// Read-only timing probe. Never clicks controls, edits drafts, or sends messages.
auto.waitFor();
var B="/sdcard/wechat-android-poc/", D=B+"artifacts/", P="com.tencent.mm";
if(files.exists(B+"watch.lock"))throw new Error("Stop watcher before probe");
var started=android.os.SystemClock.elapsedRealtime(), phase="startup", ended=false;
files.write(D+"control-probe-pulses.jsonl","");
files.write(D+"control-probe-samples.jsonl","");
function append(name,data){data.time=new Date().toISOString();files.append(D+name,JSON.stringify(data)+"\n");}
function usb(){var u=context.registerReceiver(null,new android.content.IntentFilter("android.hardware.usb.action.USB_STATE"));return u?u.getBooleanExtra("connected",false):null;}
var pulse=threads.start(function(){while(!ended){append("control-probe-pulses.jsonl",{phase:phase,usb:usb(),elapsedMs:android.os.SystemClock.elapsedRealtime()-started});sleep(1000);}});
function timed(label,fn){phase=label;var t=android.os.SystemClock.elapsedRealtime();var v=fn();return {value:v,ms:android.os.SystemClock.elapsedRealtime()-t};}
try{
 device.keepScreenOn(180000);app.launchPackage(P);sleep(1500);
 while(android.os.SystemClock.elapsedRealtime()-started<180000){
  var a=timed("selector_title",function(){var n=id(P+":id/obn").findOnce();return n?{approved:/^测试1\(\d+\)$/.test(String(n.text()||"")),top:n.bounds().top,bottom:n.bounds().bottom}:null;});
  var b=timed("native_root",function(){var n=auto.service.getRootInActiveWindow();try{return n?{pkg:String(n.getPackageName()),children:n.getChildCount()}:null;}finally{if(n)n.recycle();}});
  var c=timed("selector_input",function(){return !!id(P+":id/bkk").findOnce();});
  var d=timed("foreground_status",function(){return require(B+"foreground-service.js").isRunning();});
  append("control-probe-samples.jsonl",{usb:usb(),title:a,root:b,input:c,foreground:d});phase="sleep";sleep(500);
 }
 append("control-probe-samples.jsonl",{finished:true});
}catch(e){append("control-probe-samples.jsonl",{error:String(e),phase:phase});}
finally{ended=true;pulse.interrupt();device.cancelKeepingAwake();}
