"ui";
// Native phone controls. The watcher runs in its own AutoX engine.
var BASE = "/sdcard/wechat-android-poc/";
var STATE = BASE + "artifacts/watch-state.json";
var STOP = BASE + "STOP";
var WORKER = BASE + "watch-test-group.js";
var runRecovery = require(BASE + "run-recovery.js");
var foregroundService = require(BASE + "foreground-service.js");
var recoveryController = runRecovery.createController(BASE, function() { return workers().length; });
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
    '<text id="nextText" text="可以发送：@jarvis 普通问题" textSize="19sp" textColor="#163A31" marginBottom="16" />' +
    '<button id="startButton" text="开始测试（30分钟）" textSize="18sp" h="56" />' +
    '<button id="stopButton" text="停止回复" textSize="18sp" h="56" marginTop="8" />' +
    '<button id="recoverButton" text="检查并恢复" textSize="18sp" h="56" marginTop="8" visibility="gone" />' +
    '<text id="hintText" text="开始前：开启 AutoX 前台服务、无障碍和控件辅助，读完测试1旧消息后返回聊天列表。等准备完成，再真正 @jarvis 发送普通文字。" textSize="15sp" textColor="#53645C" marginTop="16" marginBottom="12" />' +
    '<button id="wechatButton" text="打开微信 / 返回等待" />' +
    '<button id="helperButton" text="打开微信控件辅助" />' +
    '<button id="settingsButton" text="打开无障碍设置" />' +
    '<button id="batteryButton" text="打开电池优化设置" />' +
    '<button id="shortcutButton" text="添加桌面入口" />' +
    '<text text="支持最多5条未读中只有一条 @ 的纯文字批次。多条 @ 或边界不明会暂停。最多30分钟或10条回复后自动停止。" textSize="13sp" textColor="#68776F" marginTop="16" />' +
    '</vertical></scroll>');
