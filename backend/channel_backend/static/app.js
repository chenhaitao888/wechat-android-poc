"use strict";
const $=id=>document.getElementById(id);
let key=sessionStorage.getItem("review-key")||"";
const hash=new URLSearchParams(location.hash.slice(1));
if(hash.has("key")){key=hash.get("key");history.replaceState(null,"",location.pathname);sessionStorage.setItem("review-key",key);}
const edits=new Map();
const labels={queued:"等待生成",submitting:"正在提交",running:"生成中",cancel_requested:"正在停止",draft_ready:"等待审核",approved:"已通过",edited:"修改后通过",rejected:"已驳回",needs_human:"需要人工处理",pending:"等待领取",claimed:"已领取",sending:"发送中",outgoing_observed:"已观察到发出",not_sent:"确认未发送",send_uncertain:"发送结果待核查"};
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
async function api(path,body){const r=await fetch(path,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+key,...(body?{"Content-Type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error||"请求失败");return data;}
function error(e){$("error").textContent=e.message;}
async function refresh(){try{const data=await api("/api/review/tasks");$("login").hidden=true;$("workspace").hidden=false;$("error").textContent="";$("worker").textContent="服务："+data.worker;
if(document.activeElement?.classList.contains("answer"))return;
$("tasks").replaceChildren();if(!data.tasks.length)$("tasks").append(el("p","还没有问题，可先提交上面的模拟问题。","empty"));
for(const t of data.tasks){const card=el("article");card.append(el("span",labels[t.status]||t.status,"badge"),el("p",t.message.group_name+" · "+new Date(t.created*1000).toLocaleString(),"meta"),el("p",t.message.content,"question"),el("p",t.id,"meta"));
if(t.error)card.append(el("p",t.error,"failure"));
if(t.evidence.length){const details=el("details");details.append(el("summary","查看业务依据（"+t.evidence.length+" 项）"));for(const e of t.evidence){details.append(el("h3",e.tool+" / "+e.order_id),el("pre",JSON.stringify(e.result,null,2)),el("p",e.id+" · "+e.tool_call_id,"meta"));}card.append(details);}
if(t.draft){if(t.status==="draft_ready"){const answer=el("textarea");answer.className="answer";answer.value=edits.get(t.id)??t.draft;answer.maxLength=500;answer.oninput=()=>edits.set(t.id,answer.value);const buttons=el("div",undefined,"buttons");for(const [decision,label]of[["approve","通过并加入发件箱"],["reject","驳回"]]){const btn=el("button",label,decision==="reject"?"secondary":"");btn.onclick=async()=>{btn.disabled=true;try{await api("/api/review/"+t.id,{decision,text:answer.value,version:t.version});edits.delete(t.id);$("notice").textContent=decision==="approve"?"已保存审核版本，进入模拟发件箱；未发送微信。":"已驳回，不会进入发件箱。";await refresh();}catch(e){error(e);}finally{btn.disabled=false;}};buttons.append(btn);}card.append(answer,buttons);}else card.append(el("pre",t.draft));}$("tasks").append(card);}
$("outbox").replaceChildren();for(const out of data.outbox){const d=el("article");d.append(el("span",labels[out.status]||out.status,"badge"),el("p",out.id,"meta"),el("pre",out.text));$("outbox").append(d);}if(!data.outbox.length)$("outbox").append(el("p","暂无已审核答案。"));
}catch(e){error(e);}}
$("connect").onclick=()=>{key=$("key").value.trim();sessionStorage.setItem("review-key",key);refresh();};
$("refresh").onclick=refresh;
$("logout").onclick=()=>{key="";sessionStorage.removeItem("review-key");location.reload();};
$("submit").onsubmit=async event=>{event.preventDefault();const btn=event.target.querySelector("button");btn.disabled=true;try{await api("/api/demo/messages",{content:$("question").value,event_id:crypto.randomUUID()});$("notice").textContent="问题已保存，正在等待智能体生成草稿。";await refresh();}catch(e){error(e);}finally{btn.disabled=false;}};
if(key)refresh();setInterval(()=>{if(key&&!document.hidden)refresh();},3000);
