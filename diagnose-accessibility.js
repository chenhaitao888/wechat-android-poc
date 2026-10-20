// Read-only WeChat probes with temporary, documented accessibility-service settings.
// No clicks, text changes, or message sending. Always restore the original service info.
auto.waitFor();
var BASE = "/sdcard/wechat-android-poc/";
var OUT = BASE + "artifacts/accessibility-diagnosis.json";
if (files.exists(BASE + "watch.lock")) throw new Error("Stop the watcher before diagnostics");
var service = auto.service;
if (!service) throw new Error("AutoX accessibility service unavailable");
var manager = context.getSystemService("accessibility");
var original = service.getServiceInfo();
var savedFeedback = original.feedbackType;
var savedFlags = original.flags;
var report = {startedAt: new Date().toISOString(), original: {feedbackType: savedFeedback, flags: savedFlags, capabilities: original.getCapabilities()}, samples: []};
function probe(label) {
    app.launchPackage("com.tencent.mm");
    sleep(1700);
    var nodes = packageName("com.tencent.mm").find();
    var validBounds = 0, textNodes = 0;
    for (var i = 0; i < nodes.size(); i++) {
        var n = nodes.get(i), b = n.bounds();
        if (b.width() > 0 && b.height() > 0) validBounds++;
        if (String(n.text() || "")) textNodes++;
    }
    var info = service.getServiceInfo();
    var sample = {label: label, time: new Date().toISOString(), nodes: nodes.size(), nodesWithBounds: validBounds, nodesWithText: textNodes,
        testGroupVisible: id("com.tencent.mm:id/kbq").text("测试1").exists(), feedbackType: info.feedbackType,
        flags: info.flags, touchExploration: manager.isTouchExplorationEnabled(),
        enabledServices: String(android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_accessibility_services"))};
    report.samples.push(sample);
    files.write(OUT, JSON.stringify(report, null, 2));
}
try {
    probe("baseline");
    var info = service.getServiceInfo();
    info.feedbackType = android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_SPOKEN;
    service.setServiceInfo(info);
    sleep(1000);
    home(); sleep(500);
    probe("spoken_feedback_no_touch_exploration");
    info = service.getServiceInfo();
    info.feedbackType = savedFeedback;
    info.flags = savedFlags | android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS |
        android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS |
        android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    service.setServiceInfo(info);
    sleep(1000);
    home(); sleep(500);
    probe("expanded_view_flags_original_feedback");
} catch(e) {
    report.error = String(e);
} finally {
    var restore = service.getServiceInfo();
    restore.feedbackType = savedFeedback;
    restore.flags = savedFlags;
    service.setServiceInfo(restore);
    sleep(800);
    report.restored = {feedbackType: service.getServiceInfo().feedbackType, flags: service.getServiceInfo().flags, touchExploration: manager.isTouchExplorationEnabled()};
    report.finishedAt = new Date().toISOString();
    files.write(OUT, JSON.stringify(report, null, 2));
}
