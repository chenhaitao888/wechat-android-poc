// AutoX.js v7.2.4 / WeChat 8.0.79 / Huawei DCO-AL00 single-group PoC.
// Handles one attributable mention within 1–5 unread plain-text messages in 测试1.
// No network calls, model, knowledge base, notification snooping, or other groups.
auto.waitFor();
var PKG = "com.tencent.mm";
var BASE = "/sdcard/wechat-android-poc/";
var DIR = BASE + "artifacts/";
var policy = require(BASE + "mention-policy.js");
var runRecovery = require(BASE + "run-recovery.js");
var STATE = DIR + "watch-state.json";
var LOG = DIR + "watch-events.jsonl";
var STOP = BASE + "STOP";
var MAX_MS = 10 * 60 * 1000;
var MAX_SENDS = 5;
var requestPath = BASE + "run-request.json";
if (files.exists(requestPath)) {
    var request = JSON.parse(files.read(requestPath));
    if (request.maxMinutes === 30) { MAX_MS = 30 * 60 * 1000; MAX_SENDS = 10; }
}
var monoStarted = android.os.SystemClock.elapsedRealtime();
var stateLoaded = false;
var lastHealthLog = 0;
var lastPower = "";
var lastWaitReason = null;
files.ensureDir(DIR);
var lock = new java.io.File(BASE + "watch.lock");
if (!lock.createNewFile()) throw new Error("Watcher lock exists; verify stopped before restarting");
var started = Date.now();
var state = {group: "测试1", bot: "jarvis", status: "starting", sentThisRun: 0,
    commands: {"001": {status: "recipient_confirmed_previous_one_shot"}}};
