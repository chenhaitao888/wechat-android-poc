const test = require('node:test');
const assert = require('node:assert/strict');
const recovery = require('../run-recovery');
const BASE='/sdcard/wechat-android-poc/', LOCK=BASE+'watch.lock', STATE=BASE+'artifacts/watch-state.json';
const PKG='org.autojs.autoxjs.v7';
const owner={version:1,packageName:PKG,processName:PKG+':script',pid:101,uid:10001,bootCount:7,processStartedElapsedMs:100};
const current={...owner,pid:202,processStartedElapsedMs:200,ownProcesses:[{pid:202,name:PKG+':script'}]};
const ledger={group:'测试1',bot:'jarvis',status:'watching',startedAt:'2026-10-22T00:00:00Z',updatedAt:'2026-10-22T00:01:00Z',sentThisRun:1,commands:{'027':{status:'outgoing_bubble_observed'},'028':{status:'attempting',attemptedAt:'2026-10-22T00:00:59Z'}}};
const copy=value=>JSON.parse(JSON.stringify(value));

function host(options={}) {
    const disk=new Map([[LOCK,JSON.stringify(options.owner||owner)],[STATE,options.stateRaw||JSON.stringify(ledger)]]);
    let workers=options.workers||0;
    const writes=[];
    const api={
        exists:p=>disk.has(p), read:p=>{if(!disk.has(p))throw new Error('Missing file');return disk.get(p);},
        write:(p,s)=>{
            if(options.failBackup && p.endsWith('interrupted-run-test.json'))throw new Error('disk full');
            writes.push(p);disk.set(p,s);
            if(options.race && p.endsWith('interrupted-run-test.json'))workers=1;
        },
        append:(p,s)=>{writes.push(p);disk.set(p,(disk.get(p)||'')+s);},
        rename:(a,b)=>{
            if(options.failStateRename && a===STATE+'.recovery.tmp')return false;
            if(options.failLockRename && a===LOCK)return false;
            if(!disk.has(a))return false;
            disk.set(b,disk.get(a));disk.delete(a);return true;
        },
        now:()=> '2026-10-22T00:02:00Z', unique:()=> 'test', snapshot:()=>copy(options.current||current),
    };
    return {disk,writes,controller:recovery.createController(BASE,()=>workers,api)};
}

