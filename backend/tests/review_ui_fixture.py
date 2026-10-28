"""Ephemeral UI test server; no real credentials, Hermes runs, or phone delivery.
Run from backend: .venv/bin/python -m tests.review_ui_fixture
"""
import json
import tempfile
import time
import uuid
from pathlib import Path
from aiohttp import web
from channel_backend.business import Business
from channel_backend.server import create_app
from channel_backend.store import Store


def main():
    with tempfile.TemporaryDirectory(prefix="channel-review-ui-") as temp:
        store=Store(Path(temp)/"tasks.db");business=Business(Path(temp)/"audit.db")
        cfg={"port":8661,"channel_id":"demo-channel-a","device_id":"fixture-phone","group_ref":"test-1","group_name":"测试1","review_key":"ui-fixture-only","device_key":"no-phone-delivery","biz_key":"unused","hermes_key":"unused","mcp_port":1,"run_timeout":180}
        questions=["订单 A123 卡在哪一步？需要补充哪些资料？具体原因是什么？","订单 A124 现在是什么状态？","营业执照扫描件需要符合哪些要求？","资料提交后多久可以完成审核？","订单 A123 的申请进度帮忙看一下","订单信息查询失败，请帮我确认一下"]
        names=["李明","陈晓","王晨","林小雨","张伟"]
        answer="（模拟数据）订单 A123\n当前状态：待补充资料\n当前环节：资料审核\n资料要求：补充营业执照清晰扫描件\n流程记录：申请提交（完成） → 资料审核（待补充资料）\n记录时间：2026-10-26T09:00:00+08:00\n具体原因与处理时限：本轮未核实，请人工确认。"
        now=time.time()
        for i in range(127):
            phone=i%4!=2
            message={"event_id":str(uuid.uuid4()),"group_ref":"test-1","group_name":"测试1","content":questions[i%len(questions)]+(" [验收目标]" if i==0 else ""),"sender_display_name":names[i%len(names)],"observed_at":"2026-10-28T10:00:00+08:00"}
            row,_=store.receive("fixture-phone" if phone else "web-demo",message)
            status=["draft_ready","draft_ready","running","approved","needs_human","rejected","draft_ready"][i%7]
            store.update(row["id"],status="draft_ready",draft=answer,error="未找到本渠道可访问的订单，请核对或转人工" if status=="needs_human" else None)
            for tool in ("query_order","query_trace"):
                r=business.query("demo-channel-a",tool,"A123")
                store.event(row["id"],{"event":"audit.link","audit_id":r["audit_id"],"tool_call_id":"fixture-"+tool})
            store.event(row["id"],{"event":"draft.grounded","schema":"order_facts.v1"})
            if status=="approved":
                out=store.review(row["id"],"approve",answer,1,"fixture-reviewer","test-1")
                with store.connect() as db:
                    db.execute("UPDATE outbox SET status=?,created=? WHERE id=?",("outgoing_observed" if i%2 else "not_sent",now-i*15,out["id"]))
            elif status=="rejected":store.review(row["id"],"reject","",1,"fixture-reviewer","test-1")
            else:store.update(row["id"],status=status)
            with store.connect() as db:db.execute("UPDATE tasks SET created=? WHERE id=?",(now-(4000+i if i%7==6 else i*10),row["id"]))
        print("Isolated review fixture: http://127.0.0.1:8661",flush=True)
        web.run_app(create_app(cfg,store,business,start_worker=False),host="127.0.0.1",port=8661,access_log=None)


if __name__=="__main__":main()
