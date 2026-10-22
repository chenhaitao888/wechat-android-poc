// Give the panel its own Android task, even after opening the AutoX main screen.
// AutoX 7.2.4: the public JS wrapper drops intentFlags, so use its underlying API.
// Opening the panel never starts or stops the reply watcher.
var base = "/sdcard/wechat-android-poc/";
var config = new com.stardust.autojs.execution.ExecutionConfig();
config.setWorkingDirectory(base);
config.setIntentFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_ACTIVITY_MULTIPLE_TASK);
runtime.engines.execScriptFile(base + "phone-panel.js", config);
