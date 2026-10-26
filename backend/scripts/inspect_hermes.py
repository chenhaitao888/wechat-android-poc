"""Run via Hermes' installation-bound runtime, with this profile as HERMES_HOME."""
import json
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(os.environ["HERMES_HOME"])/".env", override=True)
from hermes_cli.config import load_config
from hermes_cli.tools_config import _get_platform_tools
from tools.mcp_tool_discovery import register_mcp_servers
from model_tools import get_tool_definitions
from tools.skills_tool import find_all_skills

cfg=load_config()
register_mcp_servers(cfg.get("mcp_servers",{}))
sets=sorted(_get_platform_tools(cfg,"api_server"))
names=sorted(t["function"]["name"] for t in get_tool_definitions(enabled_toolsets=sets,quiet_mode=True))
expected=["mcp__biz__query_order","mcp__biz__query_trace"]
assert names==expected,(sets,names)
skills=find_all_skills(skip_disabled=False)
skill_names=sorted(s["name"] for s in skills)
assert skill_names==["hermes-agent"], skill_names
print(json.dumps({"toolsets":sets,"actual_tools":names,"skills":skill_names,"personal_skills":False},ensure_ascii=False))
