// Read-only WeChat accessibility probe. No clicks, typing, or sending.
auto.waitFor();
sleep(1500);
var output = "/sdcard/wechat-android-poc/artifacts/probe.json";
// currentPackage() can retain the IME package after the keyboard closes.
// Query only WeChat nodes directly; this script never operates on the UI.
var report = {time: new Date().toISOString(), packageName: currentPackage(), nodes: []};
{
    var nodes = packageName("com.tencent.mm").find();
    var limit = Math.min(nodes.size(), 1500);
    report.totalNodes = nodes.size();
    for (var i = 0; i < limit; i++) {
        var n = nodes.get(i);
        try {
            var b = n.bounds();
            report.nodes.push({
                id: String(n.id() || ""), text: String(n.text() || ""),
                desc: String(n.desc() || ""), className: String(n.className() || ""),
                depth: n.depth(), childCount: n.childCount(),
                clickable: n.clickable(),
                bounds: [b.left, b.top, b.right, b.bottom]
            });
        } catch (e) {
            report.nodes.push({error: String(e)});
        }
    }
}
files.createWithDirs(output);
files.write(output, JSON.stringify(report, null, 2));
console.log("WeChat probe: " + report.nodes.length + " nodes; " + output);
