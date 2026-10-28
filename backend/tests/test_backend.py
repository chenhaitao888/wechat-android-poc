import asyncio
import hashlib
import yaml
from unittest.mock import patch
import json
import tempfile
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from channel_backend.agent import Worker, INSTRUCTIONS, Hermes, ALLOWED_TOOLS
from channel_backend.business import Business
from channel_backend.server import create_app, validate_message
from channel_backend.store import Store, Problem, encoded


class Fixture:
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.store=Store(self.root/"tasks.db")
        self.business=Business(self.root/"audit.db")
        self.cfg={"channel_id":"demo-channel-a","device_id":"phone","group_ref":"test-1","group_name":"测试1",
                  "review_key":"r"*40,"device_key":"d"*40,"biz_key":"b"*40,"hermes_key":"h"*40,"port":8660,"mcp_port":8650,"run_timeout":180}

    def tearDown(self):
        self.tmp.cleanup()

    def message(self,**extra):
        return {"event_id":str(uuid.uuid4()),"group_ref":"test-1","group_name":"测试1",
                "content":"订单 A123 卡在哪里？","observed_at":"2026-10-26T10:00:00+08:00",**extra}

    def task(self):
        return self.store.receive("phone",self.message())[0]

    def approved(self):
        t=self.task();self.store.update(t["id"],status="draft_ready",draft="模拟答案")
        return self.store.review(t["id"],"approve","模拟答案",1,"reviewer","test-1")


