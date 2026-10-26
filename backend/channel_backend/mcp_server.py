import hmac
import json
import os

from mcp.server import MCPServer
from mcp.types import ToolAnnotations
import uvicorn

from .business import Business
from .settings import LOCAL, load


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
    uvicorn.run(create_app(cfg, LOCAL / "audit.sqlite3"), host="127.0.0.1", port=cfg["mcp_port"], access_log=False)
