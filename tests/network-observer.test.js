const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'..','observe-network.js'),'utf8');
const BASE='/sdcard/wechat-android-poc/';
const WATCH=BASE+'artifacts/watch-state.json';
const LOCK=BASE+'network-observer.lock';
const STOP=BASE+'NETWORK_OBSERVER_STOP';
const OLD='2026-10-20T00:00:00Z',RUN='2026-10-22T00:00:00Z';
function host(options={}) {
    let now=0;
    const disk=new Map();
    if(options.lock) disk.set(LOCK,'existing observer');
    const writes=[];
    const privateText='private chat must never be exported';
    function watcher() {
        const started=options.neverStart ? false : now>=4000;
        return {startedAt:options.restartAt && now>=options.restartAt ? '2026-10-22T00:01:00Z' : started?RUN:OLD,status:started && now<14000?'watching':'stopped',commands:{secret:privateText}};
    }
    const connected=()=>!(now>=6000 && now<10000);
    function File(name){this.name=name;}
    File.prototype.createNewFile=function(){if(disk.has(this.name))return false;disk.set(this.name,'');return true;};
    File.prototype.renameTo=function(target){assert.ok(disk.has(this.name));disk.set(target.name,disk.get(this.name));disk.delete(this.name);return true;};
    File.prototype.delete=function(){return disk.delete(this.name);};
    function write(name,value,append){
        assert.ok([BASE+'artifacts/network-observer-state.json.tmp',BASE+'artifacts/network-observer-events.jsonl'].includes(name),'Observer must only write its own artifacts');
        writes.push(name); disk.set(name,(append?(disk.get(name)||''):'')+value);
    }
    const epoch=Date.parse(RUN);
    function ClockDate(){return new Date(epoch+now);}
    const cm={
        getActiveNetworkInfo:()=>{if(options.permissionError)throw new Error('ACCESS_NETWORK_STATE denied');return connected()?{isConnected:()=>true}:null;},
        getActiveNetwork:()=>connected()?{}:null,
        getNetworkCapabilities:()=>({hasCapability:()=>true,hasTransport:t=>t===1}),
    };
    const context=vm.createContext({
        Date:ClockDate,
        java:{io:{File}},
        android:{os:{SystemClock:{elapsedRealtime:()=>now}},net:{NetworkCapabilities:{TRANSPORT_WIFI:1,TRANSPORT_CELLULAR:0,TRANSPORT_ETHERNET:3,TRANSPORT_VPN:4,NET_CAPABILITY_INTERNET:12,NET_CAPABILITY_VALIDATED:16}},content:{IntentFilter:function(){}}},
        context:{getSystemService:name=>({connectivity:cm,power:{isInteractive:()=>true},keyguard:{isKeyguardLocked:()=>false}})[name],registerReceiver:()=>({getBooleanExtra:()=>now<4000})},
        files:{ensureDir:()=>{},exists:name=>name===WATCH||disk.has(name),read:name=>name===WATCH?JSON.stringify(watcher()):disk.get(name),write:(n,v)=>write(n,v,false),append:(n,v)=>write(n,v,true)},
        sleep:ms=>{now+=ms;if(options.stopAt && now>=options.stopAt)disk.set(STOP,'requested');},
    });
    return {run:()=>vm.runInContext(source,context,{timeout:2000}),disk,snapshot:()=>({now,writes,privateText,state:JSON.parse(disk.get(BASE+'artifacts/network-observer-state.json')||'null'),events:(disk.get(BASE+'artifacts/network-observer-events.jsonl')||'').trim().split('\n').filter(Boolean).map(JSON.parse)})};
}

test('observer waits for a new run, records offline/reconnect, and stops with that run without exporting chat',()=>{
    const h=host();h.run();const s=h.snapshot();
    assert.equal(s.now,14000);
    assert.equal(s.state.watchedRunStartedAt,RUN);
    assert.equal(s.state.stopReason,'watcher_finished');
    const samples=s.events.filter(e=>e.type==='sample');
    assert.ok(samples.some(e=>e.detail.connected===false));
    assert.ok(samples.some(e=>e.elapsedMs>=10000 && e.detail.validated===true));
    assert.equal(JSON.stringify(s.events).includes(s.privateText),false);
    assert.equal(h.disk.has(LOCK),false);
});

test('a second observer cannot delete or overwrite the first observer lock',()=>{
    const h=host({lock:true});assert.throws(h.run,/already locked/);
    assert.equal(h.disk.get(LOCK),'existing observer');
    assert.equal(h.snapshot().writes.length,0);
});

test('observer STOP ends only the observer and releases its lock',()=>{
    const h=host({stopAt:6000});h.run();const s=h.snapshot();
    assert.equal(s.state.stopReason,'observer_stop');
    assert.equal(s.now,6000);
    assert.equal(h.disk.has(BASE+'STOP'),false);
    assert.equal(h.disk.has(LOCK),false);
});

test('observer expires after 45 minutes if no new watcher starts',()=>{
    const h=host({neverStart:true});h.run();const s=h.snapshot();
    assert.equal(s.now,45*60*1000);
    assert.equal(s.state.stopReason,'observer_time_limit');
    assert.equal(h.disk.has(LOCK),false);
});

test('network permission failure is explicit and releases the observer lock',()=>{
    const h=host({permissionError:true});h.run();const s=h.snapshot();
    assert.equal(s.state.status,'halted');
    assert.match(s.state.error,/ACCESS_NETWORK_STATE/);
    assert.equal(h.disk.has(LOCK),false);
});

test('observer refuses to silently combine two watcher runs',()=>{
    const h=host({restartAt:12000});h.run();const s=h.snapshot();
    assert.equal(s.state.status,'halted');
    assert.match(s.state.error,/Watcher run changed/);
    assert.equal(s.state.watchedRunStartedAt,RUN);
    assert.equal(h.disk.has(LOCK),false);
});
