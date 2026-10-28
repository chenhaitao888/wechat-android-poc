import hmac
import json
import os

from mcp.server import MCPServer
from mcp.types import ToolAnnotations
import uvicorn

from .business import Business
from .settings import LOCAL, load
from .tools import TOOLS, enabled, input_schema


def create_app(cfg, audit_path):
    business = Business(audit_path)
    mcp = MCPServer("channel-mock-business", version="0.1.0", instructions="模拟业务，只读；权限由服务端凭证绑定，不接收渠道参数。")
    annotations = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)

    @mcp.tool(annotations=annotations)
    def query_order(order_id: str) -> dict:
        """查询当前授权渠道的模拟订单状态、环节及补件要求。"""
        return business.query(cfg["channel_id"], "query_order", order_id)

    @mcp.tool(annotations=annotations)
    def query_trace(order_id: str) -> dict:
        """查询当前授权渠道的模拟订单流程节点和处理建议，不返回原始日志。"""
        return business.query(cfg["channel_id"], "query_trace", order_id)

    inner = mcp.streamable_http_app(json_response=True, stateless_http=True, max_request_body_size=16384)
    return guarded(cfg, inner)


def create_live_app(cfg, audit_path, upstreams=None):
    """Same endpoint and credential as mock mode, but tools forward to fixed upstream tools via the gateway."""
    from mcp import types
    from mcp.server import Server
    from .gateway import Gateway, Upstreams, load_upstreams
    gateway = Gateway(cfg, Business(audit_path), upstreams or Upstreams(load_upstreams()))
    annotations = types.ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=True)
    listed = [types.Tool(name=n, description=TOOLS[n]["description"], input_schema=input_schema(n), annotations=annotations)
              for n in sorted(gateway.names)]

    async def list_tools(ctx, params):
        return types.ListToolsResult(tools=listed)

    async def call_tool(ctx, params):
        payload = await gateway.call(params.name, params.arguments or {})
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))], is_error=False)

    server = Server("channel-live-business", version="0.2.0",
                    instructions="只读查询；每次调用都有审计编号，参数按白名单校验。",
                    on_list_tools=list_tools, on_call_tool=call_tool)
    inner = server.streamable_http_app(json_response=True, stateless_http=True, max_request_body_size=16384)
    return guarded(cfg, inner)


def guarded(cfg, inner):
    async def app(scope, receive, send):
        if scope["type"] == "http":
            values = [v for k,v in scope.get("headers", []) if k.lower() == b"authorization"]
            expected = ("Bearer "+cfg["biz_key"]).encode()
            if len(values) != 1 or not hmac.compare_digest(values[0], expected):
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
                return
        await inner(scope, receive, send)
    return app


if __name__ == "__main__":
    os.umask(0o077)
    cfg = load()
    factory = create_app if enabled(cfg) is None else create_live_app
    uvicorn.run(factory(cfg, LOCAL / "audit.sqlite3"), host="127.0.0.1", port=cfg["mcp_port"], access_log=False)
