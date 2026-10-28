"""One-time local setup. Never prints or copies unrelated personal credentials."""
import json
import argparse
import uuid
import os
import secrets
from pathlib import Path

import yaml
from dotenv import dotenv_values
from channel_backend.settings import LOCAL
from channel_backend.network import public_origin


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser()
    parser.add_argument("--public-url")
    parser.add_argument("--key-file",type=Path)
    parser.add_argument("--model",default="deepseek-v4-pro")
    args=parser.parse_args()
    if args.public_url:
        public_origin(args.public_url)
    home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    profile = home / "profiles" / "channel-bot"
    if not profile.is_dir():
        raise SystemExit("First run: hermes profile create channel-bot --no-skills --no-alias")
    LOCAL.mkdir(mode=0o700, exist_ok=True)
    if (LOCAL / "settings.json").exists():
        raise SystemExit("Already configured; refusing to rotate credentials or overwrite profile")
    cfg_file = profile / "config.yaml"
    initial = yaml.safe_load(cfg_file.read_text())
    if set(initial) - {"model", "_config_version"}:
        raise SystemExit("Profile is not fresh; inspect it before setup")
    key = args.key_file.read_text().strip() if args.key_file else dotenv_values(home / ".env").get("DEEPSEEK_API_KEY")
    if not key:
        raise SystemExit("DEEPSEEK_API_KEY not found in default profile .env")
    model = {"provider":"deepseek","default":args.model} if args.key_file else yaml.safe_load((home / "config.yaml").read_text())["model"]
    if model.get("provider") != "deepseek":
        raise SystemExit("Expected the inspected DeepSeek provider; review config before setup")
    cfg = {k: secrets.token_urlsafe(32) for k in ("review_key", "device_key", "biz_key", "hermes_key")}
    cfg.update(hermes_url="http://127.0.0.1:8643", channel_id="demo-channel-a",
               device_id="demo-android", group_ref="test-1", group_name="测试1",
               profile=str(profile), port=8660, mcp_port=8650, run_timeout=180)
    if args.public_url:
        cfg.update(public_url=args.public_url,backend_id="backend_"+uuid.uuid4().hex,
                   device_id="android-"+uuid.uuid4().hex[:12])
    (LOCAL / "reviewer-key.txt").write_text(cfg["review_key"]+"\n")
    (profile / "config.before-channel.yaml").write_text(cfg_file.read_text())
    config = {
        "_config_version": 51, "model": model, "fallback_providers": [],
        "toolsets": ["mcp-biz"], "tools": {"tool_search": {"enabled": "off"}},
        "platform_toolsets": {"api_server": ["mcp-biz"], "cli": ["mcp-biz"]},
        "agent": {"max_turns": 6, "gateway_timeout": 180,
                  "disabled_toolsets": ["memory", "session_search", "terminal", "file", "browser",
                                        "web", "code_execution", "delegation", "cronjob", "skills"]},
        "memory": {"memory_enabled": False, "user_profile_enabled": False, "provider": ""},
        "skills": {"external_dirs": [], "project_discovery": False, "auto_load": []},
        "terminal": {"cwd": str(profile / "workspace")},
        "gateway": {"standalone": True, "api_server": {"max_concurrent_runs": 1}},
        "mcp_servers": {"biz": {
            "url": "http://127.0.0.1:8650/mcp", "timeout": 15, "connect_timeout": 15,
            "headers": {"Authorization": "Bearer ${BIZ_TOOLS_TOKEN}"},
            "tools": {"include": ["query_order", "query_trace"], "resources": False, "prompts": False},
            "sampling": {"enabled": False}, "elicitation": {"enabled": False}, "trust": "untrusted"}},
    }
    cfg_file.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False))
    env = {"DEEPSEEK_API_KEY": key, "API_SERVER_KEY": cfg["hermes_key"],
           "BIZ_TOOLS_TOKEN": cfg["biz_key"], "API_SERVER_HOST": "127.0.0.1", "API_SERVER_PORT": "8643"}
    (profile / ".env").write_text("".join(k+"="+json.dumps(v)+"\n" for k,v in env.items()))
    (profile / "SOUL.md").write_text("你是渠道支持联调助手。只使用模拟业务工具提供的证据，明确标注模拟数据；无法确认时转人工。\n")
    (LOCAL / "settings.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2)+"\n")
    for path in (cfg_file, profile / ".env", LOCAL / "settings.json", LOCAL / "reviewer-key.txt"):
        path.chmod(0o600)
    print("Configured isolated channel-bot. Tokens stored privately, not printed.")


if __name__ == "__main__":
    main()
