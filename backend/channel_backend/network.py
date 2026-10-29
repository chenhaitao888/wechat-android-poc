"""Explicit HTTPS origin for the office pilot; never trust forwarded host names."""
import re
from urllib.parse import urlsplit


BACKEND_ID = re.compile(r"backend_[0-9a-f]{32}\Z")


def public_origin(value):
    if not isinstance(value,str):
        raise ValueError("Public URL must be an HTTPS origin")
    match=re.fullmatch(r"https://([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?",value)
    if not match or len(match[1])>253 or (match[2] and int(match[2])>65535):
        raise ValueError("Public URL must be https://domain with no path, credentials, query or fragment")
    labels=match[1].split('.')
    if len(labels)<2 or not re.search(r"[a-z]",labels[-1]) or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",label) for label in labels):
        raise ValueError("Public URL requires a valid DNS domain")
    return value


def access_policy(cfg):
    hosts={f"127.0.0.1:{cfg['port']}",f"localhost:{cfg['port']}"}
    origins={"http://"+host for host in hosts}
    external=cfg.get("public_url")
    if external:
        external=public_origin(external)
        if not BACKEND_ID.fullmatch(cfg.get("backend_id", "")):
            raise ValueError("Network mode requires a unique backend_id")
        host=urlsplit(external).netloc
        hosts.add(host);origins.add(external)
        # Explicit :443 is equivalent to the browser's canonical HTTPS origin.
        if external.endswith(':443'):
            hosts.add(urlsplit(external).hostname);origins.add(external[:-4])
    return hosts,origins


def connection_info(cfg):
    from .tools import enabled
    tools = "mock" if enabled(cfg) is None else "live"
    return {"mode":tools+("-network" if cfg.get("public_url") else "-local"),"tool_mode":tools,
            "phone_transport":"network-https" if cfg.get("public_url") else "usb-loopback"}


def device_config(cfg):
    if not cfg.get("public_url") and cfg.get("port",8660)!=8660:
        raise ValueError("USB mode requires port 8660")
    result={"version":1,"baseUrl":cfg.get("public_url") or "http://127.0.0.1:8660",
            "deviceKey":cfg["device_key"],"deviceId":cfg["device_id"],
            "groupRef":cfg["group_ref"],"groupName":cfg["group_name"]}
    if cfg.get("backend_id"):result["backendId"]=cfg["backend_id"]
    validate_device_config(result)
    return result


def validate_device_config(config):
    if not isinstance(config,dict) or set(config)-{"version","baseUrl","deviceKey","deviceId","groupRef","groupName","backendId"}:
        raise ValueError("Invalid device configuration fields")
    if config.get("baseUrl")!="http://127.0.0.1:8660":
        public_origin(config.get("baseUrl"))
        if not BACKEND_ID.fullmatch(config.get("backendId","")):raise ValueError("Network backend identity is required")
    if "backendId" in config and not BACKEND_ID.fullmatch(config["backendId"]):raise ValueError("Invalid backend identity")
    if config.get("version")!=1 or not re.fullmatch(r"[A-Za-z0-9_-]{32,200}",config.get("deviceKey","")) or not isinstance(config.get("deviceId"),str) or not config["deviceId"] or config.get("groupRef")!="test-1" or config.get("groupName")!="测试1":
        raise ValueError("Invalid device credential or test group")
    return config
