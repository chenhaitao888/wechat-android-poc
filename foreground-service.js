// AutoX 7.2.4 script-service readiness, observed through Android's own-app service list.
// Read-only: does not start services, change preferences, or request permissions.
function isRunning() {
    try {
        var pkg = String(context.getPackageName());
        var services = context.getSystemService("activity").getRunningServices(100);
        if (!services) return null;
        for (var i = 0; i < services.size(); i++) {
            var item = services.get(i), component = item.service;
            if (String(component.getPackageName()) === pkg &&
                String(component.getClassName()) === "com.stardust.autojs.IndependentScriptService") return !!item.foreground;
        }
        return false;
    } catch (e) { return null; }
}
function isBatteryOptimizationIgnored(packageName) {
    try { return !!context.getSystemService("power").isIgnoringBatteryOptimizations(packageName || context.getPackageName()); }
    catch (e) { return null; }
}
module.exports = {isRunning:isRunning, isBatteryOptimizationIgnored:isBatteryOptimizationIgnored};
