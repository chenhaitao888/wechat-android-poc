"""Narrow order-answer contract: select audited records, render only their fields.

The model chooses tools/record references, not free-form business assertions.
This is for the current single-order mock workflow, not general knowledge Q&A.
"""
import json
import re

SCHEMA = "order_facts.v1"
ORDER = re.compile(r"(?<![A-Za-z0-9])[A-Z][0-9]{3,8}(?![A-Za-z0-9])", re.I)
KEYS = {"schema", "order_id", "order_audit_id", "trace_audit_id"}


def unique_pairs(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON key")
        obj[key] = value
    return obj


def parse_selection(output):
    try:
        if not isinstance(output, str) or len(output) > 2000:
            raise ValueError()
        data = json.loads(output, object_pairs_hook=unique_pairs)
        if not isinstance(data, dict):
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise RuntimeError("智能体未返回可核验的订单依据，转人工") from exc
    if set(data) == {"schema", "reason"} and data.get("schema") == "needs_human.v1" and isinstance(data.get("reason"),str):
        reasons = {"missing_order_id":"缺少订单号", "multiple_orders":"本轮仅支持单个订单",
                   "tool_failed":"业务查询失败或无权限", "unsupported_question":"问题超出当前订单查询范围"}
        raise RuntimeError(reasons.get(data.get("reason"), "无法核实业务依据")+"，转人工")
    if set(data) != KEYS or data.get("schema") != SCHEMA or not all(isinstance(v,str) for v in data.values()):
        raise RuntimeError("智能体返回了未允许的说明或字段，转人工")
    if not re.fullmatch(r"[A-Z][0-9]{3,8}", data["order_id"]):
        raise RuntimeError("依据中的订单号无效")
    for key in ("order_audit_id", "trace_audit_id"):
        if not re.fullmatch(r"audit_[0-9a-f]{32}", data[key]):
            raise RuntimeError("业务依据编号无效")
    return data


def text_field(value, label):
    if not isinstance(value,str) or not value.strip() or len(value)>100 or any(ord(c)<32 for c in value):
        raise RuntimeError("业务字段缺失或格式不适合回群："+label)
    return value


def render(output, evidence, question):
    selected = parse_selection(output)
    requested = {m.upper() for m in ORDER.findall(question)}
    if requested != {selected["order_id"]}:
        raise RuntimeError("问题不是同一单个订单，转人工核对")
    records = {}
    for audit in evidence:
        if audit.get("order_id") != selected["order_id"] or audit.get("result",{}).get("ok") is not True:
            raise RuntimeError("业务依据包含其他订单或失败结果")
        if audit["id"] in records and records[audit["id"]] != audit:
            raise RuntimeError("业务依据编号重复或冲突")
        records[audit["id"]] = audit
    order = records.get(selected["order_audit_id"])
    trace = records.get(selected["trace_audit_id"])
    if not order or order.get("tool") != "query_order" or not trace or trace.get("tool") != "query_trace":
        raise RuntimeError("缺少本次已核验的订单或流程依据")
    current, flow = order["result"], trace["result"]
    if any(r.get("order_id") != selected["order_id"] or r.get("mock") is not True for r in (current,flow)):
        raise RuntimeError("业务依据与本轮模拟订单范围不符")
    status = text_field(current.get("status"), "状态")
    step = text_field(current.get("step"), "环节")
    required = text_field(current.get("required"), "补充资料")
    updated = text_field(current.get("updated_at"), "更新时间")
    if flow.get("updated_at") != updated:
        raise RuntimeError("订单与流程快照时间不一致，需重新核查")
    nodes = flow.get("nodes")
    if not isinstance(nodes,list) or not 1 <= len(nodes) <= 8 or not all(isinstance(n,dict) for n in nodes):
        raise RuntimeError("流程节点缺失或过长")
    node_texts = [text_field(n.get("node"), "节点")+"（"+text_field(n.get("status"), "节点状态")+"）" for n in nodes]
    last = nodes[-1]
    if last["node"] != step or last["status"] != status or last.get("action") != required:
        raise RuntimeError("订单状态、补件要求与流程末节点不一致，转人工")
    draft = (f"（模拟数据）订单 {selected['order_id']}\n当前状态：{status}\n当前环节：{step}"
             f"\n资料要求：{required}\n流程记录：{' → '.join(node_texts)}"
             f"\n记录时间：{updated}\n具体原因与处理时限：本轮未核实，请人工确认。")
    if len(draft) > 500:
        raise RuntimeError("核验后的答案超过回群长度限制")
    proof = {"schema":SCHEMA, "order_id":selected["order_id"],
             "order_audit_id":order["id"], "trace_audit_id":trace["id"],
             "fields":["query_order.status", "query_order.step", "query_order.required",
                       "query_order.updated_at", "query_trace.nodes[].node", "query_trace.nodes[].status"],
             "unverified":["具体原因", "处理时限"]}
    return draft, proof


LIVE_SCHEMA = "answer_draft.v1"
AUDIT = re.compile(r"audit_[0-9a-f]{32}")
# Askers may be external channel staff: internal identifiers or personal data in a draft send it to a human.
LEAKS = [
    (re.compile(r"https?://", re.I), "链接"),
    (re.compile(r"</?[A-Za-z][^>]{0,40}>"), "HTML标记"),
    (re.compile(r"(?<![\w/])[A-Za-z][\w-]*(?:/[\w.-]+){2,}"), "路径"),
    (re.compile(r"\.(?:java|kt|py|js|ts|xml|yml|yaml|sql)\b", re.I), "源文件"),
    (re.compile(r"\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+){2,}\b|\b(?:[A-Z][a-z0-9]+){3,}\b"), "类名或方法名"),
    (re.compile(r"\b[A-Za-z_]\w*(?:\.\w+)+\("), "代码调用"),
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "手机号"),
    (re.compile(r"\b(?=[0-9a-f]*[a-f])[0-9a-f]{16,}\b", re.I), "内部编号"),
    (re.compile(r"\b(?:App|Service)[A-Z]\w+"), "服务名"),
]