class StoreTests(Fixture,unittest.TestCase):
    def test_event_replay_and_changed_payload(self):
        m=self.message();t,created=self.store.receive("phone",m);self.assertTrue(created)
        again,new=self.store.receive("phone",m);self.assertEqual(t["id"],again["id"]);self.assertFalse(new)
        with self.assertRaises(Problem):self.store.receive("phone",{**m,"content":"changed"})

    def test_same_question_new_event_and_restart(self):
        first=self.task();second=self.task();self.assertNotEqual(first["id"],second["id"])
        reopened=Store(self.root/"tasks.db");self.assertEqual(reopened.get(first["id"])["status"],"queued")

    def test_concurrent_receive_one_task(self):
        m=self.message()
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(lambda _:self.store.receive("phone",m),range(8)))
        self.assertEqual(len({r[0]["id"] for r in results}),1)
        self.assertEqual(sum(r[1] for r in results),1)

    def test_review_gate_and_replay(self):
        t=self.task()
        with self.assertRaises(Problem):self.store.review(t["id"],"approve","text",1,"r","test-1")
        self.store.update(t["id"],status="draft_ready",draft="original")
        out=self.store.review(t["id"],"approve","edited",1,"r","test-1")
        again=self.store.review(t["id"],"approve","edited",1,"r","test-1")
        self.assertEqual(out["id"],again["id"]);self.assertEqual(out["text"],"edited")
        self.assertEqual(self.store.get(t["id"])["status"],"edited")
        with self.assertRaises(Problem):self.store.review(t["id"],"approve","changed",1,"r","test-1")

    def test_rejected_and_stale_version_never_outbox(self):
        t=self.task();self.store.update(t["id"],status="draft_ready",draft="text")
        with self.assertRaises(Problem):self.store.review(t["id"],"approve","text",2,"r","test-1")
        self.store.review(t["id"],"reject","",1,"r","test-1")
        self.assertEqual(self.store.outbox(),[])

    def test_claim_is_exclusive_and_get_is_readonly(self):
        out=self.approved();before=self.store.outbox();self.assertEqual(before,self.store.outbox())
        with ThreadPoolExecutor(max_workers=6) as pool:
            def claim(_):
                try:return self.store.delivery(out["id"],"phone","claim",{})
                except Problem:return None
            results=list(pool.map(claim,range(6)))
        self.assertEqual(sum(r is not None for r in results),1)

    def test_sending_never_reclaimed_even_after_expiry(self):
        out=self.approved();r=self.store.delivery(out["id"],"phone","claim",{})
        d={"lease_token":r["lease"],"attempt_id":"attempt1"}
        self.store.delivery(out["id"],"phone","sending",d)
        with self.assertRaises(Problem):self.store.delivery(out["id"],"phone","claim",{},now=time.time()+100)
        ack={**d,"outcome":"outgoing_observed","evidence":"bubble was visible"}
        self.store.delivery(out["id"],"phone","ack",ack)
        self.store.delivery(out["id"],"phone","ack",ack,now=time.time()+4000)
        self.assertEqual(len(self.store.outbox()),1)
        with self.assertRaises(Problem):self.store.delivery(out["id"],"phone","ack",{**ack,"outcome":"not_sent"})

    def test_wrong_device_lease_attempt_and_uncertain(self):
        out=self.approved()
        with self.assertRaises(Problem):self.store.delivery(out["id"],"other","claim",{})
        r=self.store.delivery(out["id"],"phone","claim",{})
        with self.assertRaises(Problem):self.store.delivery(out["id"],"phone","sending",{"lease_token":"bad","attempt_id":"a"})
        d={"lease_token":r["lease"],"attempt_id":"a"};self.store.delivery(out["id"],"phone","sending",d)
        with self.assertRaises(Problem):self.store.delivery(out["id"],"phone","ack",{**d,"attempt_id":"b","outcome":"not_sent","evidence":"x"})
        self.store.delivery(out["id"],"phone","ack",{**d,"outcome":"send_uncertain","evidence":"process interrupted"})
        with self.assertRaises(Problem):self.store.delivery(out["id"],"phone","claim",{})

    def test_expired_unstarted_lease_can_be_reclaimed(self):
        out=self.approved();r=self.store.delivery(out["id"],"phone","claim",{})
        other=self.store.delivery(out["id"],"phone","claim",{},now=time.time()+61)
        self.assertNotEqual(r["lease"],other["lease"])
        with self.assertRaises(Problem):self.store.delivery(out["id"],"phone","sending",{"lease_token":r["lease"],"attempt_id":"a"})

    def test_permission_before_data_and_audit(self):
        ok=self.business.query("demo-channel-a","query_order","A123");self.assertTrue(ok["ok"])
        denied=self.business.query("demo-channel-a","query_order","B999")
        absent=self.business.query("demo-channel-a","query_order","Z000")
        self.assertEqual(denied["error"],absent["error"]);self.assertNotIn("status",denied)
        self.assertIsNone(self.business.get(ok["audit_id"],"demo-channel-b"))

    def test_invalid_and_failure_fixtures(self):
        for value,code in [("../../x","INVALID_ORDER_ID"),("A408","TOOL_TIMEOUT"),("A500","TOOL_FAILURE")]:
            self.assertEqual(self.business.query("demo-channel-a","query_order",value)["error"],code)

    def test_reject_forged_group_channel_and_bad_time(self):
        for extra in [{"group_ref":"other"},{"channel_id":"demo-channel-b"},{"observed_at":"yesterday"},{"content":""}]:
            with self.assertRaises(Problem):validate_message(self.message(**extra),self.cfg)


