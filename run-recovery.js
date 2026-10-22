// Restore a stopped state after a verified process exit or device reboot.
// Never launch a watcher, clear deduplication records, or replay messages here.
var PACKAGE = "org.autojs.autoxjs.v7";
function whole(value, minimum) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= minimum;
}
function identityValid(value) {
    return value && value.packageName === PACKAGE && whole(value.pid, 1) && whole(value.uid, 1) &&
        whole(value.bootCount, 0) && whole(value.processStartedElapsedMs, 0) &&
        typeof value.processName === "string" &&
        (value.processName === PACKAGE || value.processName.indexOf(PACKAGE + ":") === 0);
}
function nativeSnapshot() {
    var current = {
        packageName: String(context.getPackageName()),
        pid: Number(android.os.Process.myPid()), uid: Number(android.os.Process.myUid()),
        bootCount: Number(android.provider.Settings.Global.getInt(context.getContentResolver(), "boot_count", -1)),
        processName: String(android.app.Application.getProcessName()),
        processStartedElapsedMs: Number(android.os.Process.getStartElapsedRealtime()),
        ownProcesses: null
    };
    var processes = context.getSystemService("activity").getRunningAppProcesses();
    if (processes) {
        current.ownProcesses = [];
        for (var i = 0; i < processes.size(); i++) {
            var process = processes.get(i);
            if (Number(process.uid) === current.uid) current.ownProcesses.push({pid:Number(process.pid), name:String(process.processName)});
        }
    }
    return current;
}
function makeOwner() {
    var current = nativeSnapshot();
    if (!identityValid(current)) throw new Error("Cannot identify watcher process; startup refused");
    delete current.ownProcesses;
    current.version = 1;
    current.createdAt = new Date().toISOString();
    return current;
}
function assess(owner, current, activeWorkers) {
    function no(reason) { return {recoverable:false, reason:reason}; }
    if (activeWorkers !== 0) return no("active_worker");
    if (!owner || owner.version !== 1 || !identityValid(owner) || !identityValid(current)) return no("identity_unknown");
    if (owner.uid !== current.uid) return no("identity_unknown");
    if (current.bootCount > owner.bootCount) return {recoverable:true, reason:"device_reboot"};
    if (current.bootCount !== owner.bootCount) return no("identity_unknown");
    if (!Array.isArray(current.ownProcesses) || !current.ownProcesses.some(function(p) {return p.pid === current.pid && p.name === current.processName;})) return no("process_list_unavailable");
    if (owner.pid === current.pid) {
        if (owner.processStartedElapsedMs < current.processStartedElapsedMs) return {recoverable:true, reason:"process_exit"};
        return no("owner_process_running");
    }
    if (current.ownProcesses.some(function(p) {return p.pid === owner.pid;})) return no("owner_process_running");
    return {recoverable:true, reason:"process_exit"};
}
function validLedger(state) {
    if (!state || state.group !== "测试1" || state.bot !== "jarvis" ||
        !state.commands || typeof state.commands !== "object" || Array.isArray(state.commands)) return false;
    return Object.keys(state.commands).every(function(code) {
        var item = state.commands[code];
        return /^[0-9]{3}$/.test(code) && item && typeof item === "object" && !Array.isArray(item) && typeof item.status === "string";
    });
}
function createController(base, activeWorkers, providedHost) {
    var host = providedHost || {
        exists:function(p) {return files.exists(p);}, read:function(p) {return files.read(p);},
        write:function(p,s) {files.write(p,s);}, append:function(p,s) {files.append(p,s);},
        rename:function(a,b) {return new java.io.File(a).renameTo(new java.io.File(b));},
        now:function() {return new Date().toISOString();},
        unique:function() {return String(java.util.UUID.randomUUID());}, snapshot:nativeSnapshot
    };
    var lockPath = base + "watch.lock", statePath = base + "artifacts/watch-state.json";
    function candidate() {
        if (!host.exists(lockPath)) return {recoverable:false, reason:"no_lock"};
        var result;
        try {
            var lockRaw = host.read(lockPath), stateRaw = host.read(statePath);
            var owner = JSON.parse(lockRaw), state = JSON.parse(stateRaw);
            if (!validLedger(state)) return {recoverable:false, reason:"invalid_ledger"};
            result = assess(owner, host.snapshot(), activeWorkers());
            result.owner = owner; result.state = state; result.lockRaw = lockRaw; result.stateRaw = stateRaw;
        } catch(e) { return {recoverable:false, reason:"record_unreadable"}; }
        return result;
    }
    function inspect() {
        var result = candidate();
        return {recoverable:result.recoverable, reason:result.reason};
    }
    function recover() {
        var before = candidate();
        if (!before.recoverable) throw new Error("Recovery refused: " + before.reason);
        var time = host.now(), prefix = base + "artifacts/interrupted-run-" + host.unique();
        host.write(base + "STOP", "Recovery requires manual restart at " + time);
        var backup = JSON.stringify({time:time, reason:before.reason, stateRaw:before.stateRaw, lockRaw:before.lockRaw}, null, 2);
        host.write(prefix + ".json", backup);
        if (host.read(prefix + ".json") !== backup) throw new Error("Recovery backup verification failed");
        var check = candidate();
        if (!check.recoverable || check.lockRaw !== before.lockRaw || check.stateRaw !== before.stateRaw) throw new Error("Recovery inputs changed; no lock released");
        var state = before.state;
        state.interruptedStatus = state.status;
        state.interruptedUpdatedAt = state.updatedAt || null;
        state.status = "stopped";
        state.stopReason = "recovered_after_" + before.reason;
        state.recoveredAt = time; state.updatedAt = time;
        host.write(statePath + ".recovery.tmp", JSON.stringify(state, null, 2));
        if (!host.rename(statePath + ".recovery.tmp", statePath)) throw new Error("Recovery state replacement failed; lock retained");
        if (host.read(lockPath) !== before.lockRaw || !assess(before.owner, host.snapshot(), activeWorkers()).recoverable) throw new Error("Recovery owner changed; lock retained");
        // Move the old lock into the archive only after STOP, backup and ledger are saved.
        if (!host.rename(lockPath, prefix + ".lock.json")) throw new Error("Recovery lock archive failed; startup remains blocked");
        var result = {time:time, reason:before.reason, previousStartedAt:state.startedAt || null, backup:prefix + ".json", commandCount:Object.keys(state.commands).length};
        host.append(base + "artifacts/recovery-events.jsonl", JSON.stringify(result) + "\n");
        return result;
    }
    return {inspect:inspect, recover:recover};
}
module.exports = {nativeSnapshot:nativeSnapshot, makeOwner:makeOwner, assess:assess, validLedger:validLedger, createController:createController};