def parse_live(output):
    try:
        if not isinstance(output, str) or len(output) > 4000:
            raise ValueError()
        data = json.loads(output, object_pairs_hook=unique_pairs)
        if not isinstance(data, dict):
            raise ValueError()
    except (ValueError, TypeError) as exc:
        raise RuntimeError("智能体未返回可核验的答案结构，转人工") from exc
    if set(data) == {"schema", "reason"} and data.get("schema") == "needs_human.v1" and isinstance(data.get("reason"), str):
        reasons = {"missing_order_id": "缺少订单号", "multiple_orders": "一次只处理一个订单",
                   "tool_failed": "查询失败或无权限", "unsupported_question": "问题超出当前答疑范围"}
        raise RuntimeError(reasons.get(data["reason"], "无法核实依据")+"，转人工")
    if set(data) != {"schema", "answer", "audit_ids"} or data.get("schema") != LIVE_SCHEMA:
        raise RuntimeError("智能体返回了未允许的字段，转人工")
    answer, ids = data["answer"], data["audit_ids"]
    if not isinstance(answer, str) or not answer.strip() or len(answer) > 400 or any(ord(c) < 32 and c != "\n" for c in answer):
        raise RuntimeError("答案为空、过长或含控制字符，转人工")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 10 or not all(isinstance(i, str) and AUDIT.fullmatch(i) for i in ids) \
            or len(set(ids)) != len(ids):
        raise RuntimeError("答案未引用有效的工具依据，转人工")
    return {"answer": answer.strip(), "audit_ids": ids}


def leaks(text):
    return sorted({label for pattern, label in LEAKS if pattern.search(text)})


def render_live(output, evidence):
    selected = parse_live(output)
    records = {e["id"]: e for e in evidence}
    cited = [records.get(i) for i in selected["audit_ids"]]
    if not all(cited):
        raise RuntimeError("答案引用了不属于本轮的依据编号，转人工")
    if not all(c["result"].get("ok") is True and c["result"].get("live") is True for c in cited):
        raise RuntimeError("答案引用了失败或非实时的工具结果，转人工")
    found = leaks(selected["answer"])
    if found:
        raise RuntimeError("答案含内部或个人信息（"+"、".join(found)+"），转人工")
    draft = selected["answer"]
    if len(draft) > 500:
        raise RuntimeError("答案超过回群长度限制")
    proof = {"schema": LIVE_SCHEMA, "audit_ids": selected["audit_ids"],
             "tools": sorted({c["tool"] for c in cited}), "checked": ["依据属于本轮且成功", "通过已配置的敏感格式检查"],
             "unverified": ["答案事实、措辞及是否含敏感信息，仍需审核人核对"]}
    return draft, proof