function readState() {
    if(!files.exists(STATE)) return {commands:{},textReplies:{},boundaryVersion:0,sentThisRun:0};
    var saved=JSON.parse(files.read(STATE));
    if(!runRecovery.validLedger(saved)) throw new Error("历史回执记录异常，请保持停止并检查，不要清空记录。");
    return saved;
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
        var orphaned = !active && files.exists(BASE + "watch.lock");
        var recoveryCheck = orphaned ? recoveryController.inspect() : {recoverable:false};
        var names = {test_hold: "等待本批测试消息发完", preparing: "正在记录消息边界，请稍候", watching: "正在等待群里的 @", opening_group: "正在进入测试群", sending: "正在回复", waiting_for_test_group_list: "等待返回微信聊天列表", waiting_for_unlock: "等待手机亮屏并解锁", waiting_for_accessibility: "等待控件辅助恢复", waiting_for_foreground_service: "等待前台运行服务恢复", stopped: "已停止", halted: "已停止，需要检查"};
        var label = active ? (files.exists(STOP) ? "正在停止，请稍候" : (names[s.status] || "正在启动")) : (s.status === "halted" ? names.halted : "已停止");
        if (orphaned) label = "上次任务未正常结束";
        var used = s.commands || {};
        var next = 6;
        Object.keys(used).forEach(function(k) { next = Math.max(next, Number(k) + 1); });
        var code = ("000" + next).slice(-3);
        var age = s.updatedAt ? Math.max(0, Math.round((Date.now() - Date.parse(s.updatedAt)) / 1000)) : null;
        var detail = "本轮已回复 " + (s.sentThisRun || 0) + " 条";
        if (active && s.startedAt) detail += " · 运行约 " + Math.floor((Date.now() - Date.parse(s.startedAt)) / 60000) + " 分钟";
        if (active && age !== null && age > 45) detail += "\n状态超过45秒未更新，请先停止并检查";
        if (s.error && s.status === "halted") {
            var errorText = String(s.error);
            var explanations = {
                mention_attribution_ambiguous: "这批中有多条 @ 或无法确认的 @，请人工查看测试1后再开始。",
                baseline_not_unique_or_not_visible: "旧消息位置不在屏幕内或有重复，无法确认未读边界。请人工检查后再开始。",
                unread_boundary_changed: "进入群时消息数量发生变化，已暂停。请人工检查后再开始。",
                unsupported_or_hidden_message: "这批中含有图片、系统消息或未完整显示的消息，已暂停。",
                last_message_does_not_match_preview: "最后一条消息与群列表摘要不一致，已暂停。",
                empty_question: "@ 后没有问题正文，已暂停，请检查后重新开始。",
                text_receipt_conflict: "普通文字回执与历史记录冲突，已停止，请保持现场并检查。",
                invalid_text_ledger: "普通文字回执记录异常，已停止，请勿清空历史记录。"
            };
            Object.keys(explanations).some(function(key) {
                if (errorText.indexOf(key) >= 0) { errorText = explanations[key]; return true; }
                return false;
            });
            detail += "\n" + errorText;
        }
        if (orphaned) detail += recoveryCheck.recoverable ? "\n已确认旧任务退出。请先检查群内消息，再点“检查并恢复”。" : "\n暂时无法确认旧任务已退出，请先停止；仍无法恢复时需要维护检查。";
        if (!active && s.recoveredAt) detail += "\n已恢复停止状态。历史编号已保留，检查旧消息后可重新开始。";
        var enabled = services();
        var foreground = foregroundService.isRunning();
        detail += "\n前台运行：" + (foreground === true ? "已开启" : foreground === false ? "未开启，请在AutoX菜单开启前台服务" : "暂时无法确认");
        var exempt = foregroundService.isBatteryOptimizationIgnored();
        detail += "\nAutoX电池优化：" + (exempt === true ? "已豁免" : exempt === false ? "未豁免，请设为不允许优化" : "暂时无法确认");
        var helperExempt = foregroundService.isBatteryOptimizationIgnored("local.wechat.accessibilityhelper");
        detail += "\n控件辅助电池优化：" + (helperExempt === true ? "已豁免" : helperExempt === false ? "未豁免，请设为不允许优化" : "暂时无法确认");
        detail += "\nAutoX服务：" + (enabled.indexOf("org.autojs.autoxjs.v7/") >= 0 ? "已开启" : "未开启，请先在无障碍设置中开启");
        detail += "\n控件辅助：" + (enabled.indexOf("local.wechat.accessibilityhelper/") >= 0 ? "已开启" : "未开启");
        detail += " · 触摸模式：" + (context.getSystemService("accessibility").isTouchExplorationEnabled() ? "已就绪" : "未就绪");
        detail += "\n系统屏幕朗读：" + (enabled.indexOf("com.bjbyhd.screenreader_huawei/") >= 0 ? "已开启" : "未开启");
        ui.run(function() {
            ui.statusText.setText(label);
            ui.detailText.setText(detail);
            ui.nextText.setText("可发送：@jarvis 普通问题\n编号测试仍可用：测试" + code);
            ui.startButton.setEnabled(!busy && !active && !files.exists(BASE + "watch.lock"));
            ui.recoverButton.setVisibility(orphaned ? 0 : 8);
            ui.recoverButton.setEnabled(!busy && orphaned && recoveryCheck.recoverable);
        });
    } catch (e) { ui.run(function() { ui.hintText.setText("状态暂时无法读取：" + e); }); }
}
function requireBatteryExemption(label, packageName) {
    var exempt = foregroundService.isBatteryOptimizationIgnored(packageName);
    if (exempt === true) return;
    var reason = exempt === false ? "尚未豁免电池优化" : "电池优化状态暂时无法确认";
    throw new Error(label + reason + "。请点“打开电池优化设置”，选择“所有应用”，将该应用设为“不允许”，返回后再开始。机器人保持停止。");
}
ui.startButton.on("click", function() {
    if (busy) return;
    busy = true;
    try {
        if (workers().length || files.exists(BASE + "watch.lock")) throw new Error("上一次任务还未退出，请先停止。异常残留需要检查，不能直接重复启动。");
        if (foregroundService.isRunning() !== true) throw new Error("请先打开 AutoX 左侧菜单，开启“前台服务”，再返回本面板开始。");
        var enabled = services();
        if (enabled.indexOf("org.autojs.autoxjs.v7/") < 0) throw new Error("请先在无障碍设置中开启 AutoX 服务。");
        var helper = enabled.indexOf("local.wechat.accessibilityhelper/") >= 0;
        var reader = enabled.indexOf("com.bjbyhd.screenreader_huawei/") >= 0;
        if (!helper && !reader) throw new Error("请先打开“微信控件辅助”，在系统无障碍设置中开启该服务。");
        if (!context.getSystemService("accessibility").isTouchExplorationEnabled()) throw new Error("触摸辅助模式尚未就绪，请稍候或检查辅助服务。");
        requireBatteryExemption("AutoX", null);
        if (helper) requireBatteryExemption("微信控件辅助", "local.wechat.accessibilityhelper");
        readState(); // Do not reset unreadable deduplication records.
        files.write(BASE + "run-request.json", JSON.stringify({maxMinutes: 30, source: "phone_panel", requestedAt: new Date().toISOString()}));
        if (files.exists(STOP) && !files.remove(STOP)) throw new Error("无法清除停止标记");
        engines.execScriptFile(WORKER);
        ui.hintText.setText("测试已启动。请保持微信聊天列表可见，再从另一台手机真正 @jarvis 发送普通文字。");
        app.launchPackage("com.tencent.mm");
    } catch (e) { ui.hintText.setText(String(e.message || e)); }
    finally { setTimeout(function() { busy = false; refresh(); }, 3000); }
});
ui.recoverButton.on("click", function() {
    if (busy) return;
    busy = true;
    try {
        recoveryController.recover();
        ui.hintText.setText("已恢复为停止状态，历史编号已保留。请检查测试1旧消息和输入框，再开始；旧消息不会自动补发。");
    } catch(e) { ui.hintText.setText("恢复未完成，请保持停止并检查：" + String(e.message || e)); }
    finally { busy = false; refresh(); }
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
ui.batteryButton.on("click", function() {
    try { app.startActivity({action: "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS"}); }
    catch(e) { ui.hintText.setText("请在系统设置中搜索“电池优化”，选择“所有应用”，分别将 AutoX 和微信控件辅助设为“不允许”。"); }
});
ui.shortcutButton.on("click", function() {
    try {
        var manager = context.getSystemService("shortcut");
        if (!manager || !manager.isRequestPinShortcutSupported()) throw new Error("当前桌面不支持快捷方式，请从 AutoX 打开本脚本。");
        var intent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
        intent.setClassName(context.getPackageName(), "org.autojs.autojs.external.open.RunIntentActivity");
        intent.setData(android.net.Uri.parse("file://" + BASE + "open-phone-panel.js"));
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
