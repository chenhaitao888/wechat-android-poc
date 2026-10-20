// Restore the native screen reader through the normal Settings switch and dialog.
auto.waitFor();
sleep(800);
function confirmDisable() {
    var title = packageName("com.android.settings").id("android:id/alertTitle").text("是否停用屏幕朗读？").findOnce();
    if (!title) return false;
    var ok = packageName("com.android.settings").id("android:id/button1").text("确定").findOnce();
    if (!ok || !ok.click()) throw new Error("Cannot confirm screen-reader shutdown");
    return true;
}
if (confirmDisable()) exit();
var settingsTitle = packageName("com.android.settings").id("android:id/action_bar_title").text("屏幕朗读").findOnce();
if (!settingsTitle) throw new Error("Not on the native screen-reader settings page");
var switches = packageName("com.android.settings").id("android:id/switch_widget").checked(true).find();
var target = null;
for (var i = 0; i < switches.size(); i++) {
    var node = switches.get(i);
    if (node.bounds().top >= 300 && node.bounds().bottom <= 470) target = node;
}
if (!target) throw new Error("Enabled main screen-reader switch not found; no action");
if (!target.click()) throw new Error("Main switch click failed");
sleep(700);
if (!confirmDisable()) throw new Error("Inspect settings before any further action");
