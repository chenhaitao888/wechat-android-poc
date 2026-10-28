"""Switch a dedicated channel profile between mock and live tools, with all channel services stopped.

See deploy/README.md. Credentials stay in LOCAL/upstreams.json (0600).
Never run against a shared interactive Hermes profile.
"""
import argparse
import fcntl
import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import yaml

from channel_backend.settings import LOCAL, load
from channel_backend.tools import TOOLS, enabled
from channel_backend.agent import biz_include

REQUIRED = {"phgraph": {"url", "token"}, "aitool": {"url"}, "yuque": {"command"}}
BOOK = re.compile(r"[A-Za-z0-9_-]{1,100}/[A-Za-z0-9_-]{1,100}")


def write_private(path, content):
    """Replace one complete file; never truncate a working config in place."""
    data = content.encode() if isinstance(content, str) else content
    fd, tmp = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def apply_changes(changes, proof):
    """Back up all replaced files and roll back ordinary write failures; proof stays invalidated."""
    stamp = uuid.uuid4().hex
    before = {p: p.read_bytes() if p.exists() else None for p in changes}
    snapshots = {**before, proof: proof.read_bytes() if proof.exists() else None}
    for path, data in snapshots.items():
        if data is not None:
            write_private(path.with_name(f"{path.stem}.before-live-{stamp}{path.suffix}"), data)
    # Invalidate before the first change, so an interrupted switch cannot use old approval.
    proof.unlink(missing_ok=True)
    try:
        for path, content in changes.items():
            write_private(path, content)
    except BaseException:
        for path, data in before.items():
            if data is None:
                path.unlink(missing_ok=True)
            else:
                write_private(path, data)
        raise
    return stamp


def configure(a):
    cfg = load()
    changes = {}
    if a.mock:
        cfg.update(tool_mode="mock", run_timeout=180)
        for key in ("enabled_tools", "doc_books"):
            cfg.pop(key, None)
        max_turns = 6
    else:
        if not 30 <= a.run_timeout <= 900 or not 1 <= a.max_turns <= 30:
            raise SystemExit("--run-timeout must be 30..900 seconds; --max-turns must be 1..30")
        names = [n.strip() for n in (a.tools or "").split(",") if n.strip()]
        books = [b.strip() for b in a.doc_books.split(",") if b.strip()]
        cfg.update(tool_mode="live", enabled_tools=names, doc_books=books, run_timeout=a.run_timeout)
        names = enabled(cfg)
        if any(not BOOK.fullmatch(b) for b in books):
            raise SystemExit("--doc-books entries must look like group_login/book_slug")
        if any(TOOLS[n]["upstream"] == "yuque" for n in names) and not books:
            raise SystemExit("doc_* tools need --doc-books: askers may be external, never search the whole key scope")
        if not a.upstreams:
            raise SystemExit("--upstreams is required for live mode")
        conf = json.loads(a.upstreams.read_text())
        if not isinstance(conf, dict):
            raise SystemExit("upstreams must be an object")
        for upstream in {TOOLS[n]["upstream"] for n in names}:
            entry = conf.get(upstream)
            if not isinstance(entry, dict) or any(not isinstance(entry.get(k), str) or not entry[k].strip() for k in REQUIRED[upstream]):
                raise SystemExit(f"upstreams.{upstream} missing valid {sorted(REQUIRED[upstream])}")
            if upstream != "yuque":
                url = urlsplit(entry["url"])
                if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
                    raise SystemExit(f"upstreams.{upstream} needs an HTTP(S) URL without userinfo")
            elif (not isinstance(entry.get("args", []), list) or not all(isinstance(v, str) for v in entry.get("args", []))
                  or not isinstance(entry.get("env", {}), dict)
                  or not all(isinstance(k, str) and isinstance(v, str) for k, v in entry.get("env", {}).items())):
                raise SystemExit("upstreams.yuque args/env must contain strings")
        changes[LOCAL / "upstreams.json"] = json.dumps(conf, ensure_ascii=False, indent=2) + "\n"
        max_turns = a.max_turns
    profile_cfg = Path(cfg["profile"]) / "config.yaml"
    pc = yaml.safe_load(profile_cfg.read_text())
    # Validate the full profile shape before replacing any file or credential.
    try:
        pc["mcp_servers"]["biz"]["tools"]["include"] = biz_include(cfg)
        pc["mcp_servers"]["biz"]["timeout"] = 120 if cfg["tool_mode"] == "live" else 15
        pc.setdefault("agent", {})["max_turns"] = max_turns
        pc["agent"]["gateway_timeout"] = cfg["run_timeout"]
    except (KeyError, TypeError, AttributeError) as exc:
        raise SystemExit("Invalid channel profile: initialize a dedicated profile first") from exc
    changes[profile_cfg] = yaml.safe_dump(pc, allow_unicode=True, sort_keys=False)
    changes[LOCAL / "settings.json"] = json.dumps(cfg, ensure_ascii=False, indent=2) + "\n"
    changes[Path(cfg["profile"]) / "SOUL.md"] = (
        "你是渠道支持联调助手。只使用模拟业务工具提供的证据，明确标注模拟数据；无法确认时转人工。\n" if cfg["tool_mode"] == "mock" else
        "你是渠道答疑助手。只依据本轮工具结果回答，不确定时转人工；提问人可能是外部人员，不透露内部系统细节。\n")
    stamp = apply_changes(changes, LOCAL / "profile-verification.json")
    print(json.dumps({"tool_mode": cfg["tool_mode"], "tools": biz_include(cfg), "doc_books": cfg.get("doc_books", []),
                      "backup_suffix": stamp, "next": "restart business+hermes, run scripts.verify_profile, restart backend"},
                     ensure_ascii=False))


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument("--mock", action="store_true")
    p.add_argument("--tools")
    p.add_argument("--upstreams", type=Path)
    p.add_argument("--doc-books", default="")
    p.add_argument("--run-timeout", type=int, default=300)
    p.add_argument("--max-turns", type=int, default=16)
    a = p.parse_args()
    with (LOCAL / "backend.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("Stop the channel backend before switching configuration")
        configure(a)


if __name__ == "__main__":
    main()
