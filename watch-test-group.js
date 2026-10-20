// AutoX.js v7.2.4 / WeChat 8.0.79 / Huawei DCO-AL00 single-group PoC.
// Only handles a single unread, explicitly mentioned 测试NNN command in 测试1.
// No network calls, model, knowledge base, notification snooping, or other groups.
auto.waitFor();
var PKG = "com.tencent.mm";
var BASE = "/sdcard/wechat-android-poc/";
var DIR = BASE + "artifacts/";
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
files.ensureDir(DIR);
var lock = new java.io.File(BASE + "watch.lock");
if (!lock.createNewFile()) throw new Error("Watcher lock exists; verify stopped before restarting");
var started = Date.now();
var state = {group: "测试1", bot: "jarvis", status: "starting", sentThisRun: 0,
    commands: {"001": {status: "recipient_confirmed_previous_one_shot"}}};
var lastObservation = "";
var lastHeartbeat = 0;
function health() {
    var b = context.registerReceiver(null, new android.content.IntentFilter("android.intent.action.BATTERY_CHANGED"));
    var u = context.registerReceiver(null, new android.content.IntentFilter("android.hardware.usb.action.USB_STATE"));
    return {batteryPercent: device.getBattery(), charging: device.isCharging(),
        plugged: b ? b.getIntExtra("plugged", -1) : null,
        temperatureC: b ? b.getIntExtra("temperature", -1) / 10 : null,
        usbConnected: u ? u.getBooleanExtra("connected", false) : null,
        usbConfigured: u ? u.getBooleanExtra("configured", false) : null,
        touchExploration: context.getSystemService("accessibility").isTouchExplorationEnabled(),
        enabledServices: String(android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_accessibility_services") || ""),
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
function backToList() {
    if (!groupOK()) throw new Error("Group changed before returning to list");
    var backButton = id(PKG + ":id/actionbar_up_indicator").findOnce();
    if (!visible(backButton) || !backButton.click()) throw new Error("Cannot return to list");
    sleep(1000);
    if (!observation()) throw new Error("Conversation list not confirmed");
}
function processCommand(code, observed) {
    stopIfRequested();
    var fresh = observation();
    if (!fresh || fresh.preview !== observed.preview || fresh.unread !== "1") return;
    event("mention_detected", {code: code, unread: fresh.unread, preview: fresh.preview});
    state.status = "opening_group";
    persist();
    if (!fresh.row.click()) throw new Error("Could not open test group");
    sleep(1200);
    if (!groupOK()) throw new Error("Approved group title not confirmed");
    if (!findMessage("@jarvis测试" + code, "incoming")) throw new Error("Incoming command not visible");
    var reply = "收到，测试" + code + "（自动回复测试）。";
    if (findMessage(reply, "outgoing")) {
        state.commands[code] = {status: "existing_reply_observed", reply: reply};
        persist();
        backToList();
        return;
    }
    var input = inputBox();
    if (!visible(input) || String(input.text() || "") !== "") throw new Error("Chat input not empty");
    stopIfRequested();
    if (!input.setText(reply)) throw new Error("Cannot populate reply");
    sleep(500);
    input = inputBox();
    var send = packageName(PKG).text("发送").findOnce();
    if (!groupOK() || !visible(input) || String(input.text()) !== reply || !visible(send)) throw new Error("Pre-send validation failed; inspect draft");
    stopIfRequested();
    // Persist before clicking. A crash or ambiguous result never causes automatic retransmission.
    state.commands[code] = {status: "attempting", reply: reply, startedAt: new Date().toISOString()};
    state.status = "sending";
    persist();
    event("send_attempt", {code: code, reply: reply});
    if (!send.click()) throw new Error("Send result uncertain; no retry");
    state.sentThisRun++;
    sleep(1600);
    var sent = groupOK() && findMessage(reply, "outgoing");
    state.commands[code].status = sent ? "outgoing_bubble_observed" : "uncertain";
    state.commands[code].finishedAt = new Date().toISOString();
    persist();
    event(state.commands[code].status, {code: code});
    if (!sent) throw new Error("Outgoing bubble not confirmed; no retry");
    backToList();
    state.status = "watching";
    persist();
}
try {
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
    while (android.os.SystemClock.elapsedRealtime() - monoStarted < MAX_MS && state.sentThisRun < MAX_SENDS && !files.exists(STOP)) {
        var obs = observation();
        if (obs) {
            var key = obs.unread + "|" + obs.preview;
            if (key !== lastObservation) {
                event("list_observation", {unread: obs.unread, preview: obs.preview});
                lastObservation = key;
            }
            var match = /^\[有人@我\]\s+.+:\s*@jarvis[\s\u2005\u200b]*测试(\d{3})$/.exec(obs.preview);
            if (match && obs.unread === "1" && !state.commands[match[1]]) processCommand(match[1], obs);
        }
        if (Date.now() - lastHeartbeat > 15000) {
            state.health = health();
            var powerKey = state.health.plugged + "|" + state.health.usbConnected + "|" + state.health.usbConfigured;
            if (Date.now() - lastHealthLog >= 60000 || powerKey !== lastPower) {
                event("health", state.health);
                lastHealthLog = Date.now();
                lastPower = powerKey;
            }
            state.status = obs ? "watching" : "waiting_for_test_group_list";
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
