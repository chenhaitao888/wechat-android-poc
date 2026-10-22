// Development-only helpers scoped to this test panel and the approved test group.
auto.waitFor();
var BASE = "/sdcard/wechat-android-poc/";
var action = files.read(BASE + "test-action.txt").trim();
function groupOK() {
    var t = id("com.tencent.mm:id/obn").findOnce();
    return t && /^测试1\(\d+\)$/.test(String(t.text())) && t.bounds().top > 0 && t.bounds().top < 400;
}
if (action === "prepare") {
    app.launchPackage("com.tencent.mm");
    sleep(1400);
    if (!groupOK()) {
        var names = id("com.tencent.mm:id/kbq").text("测试1").find();
        var found = [];
        for (var i = 0; i < names.size(); i++) {
            var n = names.get(i), b = n.bounds();
            if (b.top > 0 && b.bottom < device.height && b.width() > 0) found.push(n);
        }
        if (found.length !== 1) throw new Error("Unique visible test group not found");
        var row = found[0];
        for (var k = 0; row && k < 12 && String(row.id()) !== "com.tencent.mm:id/cj1"; k++) row = row.parent();
        if (!row || !row.click()) throw new Error("Cannot open test group");
        sleep(1000);
    }
    if (!groupOK()) throw new Error("Unexpected group title");
    var box = id("com.tencent.mm:id/bkk").className("android.widget.EditText").findOnce();
    if (!box || String(box.text() || "") !== "") throw new Error("Input contains a draft; no changes made");
    if (!id("com.tencent.mm:id/actionbar_up_indicator").findOnce().click()) throw new Error("Cannot return to list");
    sleep(800);
    engines.execScriptFile(BASE + "phone-panel.js");
} else if (action === "start" || action === "stop" || action === "wechat" || action === "recover") {
    var heading = packageName("org.autojs.autoxjs.v7").text("微信群测试").findOnce();
    if (!heading) throw new Error("Test panel not foreground");
    var label = action === "start" ? "开始测试（30分钟）" : action === "stop" ? "停止回复" : action === "recover" ? "检查并恢复" : "打开微信 / 返回等待";
    var button = packageName("org.autojs.autoxjs.v7").text(label).findOnce();
    if (!button || !button.click()) throw new Error("Panel button unavailable: " + label);
}
var all = engines.all(), sources = [];
for (var j = 0; j < all.length; j++) sources.push(String(all[j].getSource()));
files.write(BASE + "artifacts/control-test.json", JSON.stringify({time: new Date().toISOString(), action: action, engines: sources}, null, 2));
