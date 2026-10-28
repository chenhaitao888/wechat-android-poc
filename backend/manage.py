"""Local lifecycle for the three test services. Run from backend/."""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

from channel_backend.settings import ROOT, LOCAL, load


def identity(pid):
    r=subprocess.run(["ps","-p",str(pid),"-o","lstart=,command="],capture_output=True,text=True)
    return r.stdout.strip() if r.returncode==0 else None


def port_open(port):
    with socket.socket() as s:
        s.settimeout(.25)
        return s.connect_ex(("127.0.0.1",port))==0


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser()
    parser.add_argument("action",choices=["start","stop","status","open"])
    args=parser.parse_args();cfg=load();state_file=LOCAL/"processes.json"
    state=json.loads(state_file.read_text()) if state_file.exists() else {}
    if args.action=="status":
        for name,port in [("mcp",cfg["mcp_port"]),("hermes",8643),("backend",cfg["port"])]:
            print(name,"listening" if port_open(port) else "stopped")
        return
    if args.action=="open":
        if not port_open(cfg["port"]):raise SystemExit("Run manage.py start first")
        # Fragment never reaches HTTP logs; UI immediately removes it and keeps key only in sessionStorage.
        origin=cfg.get("public_url") or f"http://127.0.0.1:{cfg['port']}"
        webbrowser.open(f"{origin}/#key={cfg['review_key']}")
        print("Opened local review page; credential not printed.")
        return
    if args.action=="stop":
        for name in ["backend","hermes","mcp"]:
            item=state.get(name)
            if not item or identity(item["pid"])!=item["identity"]:
                continue
            os.killpg(item["pid"],signal.SIGTERM)
            deadline=time.monotonic()+12
            while identity(item["pid"]) and time.monotonic()<deadline:
                time.sleep(.2)
            if identity(item["pid"]):
                print(name,"still stopping; inspect before restarting")
            else:
                state.pop(name,None);print(name,"stopped")
        state_file.write_text(json.dumps(state,indent=2))
        return
    specs=[("mcp",cfg["mcp_port"],[sys.executable,"-m","channel_backend.mcp_server"],ROOT),
           ("hermes",8643,["hermes","-p","channel-bot","gateway","run"],Path(cfg["profile"])/"workspace"),
           ("backend",cfg["port"],[sys.executable,"-m","channel_backend.server"],ROOT)]
    for name,port,cmd,cwd in specs:
        if port_open(port):
            if name in state and identity(state[name]["pid"])==state[name]["identity"]:
                print(name,"already running");continue
            raise SystemExit(f"Port {port} is occupied outside this manager; inspect it before starting")
        with (LOCAL/(name+".log")).open("ab") as log:
            proc=subprocess.Popen(cmd,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,start_new_session=True)
        time.sleep(.2)
        state[name]={"pid":proc.pid,"identity":identity(proc.pid)}
        state_file.write_text(json.dumps(state,indent=2))
        deadline=time.monotonic()+45
        while not port_open(port) and time.monotonic()<deadline and proc.poll() is None:
            time.sleep(.25)
        if not port_open(port):raise SystemExit(f"{name} did not start; inspect .local/{name}.log; stop with manage.py stop")
        # shell launchers exec: capture identity after the final process owns the listening socket.
        state[name]["identity"]=identity(proc.pid);state_file.write_text(json.dumps(state,indent=2))
        print(name,"started")
    print(f"Review: http://127.0.0.1:{cfg['port']}/ (manage.py open supplies local login)")


if __name__=="__main__":main()
