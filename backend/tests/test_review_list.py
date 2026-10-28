import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from aiohttp.test_utils import TestClient, TestServer
from channel_backend.business import Business
from channel_backend.server import create_app
from channel_backend.store import Store


class ReviewListTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.store = Store(root / "tasks.db")
        self.business = Business(root / "audit.db")
        self.cfg = {"port":8660,"channel_id":"demo-channel-a","device_id":"phone","group_ref":"test-1","group_name":"测试1","review_key":"review-test","device_key":"device-test","biz_key":"biz-test","hermes_key":"hermes-test","mcp_port":8650,"run_timeout":180}
        self.client = TestClient(TestServer(create_app(self.cfg,self.store,self.business,start_worker=False)))
        await self.client.start_server()
        self.cfg["port"] = self.client.port
        self.headers = {"Authorization":"Bearer review-test"}

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    def task(self,content="订单 A123 卡在哪一步？",device="phone",status="draft_ready",created=None,group="test-1"):
        row,_ = self.store.receive(device,{"event_id":str(uuid.uuid4()),"group_ref":group,"group_name":"测试1" if group=="test-1" else "另一个群","content":content,"sender_display_name":"测试人","observed_at":"2026-10-28T10:00:00+08:00"})
        self.store.update(row["id"],status=status,draft="模拟答案")
        if created is not None:
            with self.store.connect() as db: db.execute("UPDATE tasks SET created=? WHERE id=?",(created,row["id"]))
        return row["id"]

    async def listing(self,**params):
        r = await self.client.get("/api/review/list",headers=self.headers,params=params)
        self.assertEqual(r.status,200,await r.text())
        return await r.json()

    async def test_pages_reach_history_beyond_100_without_audit_fetches(self):
        now=time.time()
        expected=[self.task(content=f"历史问题 {i}",created=now-i) for i in range(127)]
        seen=[]
        with patch("channel_backend.server.collect_evidence",side_effect=AssertionError("List must not fetch audits")):
            for page in (1,2,3):
                data=await self.listing(page=page,page_size=50)
                seen.extend(i["id"] for i in data["items"])
                self.assertEqual(data["total"],127)
                self.assertEqual(data["counts"]["pending"],127)
        self.assertEqual(seen,expected)
        self.assertEqual(len(set(seen)),127)
        self.assertEqual((await self.listing(page=999,page_size=50))["page"],3)
        self.assertEqual((await self.listing(sort="oldest"))["items"][0]["id"],expected[-1])

    async def test_combined_filters_counts_literal_search_and_empty_results(self):
        self.task(content="特殊字面量 100%_ A123",created=time.time()-20)
        self.task(content="其他普通内容",status="needs_human")
        self.task(content="A123 网页记录",device="web-demo",group="else")
        data=await self.listing(q="100%_",source="phone",group="test-1",category="pending",since=time.time()-60)
        self.assertEqual(data["total"],1)
        self.assertEqual(data["counts"]["all"],1)
        self.assertEqual(len(data["groups"]),2)
        self.assertEqual((await self.listing(q="测试人",source="web-demo"))["total"],1)
        for query in ("' OR 1=1 --","不存在"):
            empty=await self.listing(q=query)
            self.assertEqual((empty["total"],empty["page"],empty["pages"]),(0,1,1))
        self.assertEqual((await self.listing(since=time.time()+10))["total"],0)

    async def test_expiry_is_readonly_and_not_pending(self):
        expired=self.task(created=time.time()-1900)
        self.task();self.task(status="queued");self.task(status="needs_human")
        before=self.store.get(expired)
        data=await self.listing(category="attention")
        self.assertEqual(data["counts"],{"all":4,"pending":1,"processing":1,"reviewed":0,"attention":2})
        self.assertEqual(next(i for i in data["items"] if i["id"]==expired)["display_status"],"expired")
        self.assertEqual(self.store.get(expired),before)
        r=await self.client.get("/api/review/task/"+expired,headers=self.headers)
        self.assertFalse((await r.json())["reviewable"])
        r=await self.client.post("/api/review/"+expired,headers=self.headers,json={"decision":"approve","text":"错误通过","version":1})
        self.assertEqual(r.status,409);self.assertEqual(self.store.outbox(),[])

    async def test_outbox_detail_preserves_approved_text_and_hides_lease(self):
        task=self.task();out=self.store.review(task,"approve","修改后的确定答案",1,"reviewer","test-1")
        lease=self.store.delivery(out["id"],"phone","claim",{})["lease"]
        data=await self.listing(view="outbox",q="修改后的确定答案")
        self.assertEqual(data["total"],1);self.assertNotIn(lease,json.dumps(data))
        r=await self.client.get("/api/review/task/"+task,headers=self.headers);detail=await r.json()
        self.assertEqual(detail["draft"],"模拟答案")
        self.assertEqual(detail["outbox"]["text"],"修改后的确定答案")
        self.assertFalse(detail["reviewable"]);self.assertNotIn(lease,json.dumps(detail))
        with self.store.connect() as db: db.execute("UPDATE outbox SET expires=? WHERE id=?",(time.time()-1,out["id"]))
        data=await self.listing(view="outbox",category="attention")
        self.assertEqual(data["items"][0]["display_status"],"expired")
        self.assertEqual(self.store.outbox()[0]["status"],"claimed")

    async def test_authorization_and_invalid_parameters(self):
        for path in ("/api/review/list","/api/review/task/missing"):
            for headers in ({},{"Authorization":"Bearer device-test"}):
                r=await self.client.get(path,headers=headers);self.assertEqual(r.status,401)
        r=await self.client.get("/api/review/task/missing",headers=self.headers);self.assertEqual(r.status,404)
        for params in ({"view":"other"},{"view":"tasks","category":"sent"},{"source":"other"},{"page":"0"},{"page":"no"},{"page_size":"1000"},{"since":"nan"},{"since":"inf"},{"since":"-1"},{"sort":"created; DROP TABLE tasks"},{"q":"x"*201},{"unexpected":"x"}):
            r=await self.client.get("/api/review/list",headers=self.headers,params=params);self.assertEqual(r.status,400,params)

    async def test_edit_reject_and_stale_version_via_new_detail(self):
        task=self.task();r=await self.client.get("/api/review/task/"+task,headers=self.headers);detail=await r.json()
        self.assertTrue(detail["reviewable"])
        r=await self.client.post("/api/review/"+task,headers=self.headers,json={"decision":"approve","text":"经人工修改","version":detail["version"]})
        self.assertEqual(r.status,200)
        self.assertEqual((await self.listing(category="reviewed"))["items"][0]["display_status"],"edited")
        other=self.task()
        r=await self.client.post("/api/review/"+other,headers=self.headers,json={"decision":"reject","version":2});self.assertEqual(r.status,409)
        r=await self.client.post("/api/review/"+other,headers=self.headers,json={"decision":"reject","version":1});self.assertEqual(r.status,200)
        self.assertEqual(len(self.store.outbox()),1)


if __name__=="__main__":unittest.main()
