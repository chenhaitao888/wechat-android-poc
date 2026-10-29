"""Live mode of the biz MCP server: each exposed tool calls one fixed upstream tool, and every call is audited.

Upstream credentials live in LOCAL/upstreams.json (0600) and never reach Hermes or the model.
"""
import asyncio
import contextlib
import json
import os
import time
from urllib.parse import urlsplit

from .settings import LOCAL
from .tools import TOOLS, ToolRefused, document_books, enabled, validate

MAX_RESULT = 6000  # results accumulate in the model context; one code question used ~200k tokens at 12000
MAX_ARGS = 4000


def load_upstreams():
    path = LOCAL / "upstreams.json"
    if path.stat().st_mode & 0o077:
        raise PermissionError("upstreams.json must be 0600")
    return json.loads(path.read_text())


def result_text(result):
    structured = getattr(result, "structured_content", None)
    if structured is not None:
        return json.dumps(structured, ensure_ascii=False)
    return "\n".join(c.text for c in (result.content or []) if getattr(c, "text", None))


class Upstreams:
    """Opens one short MCP session per call: slower, but no shared state between questions."""

    def __init__(self, conf):
        self.conf = conf

    @contextlib.asynccontextmanager
    async def session(self, name):
        from mcp import ClientSession
        c = self.conf.get(name)
        if not c:
            raise ToolRefused("上游未配置：" + name)
        if name == "phgraph":
            import httpx2
            from mcp.client.streamable_http import streamable_http_client
            async with httpx2.AsyncClient(headers={"Authorization": "Bearer " + c["token"]},
                                          timeout=httpx2.Timeout(30, read=90)) as http:
                async with streamable_http_client(c["url"], http_client=http) as streams:
                    async with ClientSession(streams[0], streams[1]) as s:
                        await s.initialize()
                        yield s
        elif name == "aitool":
            from mcp.client.sse import sse_client
            async with sse_client(c["url"], timeout=30, sse_read_timeout=90) as streams:
                async with ClientSession(streams[0], streams[1]) as s:
                    await s.initialize()
                    yield s
        elif name == "yuque":
            from mcp.client.stdio import StdioServerParameters, stdio_client
            params = StdioServerParameters(command=c["command"], args=c.get("args", []), env=c.get("env"))
            with open(os.devnull, "w") as quiet:
                async with stdio_client(params, errlog=quiet) as streams:
                    async with ClientSession(streams[0], streams[1]) as s:
                        await s.initialize()
                        yield s
        else:
            raise ToolRefused("未知上游：" + name)

    async def call(self, name, args):
        spec = TOOLS[name]
        async with self.session(spec["upstream"]) as s:
            if spec["upstream"] == "aitool":
                # Fixed sub-tool name; the generic proxy itself is never offered to the model.
                res = await s.call_tool("execute_tool", {"name": spec["tool"], "arguments": args})
            else:
                res = await s.call_tool(spec["tool"], args)
        return not res.is_error, result_text(res)


def scope_search(text, books):
    """Keep only search hits inside the allowed Yuque books; refuse what cannot be filtered."""
    try:
        data = json.loads(text)
        # Only recognized result envelopes; never guess which arbitrary list contains hits.
        for _ in range(3):
            if not isinstance(data, dict):
                break
            candidates = [data[k] for k in ("data", "results", "items") if isinstance(data.get(k), (dict, list))]
            if len(candidates) != 1:
                raise ValueError()
            data = candidates[0]
        if not isinstance(data, list):
            raise ValueError()
        items = data
        if not all(isinstance(i, dict) for i in items):
            raise ValueError()
    except (ValueError, TypeError, AttributeError, StopIteration):
        raise ToolRefused("搜索结果格式无法按知识库过滤")

    def allowed(item):
        url = item.get("url")
        if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url):
            return False
        try:
            parsed = urlsplit(url)
            host = parsed.hostname or ""
            parts = parsed.path.split("/")
            return (parsed.scheme == "https" and not parsed.username and not parsed.password
                    and parsed.port in (None, 443) and (host == "yuque.com" or host.endswith(".yuque.com"))
                    and len(parts) >= 4 and bool(parts[3]) and not any(p in (".", "..") for p in parts)
                    and f"{parts[1]}/{parts[2]}" in books)
        except ValueError:
            return False
    kept = [i for i in items if allowed(i)]
    return json.dumps(kept, ensure_ascii=False)


class Gateway:
    def __init__(self, cfg, business, upstreams):
        self.cfg, self.business, self.upstreams = cfg, business, upstreams
        self.names = set(enabled(cfg) or ())
        self.books = document_books(cfg)
        # Explicit opt-in: upstream credentials define the scope; results reach the model before human review.
        self.all_books = self.books == {"*"}

    async def call(self, name, raw):
        start = time.monotonic()
        ok, text, error = False, "", None
        try:
            if name not in self.names:
                raise ToolRefused("未开放的工具")
            if len(json.dumps(raw, ensure_ascii=False)) > MAX_ARGS:
                raise ToolRefused("参数过长")
            args = validate(name, raw)
            if TOOLS[name]["upstream"] == "yuque" and not self.books:
                raise ToolRefused("未配置允许的语雀知识库")  # No implicit full-key scope when configuration is missing.
            if name == "doc_get" and not self.all_books and f"{args['group_login']}/{args['book_slug']}" not in self.books:
                raise ToolRefused("文档不在允许的知识库范围内")
            ok, text = await asyncio.wait_for(self.upstreams.call(name, args), self.cfg.get("upstream_timeout", 60))
            if not ok:
                error = "上游工具返回错误"
            elif name == "doc_search" and not self.all_books:
                text = scope_search(text, self.books)
        except ToolRefused as exc:
            ok, error = False, str(exc)
        except asyncio.TimeoutError:
            ok, error = False, "上游工具超时"
        except Exception as exc:  # transport failures must not crash the gateway or leak details
            ok, error = False, "上游工具调用失败：" + type(exc).__name__
        ok = ok and error is None
        if not ok:
            # Failed filtering and upstream errors may contain out-of-scope data or credentials.
            text = ""
        truncated = len(text) > MAX_RESULT
        text = text[:MAX_RESULT]
        audit_id = self.business.record_live(self.cfg["channel_id"], name, raw, ok, text, error,
                                             int((time.monotonic() - start) * 1000), truncated=truncated)
        payload = {"audit_id": audit_id, "ok": ok, "result": text}
        if error:
            payload["error"] = error
        if truncated:
            payload["truncated"] = True
        return payload
