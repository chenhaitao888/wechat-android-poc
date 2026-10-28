"""Read-only fixtures and independent audit. Channel scope is selected by server credential."""
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path

ORDER_RE = re.compile(r"[A-Z][0-9]{3,8}\Z")
# Deliberately includes another channel. Queries must filter before returning any business fields.
ORDERS = {
    "A123": {"channel_id": "demo-channel-a", "status": "待补充资料", "step": "资料审核",
             "updated_at": "2026-10-26T09:00:00+08:00", "required": "补充营业执照清晰扫描件"},
    "A124": {"channel_id": "demo-channel-a", "status": "已完成", "step": "开通完成",
             "updated_at": "2026-10-26T10:00:00+08:00", "required": "无需补充资料"},
    "B999": {"channel_id": "demo-channel-b", "status": "其他渠道私有状态", "step": "非本渠道节点",
             "updated_at": "2026-10-26T10:30:00+08:00", "required": "不得向渠道A泄露"},
}


class Business:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at REAL, channel TEXT, tool TEXT, order_id TEXT, result TEXT, duration_ms INTEGER)")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def query(self, channel, tool, order_id):
        start = time.monotonic()
        if tool not in {"query_order", "query_trace"}:
            raise ValueError("Unknown tool")
        result = {"audit_id": "audit_"+uuid.uuid4().hex, "mock": True, "ok": False}
        if not isinstance(order_id, str) or not ORDER_RE.fullmatch(order_id):
            result.update(error="INVALID_ORDER_ID", message="订单号格式不正确")
            order_id = "<invalid>"
        elif order_id in {"A500", "A408"}:
            # Deterministic failure fixtures; actual transport timeout tested with an injected adapter.
            result.update(error="TOOL_TIMEOUT" if order_id == "A408" else "TOOL_FAILURE", message="模拟工具暂不可用，请转人工")
        else:
            row = ORDERS.get(order_id)
            if not row or row["channel_id"] != channel:
                # The same result for absent and unauthorized orders avoids disclosing existence.
                result.update(error="NOT_FOUND_OR_FORBIDDEN", message="未找到本渠道可访问的订单，请核对或转人工")
            elif tool == "query_order":
                result.update(ok=True, order_id=order_id, **{k: v for k,v in row.items() if k != "channel_id"})
            else:
                nodes = [{"node": "申请提交", "status": "完成", "elapsed_seconds": 3},
                         {"node": row["step"], "status": row["status"], "action": row["required"]}]
                result.update(ok=True, order_id=order_id, nodes=nodes, updated_at=row["updated_at"])
        with self.connect() as db:
            db.execute("INSERT INTO audit VALUES (?,?,?,?,?,?,?)", (
                result["audit_id"], time.time(), channel, tool, order_id,
                json.dumps(result, ensure_ascii=False), int((time.monotonic()-start)*1000)))
        return result

    def record_live(self, channel, tool, args, ok, text, error, duration_ms, *, truncated=False):
        """Audit one live upstream call. order_id holds the canonical arguments so the worker can match the model's call."""
        from .tools import canonical
        audit_id = "audit_"+uuid.uuid4().hex
        result = {"audit_id": audit_id, "live": True, "ok": bool(ok), "result": text}
        if truncated:
            result["truncated"] = True
        if error:
            result["error"] = error
            result["message"] = error
        with self.connect() as db:
            db.execute("INSERT INTO audit VALUES (?,?,?,?,?,?,?)", (
                audit_id, time.time(), channel, tool, canonical(args) if isinstance(args, dict) else "<invalid>",
                json.dumps(result, ensure_ascii=False), int(duration_ms)))
        return audit_id

    def get(self, audit_id, channel):
        with self.connect() as db:
            row = db.execute("SELECT * FROM audit WHERE id=? AND channel=?", (audit_id, channel)).fetchone()
        if not row:
            return None
        data = dict(row)
        data["result"] = json.loads(data["result"])
        return data
