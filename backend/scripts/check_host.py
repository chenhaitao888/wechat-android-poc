"""Read-only host inventory. No credentials, upgrades or service changes."""
import json
import platform
import shutil
import socket
import subprocess
from pathlib import Path


def main():
    result={"platform":platform.platform(),"python":platform.python_version(),"commands":{},"loopback_ports":{}}
    release=Path('/etc/os-release')
    if release.exists():
        for line in release.read_text().splitlines():
            if line.startswith('PRETTY_NAME='):result['os']=line.split('=',1)[1].strip('"')
    for name,args in [('hermes',['--version']),('uv',['--version'])]:
        executable=shutil.which(name)
        if executable:
            try:
                run=subprocess.run([executable,*args],capture_output=True,text=True,timeout=20)
                result['commands'][name]={"available":True,"exit_code":run.returncode,"version":run.stdout.strip()[:300]}
            except subprocess.TimeoutExpired:result['commands'][name]={"available":True,"error":"version_check_timeout"}
        else:result['commands'][name]={"available":False}
    for port in (8643,8650,8660):
        with socket.socket() as sock:
            sock.settimeout(.5)
            result['loopback_ports'][str(port)]=sock.connect_ex(('127.0.0.1',port))==0
    result['note']='An open port is not proof of an authenticated Hermes API; inspect its configuration separately.'
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
