// Read-only inspection using AutoX, preserving other accessibility services.
auto.waitFor();
sleep(1200);
var BASE = "/sdcard/wechat-android-poc/";
var manager = context.getSystemService("accessibility");
var report = {time: new Date().toISOString(), touchExploration: manager.isTouchExplorationEnabled(), enabledServices: String(android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_accessibility_services")), packages: {}};
["com.tencent.mm", "local.wechat.accessibilityhelper", "com.android.settings", "org.autojs.autoxjs.v7"].forEach(function(pkg) {
    var nodes = packageName(pkg).find();
    var item = {totalNodes: nodes.size(), nodesWithBounds: 0, controls: []};
    for(var i = 0; i < nodes.size(); i++) {
        var n = nodes.get(i), b = n.bounds();
        if(b.width() > 0 && b.height() > 0) item.nodesWithBounds++;
        var t = String(n.text() || ""), nodeId = String(n.id() || "");
        // Never retain other WeChat conversation previews or message contents.
        if(pkg === "com.tencent.mm" && !(t === "测试1" || /^测试1\(\d+\)$/.test(t))) continue;
        if(t || nodeId.indexOf("switch") >= 0) item.controls.push({text: t, id: nodeId, bounds: [b.left,b.top,b.right,b.bottom], checked: n.checked(), clickable: n.clickable(), enabled: n.enabled()});
    }
    report.packages[pkg] = item;
});
files.write(BASE + "artifacts/ui-inspection.json", JSON.stringify(report, null, 2));
