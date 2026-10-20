// One explicitly requested reply to the existing 测试001 sample in 测试1.
auto.waitFor();
sleep(1000);
var PKG = "com.tencent.mm";
var BASE = "/sdcard/wechat-android-poc/";
var REPLY = "收到，测试001（自动回复测试）。";
var ledger = BASE + "artifacts/test001-send-state.json";
function save(value) {
    value.time = new Date().toISOString();
    files.createWithDirs(ledger);
    files.write(ledger, JSON.stringify(value, null, 2));
    console.log(JSON.stringify(value));
}
function groupOK() {
    var title = id(PKG + ":id/obn").findOnce();
    return title && /^测试1\(\d+\)$/.test(String(title.text())) && title.bounds().top < 400;
}
function incoming(node) {
    var row = node;
    for (var i = 0; row && i < 8; i++, row = row.parent()) {
        if (String(row.id()) === PKG + ":id/bkj") {
            var avatar = row.findOne(id(PKG + ":id/bk1"));
            return avatar && avatar.bounds().right < device.width / 2;
        }
    }
    return false;
}
if (files.exists(ledger)) throw new Error("A send attempt already exists; inspect its result before retrying");
if (!groupOK()) throw new Error("Not in the approved test group");
var messages = id(PKG + ":id/bkl").find();
var matched = false;
for (var i = 0; i < messages.size(); i++) {
    var node = messages.get(i);
    var normalized = String(node.text() || "").replace(/[\s\u2005\u200b]+/g, "");
    if (normalized === "@jarvis测试001" && incoming(node)) matched = true;
}
if (!matched) throw new Error("The confirmed incoming test001 sample was not found");
var input = id(PKG + ":id/bkk").className("android.widget.EditText").findOnce();
if (!input || String(input.text() || "") !== "") throw new Error("No empty chat input");
if (!input.setText(REPLY)) throw new Error("Could not set reply text");
sleep(500);
var send = packageName(PKG).text("发送").findOnce();
input = id(PKG + ":id/bkk").className("android.widget.EditText").findOnce();
if (!groupOK() || !input || String(input.text()) !== REPLY || !send) {
    save({status: "draft_only", reason: "Send controls or group validation failed"});
    throw new Error("Send validation failed; reply was left as a draft");
}
save({status: "attempting", group: "测试1", reply: REPLY});
if (!send.click()) {
    save({status: "uncertain", reason: "Send action returned false; no automatic retry"});
    exit();
}
sleep(1600);
var sent = false;
if (groupOK()) {
    messages = id(PKG + ":id/bkl").text(REPLY).find();
    for (var j = 0; j < messages.size(); j++) {
        var row = messages.get(j);
        for (var k = 0; row && k < 8; k++, row = row.parent()) {
            if (String(row.id()) === PKG + ":id/bkj") {
                var avatar = row.findOne(id(PKG + ":id/bk1"));
                if (avatar && avatar.bounds().left > device.width / 2) sent = true;
                break;
            }
        }
    }
}
save({status: sent ? "outgoing_bubble_observed" : "uncertain", group: "测试1", reply: REPLY,
    note: "Recipient delivery requires confirmation on the other phone; no automatic retries"});
