"""Live tool allowlist for the channel gateway.

Hermes only sees the names below (as mcp__biz__<name>). Each one maps to exactly one
upstream tool with a fixed argument contract; anything else is refused before any
upstream call. ai-tool's generic execute_tool proxy is never exposed: the gateway
calls it with a fixed sub-tool name and a fixed environment.
"""
import json
import re

SERVICE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,99}")
SYMBOL = re.compile(r"[A-Za-z_$][A-Za-z0-9_$.#()]{0,199}")
ORDER_NO = re.compile(r"[A-Za-z0-9_-]{6,64}")
SLUG = re.compile(r"[A-Za-z0-9_-]{1,100}")
QUERY_TIME = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")


def text(max_len):
    return ("text", max_len)


# arg spec: (kind, constraint, required)
TOOLS = {
    # phgraph: read-only code graph on this host
    "code_list_services": {"upstream": "phgraph", "tool": "list_services", "kind": "code",
                           "description": "列出已建代码图谱的服务名（其他代码工具的 service 参数只能取这里的名字）。", "args": {}},
    "code_list_domains": {"upstream": "phgraph", "tool": "list_domains", "kind": "code",
                          "description": "列出某服务的中文业务域。", "args": {"service": ("re", SERVICE, True)}},
    "code_domain_nodes": {"upstream": "phgraph", "tool": "domain_nodes", "kind": "code",
                          "description": "按中文业务词查某服务的相关代码入口。",
                          "args": {"service": ("re", SERVICE, True), "domain": (*text(50), True),
                                   "exclusive": ("bool", None, False), "direct": ("bool", None, False),
                                   "top": ("int", (1, 50), False)}},
    "code_find_nodes": {"upstream": "phgraph", "tool": "find_nodes", "kind": "code",
                        "description": "按英文类名/方法名子串查代码节点。",
                        "args": {"service": ("re", SERVICE, True), "keyword": ("re", SYMBOL, True)}},
    "code_entrypoints": {"upstream": "phgraph", "tool": "entrypoints", "kind": "code",
                         "description": "某服务按调用量排序的对外接口与 MQ 入口。", "args": {"service": ("re", SERVICE, True)}},
    "code_graph_path": {"upstream": "phgraph", "tool": "graph_path", "kind": "code",
                        "description": "两个英文符号之间的调用链。",
                        "args": {"service": ("re", SERVICE, True), "source": ("re", SYMBOL, True),
                                 "target": ("re", SYMBOL, True), "maxhop": ("int", (1, 20), False)}},
    "code_affected": {"upstream": "phgraph", "tool": "affected", "kind": "code",
                      "description": "改某个类/方法会波及哪些对外接口。",
                      "args": {"service": ("re", SERVICE, True), "node": ("re", SYMBOL, True),
                               "depth": ("int", (0, 20), False), "top": ("int", (1, 50), False)}},
    "code_mqflow": {"upstream": "phgraph", "tool": "mqflow", "kind": "code",
                    "description": "某服务的 MQ 生产/消费链路。", "args": {"service": ("re", SERVICE, True)}},
    # yuque: search/read only; create_doc, update_doc, get_toc, upload_yuque_to_metis are not exposed
    "doc_search": {"upstream": "yuque", "tool": "search_doc", "kind": "doc",
                   "description": "搜索语雀文档。", "args": {"q": (*text(100), True)}},
    "doc_get": {"upstream": "yuque", "tool": "get_doc", "kind": "doc",
                "description": "读取一篇语雀文档。",
                "args": {"group_login": ("re", SLUG, True), "book_slug": ("re", SLUG, True), "id": ("re", SLUG, True)}},
    # ai-tool (pro gateway) via execute_tool with a fixed sub-tool name; env forced to pro
    "order_journey": {"upstream": "aitool", "tool": "query_journey", "kind": "order",
                      "description": "按行程单号查询行程详情。",
                      "args": {"orderNo": ("re", ORDER_NO, True), "bizCode": ("enum", {"TAXI", "HITCH"}, False)}},
    "order_by_jp": {"upstream": "aitool", "tool": "query_order_jpnum", "kind": "order",
                    "description": "按 JP 单号查询订单综合信息。", "args": {"jpOrderNo": ("re", ORDER_NO, True)}},
    "order_trace": {"upstream": "aitool", "tool": "trace_grab", "kind": "trace",
                    "description": "按订单号抓取请求链路。",
                    "args": {"orderId": ("re", ORDER_NO, True), "queryTime": ("re", QUERY_TIME, False)},
                    "fixed": {"env": "pro"}},
}


