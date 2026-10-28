"""Deploy stopped phone scripts and provision only its device key over authorized USB."""
import argparse
import json
import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from channel_backend.settings import ROOT, LOCAL, load
from channel_backend.network import device_config, validate_device_config

REMOTE = "/sdcard/wechat-android-poc/"
SCRIPTS = ["watch-test-group.js", "phone-panel.js", "open-phone-panel.js", "mention-policy.js",
           "run-recovery.js", "foreground-service.js", "agent-bridge.js", "agent-client.js", "setup-agent.js"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--config-file",type=Path,help="Device-only config exported from the target backend")
    parser.add_argument("--switch-backend",action="store_true",help="Archive old connection; retain its queue; old server tasks do not migrate")
    args = parser.parse_args()
    os.umask(0o077)
    settings=validate_device_config(json.loads(args.config_file.read_text())) if args.config_file else device_config(load())
    LOCAL.mkdir(parents=True,exist_ok=True)

    def adb(*parts, check=True):
        return subprocess.run(["adb", "-s", args.serial, *parts], check=check, capture_output=True, text=True)

    if adb("get-state").stdout.strip() != "device":
        raise SystemExit("Unlock and authorize USB first")
    if adb("shell", "test", "-f", REMOTE+"watch.lock", check=False).returncode == 0:
        raise SystemExit("Watcher lock exists; stop and verify the watcher before deploying")
    if adb("shell", "test", "-f", REMOTE+"STOP", check=False).returncode != 0:
        raise SystemExit("STOP marker required before deployment")
    backup = ROOT.parent / "checkpoints" / ("agent-before-"+datetime.now().strftime("%Y%m%d-%H%M%S"))
    backup.mkdir(parents=True)
    for name in SCRIPTS + ["artifacts/watch-state.json", "artifacts/watch-events.jsonl"]:
        if adb("shell", "test", "-f", REMOTE+name, check=False).returncode == 0:
            adb("pull", REMOTE+name, str(backup/Path(name).name))
    for name in SCRIPTS:
        adb("push", str(ROOT.parent/name), REMOTE+name)
    if settings["baseUrl"]=="http://127.0.0.1:8660":
        adb("reverse", "tcp:8660", "tcp:8660")
    staging = LOCAL / "phone-config.staging.json"
    try:
        staging.write_text(json.dumps({"config":settings,"switchBackend":args.switch_backend},ensure_ascii=False))
        staging.chmod(0o600)
        adb("push", str(staging), REMOTE+"agent-config.staging.json")
        began = time.time()
        adb("shell", "am", "start", "-n", "org.autojs.autoxjs.v7/org.autojs.autojs.external.open.RunIntentActivity",
            "-d", "file://"+REMOTE+"setup-agent.js")
        while time.time()-began < 20:
            response = adb("shell", "cat", REMOTE+"artifacts/agent-setup.json", check=False)
            try:
                result = json.loads(response.stdout)
                if datetime.fromisoformat(result["at"].replace("Z","+00:00")).timestamp() >= began-1:
                    print(json.dumps(result,ensure_ascii=False))
                    if not result["ok"]:
                        raise SystemExit("Phone provisioning check failed; watcher remains stopped")
                    if adb("shell", "test", "-f", REMOTE+"agent-config.staging.json", check=False).returncode == 0:
                        raise SystemExit("Staging credential was not removed; inspect before starting")
                    print("Stopped phone deployed. Only device credential provisioned into app-private storage.")
                    return
            except (ValueError, KeyError):
                pass
            time.sleep(.5)
        raise SystemExit("Phone setup did not finish in 20 seconds; watcher remains stopped")
    finally:
        staging.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
