import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager


class Problem(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, device TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 message TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
 run_id TEXT, request_body TEXT, submitted REAL, draft TEXT, version INTEGER NOT NULL DEFAULT 1,
 error TEXT, usage TEXT, upstream_status TEXT, UNIQUE(device,event_id));
CREATE TABLE IF NOT EXISTS events (
 task_id TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
 PRIMARY KEY(task_id,fingerprint));
CREATE TABLE IF NOT EXISTS reviews (
 task_id TEXT PRIMARY KEY, decision TEXT NOT NULL, reviewer TEXT NOT NULL,
 text TEXT NOT NULL, version INTEGER NOT NULL, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, device TEXT NOT NULL, group_ref TEXT NOT NULL,
 text TEXT NOT NULL, reply_version INTEGER NOT NULL, status TEXT NOT NULL,
 created REAL NOT NULL, expires REAL NOT NULL, lease TEXT, lease_until REAL,
 attempt_id TEXT, evidence TEXT);
""")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            yield db

    def receive(self, device, message):
        fingerprint = hashlib.sha256(encoded(message).encode()).hexdigest()
        with self.transaction() as db:
            old = db.execute("SELECT * FROM tasks WHERE device=? AND event_id=?", (device,message["event_id"])).fetchone()
            if old:
                if old["fingerprint"] != fingerprint:
                    raise Problem(409, "相同 event_id 的正文不一致")
                return dict(old), False
            task_id = "task_"+uuid.uuid4().hex
            now = time.time()
            db.execute("INSERT INTO tasks (id,device,event_id,fingerprint,message,status,created,updated) VALUES (?,?,?,?,?,?,?,?)",
                       (task_id,device,message["event_id"],fingerprint,encoded(message),"queued",now,now))
            row = dict(db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
        return row, True

    def get(self, task_id):
        with self.connect() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise Problem(404, "任务不存在")
        return dict(row)

    def tasks(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM tasks ORDER BY created DESC LIMIT 100")]

    def next_task(self):
        with self.connect() as db:
            row = db.execute("SELECT * FROM tasks WHERE status IN ('queued','submitting','running','cancel_requested') ORDER BY created LIMIT 1").fetchone()
        return dict(row) if row else None

    def update(self, task_id, **fields):
        allowed = {"status", "run_id", "request_body", "submitted", "draft", "error", "usage", "upstream_status"}
        if not fields or not set(fields) <= allowed:
            raise ValueError("Invalid update")
        fields["updated"] = time.time()
        with self.transaction() as db:
            db.execute("UPDATE tasks SET "+",".join(k+"=?" for k in fields)+" WHERE id=?", (*fields.values(),task_id))

    def event(self, task_id, data):
        value = encoded(data)
        fingerprint = hashlib.sha256(value.encode()).hexdigest()
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?)", (task_id,fingerprint,value))

    def events(self, task_id):
        with self.connect() as db:
            return [json.loads(r[0]) for r in db.execute("SELECT data FROM events WHERE task_id=? ORDER BY rowid", (task_id,))]

    def review(self, task_id, decision, text, version, reviewer, group_ref):
        if decision not in {"approve", "reject"}:
            raise Problem(400, "审核决定无效")
        if decision == "approve" and (not isinstance(text,str) or not 1 <= len(text.strip()) <= 500):
            raise Problem(400, "待发答案需为1至500字")
        text = text.strip() if decision == "approve" else ""
        with self.transaction() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                raise Problem(404, "任务不存在")
            old = db.execute("SELECT * FROM reviews WHERE task_id=?", (task_id,)).fetchone()
            if old:
                if (old["decision"],old["text"],old["version"]) != (decision,text,version):
                    raise Problem(409, "此任务已审核；已有版本不可覆盖")
                out = db.execute("SELECT * FROM outbox WHERE task_id=?", (task_id,)).fetchone()
                return dict(out) if out else None
            if row["status"] != "draft_ready" or row["version"] != version:
                raise Problem(409, "任务不是当前可审核草稿")
            if time.time()-row["created"] > 1800:
                raise Problem(409, "草稿已过期，请重新核查后创建新任务")
            now = time.time()
            db.execute("INSERT INTO reviews VALUES (?,?,?,?,?,?)", (task_id,decision,reviewer,text,version,now))
            status = "rejected" if decision == "reject" else "approved" if text == row["draft"] else "edited"
            db.execute("UPDATE tasks SET status=?,updated=? WHERE id=?", (status,now,task_id))
            if decision == "reject":
                return None
            out_id = "out_"+uuid.uuid4().hex
            db.execute("INSERT INTO outbox (id,task_id,device,group_ref,text,reply_version,status,created,expires) VALUES (?,?,?,?,?,?,?,?,?)",
                       (out_id,task_id,row["device"],group_ref,text,version,"pending",now,now+1800))
            return dict(db.execute("SELECT * FROM outbox WHERE id=?", (out_id,)).fetchone())

    def outbox(self, device=None):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM outbox"+(" WHERE device=?" if device else "")+" ORDER BY created DESC LIMIT 100", (device,) if device else ())
            # GET never changes delivery state or exposes lease credentials.
            return [{k:v for k,v in dict(r).items() if k != "lease"} for r in rows]

    def delivery(self, out_id, device, action, data, now=None):
        now = time.time() if now is None else now
        with self.transaction() as db:
            row = db.execute("SELECT * FROM outbox WHERE id=? AND device=?", (out_id,device)).fetchone()
            if not row:
                raise Problem(404, "发件项不存在")
            row = dict(row)
            if action == "claim":
                if now >= row["expires"]:
                    raise Problem(409, "发件项已过期")
                if row["status"] == "claimed" and now < row["lease_until"]:
                    raise Problem(409, "已被领取")
                if row["status"] not in {"pending", "claimed"}:
                    raise Problem(409, "此发送状态不允许重新领取")
                lease = secrets.token_urlsafe(32)
                db.execute("UPDATE outbox SET status='claimed',lease=?,lease_until=? WHERE id=?", (lease,now+60,out_id))
            else:
                if not isinstance(data.get("lease_token"),str) or not secrets.compare_digest(data["lease_token"],row["lease"] or ""):
                    raise Problem(403, "领取凭证无效")
                attempt = data.get("attempt_id")
                if not isinstance(attempt,str) or not 1 <= len(attempt) <= 100:
                    raise Problem(400, "缺少发送尝试编号")
                if action == "sending":
                    if row["status"] == "sending" and row["attempt_id"] == attempt:
                        return row
                    if row["status"] != "claimed" or now >= min(row["lease_until"],row["expires"]):
                        raise Problem(409, "领取已过期或状态不允许发送")
                    db.execute("UPDATE outbox SET status='sending',attempt_id=? WHERE id=?", (attempt,out_id))
                elif action == "ack":
                    outcome = data.get("outcome")
                    if outcome not in {"outgoing_observed", "not_sent", "send_uncertain"}:
                        raise Problem(400, "发送结果无效")
                    evidence = data.get("evidence")
                    if not isinstance(evidence,str) or not 1 <= len(evidence) <= 1000:
                        raise Problem(400, "需提供本次发送的观察记录")
                    if row["attempt_id"] != attempt:
                        raise Problem(409, "发送尝试编号不一致")
                    if row["status"] == outcome:
                        if row["evidence"] != evidence:
                            raise Problem(409, "重复回报的证据不一致")
                        return row
                    if row["status"] != "sending":
                        raise Problem(409, "不可覆盖已确认的发送结果")
                    db.execute("UPDATE outbox SET status=?,evidence=? WHERE id=?", (outcome,evidence,out_id))
                else:
                    raise Problem(404, "未知操作")
            return dict(db.execute("SELECT * FROM outbox WHERE id=?", (out_id,)).fetchone())