var lastObservation = "";
var lastHeartbeat = 0;
function runtimeStatus() {
    return {
        screenInteractive: context.getSystemService("power").isInteractive(),
        keyguardLocked: context.getSystemService("keyguard").isKeyguardLocked(),
        touchExploration: context.getSystemService("accessibility").isTouchExplorationEnabled(),
        enabledServices: String(android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_accessibility_services") || "")
    };
}
function waitReason(status) {
    if (!status.screenInteractive || status.keyguardLocked) return "waiting_for_unlock";
    var services = status.enabledServices;
    if (!status.touchExploration || services.indexOf("org.autojs.autoxjs.v7/") < 0 ||
        (services.indexOf("local.wechat.accessibilityhelper/") < 0 && services.indexOf("com.bjbyhd.screenreader_huawei/") < 0)) return "waiting_for_accessibility";
    return null;
}
function requireRuntimeReady() {
    stopIfRequested();
    var reason = waitReason(runtimeStatus());
    if (reason) throw new Error("界面操作期间运行条件失效，已停止，请检查后重新开始：" + reason);
}
function health() {
    var runtime = runtimeStatus();
    var b = context.registerReceiver(null, new android.content.IntentFilter("android.intent.action.BATTERY_CHANGED"));
    var u = context.registerReceiver(null, new android.content.IntentFilter("android.hardware.usb.action.USB_STATE"));
    return {batteryPercent: device.getBattery(), charging: device.isCharging(),
        plugged: b ? b.getIntExtra("plugged", -1) : null,
        temperatureC: b ? b.getIntExtra("temperature", -1) / 10 : null,
        usbConnected: u ? u.getBooleanExtra("connected", false) : null,
        usbConfigured: u ? u.getBooleanExtra("configured", false) : null,
        screenInteractive: runtime.screenInteractive, keyguardLocked: runtime.keyguardLocked,
        touchExploration: runtime.touchExploration, enabledServices: runtime.enabledServices,
        elapsedSeconds: Math.round((android.os.SystemClock.elapsedRealtime() - monoStarted) / 1000)};
}
function stopIfRequested() {
    if (files.exists(STOP)) throw new Error("User requested stop");
}
function persist() {
    state.updatedAt = new Date().toISOString();
    files.write(STATE + ".tmp", JSON.stringify(state, null, 2));
    if (!new java.io.File(STATE + ".tmp").renameTo(new java.io.File(STATE))) throw new Error("State replacement failed");
}
function event(type, detail) {
    files.append(LOG, JSON.stringify({time: new Date().toISOString(), type: type, detail: detail}) + "\n");
}
function visible(n) {
    if (!n) return false;
    var b = n.bounds();
    return b.width() > 0 && b.height() > 0 && b.top >= 0 && b.bottom <= device.height;
}
function ancestor(n, suffix) {
    for (var i = 0; n && i < 12; i++, n = n.parent()) {
        if (String(n.id()) === PKG + ":id/" + suffix) return n;
    }
    return null;
}
function groupOK() {
    var title = id(PKG + ":id/obn").findOnce();
    return visible(title) && /^测试1\(\d+\)$/.test(String(title.text())) && title.bounds().top < 400;
}
function messageSide(node, side) {
    var row = ancestor(node, "bkj");
    var avatar = row && row.findOne(id(PKG + ":id/bk1"));
    return visible(avatar) && (side === "incoming" ? avatar.bounds().right < device.width / 2 : avatar.bounds().left > device.width / 2);
}
function findMessage(value, side) {
    var messages = id(PKG + ":id/bkl").find();
    for (var i = 0; i < messages.size(); i++) {
        var node = messages.get(i);
        var normalized = String(node.text() || "").replace(/[\s\u2005\u200b]+/g, "");
        if (visible(node) && normalized === value && messageSide(node, side)) return node;
    }
    return null;
}
function inputBox() { return id(PKG + ":id/bkk").className("android.widget.EditText").findOnce(); }
function observation() {
    // Visible group-chat title means we are not on the conversation list.
    if (visible(id(PKG + ":id/obn").findOnce())) return null;
    var names = id(PKG + ":id/kbq").text("测试1").find();
    var found = [];
    for (var i = 0; i < names.size(); i++) if (visible(names.get(i))) found.push(names.get(i));
    if (found.length !== 1) return null;
    var row = ancestor(found[0], "cj1");
    if (!visible(row)) return null;
    var preview = row.findOne(id(PKG + ":id/ht5"));
    var badge = row.findOne(id(PKG + ":id/o_u"));
    return {row: row, preview: String(preview ? preview.text() : ""), unread: String(badge ? badge.text() : "0")};
}
function waitForChatReady() {
    var deadline = android.os.SystemClock.elapsedRealtime() + 8000;
    while (android.os.SystemClock.elapsedRealtime() < deadline) {
        requireRuntimeReady();
        if (groupOK() && visible(inputBox()) && visible(id(PKG + ":id/bp0").findOnce())) return;
        sleep(200);
    }
    throw new Error("进入测试群后8秒仍未就绪，已停止，请检查当前页面。");
}
function backToList() {
    requireRuntimeReady();
    if (!groupOK()) throw new Error("Group changed before returning to list");
    var backButton = id(PKG + ":id/actionbar_up_indicator").findOnce();
    if (!visible(backButton) || !backButton.click()) throw new Error("Cannot return to list");
    var deadline = android.os.SystemClock.elapsedRealtime() + 8000;
    while (android.os.SystemClock.elapsedRealtime() < deadline) {
        requireRuntimeReady();
        if (observation()) return;
        sleep(200);
    }
    throw new Error("返回微信列表后8秒仍未就绪，已停止。");
}
function chatRows() {
    if (!groupOK()) throw new Error("测试群标题不匹配");
    var list = id(PKG + ":id/bp0").findOnce();
    if (!visible(list)) throw new Error("消息列表不可读");
    var viewport=list.bounds(), rows=[];
    for(var i=0;i<list.childCount();i++) {
        var row=list.child(i), b=row.bounds();
        if(b.height()<=0 || b.bottom<=viewport.top || b.top>=viewport.bottom) continue;
        var bubbles=row.find(id(PKG+":id/bkl"));
        var avatars=row.find(id(PKG+":id/bk1"));
        var sender=row.findOne(id(PKG+":id/brc"));
        var texts=row.find(className("android.widget.TextView"));
        var plain=String(row.id())===PKG+":id/bn1" && bubbles.size()===1 && avatars.size()===1;
        for(var t=0;t<texts.size();t++) {
            var tid=String(texts.get(t).id());
            if(tid!==PKG+":id/bkl" && tid!==PKG+":id/brc" && tid!==PKG+":id/br1") plain=false;
        }
        var avatar=avatars.size()===1 ? avatars.get(0) : null;
        var direction=avatar ? (avatar.bounds().right<device.width/2 ? "incoming" : avatar.bounds().left>device.width/2 ? "outgoing" : "unknown") : "unknown";
        rows.push({text:bubbles.size()===1 ? String(bubbles.get(0).text()||"") : "",sender:sender ? String(sender.text()||"") : "",direction:direction,simpleText:plain,fullyVisible:b.top>=viewport.top && b.bottom<=viewport.bottom});
    }
    return rows;
}
function rememberBoundary(rows) {
    var anchor=rows.slice(-2);
    if(!anchor.length || anchor.some(function(r){return !r.simpleText || !r.text;})) throw new Error("无法记录纯文字消息边界");
    state.anchor=anchor;
    persist();
}
function prepareBoundary() {
    state.status="preparing"; persist();
    var deadline = android.os.SystemClock.elapsedRealtime() + 20000;
    var obs = null;
    while (android.os.SystemClock.elapsedRealtime() < deadline) {
        stopIfRequested();
        var waiting = waitReason(runtimeStatus());
        if (!waiting) obs = observation();
        if (obs) break;
        if (state.status !== (waiting || "preparing")) { state.status = waiting || "preparing"; persist(); }
        sleep(500);
    }
    if (!obs) throw new Error("等待20秒后仍未就绪，请解锁手机、检查控件辅助，并让测试1在微信列表中可见后重新开始。");
    if(obs.unread!=="0") throw new Error("开始前请先读完测试1旧消息，并返回聊天列表；当前未读不会自动清空。");
    stopIfRequested();
    var fresh=observation();
    if(!fresh || fresh.unread!=="0" || fresh.preview!==obs.preview) throw new Error("准备期间来了新消息，请检查后重新启动。");
    requireRuntimeReady();
    if(!fresh.row.click()) throw new Error("无法进入测试群记录边界");
    waitForChatReady();
    rememberBoundary(chatRows());
    backToList();
    event("baseline_recorded",{anchorRows:state.anchor.length});
    state.status="watching"; persist();
}
function processBatch(observed) {
    requireRuntimeReady();
    var fresh=observation();
    if(!fresh || fresh.preview!==observed.preview || fresh.unread!==observed.unread) return;
    if(!/^[1-5]$/.test(fresh.unread)) throw new Error("未读超过5条或数量不明确，已暂停，请人工检查测试群。");
    state.status="opening_group"; persist();
    requireRuntimeReady();
    if(!fresh.row.click()) throw new Error("Could not open test group");
    waitForChatReady();
    var rows=chatRows();
    var decision=policy.decide(fresh,rows,state.anchor,state.commands);
    event("batch_classified",{unread:fresh.unread,decision:decision});
    if(decision.kind==="pause") {
        files.write(DIR+"pending-batch.json",JSON.stringify({time:new Date().toISOString(),observation:{preview:fresh.preview,unread:fresh.unread},anchor:state.anchor,rows:rows,reason:decision.reason},null,2));
        throw new Error("这批消息无法准确归属 @，已暂停并保留记录："+decision.reason);
    }
    if(decision.kind!=="reply") { rememberBoundary(rows); backToList(); return; }
    var code=decision.code;
    if(!findMessage("@jarvis测试"+code,"incoming")) throw new Error("Incoming command not visible");
    var reply="收到，测试"+code+"（自动回复测试）。";
    if(findMessage(reply,"outgoing")) {
        state.commands[code]={status:"existing_reply_observed",reply:reply};
        rememberBoundary(rows); backToList(); return;
    }
    sleep(350);
    if(!policy.sameRows(rows,chatRows())) throw new Error("检查期间消息发生变化，已暂停，未发送。");
    var input=inputBox();
    if(!visible(input) || String(input.text()||"")!=="") throw new Error("Chat input not empty");
    requireRuntimeReady();
    if(!input.setText(reply)) throw new Error("Cannot populate reply");
    sleep(500);
    input=inputBox();
    var send=packageName(PKG).text("发送").findOnce();
    if(!groupOK() || !visible(input) || String(input.text())!==reply || !visible(send)) throw new Error("Pre-send validation failed; inspect draft");
    if(!policy.sameRows(rows,chatRows())) throw new Error("发送前消息发生变化，已暂停，请检查输入框草稿。");
    requireRuntimeReady();
    // Persist before clicking; uncertain results are never retried automatically.
    state.commands[code]={status:"attempting",reply:reply,startedAt:new Date().toISOString(),unreadBatchSize:decision.batchSize};
    state.status="sending"; persist();
    event("send_attempt",{code:code,reply:reply,unreadBatchSize:decision.batchSize});
    requireRuntimeReady();
    if(!send.click()) throw new Error("Send result uncertain; no retry");
    state.sentThisRun++;
    sleep(1600);
    var sent=groupOK() && findMessage(reply,"outgoing");
    state.commands[code].status=sent ? "outgoing_bubble_observed" : "uncertain";
    state.commands[code].finishedAt=new Date().toISOString();
    persist(); event(state.commands[code].status,{code:code});
    if(!sent) throw new Error("Outgoing bubble not confirmed; no retry");
    var after=chatRows(),last=after[after.length-1];
    if(!last || last.direction!=="outgoing" || last.text!==reply) throw new Error("回复后又有新消息，已暂停，请检查测试群。");
    rememberBoundary(after);
    backToList();
    state.status="watching"; persist();
}

try {
    files.write(BASE + "watch.lock", JSON.stringify(runRecovery.makeOwner()));
    if (files.exists(STATE)) {
        var previous = JSON.parse(files.read(STATE));
        if (previous.group !== state.group || previous.bot !== state.bot) throw new Error("State belongs to another target");
        if (!previous.commands || typeof previous.commands !== "object") throw new Error("Deduplication state invalid");
        state.commands = previous.commands;
    }
    stateLoaded = true;
    if (files.exists(STOP)) throw new Error("STOP file present; intentionally disabled");
    device.keepScreenOn(MAX_MS);
    state.startedAt = new Date().toISOString();
    state.status = "watching";
    state.maxMinutes = MAX_MS / 60000;
    state.maxSends = MAX_SENDS;
    state.health = health();
    persist();
    event("started", {maxMinutes: state.maxMinutes, maxSends: MAX_SENDS, health: state.health});
    prepareBoundary();
    while (android.os.SystemClock.elapsedRealtime() - monoStarted < MAX_MS && state.sentThisRun < MAX_SENDS && !files.exists(STOP)) {
        var availability = runtimeStatus(), waiting = waitReason(availability);
        if (waiting !== lastWaitReason) {
            event("runtime_availability", {waiting: waiting, runtime: availability});
            state.status = waiting || "watching"; persist();
            lastWaitReason = waiting;
        }
        var obs = waiting ? null : observation();
        if (obs) {
            var key = obs.unread + "|" + obs.preview;
            if (key !== lastObservation) {
                event("list_observation", {unread: obs.unread, preview: obs.preview});
                lastObservation = key;
            }
            // Development-only gate makes unread batches reproducible on the device.
            if (!files.exists(BASE + "TEST_HOLD") && /^\[有人@我\]/.test(obs.preview)) processBatch(obs);
        }
        if (Date.now() - lastHeartbeat > 15000) {
            state.health = health();
            var powerKey = state.health.plugged + "|" + state.health.usbConnected + "|" + state.health.usbConfigured;
            if (Date.now() - lastHealthLog >= 60000 || powerKey !== lastPower) {
                event("health", state.health);
                lastHealthLog = Date.now();
                lastPower = powerKey;
            }
            state.status = waiting || (files.exists(BASE + "TEST_HOLD") ? "test_hold" : obs ? "watching" : "waiting_for_test_group_list");
            persist();
            lastHeartbeat = Date.now();
        }
        sleep(1200);
    }
    state.status = "stopped";
    state.stopReason = files.exists(STOP) ? "stop_file" : state.sentThisRun >= MAX_SENDS ? "send_limit" : "time_limit";
    persist();
    event("stopped", {reason: state.stopReason});
} catch (e) {
    state.status = files.exists(STOP) ? "stopped" : "halted";
    state.error = String(e);
    if (state.status === "stopped") state.stopReason = "stop_file";
    if (stateLoaded) persist();
    else files.write(DIR + "last-start-error.json", JSON.stringify({time: new Date().toISOString(), error: String(e)}));
    event(state.status, {error: String(e)});
    console.error(e);
} finally {
    device.cancelKeepingAwake();
    lock.delete();
}
