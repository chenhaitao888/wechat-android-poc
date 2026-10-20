"ui";
// Native phone controls. The watcher runs in its own AutoX engine.
var BASE = "/sdcard/wechat-android-poc/";
var STATE = BASE + "artifacts/watch-state.json";
var STOP = BASE + "STOP";
var WORKER = BASE + "watch-test-group.js";
var busy = false;
// Reopening the desktop entry replaces only older copies of this panel.
var ownEngine = engines.myEngine();
engines.all().forEach(function(engine) {
    if (String(engine.getSource()) === BASE + "phone-panel.js" && !engine.equals(ownEngine)) engine.forceStop();
});
files.ensureDir(BASE + "artifacts/");
ui.statusBarColor("#163A31");
ui.layout('<scroll bg="#F4F7F5"><vertical padding="24">' +
    '<text text="微信群测试" textSize="28sp" textColor="#163A31" textStyle="bold" marginBottom="8" />' +
    '<text text="测试1 · jarvis · 固定回复" textSize="16sp" textColor="#53645C" marginBottom="20" />' +
    '<text id="statusText" text="正在读取状态…" textSize="20sp" textColor="#163A31" textStyle="bold" />' +
    '<text id="detailText" text="" textSize="14sp" textColor="#53645C" marginTop="8" marginBottom="16" />' +
    '<text id="nextText" text="下次发送：@jarvis 测试006" textSize="19sp" textColor="#163A31" marginBottom="16" />' +
    '<button id="startButton" text="开始测试（30分钟）" textSize="18sp" h="56" />' +
    '<button id="stopButton" text="停止回复" textSize="18sp" h="56" marginTop="8" />' +
    '<text id="hintText" text="开始前：开启 AutoX 和“微信控件辅助”，保持微信聊天列表可见。每次使用新的测试编号。" textSize="15sp" textColor="#53645C" marginTop="16" marginBottom="12" />' +
    '<button id="wechatButton" text="打开微信 / 返回等待" />' +
    '<button id="helperButton" text="打开微信控件辅助" />' +
    '<button id="settingsButton" text="打开无障碍设置" />' +
    '<button id="shortcutButton" text="添加桌面入口" />' +
    '<text text="从成员列表选择 @jarvis，一次发一条。最多30分钟或10条回复后自动停止。查看本页时暂停识别，返回微信列表后继续。" textSize="13sp" textColor="#68776F" marginTop="16" />' +
    '</vertical></scroll>');