class WorkerTests(Fixture,unittest.IsolatedAsyncioTestCase):
    def running(self,age=0):
        t=self.task();self.store.update(t["id"],status="running",run_id="run_abc",submitted=time.time()-age,
                                      request_body=encoded({"input":"x","session_id":t["id"],"instructions":INSTRUCTIONS}))
        return self.store.get(t["id"])

    async def test_preflight_requires_verified_config_and_no_extra_tools(self):
        self.cfg["profile"]=str(self.root)
        config={"platform_toolsets":{"api_server":["mcp-biz"]},"mcp_servers":{"biz":{
            "url":"http://127.0.0.1:8650/mcp","tools":{"include":["query_order","query_trace"],"resources":False,"prompts":False}}},
            "tools":{"tool_search":{"enabled":"off"}},"memory":{"memory_enabled":False,"user_profile_enabled":False,"provider":""}}
        path=self.root/"config.yaml";path.write_text(yaml.safe_dump(config))
        (self.root/"profile-verification.json").write_text(json.dumps({"config_sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"actual_tools":list(ALLOWED_TOOLS)}))
        adapter=Hermes(self.cfg,None)
        async def request(method,path):
            return {"data":[]} if path.endswith("toolsets") else {"features":{"runs_idempotency":{"durable":True,"retention_seconds":86400}}}
        with patch("channel_backend.agent.LOCAL",self.root),patch.object(adapter,"request",request):
            await adapter.preflight()
            path.write_text(path.read_text()+"# changed\n")
            with self.assertRaises(RuntimeError):await adapter.preflight()

    async def test_resume_polls_same_run_without_submit(self):
        t=self.running();calls=[]
        class Fake:
            async def request(_,method,path,*args,**kw):
                calls.append((method,path));return {"status":"failed"}
            async def events(_,run,callback):pass
        await Worker(self.store,self.business,self.cfg).process(Fake(),t)
        self.assertTrue(all(m=="GET" for m,p in calls));self.assertIn("run_abc",calls[0][1])
        self.assertEqual(self.store.get(t["id"])["status"],"needs_human")

    async def test_timeout_cancels_and_drops_late_answer(self):
        t=self.running(age=200);calls=[]
        class Fake:
            async def request(_,method,path,*args,**kw):
                calls.append((method,path));return {"status":"completed","output":"late"}
            async def events(_,run,callback):pass
        await Worker(self.store,self.business,self.cfg).process(Fake(),t)
        self.assertTrue(any(p.endswith('/stop') for m,p in calls));self.assertEqual(self.store.outbox(),[])
        self.assertEqual(self.store.get(t["id"])["status"],"needs_human")

    async def test_unknown_status_is_not_success(self):
        t=self.running()
        class Fake:
            async def request(*args,**kw):return {"status":"new_unknown_status"}
            async def events(*args,**kw):pass
        await Worker(self.store,self.business,self.cfg).process(Fake(),t)
        self.assertEqual(self.store.get(t["id"])["status"],"needs_human")

    async def test_old_uncertain_submit_not_replayed(self):
        t=self.running(age=400);self.store.update(t["id"],run_id=None,status="submitting")
        class Fake:
            async def request(*args,**kw):raise AssertionError("must not submit")
        await Worker(self.store,self.business,self.cfg).process(Fake(),self.store.get(t["id"]))
        self.assertEqual(self.store.get(t["id"])["status"],"needs_human")

    async def test_complete_requires_audited_tool_result(self):
        t=self.running();messages=[];audits={}
        for index,tool in enumerate(("query_order","query_trace")):
            audit=self.business.query(self.cfg["channel_id"],tool,"A123");audits[tool]=audit
            name="mcp__biz__"+tool;call="call"+str(index)
            messages.extend([{"role":"assistant","tool_calls":[{"id":call,"function":{"name":name,"arguments":'{"order_id":"A123"}'}}]},
                             {"role":"tool","tool_name":name,"tool_call_id":call,"content":json.dumps(audit)}])
        class Fake:
            async def request(*args,**kw):return {"data":messages}
        worker=Worker(self.store,self.business,self.cfg)
        output=json.dumps({"schema":"order_facts.v1","order_id":"A123","order_audit_id":audits["query_order"]["audit_id"],"trace_audit_id":audits["query_trace"]["audit_id"]})
        await worker.finish(Fake(),t,{"session_id":t["id"],"output":output})
        saved=self.store.get(t["id"])
        self.assertEqual(saved["status"],"draft_ready");self.assertEqual(self.store.outbox(),[])
        self.assertIn("本轮未核实",saved["draft"]);self.assertNotIn("审核未通过",saved["draft"])
        self.assertTrue(any(e.get("event")=="draft.grounded" for e in self.store.events(t["id"])))
        messages[1]["content"]='{"audit_id":"audit_00000000000000000000000000000000"}'
        with self.assertRaises(RuntimeError):await worker.finish(Fake(),t,{"session_id":t["id"],"output":output})

    async def test_free_form_hallucination_never_becomes_a_reviewable_draft(self):
        t=self.running();messages=[]
        for index,tool in enumerate(("query_order","query_trace")):
            audit=self.business.query(self.cfg["channel_id"],tool,"A123");name="mcp__biz__"+tool;call="c"+str(index)
            messages.extend([{"role":"assistant","tool_calls":[{"id":call,"function":{"name":name,"arguments":'{"order_id":"A123"}'}}]},
                             {"role":"tool","tool_name":name,"tool_call_id":call,"content":json.dumps(audit)}])
        class Fake:
            async def request(_,method,path,*args,**kw):
                if path.startswith('/api/sessions'):return {"data":messages}
                return {"status":"completed","session_id":t["id"],"output":"原扫描件不清晰，审核未通过，补齐马上通过"}
            async def events(*args,**kw):pass
        await Worker(self.store,self.business,self.cfg).process(Fake(),t)
        self.assertEqual(self.store.get(t["id"])["status"],"needs_human")
        self.assertIsNone(self.store.get(t["id"])["draft"]);self.assertEqual(self.store.outbox(),[])


class ApiTests(Fixture,unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client=TestClient(TestServer(create_app(self.cfg,self.store,self.business,start_worker=False)))
        await self.client.start_server();self.cfg["port"]=self.client.port

    async def asyncTearDown(self):
        await self.client.close()

    async def test_auth_roles_and_cross_origin(self):
        r=await self.client.get('/api/review/tasks');self.assertEqual(r.status,401)
        r=await self.client.get('/api/review/tasks',headers={"Authorization":"Bearer "+self.cfg["device_key"]});self.assertEqual(r.status,401)
        r=await self.client.get('/api/review/tasks',headers={"Authorization":"Bearer "+self.cfg["review_key"],"Origin":"https://evil.example"});self.assertEqual(r.status,403)
        r=await self.client.get('/api/outbox',headers={"Authorization":"Bearer "+self.cfg["review_key"]});self.assertEqual(r.status,401)

    async def test_receive_replay_over_http(self):
        h={"Authorization":"Bearer "+self.cfg["device_key"]};m=self.message()
        r=await self.client.post('/api/messages',json=m,headers=h);a=await r.json();self.assertEqual(r.status,202)
        r=await self.client.post('/api/messages',json=m,headers=h);b=await r.json();self.assertEqual(a['task_id'],b['task_id'])
        r=await self.client.post('/api/messages',json={**m,"content":"different"},headers=h);self.assertEqual(r.status,409)

    async def test_phone_source_review_and_delivery_over_http(self):
        device={"Authorization":"Bearer "+self.cfg["device_key"]}
        reviewer={"Authorization":"Bearer "+self.cfg["review_key"]}
        r=await self.client.post('/api/messages',json=self.message(),headers=device)
        task=(await r.json())["task_id"]
        r=await self.client.get('/api/outbox',headers=device)
        self.assertEqual((await r.json())["items"],[])
        self.store.update(task,status="draft_ready",draft="模拟答案")
        r=await self.client.get('/api/review/tasks',headers=reviewer)
        self.assertEqual((await r.json())["tasks"][0]["source"],"phone")
        r=await self.client.post('/api/review/'+task,json={"decision":"approve","text":"模拟答案","version":1},headers=reviewer)
        out=(await r.json())["outbox_id"]
        r=await self.client.get('/api/outbox',headers=device)
        item=(await r.json())["items"][0]
        self.assertEqual(item["id"],out);self.assertNotIn("lease",item)
        r=await self.client.post('/api/outbox/'+out+'/claim',json={},headers=device)
        lease=(await r.json())["lease_token"]
        payload={"lease_token":lease,"attempt_id":"http-phone-attempt"}
        r=await self.client.post('/api/outbox/'+out+'/sending',json=payload,headers=device)
        self.assertEqual(r.status,200)
        r=await self.client.post('/api/outbox/'+out+'/ack',json={**payload,"outcome":"outgoing_observed","evidence":"test bubble"},headers=device)
        self.assertEqual((await r.json())["status"],"outgoing_observed")

    async def test_web_demo_cannot_be_claimed_by_phone(self):
        h={"Authorization":"Bearer "+self.cfg["review_key"]}
        r=await self.client.post('/api/demo/messages',json={"content":"订单 A123 状态"},headers=h);task=(await r.json())["task_id"]
        self.store.update(task,status="draft_ready",draft="模拟")
        r=await self.client.post('/api/review/'+task,json={"decision":"approve","text":"模拟","version":1},headers=h);self.assertEqual(r.status,200)
        r=await self.client.get('/api/outbox',headers={"Authorization":"Bearer "+self.cfg["device_key"]});self.assertEqual((await r.json())["items"],[])


if __name__=='__main__':unittest.main()
