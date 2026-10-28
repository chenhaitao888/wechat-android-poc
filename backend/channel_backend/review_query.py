"""Read-only, paginated reviewer queries. Device delivery uses its existing API."""
import json
import math
import time

from .store import Problem


class ReviewQuery:
    def __init__(self, store):
        self.store = store

    def list(self, params):
        allowed = {"view", "category", "source", "group", "q", "since", "page", "page_size", "sort"}
        if set(params) - allowed:
            raise Problem(400, "不支持的筛选条件")
        view = params.get("view", "tasks")
        source = params.get("source", "all")
        category = params.get("category", "all")
        sort = params.get("sort", "newest")
        categories = ("pending", "processing", "reviewed", "attention") if view == "tasks" else ("pending", "sent", "attention")
        if view not in {"tasks", "outbox"} or source not in {"all", "phone", "web-demo"} or sort not in {"newest", "oldest"} or category not in ("all", *categories):
            raise Problem(400, "筛选条件无效")
        try:
            page = int(params.get("page", 1))
            size = int(params.get("page_size", 20))
            since = float(params.get("since", 0))
        except (ValueError, TypeError, OverflowError):
            raise Problem(400, "分页或时间范围无效")
        query = params.get("q", "").strip()
        group = params.get("group", "")
        if not 1 <= page <= 1000000 or size not in {10, 20, 50} or not math.isfinite(since) or since < 0 or len(query) > 200 or len(group) > 1500:
            raise Problem(400, "分页或搜索范围无效")
        now = time.time()
        if view == "tasks":
            base = """SELECT t.id,t.id AS task_id,t.status,t.created,t.message,
                CASE WHEN t.status='draft_ready' AND t.created<=? THEN 'expired' ELSE t.status END AS display_status,
                CASE WHEN t.device='web-demo' THEN 'web-demo' ELSE 'phone' END AS source,
                o.status AS delivery_status,NULL AS text
                FROM tasks t LEFT JOIN outbox o ON o.task_id=t.id"""
            base_params = [now - 1800]
            category_sql = """CASE WHEN display_status='draft_ready' THEN 'pending'
                WHEN display_status IN ('queued','submitting','running','cancel_requested') THEN 'processing'
                WHEN display_status IN ('approved','edited','rejected') THEN 'reviewed' ELSE 'attention' END"""
        else:
            base = """SELECT o.id,o.task_id,o.status,o.created,t.message,
                CASE WHEN o.status IN ('pending','claimed') AND o.expires<=? THEN 'expired' ELSE o.status END AS display_status,
                CASE WHEN o.device='web-demo' THEN 'web-demo' ELSE 'phone' END AS source,
                o.status AS delivery_status,o.text
                FROM outbox o JOIN tasks t ON t.id=o.task_id"""
            base_params = [now]
            category_sql = """CASE WHEN display_status IN ('pending','claimed','sending') THEN 'pending'
                WHEN display_status='outgoing_observed' THEN 'sent' ELSE 'attention' END"""
        where, values = ["created>=?"], [since]
        if source != "all":
            where.append("source=?"); values.append(source)
        if group:
            where.append("json_extract(message,'$.group_ref')=?"); values.append(group)
        if query:
            where.append("instr(lower(id || ' ' || task_id || ' ' || json_extract(message,'$.content') || ' ' || coalesce(json_extract(message,'$.sender_display_name'),'') || ' ' || coalesce(text,'')),lower(?))>0")
            values.append(query)
        cte = "WITH base AS (" + base + "), filtered AS (SELECT *," + category_sql + " AS category FROM base WHERE " + " AND ".join(where) + ") "
        args = base_params + values
        direction = "DESC" if sort == "newest" else "ASC"
        with self.store.connect() as db:
            # Counts and this page share a SQLite snapshot. Reading never expires or claims a record.
            db.execute("BEGIN")
            counts = {name: 0 for name in ("all", *categories)}
            for row in db.execute(cte + "SELECT category,count(*) AS n FROM filtered GROUP BY category", args):
                counts[row["category"]] = row["n"]
                counts["all"] += row["n"]
            total = counts[category]
            pages = max(1, math.ceil(total / size))
            page = min(page, pages)
            clause = " WHERE category=?" if category != "all" else ""
            rows = db.execute(cte + "SELECT * FROM filtered" + clause + f" ORDER BY created {direction},id {direction} LIMIT ? OFFSET ?",
                              [*args, *([category] if category != "all" else []), size, (page - 1) * size]).fetchall()
            groups = [dict(r) for r in db.execute("SELECT DISTINCT json_extract(message,'$.group_ref') AS ref,json_extract(message,'$.group_name') AS name FROM tasks ORDER BY name,ref")]
        items = []
        for row in rows:
            item = dict(row)
            item["message"] = json.loads(item["message"])
            items.append(item)
        return {"items": items, "total": total, "page": page, "page_size": size, "pages": pages,
                "counts": counts, "groups": groups, "server_time": now}

    def delivery_for(self, task_id):
        with self.store.connect() as db:
            row = db.execute("SELECT id,task_id,status,created,expires,text,reply_version,evidence FROM outbox WHERE task_id=?", (task_id,)).fetchone()
        return dict(row) if row else None