function readState() {
    return files.exists(STATE) ? JSON.parse(files.read(STATE)) : {commands: {}, sentThisRun: 0};
}
function services() {
    return String(android.provider.Settings.Secure.getString(context.getContentResolver(), "enabled_accessibility_services") || "");
}
function workers() {
    var all = engines.all();
    var out = [];
    for (var i = 0; i < all.length; i++) {
        if (String(all[i].getSource()).indexOf("watch-test-group") >= 0 && !all[i].isDestroyed()) out.push(all[i]);
    }
    return out;
}
function refresh() {
    try {
        var s = readState();
        var active = workers().length > 0;
        var names = {watching: "正在等待群里的 @", opening_group: "正在进入测试群", sending: "正在回复", waiting_for_test_group_list: "等待返回微信聊天列表", stopped: "已停止", halted: "已停止，需要检查"};
        var label = active ? (files.exists(STOP) ? "正在停止，请稍候" : (names[s.status] || "正在启动")) : (s.status === "halted" ? names.halted : "已停止");
        var used = s.commands || {};
        var next = 6;
        Object.keys(used).forEach(function(k) { next = Math.max(next, Number(k) + 1); });
        var code = ("000" + next).slice(-3);
        var age = s.updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(s.updatedAt)) / 1000)) : null;
        var detail = "本轮已回复 " + (s.sentThisRun || 0) + " 条";
        if (active && s.startedAt) detail += " · 运行约 " + Math.floor((Date.now() - Date.parse(s.startedAt)) / 60000) + " 分钟";
        if (active && age !== null && age > 45) detail += "\n状态超过45秒未更新，请先停止并检查";
        if (s.error && s.status === "halted") detail += "\n" + s.error;
        var enabled = services();
        detail += "\n控件辅助：" + (enabled.indexOf("local.wechat.accessibilityhelper/") >= 0 ? "已开启" : "未开启");
        detail += " · 触摸模式：" + (context.getSystemService("accessibility").isTouchExplorationEnabled() ? "已就绪" : "未就绪");
        detail += "\n系统屏幕朗读：" + (enabled.indexOf("com.bjbyhd.screenreader_huawei/") >= 0 ? "已开启" : "未开启");
        ui.run(function() {
            ui.statusText.setText(label);
            ui.detailText.setText(detail);
            ui.nextText.setText("下次发送：@jarvis 测试" + code);
            ui.startButton.setEnabled(!busy && !active && !files.exists(BASE + "watch.lock"));
        });
    } catch (e) { ui.run(function() { ui.hintText.setText("状态暂时无法读取：" + e); }); }
}
ui.startButton.on("click", function() {
    if (busy) return;
    busy = true;
    try {
        if (workers().length || files.exists(BASE + "watch.lock")) throw new Error("上一次任务还未退出，请先停止。异常残留需要检查，不能直接重复启动。");
        var enabled = services();
        if (enabled.indexOf("org.autojs.autoxjs.v7/") < 0) throw new Error("请先在无障碍设置中开启 AutoX 服务。");
        var helper = enabled.indexOf("local.wechat.accessibilityhelper/") >= 0;
        var reader = enabled.indexOf("com.bjbyhd.screenreader_huawei/") >= 0;
        if (!helper && !reader) throw new Error("请先打开“微信控件辅助”，在系统无障碍设置中开启该服务。");
        if (!context.getSystemService("accessibility").isTouchExplorationEnabled()) throw new Error("触摸辅助模式尚未就绪，请稍候或检查辅助服务。");
        readState(); // Do not reset unreadable deduplication records.
        files.write(BASE + "run-request.json", JSON.stringify({maxMinutes: 30, source: "phone_panel", requestedAt: new Date().toISOString()}));
        if (files.exists(STOP) && !files.remove(STOP)) throw new Error("无法清除停止标记");
        engines.execScriptFile(WORKER);
        ui.hintText.setText("测试已启动。请保持微信聊天列表可见，再从另一台手机发送新的测试编号。");
        app.launchPackage("com.tencent.mm");
    } catch (e) { ui.hintText.setText(String(e.message || e)); }
    finally { setTimeout(function() { busy = false; refresh(); }, 3000); }
});
ui.stopButton.on("click", function() {
    files.write(STOP, "stopped from phone panel at " + new Date().toISOString());
    ui.hintText.setText("已请求停止，通常几秒内结束。已发送的消息不会撤回。");
    refresh();
});
ui.wechatButton.on("click", function() { app.launchPackage("com.tencent.mm"); });
ui.helperButton.on("click", function() {
    try { app.startActivity({packageName: "local.wechat.accessibilityhelper", className: "local.wechat.accessibilityhelper.MainActivity", flags: ["activity_new_task", "activity_clear_top"]}); }
    catch(e) { ui.hintText.setText("辅助应用未能打开，请在桌面打开“微信控件辅助”。"); }
});
ui.settingsButton.on("click", function() { app.startActivity({action: "android.settings.ACCESSIBILITY_SETTINGS"}); });
ui.shortcutButton.on("click", function() {
    try {
        var manager = context.getSystemService("shortcut");
        if (!manager || !manager.isRequestPinShortcutSupported()) throw new Error("当前桌面不支持快捷方式，请从 AutoX 打开本脚本。");
        var intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
        intent.setClassName(context.getPackageName(), "org.autojs.autojs.external.open.RunIntentActivity");
        intent.setData(android.net.Uri.parse("file://" + BASE + "phone-panel.js"));
        var shortcut = new android.content.pm.ShortcutInfo.Builder(context, "wechat-test-panel")
            .setShortLabel("微信群测试").setLongLabel("微信群测试控制台")
            .setIcon(android.graphics.drawable.Icon.createWithResource(context, android.R.drawable.ic_menu_send))
            .setIntent(intent).build();
        var accepted = manager.requestPinShortcut(shortcut, null);
        ui.hintText.setText(accepted ? "请在系统提示中确认添加；之后可从桌面打开。" : "桌面未接受添加请求，可从 AutoX 打开本脚本。");
    } catch (e) { ui.hintText.setText("添加桌面入口失败：" + e); }
});
refresh();
setInterval(refresh, 2000);
