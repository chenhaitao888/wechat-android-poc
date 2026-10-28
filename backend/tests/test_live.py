import asyncio
import hashlib
import json
import socket
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import yaml

from channel_backend.agent import Hermes, Worker, allowed_tools, biz_include
from channel_backend.business import Business
from channel_backend.gateway import Gateway, Upstreams, scope_search, result_text
from channel_backend.grounding import leaks, parse_live, render_live
from channel_backend.store import Store, encoded
from channel_backend.tools import TOOLS, ToolRefused, canonical, enabled, input_schema, validate

LIVE = ["code_find_nodes", "code_list_services", "doc_get", "doc_search", "order_journey", "order_trace"]


def live_cfg(**extra):
    return {"channel_id": "demo-channel-a", "device_id": "phone", "group_ref": "test-1", "group_name": "测试1",
            "review_key": "r"*40, "device_key": "d"*40, "biz_key": "b"*40, "hermes_key": "h"*40,
            "port": 8660, "mcp_port": 8650, "run_timeout": 180,
            "tool_mode": "live", "enabled_tools": LIVE, "doc_books": ["team/channel-faq"], **extra}


class FakeUpstreams:
    def __init__(self, reply=(True, '{"ok":1}'), delay=0, error=None):
        self.reply, self.delay, self.error, self.calls = reply, delay, error, []

    async def call(self, name, args):
        self.calls.append((name, args))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.reply