class ToolRefused(ValueError):
    pass


def validate(name, args):
    """Return the exact upstream arguments, or raise ToolRefused. Never passes unknown keys."""
    spec = TOOLS.get(name)
    if not spec:
        raise ToolRefused("未开放的工具")
    if not isinstance(args, dict):
        raise ToolRefused("参数必须是对象")
    allowed = spec["args"]
    extra = set(args) - set(allowed)
    if extra:
        raise ToolRefused("包含未允许的参数：" + ",".join(sorted(extra)))
    out = {}
    for key, (kind, rule, required) in allowed.items():
        if key not in args or args[key] is None:
            if required:
                raise ToolRefused("缺少参数：" + key)
            continue
        value = args[key]
        if kind == "re":
            if not isinstance(value, str) or not rule.fullmatch(value):
                raise ToolRefused("参数格式不正确：" + key)
        elif kind == "text":
            if not isinstance(value, str) or not value.strip() or len(value) > rule or any(ord(c) < 32 for c in value):
                raise ToolRefused("参数格式不正确：" + key)
            value = value.strip()
        elif kind == "bool":
            if not isinstance(value, bool):
                raise ToolRefused("参数必须是布尔值：" + key)
        elif kind == "int":
            if isinstance(value, bool) or not isinstance(value, int) or not rule[0] <= value <= rule[1]:
                raise ToolRefused("参数超出范围：" + key)
        elif kind == "enum":
            if not isinstance(value, str) or value not in rule:
                raise ToolRefused("参数取值不允许：" + key)
        if key == "service" and any(part in ("", ".", "..") for part in value.split("/")):
            raise ToolRefused("服务名不能包含路径跳转：" + key)
        out[key] = value
    out.update(spec.get("fixed", {}))
    return out


def canonical(args):
    return json.dumps(args, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def enabled(cfg):
    """Sorted live tool names, or None in mock mode."""
    if cfg.get("tool_mode", "mock") == "mock":
        return None
    names = cfg.get("enabled_tools")
    if cfg.get("tool_mode") != "live" or not isinstance(names, list) or not names \
            or not all(isinstance(n, str) for n in names) or len(set(names)) != len(names) or set(names) - set(TOOLS):
        raise ValueError("tool_mode / enabled_tools 配置无效")
    return sorted(names)


def document_books(cfg):
    """Validate scope before set conversion; only the exact list ["*"] opts into all books."""
    books = cfg.get("doc_books", [])
    if books is None:
        books = []
    if not isinstance(books, list) or not all(isinstance(b, str) for b in books):
        raise ValueError("doc_books must be a list of group_login/book_slug, or exactly ['*']")
    if books == ["*"]:
        return {"*"}
    for book in books:
        parts = book.split("/")
        if len(parts) != 2 or not all(SLUG.fullmatch(part) for part in parts):
            raise ValueError("doc_books entries must be group_login/book_slug, or exactly ['*']")
    return set(books)


def input_schema(name):
    props, required = {}, []
    for key, (kind, rule, needed) in TOOLS[name]["args"].items():
        if kind == "text":
            schema = {"type": "string", "maxLength": rule}
        elif kind == "re":
            schema = {"type": "string", "pattern": "^(?:" + rule.pattern + ")$"}
        elif kind == "bool":
            schema = {"type": "boolean"}
        elif kind == "int":
            schema = {"type": "integer", "minimum": rule[0], "maximum": rule[1]}
        else:
            schema = {"type": "string", "enum": sorted(rule)}
        props[key] = schema
        if needed:
            required.append(key)
    return {"type": "object", "properties": props, "required": required, "additionalProperties": False}
