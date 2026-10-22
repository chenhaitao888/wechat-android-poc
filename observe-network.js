// Read-only Android network observation for one subsequent watcher run.
// No UI access, network requests, network setting changes, or message contents.
var NET = {base:"/sdcard/wechat-android-poc/", limitMs:45*60*1000};
NET.dir=NET.base+"artifacts/";
NET.statePath=NET.dir+"network-observer-state.json";
NET.logPath=NET.dir+"network-observer-events.jsonl";
NET.stopPath=NET.base+"NETWORK_OBSERVER_STOP";
NET.lock=new java.io.File(NET.base+"network-observer.lock");
files.ensureDir(NET.dir);
if(!NET.lock.createNewFile()) throw new Error("Network observer already locked; check existing observer first");
NET.monoStart=android.os.SystemClock.elapsedRealtime();
NET.state={startedAt:new Date().toISOString(),status:"starting",watchedRunStartedAt:null,samples:0};
function netWatchState() {
    var path=NET.dir+"watch-state.json";
    if(!files.exists(path)) return {};
    var s=JSON.parse(files.read(path));
    return {startedAt:s.startedAt||null,status:s.status||null};
}
function netSnapshot() {
    var cm=context.getSystemService("connectivity");
    var info=cm.getActiveNetworkInfo();
    var active=cm.getActiveNetwork();
    var caps=active ? cm.getNetworkCapabilities(active) : null;
    var C=android.net.NetworkCapabilities;
    var usb=context.registerReceiver(null,new android.content.IntentFilter("android.hardware.usb.action.USB_STATE"));
    var transports=[];
    if(caps) {
        if(caps.hasTransport(C.TRANSPORT_WIFI)) transports.push("wifi");
        if(caps.hasTransport(C.TRANSPORT_CELLULAR)) transports.push("cellular");
        if(caps.hasTransport(C.TRANSPORT_ETHERNET)) transports.push("ethernet");
        if(caps.hasTransport(C.TRANSPORT_VPN)) transports.push("vpn");
    }
    return {connected:!!(info&&info.isConnected()),activeNetwork:!!active,
        internetCapability:!!(caps&&caps.hasCapability(C.NET_CAPABILITY_INTERNET)),
        validated:!!(caps&&caps.hasCapability(C.NET_CAPABILITY_VALIDATED)),transports:transports,
        usbConnected:usb ? usb.getBooleanExtra("connected",false) : null,
        usbConfigured:usb ? usb.getBooleanExtra("configured",false) : null,
        screenInteractive:context.getSystemService("power").isInteractive(),
        keyguardLocked:context.getSystemService("keyguard").isKeyguardLocked()};
}
function netSave(type,detail) {
    var now=new Date().toISOString();
    NET.state.updatedAt=now;
    files.append(NET.logPath,JSON.stringify({time:now,type:type,observerStartedAt:NET.state.startedAt,elapsedMs:android.os.SystemClock.elapsedRealtime()-NET.monoStart,watchedRunStartedAt:NET.state.watchedRunStartedAt,detail:detail})+"\n");
    files.write(NET.statePath+".tmp",JSON.stringify(NET.state,null,2));
    if(!new java.io.File(NET.statePath+".tmp").renameTo(new java.io.File(NET.statePath))) throw new Error("Observer state replacement failed");
}
try {
    NET.initialRun=netWatchState().startedAt||null;
    NET.state.status="waiting_for_next_run";
    netSave("observer_started",{initialRunStartedAt:NET.initialRun,limitMinutes:45});
    var netLastKey="",netLastLog=-30000;
    while(android.os.SystemClock.elapsedRealtime()-NET.monoStart<NET.limitMs && !files.exists(NET.stopPath)) {
        var netWatch=netWatchState();
        if(!NET.state.watchedRunStartedAt && netWatch.startedAt && netWatch.startedAt!==NET.initialRun) {
            NET.state.watchedRunStartedAt=netWatch.startedAt;
            NET.state.status="observing";
            netSave("watcher_attached",{startedAt:netWatch.startedAt});
        }
        if(NET.state.watchedRunStartedAt && netWatch.startedAt!==NET.state.watchedRunStartedAt) throw new Error("Watcher run changed; start a separate observer for the new run");
        var netSample=netSnapshot();
        netSample.watcherStatus=netWatch.status;
        var netKey=JSON.stringify(netSample),netNow=android.os.SystemClock.elapsedRealtime()-NET.monoStart;
        if(netKey!==netLastKey || netNow-netLastLog>=30000) {
            NET.state.latest=netSample; NET.state.samples++;
            netSave("sample",netSample); netLastKey=netKey; netLastLog=netNow;
        }
        if(NET.state.watchedRunStartedAt && (netWatch.status==="stopped" || netWatch.status==="halted")) {
            NET.state.stopReason="watcher_finished"; break;
        }
        sleep(2000);
    }
    NET.state.status="stopped";
    NET.state.stopReason=NET.state.stopReason||(files.exists(NET.stopPath)?"observer_stop":"observer_time_limit");
    netSave("observer_stopped",{reason:NET.state.stopReason});
} catch(e) {
    NET.state.status="halted"; NET.state.error=String(e);
    netSave("observer_halted",{error:String(e)});
} finally { NET.lock.delete(); }