class ToolContractTests(unittest.TestCase):
    def test_unknown_tool_extra_args_and_bad_values_are_refused(self):
        for name, args in [("execute_tool", {}), ("code_find_nodes", {"service": "a", "keyword": "X", "env": "pro"}),
                           ("code_find_nodes", {"service": "a"}), ("code_find_nodes", {"service": "a b", "keyword": "X"}),
                           ("code_find_nodes", {"service": "a", "keyword": "X; rm -rf /"}),
                           ("code_affected", {"service": "a", "node": "X", "depth": True}),
                           ("code_affected", {"service": "a", "node": "X", "depth": 99}),
                           ("order_journey", {"orderNo": "ABC123456", "bizCode": "PAY"}),
                           ("doc_search", {"q": "  "}), ("doc_search", {"q": "x"*101}), ("doc_search", {"q": "a\nb"}),
                           ("order_journey", "not-a-dict"), ("order_journey", {"orderNo": "ABC123456", "bizCode": []}),
                           ("code_find_nodes", {"service": "a/../b", "keyword": "X"})]:
            with self.subTest(name=name, args=args), self.assertRaises(ToolRefused):
                validate(name, args)

    def test_fixed_arguments_cannot_be_overridden_and_text_is_trimmed(self):
        self.assertEqual(validate("order_trace", {"orderId": "JP1234567"}), {"orderId": "JP1234567", "env": "pro"})
        with self.assertRaises(ToolRefused):
            validate("order_trace", {"orderId": "JP1234567", "env": "fat"})
        self.assertEqual(validate("doc_search", {"q": "  退款规则 "}), {"q": "退款规则"})

    def test_no_write_or_proxy_tool_is_in_the_allowlist(self):
        upstream_tools = {spec["tool"] for spec in TOOLS.values()}
        for forbidden in ("execute_tool", "create_doc", "update_doc", "upload_yuque_to_metis", "rabbit_execute",
                          "dbops_sql_query", "chatbi_execute_sql", "get_toc"):
            self.assertNotIn(forbidden, upstream_tools)

    def test_enabled_modes(self):
        self.assertIsNone(enabled({}))
        self.assertEqual(enabled(live_cfg()), sorted(LIVE))
        for bad in ({"tool_mode": "live"}, {"tool_mode": "live", "enabled_tools": []},
                    {"tool_mode": "live", "enabled_tools": ["execute_tool"]},
                    {"tool_mode": "live", "enabled_tools": ["doc_get", "doc_get"]}, {"tool_mode": "other"}, {"tool_mode": "live", "enabled_tools": [[]]}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                enabled(bad)
        self.assertEqual(biz_include({}), ["query_order", "query_trace"])
        self.assertEqual(allowed_tools(live_cfg()), {"mcp__biz__"+n for n in LIVE})

    def test_schema_matches_validation(self):
        schema = input_schema("code_affected")
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), {"service", "node"})
        self.assertEqual(schema["properties"]["depth"], {"type": "integer", "minimum": 0, "maximum": 20})


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.business = Business(Path(self.tmp.name)/"audit.db")

    def tearDown(self):
        self.tmp.cleanup()

    def audit(self, payload):
        return self.business.get(payload["audit_id"], "demo-channel-a")

    async def test_valid_call_is_forwarded_and_audited_with_canonical_args(self):
        up = FakeUpstreams()
        raw = {"service": "Growth/AppPHHomePageService", "keyword": "Order"}
        payload = await Gateway(live_cfg(), self.business, up).call("code_find_nodes", raw)
        self.assertTrue(payload["ok"]); self.assertEqual(up.calls, [("code_find_nodes", raw)])
        audit = self.audit(payload)
        self.assertEqual(audit["tool"], "code_find_nodes"); self.assertEqual(audit["order_id"], canonical(raw))
        self.assertTrue(audit["result"]["live"])

    async def test_refusals_never_reach_upstream_but_are_audited(self):
        up = FakeUpstreams()
        gw = Gateway(live_cfg(enabled_tools=["code_find_nodes"]), self.business, up)
        for name, args in [("code_mqflow", {"service": "a"}), ("code_find_nodes", {"service": "a", "keyword": "X", "x": 1}),
                           ("code_find_nodes", {"service": "a", "keyword": "K"*5000})]:
            payload = await gw.call(name, args)
            self.assertFalse(payload["ok"]); self.assertIn("error", payload)
            self.assertFalse(self.audit(payload)["result"]["ok"])
        self.assertEqual(up.calls, [])

    async def test_doc_tools_require_configured_books_and_filter_results(self):
        up = FakeUpstreams()
        gw = Gateway(live_cfg(doc_books=[]), self.business, up)
        self.assertFalse((await gw.call("doc_search", {"q": "退款"}))["ok"]); self.assertEqual(up.calls, [])
        gw = Gateway(live_cfg(), self.business, up)
        payload = await gw.call("doc_get", {"group_login": "other", "book_slug": "secret", "id": "1"})
        self.assertFalse(payload["ok"]); self.assertEqual(up.calls, [])
        hits = [{"title": "ok", "url": "https://hellobike.yuque.com/team/channel-faq/abc"},
                {"title": "internal", "url": "https://hellobike.yuque.com/team/internal/xyz"},
                {"title": "no url"}]
        gw = Gateway(live_cfg(), self.business, FakeUpstreams(reply=(True, json.dumps({"data": hits}))))
        payload = await gw.call("doc_search", {"q": "退款"})
        self.assertTrue(payload["ok"]); self.assertEqual([h["title"] for h in json.loads(payload["result"])], ["ok"])
        gw = Gateway(live_cfg(), self.business, FakeUpstreams(reply=(True, "plain text result")))
        self.assertFalse((await gw.call("doc_search", {"q": "退款"}))["ok"])

    async def test_upstream_failures_are_contained_and_sanitized(self):
        payload = await Gateway(live_cfg(), self.business, FakeUpstreams(error=OSError("secret-host:token"))).call(
            "code_list_services", {})
        self.assertFalse(payload["ok"]); self.assertNotIn("secret", json.dumps(payload))
        payload = await Gateway(live_cfg(upstream_timeout=0.05), self.business, FakeUpstreams(delay=1)).call(
            "code_list_services", {})
        self.assertEqual(payload["error"], "上游工具超时")
        payload = await Gateway(live_cfg(), self.business, FakeUpstreams(reply=(False, "boom"))).call("code_list_services", {})
        self.assertFalse(payload["ok"])
        payload = await Gateway(live_cfg(), self.business, FakeUpstreams(reply=(True, "x"*20000))).call("code_list_services", {})
        self.assertTrue(payload["truncated"]); self.assertEqual(len(payload["result"]), 6000)

    async def test_aitool_always_uses_fixed_sub_tool_and_env(self):
        seen = []

        class Session:
            async def call_tool(self, name, args):
                seen.append((name, args))

                class R:
                    is_error, content = False, []
                return R()

        class Fixed(Upstreams):
            def session(self, name):
                import contextlib

                @contextlib.asynccontextmanager
                async def cm():
                    yield Session()
                return cm()
        await Fixed({}).call("order_trace", validate("order_trace", {"orderId": "JP1234567"}))
        self.assertEqual(seen, [("execute_tool", {"name": "trace_grab", "arguments": {"orderId": "JP1234567", "env": "pro"}})])

    def test_scope_search_shapes(self):
        books = {"team/faq"}
        self.assertEqual(json.loads(scope_search("[]", books)), [])
        for bad in ("{}", '{"data": [1]}', "null"):
            with self.assertRaises(ToolRefused):
                scope_search(bad, books)


class LiveGroundingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.business = Business(Path(self.tmp.name)/"audit.db")
        good = self.business.record_live("demo-channel-a", "doc_search", {"q": "x"}, True, "[]", None, 3)
        bad = self.business.record_live("demo-channel-a", "doc_search", {"q": "y"}, False, "", "上游工具超时", 3)
        mock = self.business.query("demo-channel-a", "query_order", "A123")["audit_id"]
        self.ids = {"good": good, "bad": bad, "mock": mock}
        self.evidence = [self.business.get(i, "demo-channel-a") for i in (good, bad, mock)]

    def tearDown(self):
        self.tmp.cleanup()

    def out(self, answer="退款一般 1-3 个工作日原路退回，具体以到账为准。", ids=None, **extra):
        return json.dumps({"schema": "answer_draft.v1", "answer": answer, "audit_ids": ids or [self.ids["good"]], **extra},
                          ensure_ascii=False)

    def test_valid_answer_renders_with_proof(self):
        draft, proof = render_live(self.out(), self.evidence)
        self.assertIn("退款", draft); self.assertEqual(proof["audit_ids"], [self.ids["good"]])

    def test_structure_and_citations_fail_closed(self):
        for output in ("退款三天到账", self.out(reason="x"), self.out(answer=""), self.out(answer="长"*401),
                       self.out(ids=["audit_"+"0"*32]), self.out(ids=[self.ids["bad"]]), self.out(ids=[self.ids["mock"]]),
                       self.out(ids=[self.ids["good"], self.ids["good"]]),
                       json.dumps({"schema": "answer_draft.v1", "answer": "a", "audit_ids": "x"})):
            with self.subTest(output=output[:60]), self.assertRaises(RuntimeError):
                render_live(output, self.evidence)
        with self.assertRaisesRegex(RuntimeError, "缺少订单号"):
            parse_live('{"schema":"needs_human.v1","reason":"missing_order_id"}')

    def test_internal_identifiers_and_personal_data_go_to_a_human(self):
        for answer in ("问题出在 AppPHHitchCoreService 的超时", "请看 queryJourneyInfo 的返回", "联系 13812345678",
                       "详见 https://hellobike.yuque.com/team/internal/1", "traceId 0af3c9e1b2d4f5a6b7c8 报错",
                       "代码在 Growth/AppPHHomePageService/src", "OrderService.publish( 抛异常", "见 Foo.java", "第一步<br>第二步"):
            with self.subTest(answer=answer), self.assertRaises(RuntimeError):
                render_live(self.out(answer=answer), self.evidence)
        for answer in ("订单 1234567890123456789 已完成", "2026/10/28 下单后 3 天内理"):
            self.assertEqual(leaks(answer), [], answer)


class LiveWorkerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root/"tasks.db"); self.business = Business(self.root/"audit.db")
        self.cfg = live_cfg()

    def tearDown(self):
        self.tmp.cleanup()

    def running(self):
        msg = {"event_id": str(uuid.uuid4()), "group_ref": "test-1", "group_name": "测试1",
               "content": "HomePage 首页推荐在哪里配置？", "observed_at": "2026-10-28T10:00:00+08:00"}
        t = self.store.receive("phone", msg)[0]
        self.store.update(t["id"], status="running", run_id="run_abc", submitted=time.time()-1, request_body=encoded({}))
        return self.store.get(t["id"])

    async def finish(self, args, called_name="mcp__biz__code_find_nodes", answer="首页推荐由运营后台配置，具体开关待人工确认。"):
        t = self.running()
        payload = await Gateway(self.cfg, self.business, FakeUpstreams()).call("code_find_nodes", args)
        messages = [{"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": called_name, "arguments": json.dumps(args)}}]},
                    {"role": "tool", "tool_name": called_name, "tool_call_id": "c1", "content": json.dumps(payload)}]

        class Fake:
            async def request(*a, **kw):
                return {"data": messages}
        output = json.dumps({"schema": "answer_draft.v1", "answer": answer, "audit_ids": [payload["audit_id"]]}, ensure_ascii=False)
        await Worker(self.store, self.business, self.cfg).finish(Fake(), t, {"session_id": t["id"], "output": output})
        return self.store.get(t["id"])

    async def test_live_answer_becomes_a_reviewable_draft_only(self):
        saved = await self.finish({"service": "Growth/AppPHHomePageService", "keyword": "Recommend"})
        self.assertEqual(saved["status"], "draft_ready"); self.assertEqual(self.store.outbox(), [])
        grounded = [e for e in self.store.events(saved["id"]) if e.get("event") == "draft.grounded"]
        self.assertEqual(grounded[0]["schema"], "answer_draft.v1")

    async def test_tool_outside_live_allowlist_is_rejected(self):
        self.cfg = live_cfg(enabled_tools=["doc_search"])
        with self.assertRaises(RuntimeError):
            await self.finish({"service": "a", "keyword": "X"})

    async def test_leaky_answer_is_rejected(self):
        with self.assertRaises(RuntimeError):
            await self.finish({"service": "a", "keyword": "X"}, answer="在 HomeRecommendController 里")

    async def test_preflight_accepts_configured_live_allowlist_only(self):
        self.cfg["profile"] = str(self.root)
        config = {"platform_toolsets": {"api_server": ["mcp-biz"]}, "mcp_servers": {"biz": {
            "url": "http://127.0.0.1:8650/mcp", "tools": {"include": sorted(LIVE), "resources": False, "prompts": False}}},
            "tools": {"tool_search": {"enabled": "off"}}, "memory": {"memory_enabled": False, "user_profile_enabled": False, "provider": ""}}
        path = self.root/"config.yaml"; path.write_text(yaml.safe_dump(config))
        proof = self.root/"profile-verification.json"
        proof.write_text(json.dumps({"config_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                     "actual_tools": sorted(allowed_tools(self.cfg))}))
        adapter = Hermes(self.cfg, None)

        async def request(method, path):
            return {"data": []} if path.endswith("toolsets") else {"features": {"runs_idempotency": {"durable": True, "retention_seconds": 86400}}}
        with patch("channel_backend.agent.LOCAL", self.root), patch.object(adapter, "request", request):
            await adapter.preflight()
            proof.write_text(json.dumps({"config_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                         "actual_tools": sorted(allowed_tools(self.cfg) | {"mcp__biz__execute_tool"})}))
            with self.assertRaises(RuntimeError):
                await adapter.preflight()


class LiveServerTests(unittest.IsolatedAsyncioTestCase):
    """The live MCP endpoint over real HTTP: bearer auth, listed tools, audited calls."""

    async def test_live_endpoint(self):
        import httpx2
        import uvicorn
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        from channel_backend.mcp_server import create_live_app
        with tempfile.TemporaryDirectory() as tmp:
            cfg = live_cfg()
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
            up = FakeUpstreams(reply=(True, '["Growth/AppPHHomePageService"]'))
            server = uvicorn.Server(uvicorn.Config(create_live_app(cfg, Path(tmp)/"audit.db", up), host="127.0.0.1",
                                                   port=port, log_level="error"))
            thread = threading.Thread(target=server.run, daemon=True); thread.start()
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(0.05)
            url = f"http://127.0.0.1:{port}/mcp"
            try:
                async with httpx2.AsyncClient() as http:
                    r = await http.post(url, json={})
                    self.assertEqual(r.status_code, 401)
                async with httpx2.AsyncClient(headers={"Authorization": "Bearer "+cfg["biz_key"]}) as http:
                    async with streamable_http_client(url, http_client=http) as streams:
                        async with ClientSession(streams[0], streams[1]) as session:
                            await session.initialize()
                            listed = await session.list_tools()
                            self.assertEqual(sorted(t.name for t in listed.tools), sorted(LIVE))
                            res = await session.call_tool("code_list_services", {})
                            payload = json.loads(res.content[0].text)
                            self.assertTrue(payload["ok"]); self.assertTrue(payload["audit_id"].startswith("audit_"))
                            res = await session.call_tool("code_mqflow", {"service": "a"})
                            self.assertFalse(json.loads(res.content[0].text)["ok"])
                self.assertEqual(up.calls, [("code_list_services", {})])
            finally:
                server.should_exit = True; thread.join(5)


class ConfigureLiveTests(unittest.TestCase):
    """scripts.configure_live end to end in a throwaway data dir + profile."""

    def run_script(self, data, *args):
        import os, subprocess, sys
        env = dict(os.environ, CHANNEL_DATA_DIR=str(data))
        return subprocess.run([sys.executable, "-B", "-m", "scripts.configure_live", *args], cwd=Path(__file__).resolve().parents[1],
                              env=env, capture_output=True, text=True)

    def test_switch_to_live_and_back(self):
        import os, stat
        with tempfile.TemporaryDirectory() as tmp:
            data, profile = Path(tmp)/"data", Path(tmp)/"profile"
            data.mkdir(); profile.mkdir()
            cfg = {k: v for k, v in live_cfg().items() if k not in ("tool_mode", "enabled_tools", "doc_books")}
            cfg["profile"] = str(profile)
            (data/"settings.json").write_text(json.dumps(cfg))
            (data/"profile-verification.json").write_text("{}")
            (profile/"config.yaml").write_text(yaml.safe_dump({"agent": {"max_turns": 6}, "mcp_servers": {"biz": {
                "url": "http://127.0.0.1:8650/mcp", "tools": {"include": ["query_order", "query_trace"], "resources": False, "prompts": False}}}}))
            up = Path(tmp)/"up.json"; up.write_text(json.dumps({"phgraph": {"url": "http://127.0.0.1:8848/mcp", "token": "t"*20}}))
            r = self.run_script(data, "--upstreams", str(up), "--tools", "doc_search")
            self.assertNotEqual(r.returncode, 0); self.assertIn("doc-books", r.stdout + r.stderr)
            r = self.run_script(data, "--upstreams", str(up), "--tools", "code_find_nodes,execute_tool")
            self.assertNotEqual(r.returncode, 0)
            r = self.run_script(data, "--upstreams", str(up), "--tools", "code_find_nodes,order_trace")
            self.assertNotEqual(r.returncode, 0); self.assertIn("aitool", r.stdout + r.stderr)
            r = self.run_script(data, "--upstreams", str(up), "--tools", "code_list_services,code_find_nodes")
            self.assertEqual(r.returncode, 0, r.stderr); self.assertNotIn("t"*20, r.stdout)
            saved = json.loads((data/"settings.json").read_text())
            self.assertEqual((saved["tool_mode"], saved["enabled_tools"]), ("live", ["code_list_services", "code_find_nodes"]))
            self.assertEqual(stat.S_IMODE(os.stat(data/"upstreams.json").st_mode), 0o600)
            self.assertFalse((data/"profile-verification.json").exists())
            self.assertNotIn("模拟", (profile/"SOUL.md").read_text())
            pc = yaml.safe_load((profile/"config.yaml").read_text())
            self.assertEqual(pc["mcp_servers"]["biz"]["tools"]["include"], ["code_find_nodes", "code_list_services"])
            r = self.run_script(data, "--mock")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(json.loads((data/"settings.json").read_text())["tool_mode"], "mock")
            self.assertIn("模拟", (profile/"SOUL.md").read_text())
            pc = yaml.safe_load((profile/"config.yaml").read_text())
            self.assertEqual(pc["mcp_servers"]["biz"]["tools"]["include"], ["query_order", "query_trace"])
            self.assertTrue(list(profile.glob("config.before-live-*.yaml")))


class GatewayRegressionTests(unittest.IsolatedAsyncioTestCase):
    setUp, tearDown, audit = GatewayTests.setUp, GatewayTests.tearDown, GatewayTests.audit

    async def test_unfilterable_search_never_exposes_original_text(self):
        secret = '{"error": "internal document and credential"}'
        payload = await Gateway(live_cfg(), self.business, FakeUpstreams(reply=(True, secret))).call("doc_search", {"q": "退款"})
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["result"], "")
        self.assertNotIn("credential", json.dumps(self.audit(payload)))

    async def test_upstream_error_body_is_not_returned_or_persisted(self):
        payload = await Gateway(live_cfg(), self.business, FakeUpstreams(reply=(False, "secret-host:token"))).call("code_list_services", {})
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["result"], "")
        self.assertNotIn("secret-host", json.dumps(self.audit(payload)))

    async def test_truncation_is_visible_in_persisted_evidence(self):
        payload = await Gateway(live_cfg(), self.business, FakeUpstreams(reply=(True, "x"*20000))).call("code_list_services", {})
        self.assertTrue(self.audit(payload)["result"].get("truncated"))

    def test_scope_checks_exact_host_and_url(self):
        urls = ["https://yuque.com/team/faq/abc", "https://company.yuque.com/team/faq/abc",
                "https://notyuque.com/team/faq/abc", "https://yuque.com.evil.test/team/faq/abc",
                "prefix https://yuque.com/team/faq/abc", "https://user:pass@yuque.com/team/faq/abc"]
        hits = [{"url": u} for u in urls]
        self.assertEqual(json.loads(scope_search(json.dumps(hits), {"team/faq"})), hits[:2])

    def test_structured_only_mcp_results_are_preserved(self):
        from mcp.types import CallToolResult
        self.assertEqual(json.loads(result_text(CallToolResult(content=[], structured_content={"data": []}))), {"data": []})


class ConfigurationRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data, self.profile = self.root/"data", self.root/"profile"
        self.data.mkdir(); self.profile.mkdir()
        cfg = live_cfg(profile=str(self.profile))
        (self.data/"settings.json").write_text(json.dumps(cfg))
        (self.profile/"config.yaml").write_text(yaml.safe_dump({"mcp_servers": {"biz": {"tools": {"include": LIVE}}}}))
        (self.profile/"SOUL.md").write_text("original soul")
        (self.data/"upstreams.json").write_text('{"old":"original secret"}')
        (self.data/"profile-verification.json").write_text("{}")
        self.up = self.root/"new.json"
        self.up.write_text(json.dumps({"phgraph": {"url": "http://127.0.0.1:8848/mcp", "token": "new token"}}))

    def tearDown(self):
        self.tmp.cleanup()

    def run_config(self, *args):
        return ConfigureLiveTests.run_script(self, self.data, "--upstreams", str(self.up), "--tools", "code_list_services", *args)

    def test_invalid_profile_does_not_replace_credentials(self):
        (self.profile/"config.yaml").write_text("{}")
        before = (self.data/"upstreams.json").read_bytes()
        r = self.run_config()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.data/"upstreams.json").read_bytes(), before)
        self.assertTrue((self.data/"profile-verification.json").exists())

    def test_running_backend_prevents_configuration_switch(self):
        import fcntl
        before = (self.data/"settings.json").read_bytes()
        with (self.data/"backend.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = self.run_config()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("stop", r.stderr.lower())
        self.assertEqual((self.data/"settings.json").read_bytes(), before)

    def test_timeout_and_turns_must_be_bounded(self):
        for args in [("--max-turns", "0"), ("--run-timeout", "-1")]:
            with self.subTest(args=args):
                r = self.run_config(*args)
                self.assertNotEqual(r.returncode, 0)
        self.assertEqual((self.data/"upstreams.json").read_text(), '{"old":"original secret"}')

    def test_backup_covers_credentials_and_soul_and_does_not_collide(self):
        for _ in range(2):
            r = self.run_config()
            self.assertEqual(r.returncode, 0, r.stderr)
        backups = list(self.data.glob("upstreams.before-live-*.json"))
        self.assertEqual(len(backups), 2)
        self.assertTrue(any(p.read_text() == '{"old":"original secret"}' for p in backups))
        self.assertTrue(any(p.read_text() == "original soul" for p in self.profile.glob("SOUL.before-live-*.md")))
        self.assertTrue(all(p.stat().st_mode & 0o077 == 0 for p in backups))

    def test_write_failure_restores_original_files_and_invalidates_proof(self):
        from scripts import configure_live
        first, second, created = self.profile/"SOUL.md", self.data/"settings.json", self.data/"new-config.json"
        proof = self.data/"profile-verification.json"
        before = {p: p.read_bytes() for p in (first, second)}
        real_write = configure_live.write_private
        failed = False

        def fail_once(path, content):
            nonlocal failed
            if path == second and not failed:
                failed = True
                raise OSError("simulated disk failure")
            real_write(path, content)

        with patch.object(configure_live, "write_private", side_effect=fail_once):
            with self.assertRaises(OSError):
                configure_live.apply_changes({first: "new soul", created: "new file", second: "new settings"}, proof)
        self.assertTrue(failed)
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertFalse(created.exists())
        self.assertFalse(proof.exists())


if __name__ == "__main__":
    unittest.main()