test('a verified dead script process permits recovery even when the main app still runs',()=>{
    const snapshot=copy(current);snapshot.ownProcesses.push({pid:300,name:PKG});
    assert.deepEqual(recovery.assess(owner,snapshot,0),{recoverable:true,reason:'process_exit'});
});
test('reboot evidence works even with reused PID and an unavailable process list',()=>{
    assert.deepEqual(recovery.assess(owner,{...owner,bootCount:8,ownProcesses:null},0),{recoverable:true,reason:'device_reboot'});
});
test('a current worker or the original process blocks recovery',()=>{
    assert.equal(recovery.assess(owner,current,1).recoverable,false);
    assert.equal(recovery.assess(owner,{...current,ownProcesses:[...current.ownProcesses,{pid:101,name:PKG+':script'}]},0).recoverable,false);
    assert.equal(recovery.assess(owner,{...owner,ownProcesses:[{pid:101,name:PKG+':script'}]},0).recoverable,false);
});
test('PID reuse requires a strictly newer process start time',()=>{
    assert.equal(recovery.assess(owner,{...owner,processStartedElapsedMs:300,ownProcesses:[{pid:101,name:PKG+':script'}]},0).recoverable,true);
    assert.equal(recovery.assess(owner,{...owner,processStartedElapsedMs:50,ownProcesses:[{pid:101,name:PKG+':script'}]},0).recoverable,false);
});
test('unknown identity, boot rollback and incomplete process listing all block recovery',()=>{
    for(const snapshot of [{...current,bootCount:6},{...current,uid:9},{...current,ownProcesses:null},{...current,ownProcesses:[]},{...current,bootCount:-1}]) {
        assert.equal(recovery.assess(owner,snapshot,0).recoverable,false);
    }
    assert.equal(recovery.assess({},current,0).recoverable,false);
});
test('recovery archives original evidence, preserves completed and uncertain attempts, and stays stopped',()=>{
    const h=host(),originalState=h.disk.get(STATE),originalLock=h.disk.get(LOCK);
    const result=h.controller.recover();
    const saved=JSON.parse(h.disk.get(STATE));
    assert.equal(result.reason,'process_exit');
    assert.deepEqual(saved.commands,ledger.commands);
    assert.equal(saved.status,'stopped');
    assert.equal(saved.stopReason,'recovered_after_process_exit');
    assert.equal(saved.interruptedStatus,'watching');
    assert.equal(h.disk.has(LOCK),false);
    assert.ok(h.disk.has(BASE+'STOP'));
    const archive=JSON.parse(h.disk.get(BASE+'artifacts/interrupted-run-test.json'));
    assert.equal(archive.stateRaw,originalState);
    assert.equal(archive.lockRaw,originalLock);
    assert.equal(h.disk.get(BASE+'artifacts/interrupted-run-test.lock.json'),originalLock);
    assert.equal(h.disk.has(BASE+'run-request.json'),false);
    assert.equal(h.disk.has(BASE+'artifacts/watch-events.jsonl'),false);
});
test('reboot recovery records interruption instead of claiming normal completion',()=>{
    const h=host({current:{...current,bootCount:8}});h.controller.recover();
    assert.equal(JSON.parse(h.disk.get(STATE)).stopReason,'recovered_after_device_reboot');
    assert.match(h.disk.get(BASE+'artifacts/recovery-events.jsonl'),/device_reboot/);
});
test('corrupt and wrong-target ledgers remain untouched',()=>{
    for(const stateRaw of ['{broken',JSON.stringify({...ledger,group:'other'}),JSON.stringify({...ledger,commands:[]})]) {
        const h=host({stateRaw});
        assert.throws(()=>h.controller.recover(),/Recovery refused/);
        assert.equal(h.disk.get(STATE),stateRaw);
        assert.ok(h.disk.has(LOCK));
        assert.equal(h.writes.length,0);
    }
});
test('legacy empty locks are not silently discarded',()=>{
    const h=host();h.disk.set(LOCK,'');
    assert.throws(()=>h.controller.recover(),/Recovery refused/);
    assert.equal(h.disk.get(LOCK),'');assert.equal(h.writes.length,0);
});
test('a newly visible worker during recovery prevents releasing the lock',()=>{
    const h=host({race:true}),state=h.disk.get(STATE);
    assert.throws(()=>h.controller.recover(),/inputs changed/);
    assert.ok(h.disk.has(LOCK));assert.equal(h.disk.get(STATE),state);
});
test('backup or state-write failure retains the original ledger and lock',()=>{
    for(const options of [{failBackup:true},{failStateRename:true}]) {
        const h=host(options),state=h.disk.get(STATE);
        assert.throws(()=>h.controller.recover());
        assert.ok(h.disk.has(LOCK));assert.equal(h.disk.get(STATE),state);
        assert.ok(h.disk.has(BASE+'STOP'));
    }
});
test('lock archival failure keeps startup blocked without losing deduplication records',()=>{
    const h=host({failLockRename:true});
    assert.throws(()=>h.controller.recover(),/startup remains blocked/);
    assert.ok(h.disk.has(LOCK));
    assert.deepEqual(JSON.parse(h.disk.get(STATE)).commands,ledger.commands);
});


const textEntry={status:'attempting',incomingText:'@jarvis 一个问题',sender:'tester',reply:'收到你的消息（自动回复测试，回执 Q3）。'};
test('process and reboot recovery preserve ordinary receipts and their sequence',()=>{
    for(const snapshot of [current,{...current,bootCount:8}]) {
        const before={...ledger,boundaryVersion:4,textReplies:{'text-3':textEntry,'text-4':{...textEntry,status:'uncertain'}}};
        const h=host({current:snapshot,stateRaw:JSON.stringify(before)});h.controller.recover();
        const after=JSON.parse(h.disk.get(STATE));
        assert.deepEqual(after.textReplies,before.textReplies);assert.equal(after.boundaryVersion,4);
        assert.deepEqual(after.commands,before.commands);assert.equal(after.status,'stopped');
    }
});
test('missing counters, malformed receipts and counter rollback block recovery without rewriting evidence',()=>{
    const cases=[{textReplies:{}},{boundaryVersion:1},{boundaryVersion:1,textReplies:[]},
        {boundaryVersion:2,textReplies:{'text-3':textEntry}},
        {boundaryVersion:3,textReplies:{'text-3':{...textEntry,sender:''}}},
        {boundaryVersion:9007199254740992,textReplies:{}}];
    for(const extra of cases) {
        const raw=JSON.stringify({...ledger,...extra});const h=host({stateRaw:raw});
        assert.throws(()=>h.controller.recover(),/Recovery refused/);
        assert.equal(h.disk.get(STATE),raw);assert.ok(h.disk.has(LOCK));assert.equal(h.writes.length,0);
    }
});
