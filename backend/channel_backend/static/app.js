"use strict";
const $ = id => document.getElementById(id);
const paths = {
  inbox:"M4 4h16v16H4z M4 13h5l2 3h2l2-3h5", send:"m3 3 18 9-18 9 4-9-4-9z M7 12h14",
  refresh:"M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 6 M18 17a7 7 0 0 1-12 1l-2-6",
  plus:"M12 5v14 M5 12h14", search:"M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  close:"m6 6 12 12 M6 18 18 6", clock:"M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  check:"m5 12 4 4L19 6", alert:"M12 8v5 M12 17h.01 M12 3 2 21h20L12 3z",
  phone:"M7 2h10v20H7z M10 18h4", browser:"M3 4h18v16H3z M3 9h18 M6 6.5h.01 M9 6.5h.01",
  logout:"M9 4H4v16h5 M10 12h11 M17 8l4 4-4 4", file:"M6 2h8l4 4v16H6z M14 2v5h4 M9 11h6 M9 15h6 M9 18h4",
  book:"M12 5v16 M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 1"
};
function icon(name) {
  const n=document.createElementNS("http://www.w3.org/2000/svg","svg");
  for(const [key,value] of Object.entries({viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"1.6","stroke-linecap":"round","stroke-linejoin":"round",class:"icon","aria-hidden":"true"}))n.setAttribute(key,value);
  const path=document.createElementNS(n.namespaceURI,"path");path.setAttribute("d",paths[name]||paths.file);n.append(path);return n;
}
for(const n of document.querySelectorAll("[data-icon]"))n.append(icon(n.dataset.icon));
function el(tag,text,cls) {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,cls,action) {const b=el("button",text,cls);b.type="button";b.onclick=action;return b;}
const labels={queued:"等待生成",submitting:"正在提交",running:"生成中",cancel_requested:"正在停止",draft_ready:"待审核",approved:"已通过",edited:"修改后通过",rejected:"已驳回",needs_human:"需人工处理",expired:"已过期",pending:"等待领取",claimed:"已领取",sending:"发送中",outgoing_observed:"已观察到发出",not_sent:"确认未发送",send_uncertain:"结果待核查"};
function badge(status) {const color=["approved","edited","outgoing_observed"].includes(status)?"green":["draft_ready","pending","claimed"].includes(status)?"amber":["queued","submitting","running","sending","cancel_requested"].includes(status)?"blue":["needs_human","send_uncertain","not_sent"].includes(status)?"rose":"";return el("span",labels[status]||status,"badge "+color);}
const sourceName=s=>s==="phone"?"手机实收":"网页模拟";
const date=s=>new Date(s*1000).toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).replaceAll("/","-");
const time=s=>new Date(s*1000).toLocaleTimeString("zh-CN",{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"});
const fullDate=s=>date(s)+" "+time(s);
let key=sessionStorage.getItem("review-key")||"";
const hash=new URLSearchParams(location.hash.slice(1));
if(hash.has("key")){key=hash.get("key");history.replaceState(null,"",location.pathname);sessionStorage.setItem("review-key",key);}
const state={view:"tasks",category:"all",page:1,pages:1,size:10,total:0,items:[],counts:{},selected:null,detail:null,detailSignature:"",reviewing:false};
const edits=new Map();
let listController=null,listSequence=0,detailSequence=0,clockOffset=0,searchTimer;
async function api(path,body,signal) {
  const r=await fetch(path,{method:body===undefined?"GET":"POST",headers:{Authorization:"Bearer "+key,...(body===undefined?{}:{"Content-Type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body),signal:signal||AbortSignal.timeout(15000)});
  let data;try{data=await r.json();}catch(_){throw new Error("服务响应异常，请稍后刷新。");}
  if(!r.ok){const e=new Error(data.error||"请求失败，请稍后重试。");e.status=r.status;throw e;}return data;
}
function feedback(id,message){$(id).textContent=message;$(id).hidden=!message;}
function sync(ok){$("sync-state").classList.toggle("offline",!ok);$("sync-state").replaceChildren(el("span",undefined,"status-dot"),document.createTextNode(ok?"自动更新 · 每 5 秒":"连接中断"));}
function handleError(e){const message=e.name==="TimeoutError"?"服务响应超时，请稍后刷新。":e.message||"连接失败，请检查本机服务。";feedback($("workspace").hidden?"login-error":"error",message);sync(false);}
function sinceValue(){const d=new Date();if($("period").value==="all")return 0;if($("period").value==="today")d.setHours(0,0,0,0);else d.setDate(d.getDate()-($("period").value==="week"?7:30));return Math.floor(d.getTime()/1000);}
function parameters(){return new URLSearchParams({view:state.view,category:state.category,page:state.page,page_size:state.size,q:$("search").value.trim(),source:$("source").value,group:$("group").value,since:sinceValue(),sort:$("sort").value});}
async function refresh(silent=false) {
  if(!key||(silent&&listController))return;
  listController?.abort();const controller=new AbortController();listController=controller;const sequence=++listSequence;
  const timeout=setTimeout(()=>controller.abort(new DOMException("请求超时","TimeoutError")),15000);
  if(!silent)$("table-region").setAttribute("aria-busy","true");
  try{
    const data=await api("/api/review/list?"+parameters(),undefined,controller.signal);
    if(sequence!==listSequence)return;
    $("login").hidden=true;$("workspace").hidden=false;feedback("login-error","");feedback("error","");sync(true);
    $("environment-name").textContent=data.phone_transport==="network-https"?"网络联调":"本机联调";$("connection-note").textContent=data.phone_transport==="network-https"?"手机通过办公网络连接":"手机联调需保持 USB 连接";
    clockOffset=data.server_time*1000-Date.now();Object.assign(state,{page:data.page,pages:data.pages,total:data.total,items:data.items,counts:data.counts});
    const groupValue=$("group").value;
    const groupSignature=JSON.stringify(data.groups);
    if($("group").dataset.signature!==groupSignature){$("group").replaceChildren(new Option("全部群聊",""));for(const g of data.groups)$("group").add(new Option(g.name,g.ref));$("group").value=groupValue;$("group").dataset.signature=groupSignature;}
    $("worker").textContent="智能体服务："+data.worker;$("updated-at").textContent="更新于 "+time(data.server_time);
    renderOverview();renderRows();
    if(state.selected&&!state.reviewing)await loadDetail(state.selected,true);
  }catch(e){if(sequence===listSequence&&e.name!=="AbortError")handleError(e);}
  finally{clearTimeout(timeout);if(sequence===listSequence){listController=null;$("table-region").removeAttribute("aria-busy");}}
}
function categories(){return state.view==="tasks"?[["all","全部"],["pending","待审核"],["processing","生成中"],["reviewed","已审核"],["attention","需关注"]]:[["all","全部"],["pending","待发送"],["sent","已观察到发出"],["attention","需关注"]];}
function changeCategory(value){if(state.category===value)return;state.category=value;state.page=1;refresh();}
function renderOverview(){
  const cards=state.view==="tasks"?[["all","全部问题","inbox",""],["pending","待审核","clock","amber"],["processing","生成中","refresh","blue"],["attention","需关注","alert","rose"]]:[["all","全部发件","send",""],["pending","待发送","clock","amber"],["sent","已观察到发出","check","blue"],["attention","需关注","alert","rose"]];
  const signature=JSON.stringify([state.view,state.category,state.counts]);if($("stats").dataset.signature===signature)return;
  $("stats").dataset.signature=signature;$("stats").replaceChildren();$("tabs").replaceChildren();
  for(const [value,label,name,color] of cards){const b=button("","stat"+(state.category===value?" selected":""),()=>changeCategory(value));b.setAttribute("aria-pressed",String(state.category===value));const body=el("div");body.append(el("span",label,"stat-label"),el("span",String(state.counts[value]||0),"stat-value"));const symbol=el("span",undefined,"stat-icon "+color);symbol.append(icon(name));b.append(body,symbol);$("stats").append(b);}
  for(const [value,label] of categories()){const b=button(label,"tab"+(state.category===value?" active":""),()=>changeCategory(value));b.setAttribute("aria-pressed",String(state.category===value));b.append(el("span",String(state.counts[value]||0),"tab-count"));$("tabs").append(b);}
}
function renderRows(){
  const taskView=state.view==="tasks";
  const signature=JSON.stringify([state.view,state.items]);
  if($("rows").dataset.signature!==signature){
    $("rows").dataset.signature=signature;$("rows").replaceChildren();$("table-head").replaceChildren();const head=el("tr");
    for(const [text,cls]of[[taskView?"问题内容":"已审核答案","question-cell"],["所属群聊","group-cell"],["消息来源","source-cell"],[taskView?"审核状态":"发送状态","status-cell"],[taskView?"接收时间":"审核时间","time-cell"],["操作","action-cell"]]){const th=el("th",text,cls);th.scope="col";head.append(th);}$("table-head").append(head);
    for(const item of state.items){
      const row=el("tr");const q=el("td");const title=taskView?item.message.content:item.text;
      const open=button(title,"question-link",()=>openDetail(item.task_id));open.title=title;q.append(open,el("span",taskView?(item.message.sender_display_name||"未提供昵称")+" · "+item.id.slice(-8):item.message.content,"row-meta"));
      const group=el("td");group.append(el("div",item.message.group_name,"group-name"));
      const source=el("td");const origin=el("span",undefined,"source-label "+item.source);origin.append(icon(item.source==="phone"?"phone":"browser"),document.createTextNode(sourceName(item.source)));source.append(origin);
      const status=el("td");status.append(badge(item.display_status));if(item.source==="web-demo"&&!taskView)status.append(el("span","仅模拟，不发送微信","row-meta"));
      const stamp=el("td");stamp.append(el("div",date(item.created),"time-date"),el("div",time(item.created),"time-clock"));
      const action=el("td");const reviewable=taskView&&item.display_status==="draft_ready";action.append(button(reviewable?"审核":"详情 →","row-action"+(reviewable?" review-action":""),()=>openDetail(item.task_id)));
      row.append(q,group,source,status,stamp,action);$("rows").append(row);
    }
  }
  $("empty").hidden=state.items.length>0;$("table-region").hidden=!state.items.length;
  const filtering=$("search").value||$("source").value!=="all"||$("group").value||$("period").value!=="all"||state.category!=="all";
  $("empty-title").textContent=filtering?"暂无匹配记录":taskView?"还没有收到问题":"还没有审核通过的答案";
  $("empty-text").textContent=filtering?"试试其他关键词，或调整筛选条件。":taskView?"群内真正 @ 机器人提问，或点击右上角「模拟提问」。":"审核通过后，答案的发送进度会显示在这里。";
  $("empty-reset").hidden=!filtering;$("range").textContent=state.total?`共 ${state.total} 条 · 当前 ${(state.page-1)*state.size+1}–${Math.min(state.page*state.size,state.total)} 条`:"共 0 条";
  $("page-number").textContent=state.page+" / "+state.pages;$("previous").disabled=state.page<=1;$("next").disabled=state.page>=state.pages;
}
function setView(view){state.view=view;state.category="all";state.page=1;const taskView=view==="tasks";const title=taskView?"答案审核":"发件记录";$("page-title").textContent=title;$("breadcrumb-view").textContent=title;document.title=title+" · 渠道助手";$("page-description").textContent=taskView?"集中处理群内提问，核对依据后再发送回复。":"追踪每一份已审核答案，查看发送进度与观察记录。";$("list-heading").textContent=taskView?"问题列表":"发送列表";$("table-caption").textContent=title+"列表";$("search").placeholder=taskView?"搜索问题、提问人或编号":"搜索答案、原问题或编号";$("search").setAttribute("aria-label",$("search").placeholder);for(const name of ["tasks","outbox"]){$("nav-"+name).classList.toggle("active",name===view);if(name===view)$("nav-"+name).setAttribute("aria-current","page");else $("nav-"+name).removeAttribute("aria-current");}feedback("notice","");refresh();}
function section(title,name,caption){const body=el("section",undefined,"detail-section");const heading=el("div",undefined,"section-heading");const h=el("h3",title);h.prepend(icon(name));heading.append(h);if(caption)heading.append(el("span",caption,"section-caption"));body.append(heading);return body;}
function reviewable(t){return t.status==="draft_ready"&&t.reviewable&&(Date.now()+clockOffset)/1000-t.created<1800;}
function taskStatus(t){return t.status==="draft_ready"&&!reviewable(t)?"expired":t.status;}
function showDetailError(message){let box=$("detail-error");if(!box){box=el("p",undefined,"error-banner");box.id="detail-error";box.setAttribute("role","alert");$("detail-footer").prepend(box);}box.textContent=message;}
async function openDetail(id){state.selected=id;state.detail=null;state.detailSignature="";$("detail-body").replaceChildren(el("p","正在读取问题与业务依据…","muted"));$("detail-footer").replaceChildren();if(!$("detail").open)$("detail").showModal();await loadDetail(id);}
async function loadDetail(id,silent=false){const sequence=++detailSequence;try{const t=await api("/api/review/task/"+encodeURIComponent(id));if(state.selected!==id||sequence!==detailSequence)return;clockOffset=t.server_time*1000-Date.now();state.detail=t;const signature=JSON.stringify([t.status,t.version,t.draft,t.error,t.reviewable,t.outbox]);if(!silent||state.detailSignature!==signature){state.detailSignature=signature;renderDetail(t);}}catch(e){if(state.selected===id&&sequence===detailSequence)showDetailError("详情更新失败："+e.message);}}
function renderEvidence(e){
  const card=el("div",undefined,"evidence-card");const heading=el("div",undefined,"evidence-heading");heading.append(el("span",(e.tool==="query_order"?"订单状态":e.tool==="query_trace"?"流程记录":e.tool)+" · "+e.order_id),el("small",e.result?.mock?"模拟依据":"业务依据"));card.append(heading);
  const r=e.result||{};
  if(!r.ok)card.append(el("p",r.message||"未取得有效业务信息","muted"));
  else if(e.tool==="query_order"){const facts=el("dl",undefined,"facts");for(const [label,value]of[["当前状态",r.status],["当前环节",r.step],["资料要求",r.required],["记录时间",r.updated_at]]){facts.append(el("dt",label),el("dd",value||"未提供"));}card.append(facts);}
  else if(r.live){card.append(el("pre",String(r.result||"").slice(0,1500)+(String(r.result||"").length>1500?"\n…":""),"live-result"));if(r.truncated)card.append(el("p","工具结果已截断；当前记录不是完整结果。","muted"));}
  else if(Array.isArray(r.nodes)){const list=el("ol",undefined,"trace-list");for(const node of r.nodes){const li=el("li",node.node);li.append(el("small",node.status));if(node.action)li.append(el("p",node.action));list.append(li);}card.append(list);}
  const raw=el("details",undefined,"raw-details");raw.append(el("summary","查看原始记录与审计编号"),el("pre",JSON.stringify(r,null,2)),el("p",e.id+" · "+e.tool_call_id,"detail-id"));card.append(raw);return card;
}
function renderDetail(t){
  const body=$("detail-body");body.replaceChildren();$("detail-eyebrow").textContent=sourceName(t.source)+" · "+t.message.group_name;$("detail-title").textContent=reviewable(t)?"核对与审核":"问题详情";
  const status=el("div",undefined,"detail-status-line");status.append(badge(taskStatus(t)),el("span",t.id,"detail-id"));body.append(status);
  const original=section("用户问题","file");original.append(el("p",t.message.content,"original-question"));const meta=el("div",undefined,"detail-meta");for(const value of ["提问人："+(t.message.sender_display_name||"未提供昵称"),"接收于 "+fullDate(t.created)])meta.append(el("span",value));original.append(meta);body.append(original);
  if(t.error){const alert=el("p",t.error,"error-banner");body.append(alert);}
  const answerSection=section(t.outbox?"已审核答案":"回复草稿","send",t.outbox?"审核版本 v"+t.outbox.reply_version:"草稿 v"+t.version);
  if(t.draft){
    if(t.grounding)answerSection.append(el("p",t.grounding.schema==="answer_draft.v1"?"草稿由智能体依据下方本轮工具结果撰写；后台已核对依据归属，并检查部分敏感格式。答案事实和敏感信息仍需你逐条核对。":"草稿按订单与流程记录生成。具体原因和处理时限未核实；手工修改后请重新核对业务依据。","grounding-note"));
    const answer=el("textarea",undefined,"answer"+(reviewable(t)?"":" readonly"));answer.id="review-answer";answer.setAttribute("aria-label",t.outbox?"已审核答案":"回复草稿");answer.readOnly=!reviewable(t);
    const edit=edits.get(t.id);answer.value=edit?.version===t.version&&!t.outbox?edit.text:(t.outbox?.text||t.draft);
    const info=el("div",undefined,"answer-info");const hint=el("span",t.outbox?"已保存的确定版本":edit?"本页已保留修改":"核对后可在此修改答案");const count=el("span");count.id="answer-count";const updateCount=()=>{const n=Array.from(answer.value).length;count.textContent=n+" / 500 字";const approve=$("approve");if(approve)approve.disabled=state.reviewing||!answer.value.trim()||n>500||!reviewable(t);};
    answer.oninput=()=>{edits.set(t.id,{version:t.version,text:answer.value});hint.textContent="本页已保留修改";updateCount();};info.append(hint,count);answerSection.append(answer,info);body.append(answerSection);renderDetailFooter(t);updateCount();
  }else{answerSection.append(el("p",t.status==="needs_human"?"本次未生成可审核答案，请结合业务记录人工处理。":"智能体正在处理问题，生成完成后可在这里审核。","grounding-note"));body.append(answerSection);renderDetailFooter(t);}
  const evidence=section("业务依据","book",t.evidence.length+" 项记录");if(t.evidence.length)for(const e of t.evidence)evidence.append(renderEvidence(e));else evidence.append(el("p","暂无已核验的业务依据。","muted"));body.append(evidence);
  if(t.outbox){const out=t.outbox;const delivery=section("发送记录","send");const box=el("div",undefined,"delivery-box");const expired=["pending","claimed"].includes(out.status)&&out.expires<=(Date.now()+clockOffset)/1000;box.append(badge(expired?"expired":out.status));box.append(el("p",t.source==="web-demo"?"网页模拟任务，不会发送到微信。":out.status==="outgoing_observed"?"机器人已观察到微信中的发送气泡；这不代表接收方已读。":expired?"已超过发送有效期，不再自动发送。":"审核通过后，机器人运行时按发送状态处理。"));if(out.evidence)box.append(el("p",out.evidence));box.append(el("p","审核于 "+fullDate(out.created),"muted"),el("p",out.id,"detail-id"));delivery.append(box);body.append(delivery);}
}
function renderDetailFooter(t){
  const footer=$("detail-footer");footer.replaceChildren();
  if(reviewable(t)){footer.append(el("p",t.source==="phone"?"通过后将加入发件箱，由机器人发送到「"+t.message.group_name+"」。":"此为网页模拟任务，通过后保存模拟版本，不发送微信。","footer-note"));const actions=el("div",undefined,"footer-actions");const reject=button("驳回","danger-button",()=>decide("reject"));reject.id="reject";const approve=button("通过并加入发件箱","primary",()=>decide("approve"));approve.id="approve";reject.disabled=approve.disabled=state.reviewing;actions.append(reject,approve);footer.append(actions);}
  else{footer.append(el("p",taskStatus(t)==="expired"?"草稿已超过 30 分钟有效期，需重新提问并核查依据。":t.status==="rejected"?"此答案已驳回，不会进入发件箱。":t.outbox?"审核版本已保存，不能覆盖。":"当前任务暂无可审核草稿。","footer-note"));const actions=el("div",undefined,"footer-actions");actions.append(button("关闭详情","secondary",()=>$("detail").close()));footer.append(actions);}
}
async function decide(decision){
  const t=state.detail;if(state.reviewing||!t)return;if(!reviewable(t)){renderDetailFooter(t);return;}
  const text=$("review-answer")?.value||"";const version=t.version;state.reviewing=true;$("approve").disabled=true;$("reject").disabled=true;
  try{await api("/api/review/"+encodeURIComponent(t.id),{decision,text,version});edits.delete(t.id);feedback("notice",decision==="reject"?"已驳回，答案不会进入发件箱。":t.source==="phone"?"审核已保存。机器人运行时会将答案发送到「"+t.message.group_name+"」。":"模拟审核已保存，不会发送微信。");state.detailSignature="";await refresh();if(state.selected===t.id)await loadDetail(t.id);}
  catch(e){if(state.selected===t.id){if(e.status===409)await loadDetail(t.id);showDetailError(e.message);}else handleError(e);}
  finally{state.reviewing=false;if(state.selected===t.id&&state.detail){const errorMessage=$("detail-error")?.textContent;renderDetailFooter(state.detail);if(errorMessage)showDetailError(errorMessage);const answer=$("review-answer");if(answer){const approve=$("approve");if(approve)approve.disabled=!answer.value.trim()||Array.from(answer.value).length>500;}}}
}
function resetFilters(){clearTimeout(searchTimer);$("search").value="";$("source").value="all";$("group").value="";$("period").value="all";state.category="all";state.page=1;refresh();}
$("login-form").onsubmit=async e=>{e.preventDefault();key=$("key").value.trim();sessionStorage.setItem("review-key",key);$("connect").disabled=true;try{await refresh();}finally{$("connect").disabled=false;}};
$("logout").onclick=$("logout-mobile").onclick=()=>{key="";sessionStorage.removeItem("review-key");edits.clear();location.reload();};
$("refresh").onclick=()=>refresh();$("nav-tasks").onclick=()=>setView("tasks");$("nav-outbox").onclick=()=>setView("outbox");
$("search").oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.page=1;refresh();},300);};
$("filters").onsubmit=e=>{e.preventDefault();clearTimeout(searchTimer);state.page=1;refresh();};
for(const name of ["source","group","period","sort"])$(name).onchange=()=>{state.page=1;refresh();};
$("page-size").onchange=()=>{state.size=Number($("page-size").value);state.page=1;refresh();};
$("reset").onclick=$("empty-reset").onclick=resetFilters;
$("previous").onclick=()=>{if(state.page>1){state.page--;refresh();}};$("next").onclick=()=>{if(state.page<state.pages){state.page++;refresh();}};
$("close-detail").onclick=()=>$("detail").close();$("detail").addEventListener("close",()=>{state.selected=null;state.detail=null;detailSequence++;});
$("new-demo").onclick=()=>{feedback("demo-error","");$("demo").showModal();$("question").focus();};$("close-demo").onclick=()=>$("demo").close();
$("submit").onsubmit=async e=>{e.preventDefault();if(!$("question").value.trim())return;const btn=$("demo-submit");btn.disabled=true;try{const data=await api("/api/demo/messages",{content:$("question").value.trim(),event_id:crypto.randomUUID()});$("demo").close();$("question").value="";setView("tasks");resetFilters();feedback("notice","问题已保存，正在等待智能体生成草稿。");await openDetail(data.task_id);}catch(e){feedback("demo-error",e.message);}finally{btn.disabled=false;}};
if(key)refresh();
setInterval(()=>{if(key&&!document.hidden){if(state.detail&&taskStatus(state.detail)==="expired"&&$("approve"))renderDetailFooter(state.detail);refresh(true);}},5000);
