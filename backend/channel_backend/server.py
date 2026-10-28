import asyncio
import contextlib
import fcntl
import hmac
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import web

from .agent import Worker, collect_evidence
from .business import Business
from .settings import LOCAL, load
from .store import Problem, Store
from .review_query import ReviewQuery
from .network import access_policy, connection_info


def validate_message(body, cfg):
    required = {"event_id", "group_ref", "group_name", "content", "observed_at"}
    allowed = required | {"sender_display_name", "local_receipt_id"}
    if not isinstance(body,dict) or not required <= set(body) or not set(body) <= allowed:
        raise Problem(400,"消息字段不完整或包含未允许字段")
    if not all(isinstance(v,str) for v in body.values()):
        raise Problem(400,"消息字段必须为文字")
    try:
        uuid.UUID(body["event_id"])
        stamp = datetime.fromisoformat(body["observed_at"].replace("Z","+00:00"))
        if stamp.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise Problem(400,"事件编号或观测时间无效")
    if body["group_ref"] != cfg["group_ref"] or body["group_name"] != cfg["group_name"]:
        raise Problem(403,"凭证不允许访问这个群")
    if not 1 <= len(body["content"].strip()) <= 1000 or any(len(v)>1500 for v in body.values()):
        raise Problem(400,"问题为空或过长")
    return body


def create_app(cfg, store, business, *, start_worker=True):
    worker = Worker(store,business,cfg)
    access_policy(cfg)  # Reject an invalid deployment before serving.

    @web.middleware
    async def boundary(request, handler):
        try:
            allowed_hosts, allowed_origins = access_policy(cfg)
            if request.host not in allowed_hosts:
                raise Problem(403,"此地址未配置为允许访问的域名")
            origin = request.headers.get("Origin")
            if origin and origin not in allowed_origins:
                raise Problem(403,"跨站请求被拒绝")
            if request.host not in {f"127.0.0.1:{cfg['port']}",f"localhost:{cfg['port']}"}:
                # Only the same-host TLS proxy may attest HTTPS; the application binds loopback.
                if not request.secure and not (request.remote in {"127.0.0.1","::1"} and request.headers.getall("X-Forwarded-Proto",[])==["https"]):
                    raise Problem(403,"域名访问必须经过本机 HTTPS 代理")
            response = await handler(request)
        except Problem as exc:
            response = web.json_response({"error":exc.message},status=exc.status)
        except (ValueError,TypeError,KeyError,json.JSONDecodeError):
            response = web.json_response({"error":"请求格式错误"},status=400)
        response.headers.update({"Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
            "Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"})
        return response

    def auth(request, role):
        values = request.headers.getall("Authorization",[])
        if len(values)!=1 or not hmac.compare_digest(values[0],"Bearer "+cfg[role+"_key"]):
            raise Problem(401,"请使用正确的审核或设备凭证")

    async def body(request):
        if request.content_type != "application/json":
            raise Problem(415,"仅接受 JSON")
        data = await request.json()
        if not isinstance(data,dict):
            raise Problem(400,"JSON 必须为对象")
        return data

    async def static(request):
        name = request.match_info.get("name","index.html")
        if name not in {"index.html","app.js","style.css"}:
            raise Problem(404,"页面不存在")
        return web.FileResponse(Path(__file__).parent/"static"/name)

    async def health(request):
        return web.json_response({"status":"running","worker":worker.health,**connection_info(cfg)})

    async def device_info(request):
        auth(request,"device")
        return web.json_response({"backend_id":cfg.get("backend_id"),"device_id":cfg["device_id"],
                                  "group_ref":cfg["group_ref"],"group_name":cfg["group_name"],**connection_info(cfg)})

    async def receive(request):
        auth(request,"device")
        data = validate_message(await body(request),cfg)
        task,created = store.receive(cfg["device_id"],data)
        return web.json_response({"task_id":task["id"],"status":task["status"],"created":created},status=202)

    async def demo(request):
        auth(request,"review")
        data = await body(request)
        event = {"event_id":data.get("event_id",str(uuid.uuid4())),"content":data["content"],
                 "group_ref":cfg["group_ref"],"group_name":cfg["group_name"],
                 "observed_at":data.get("observed_at",datetime.now(timezone.utc).isoformat()),
                 "sender_display_name":"网页模拟提问"}
        task,created = store.receive("web-demo",validate_message(event,cfg))
        return web.json_response({"task_id":task["id"],"created":created},status=202)

    async def tasks(request):
        auth(request,"review")
        rows = []
        for task in store.tasks():
            message = json.loads(task["message"])
            rows.append({k:task[k] for k in ("id","status","created","draft","version","error","run_id","upstream_status","usage")} |
                        {"message":message,"source":"web-demo" if task["device"]=="web-demo" else "phone","evidence":collect_evidence(store,business,cfg,task),
                         "grounding":next((e for e in store.events(task["id"]) if e.get("event")=="draft.grounded"),None)})
        return web.json_response({"tasks":rows,"outbox":store.outbox(),"worker":worker.health,**connection_info(cfg)})

    async def review_list(request):
        auth(request,"review")
        result = ReviewQuery(store).list(request.query)
        return web.json_response({**result,"worker":worker.health,**connection_info(cfg)})

    async def review_detail(request):
        auth(request,"review")
        task = store.get(request.match_info["task_id"])
        now = time.time()
        result = {k:task[k] for k in ("id","status","created","updated","draft","version","error")}
        result.update(message=json.loads(task["message"]), source="web-demo" if task["device"]=="web-demo" else "phone",
                      evidence=collect_evidence(store,business,cfg,task),
                      grounding=next((e for e in store.events(task["id"]) if e.get("event")=="draft.grounded"),None),
                      outbox=ReviewQuery(store).delivery_for(task["id"]), server_time=now,
                      reviewable=task["status"]=="draft_ready" and now-task["created"]<1800)
        return web.json_response(result)

    async def review(request):
        auth(request,"review")
        data = await body(request)
        out = store.review(request.match_info["task_id"],data["decision"],data.get("text",""),
                           data["version"],"local-reviewer",cfg["group_ref"])
        return web.json_response({"outbox_id":out["id"] if out else None})

    async def outbox(request):
        auth(request,"device")
        return web.json_response({"items":store.outbox(cfg["device_id"])})

    async def delivery(request):
        auth(request,"device")
        row = store.delivery(request.match_info["outbox_id"],cfg["device_id"],request.match_info["action"],await body(request))
        row["lease_token"] = row.pop("lease",None)
        return web.json_response(row)

    async def worker_context(app):
        task = asyncio.create_task(worker.run()) if start_worker else None
        yield
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = web.Application(middlewares=[boundary],client_max_size=16384)
    app.cleanup_ctx.append(worker_context)
    app.add_routes([web.get("/",static),web.get("/static/{name}",static),web.get("/health",health),
                    web.get("/api/device-info",device_info),web.post("/api/messages",receive),web.post("/api/demo/messages",demo),
                    web.get("/api/review/tasks",tasks),web.get("/api/review/list",review_list),
                    web.get("/api/review/task/{task_id}",review_detail),web.post("/api/review/{task_id}",review),
                    web.get("/api/outbox",outbox),web.post("/api/outbox/{outbox_id}/{action}",delivery)])
    return app


if __name__ == "__main__":
    os.umask(0o077)
    cfg = load()
    lock = (LOCAL/"backend.lock").open("w")
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Backend already running; single worker required")
    web.run_app(create_app(cfg,Store(LOCAL/"tasks.sqlite3"),Business(LOCAL/"audit.sqlite3")),
                host="127.0.0.1",port=cfg["port"],access_log=None)
