import json
import hashlib
import os
import subprocess
from pathlib import Path
from channel_backend.settings import load,ROOT,LOCAL
from channel_backend.agent import allowed_tools

cfg=load()
env=os.environ.copy()
env["HERMES_HOME"]=cfg["profile"]
env["CHANNEL_EXPECTED_TOOLS"]=json.dumps(sorted(allowed_tools(cfg)))
# Official launcher resolves the PM-managed Python/dependency generation; no raw pip/uv changes.
cmd=json.loads(subprocess.check_output(["hermes","--print-runtime-command","--module","contextlib"],env=env,text=True))
cmd[3] += "; runpy.run_path("+repr(str(ROOT/"scripts/inspect_hermes.py"))+", run_name=\"__main__\")"
result=subprocess.run(cmd,env=env,cwd=Path(cfg["profile"])/"workspace",text=True,capture_output=True)
if result.returncode:
    print(result.stderr[-4000:]); print(result.stdout[-2000:]); raise SystemExit(result.returncode)
lines=result.stdout.strip().splitlines()
report=json.loads(lines[-1])
report["config_sha256"]=hashlib.sha256((Path(cfg["profile"])/"config.yaml").read_bytes()).hexdigest()
(LOCAL/"profile-verification.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False))
