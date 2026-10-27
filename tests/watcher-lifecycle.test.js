// Lifecycle tests run the deployed script in a memory-only AutoX host.
// Native UI is stubbed; real WeChat behavior is covered by device tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../mention-policy');
const recovery = require('../run-recovery');
const source = fs.readFileSync(path.join(__dirname, '..', 'watch-test-group.js'), 'utf8');
const BASE = '/sdcard/wechat-android-poc/';
const STATE = BASE + 'artifacts/watch-state.json';
const LOCK = BASE + 'watch.lock';
const STOP = BASE + 'STOP';
const prior = {group:'测试1',bot:'jarvis',commands:{'021':{status:'outgoing_bubble_observed'}}};

function host(options = {}) {
    let now = 0;
    let uiCalls = 0;
    let cancelled = 0;
    const keptAwake = [];
    const observationTimes = [];
    let rowClicks = 0;
    const inWindow = range => range && now >= range[0] && now < range[1];
    const available = () => !inWindow(options.accessibilityUnavailable);
    const enabledServices = () => 'org.autojs.autoxjs.v7/Service' + (available() ? ':local.wechat.accessibilityhelper/Service' : '');
    const disk = new Map([[STATE, options.ledger ?? JSON.stringify(prior)]]);
    if (options.lock) disk.set(LOCK, 'another watcher owns this lock');
    if (options.stop) disk.set(STOP, 'requested');
    if (options.minutes) disk.set(BASE + 'run-request.json', JSON.stringify({maxMinutes:options.minutes}));
    const epoch = Date.parse('2026-01-01T00:00:00Z');
    const wall = () => epoch + now - (options.wallClockRollback && now >= 300000 ? 86400000 : 0);
    function ClockDate(...args) { return new Date(...(args.length ? args : [wall()])); }
    ClockDate.now = wall;
    ClockDate.parse = Date.parse;
    function File(name) { this.name = name; }
    File.prototype.createNewFile = function() {
        if (disk.has(this.name)) return false;
        disk.set(this.name, ''); return true;
    };
    File.prototype.renameTo = function(target) {
        if (!disk.has(this.name)) return false;
        disk.set(target.name, disk.get(this.name)); disk.delete(this.name); return true;
    };
    File.prototype.delete = function() { return disk.delete(this.name); };
    const autoxRuntime = {nativeRuntime:true};
    const globals = {
        runtime:autoxRuntime,
        Date: ClockDate,
        files: {
            exists: name => disk.has(name),
            read: name => { if (!disk.has(name)) throw new Error('Missing file'); return disk.get(name); },
            write: (name, data) => disk.set(name, String(data)),
            append: (name, data) => disk.set(name, (disk.get(name) || '') + data),
            ensureDir: () => {},
        },
        require: name => {
            if (name === BASE + 'foreground-service.js') return {isRunning:() => !inWindow(options.foregroundUnavailable),isBatteryOptimizationIgnored:pkg => pkg === 'local.wechat.accessibilityhelper' && Object.hasOwn(options,'helperBatteryExempt') ? options.helperBatteryExempt : true};
            if (name === BASE + 'run-recovery.js') return {validLedger:recovery.validLedger,makeOwner:() => ({version:1,pid:101,uid:10001,bootCount:7,packageName:'org.autojs.autoxjs.v7',processName:'org.autojs.autoxjs.v7:script',processStartedElapsedMs:100})};
            assert.equal(name, BASE + 'mention-policy.js'); return policy;
        },
        java: {io:{File}},
        android: {
            os:{SystemClock:{elapsedRealtime:() => now}},
            content:{IntentFilter:function(){}},
            provider:{Settings:{Secure:{getString:enabledServices}}},
        },
        context: {
            registerReceiver:() => null,
            getContentResolver:() => ({}),
            getSystemService: name => ({
                accessibility:{isTouchExplorationEnabled:available},
                power:{isInteractive:() => !inWindow(options.screenOff)},
                keyguard:{isKeyguardLocked:() => !!inWindow(options.keyguardLocked)},
            })[name],
        },
        device: {
            getBattery:() => 100, isCharging:() => false,
            keepScreenOn: duration => keptAwake.push(duration),
            cancelKeepingAwake:() => { cancelled++; },
        },
        sleep: milliseconds => {
            now += milliseconds;
            if (options.stopAfterMs && now >= options.stopAfterMs) disk.set(STOP, 'requested while running');
        },
        id:() => { uiCalls++; throw new Error('Native UI must not be touched by this lifecycle test'); },
        console:{error:() => {}},
        __testObservation:() => {
            observationTimes.push(now);
            if (!options.realPreparation || now < (options.listReadyAt || 0)) return null;
            return {preview:'previous reply',unread:'0',row:{click:() => {rowClicks++;return true;}}};
        },
    };
    let context;
    globals.auto = {waitFor:() => {
        // Function declarations have been initialized at this point. Replace only
        // native UI boundaries; the actual lock, ledger, loop and finally execute.
        vm.runInContext('observation = __testObservation;', context);
        if (options.realPreparation) {
            vm.runInContext('chatRows = function() { return [{text:"previous reply",sender:"",direction:"outgoing",simpleText:true,fullyVisible:true}]; }; backToList = function() {}; waitForChatReady = function() {};', context);
        } else vm.runInContext('prepareBoundary = function() {};', context);
    }};
    context = vm.createContext(globals);
    return {
        run:() => vm.runInContext(source, context, {timeout:2000}),
        evaluate:code => vm.runInContext(code, context, {timeout:2000}),
        disk,
        snapshot:() => ({runtimeUnchanged:context.runtime===autoxRuntime,now,uiCalls,cancelled,keptAwake,observationTimes,rowClicks,state:JSON.parse(disk.get(STATE)),events:(disk.get(BASE+'artifacts/watch-events.jsonl')||'').trim().split('\n').filter(Boolean).map(JSON.parse)}),
    };
}

test('an existing lock prevents a second watcher without releasing the first lock', () => {
    const h=host({lock:true}); const before=h.disk.get(STATE);
    assert.throws(h.run, /Watcher lock exists/);
    assert.equal(h.disk.get(STATE), before);
    assert.equal(h.disk.get(LOCK), 'another watcher owns this lock');
    assert.equal(h.snapshot().cancelled, 0);
    assert.equal(h.snapshot().uiCalls, 0);
});

test('a corrupt ledger is preserved and never replaced by fresh deduplication state', () => {
    const h=host({ledger:'{corrupt'}); h.run();
    assert.equal(h.disk.get(STATE), '{corrupt');
    assert.ok(h.disk.has(BASE+'artifacts/last-start-error.json'));
    assert.equal(h.disk.has(LOCK), false);
});

test('a ledger for another group cannot be reused or overwritten', () => {
    const ledger=JSON.stringify({...prior,group:'another group'});
    const h=host({ledger}); h.run();
    assert.equal(h.disk.get(STATE), ledger);
    assert.equal(h.disk.has(LOCK), false);
});

test('STOP before startup preserves handled commands and avoids UI work', () => {
    const h=host({stop:true}); h.run(); const s=h.snapshot();
    assert.deepEqual(s.state.commands, prior.commands);
    assert.equal(s.state.status, 'stopped');
    assert.equal(s.state.stopReason, 'stop_file');
    assert.equal(s.uiCalls, 0);
    assert.deepEqual(s.keptAwake, []);
    assert.equal(h.disk.has(LOCK), false);
});

test('30-minute idle run stops at the monotonic time limit and releases the wake request and lock', () => {
    const h=host({minutes:30}); h.run(); const s=h.snapshot();
    assert.equal(s.now, 30*60*1000);
    assert.equal(s.state.status, 'stopped');
    assert.equal(s.state.stopReason, 'time_limit');
    assert.equal(s.state.sentThisRun, 0);
    assert.equal(s.events.filter(e=>e.type==='send_attempt').length, 0);
    assert.deepEqual(s.state.commands, prior.commands);
    assert.equal(s.cancelled, 1);
    assert.equal(h.disk.has(LOCK), false);
});

test('STOP during idle polling exits promptly without changing the send history', () => {
    const h=host({minutes:30,stopAfterMs:8400}); h.run(); const s=h.snapshot();
    assert.equal(s.now, 8400);
    assert.equal(s.state.stopReason, 'stop_file');
    assert.deepEqual(s.state.commands, prior.commands);
    assert.equal(s.cancelled, 1);
    assert.equal(h.disk.has(LOCK), false);
});

test('moving wall-clock time backwards does not extend the run duration', () => {
    const h=host({minutes:30,wallClockRollback:true}); h.run(); const s=h.snapshot();
    assert.equal(s.now, 30*60*1000);
    assert.equal(s.state.stopReason, 'time_limit');
    assert.equal(h.disk.has(LOCK), false);
});


test('startup waits for accessibility and a readable list before recording its boundary', () => {
    const h=host({realPreparation:true,accessibilityUnavailable:[0,2000],listReadyAt:3000,stopAfterMs:8000});
    h.run(); const s=h.snapshot();
    assert.ok(s.observationTimes.length > 0);
    assert.ok(s.observationTimes.every(t => t >= 2000));
    assert.equal(s.rowClicks, 1);
    assert.equal(s.events.filter(e => e.type === 'baseline_recorded').length, 1);
    assert.equal(s.state.stopReason, 'stop_file');
});

test('startup with a persistently unreadable list halts without clicking or losing history', () => {
    const h=host({realPreparation:true,listReadyAt:30000}); h.run(); const s=h.snapshot();
    assert.equal(s.now, 20000);
    assert.equal(s.rowClicks, 0);
    assert.equal(s.state.status, 'halted');
    assert.match(s.state.error, /等待20秒/);
    assert.deepEqual(s.state.commands, prior.commands);
    assert.equal(h.disk.has(LOCK), false);
});

for (const [name, option, status] of [
    ['screen is off', 'screenOff', 'waiting_for_unlock'],
    ['lit screen is locked', 'keyguardLocked', 'waiting_for_unlock'],
    ['accessibility provider is unavailable', 'accessibilityUnavailable', 'waiting_for_accessibility'],
]) {
    test(`polling suspends while ${name}, then resumes without clearing send history`, () => {
        const h=host({[option]:[2400,7200],stopAfterMs:9600}); h.run(); const s=h.snapshot();
        assert.ok(s.observationTimes.some(t => t < 2400));
        assert.ok(s.observationTimes.every(t => t < 2400 || t >= 7200));
        assert.ok(s.observationTimes.some(t => t >= 7200));
        const transitions=s.events.filter(e=>e.type==='runtime_availability').map(e=>e.detail.waiting);
        assert.deepEqual(transitions, [status,null]);
        assert.deepEqual(s.state.commands, prior.commands);
        assert.equal(s.state.stopReason, 'stop_file');
    });
}

test('STOP remains effective while waiting for unlock', () => {
    const h=host({keyguardLocked:[0,100000],stopAfterMs:2400}); h.run(); const s=h.snapshot();
    assert.equal(s.now, 2400);
    assert.equal(s.observationTimes.length, 0);
    assert.equal(s.state.stopReason, 'stop_file');
    assert.equal(h.disk.has(LOCK), false);
});


test('the watcher preserves the AutoX native runtime global used by selectors', () => {
    const h=host({stopAfterMs:2400}); h.run();
    assert.equal(h.snapshot().runtimeUnchanged, true);
});


function pageWaitHost(options={}) {
    const h=host({...options,stop:true}); h.run(); h.disk.delete(STOP);
    h.evaluate(`
        device.height = 2600;
        var testNode = {bounds:function(){return {width:function(){return 100;},height:function(){return 100;},top:100,bottom:200};}};
        inputBox = function(){return testNode;};
        id = function(){return {findOnce:function(){return testNode;}};};
    `);
    return h;
}

test('group transition waits beyond the previous fixed delay for title and controls to be ready', () => {
    const h=pageWaitHost();
    h.evaluate('groupOK=function(){return android.os.SystemClock.elapsedRealtime()>=2200;}; waitForChatReady();');
    assert.equal(h.snapshot().now,2200);
});

test('group transition times out without retrying navigation when the target never becomes ready', () => {
    const h=pageWaitHost();
    assert.throws(()=>h.evaluate('groupOK=function(){return false;}; waitForChatReady();'),/8秒仍未就绪/);
    assert.equal(h.snapshot().now,8000);
});

test('locking during a group transition stops before further UI work', () => {
    const h=pageWaitHost({keyguardLocked:[1000,10000]});
    assert.throws(()=>h.evaluate('groupOK=function(){return false;}; waitForChatReady();'),/waiting_for_unlock/);
    assert.equal(h.snapshot().now,1000);
});


test('startup without foreground service waits then stops without reading or clicking WeChat', () => {
    const h=host({realPreparation:true,foregroundUnavailable:[0,30000]});h.run();const s=h.snapshot();
    assert.equal(s.state.status,'halted');assert.equal(s.uiCalls,0);assert.equal(s.rowClicks,0);
    assert.equal(s.observationTimes.length,0);assert.deepEqual(s.state.commands,prior.commands);
});
test('a lost foreground service suspends UI polling until restored within the same run', () => {
    const h=host({foregroundUnavailable:[2400,7200],stopAfterMs:9600});h.run();const s=h.snapshot();
    assert.ok(s.observationTimes.some(t=>t<2400));assert.ok(s.observationTimes.every(t=>t<2400||t>=7200));
    assert.ok(s.observationTimes.some(t=>t>=7200));
    assert.ok(s.events.some(e=>e.type==='runtime_availability'&&e.detail.waiting==='waiting_for_foreground_service'));
    assert.deepEqual(s.state.commands,prior.commands);
});
function sendReadyHost(options={}) {
    const h=pageWaitHost(options);
    h.evaluate(`
        var draft='expected reply',sendReadyAt=1800,sendClicks=0,draftWrites=0;
        testNode.text=function(){return draft;};
        testNode.setText=function(){draftWrites++;};
        var sendNode={bounds:testNode.bounds,enabled:function(){return true;},click:function(){sendClicks++;}};
        groupOK=function(){return true;};
        packageName=function(){return {text:function(){return {findOnce:function(){return android.os.SystemClock.elapsedRealtime()>=sendReadyAt?sendNode:null;}};}};};
    `);
    return h;
}
test('delayed send controls are awaited without retyping or clicking', () => {
    const h=sendReadyHost();h.evaluate('waitForSendReady("expected reply");');
    assert.equal(h.snapshot().now,1800);assert.equal(h.evaluate('sendClicks+draftWrites'),0);
});
test('send readiness timeout preserves an altered draft and never clicks', () => {
    const h=sendReadyHost();h.evaluate('draft="changed by user";sendReadyAt=0;');
    assert.throws(()=>h.evaluate('waitForSendReady("expected reply");'),/4秒内/);
    assert.equal(h.snapshot().now,4000);assert.equal(h.evaluate('draft'), 'changed by user');
    assert.equal(h.evaluate('sendClicks+draftWrites'),0);
    assert.equal(h.snapshot().events.at(-1).detail.draftMatches,false);
});
test('lock or foreground loss during send readiness stops before any send action', () => {
    for(const condition of ['keyguardLocked','foregroundUnavailable']) {
        const h=sendReadyHost({[condition]:[1000,10000]});
        assert.throws(()=>h.evaluate('waitForSendReady("expected reply");'),/运行条件失效/);
        assert.equal(h.snapshot().now,1000);assert.equal(h.evaluate('sendClicks+draftWrites'),0);
    }
});


test('resuming inside a UI operation after the deadline stops before reading or clicking', () => {
    const h=sendReadyHost();
    h.evaluate('sleep(30*60*1000);');
    assert.throws(()=>h.evaluate('waitForSendReady("expected reply");'),/Run time limit reached/);
    assert.equal(h.evaluate('sendClicks+draftWrites'),0);
});
test('deadline reached inside a batch is recorded as a timed stop and releases the lock', () => {
    const h=host({minutes:30});
    h.evaluate('var originalAutoWait=auto.waitFor; auto.waitFor=function(){originalAutoWait(); processBatch=function(){sleep(30*60*1000);requireRuntimeReady();}; observation=function(){return {preview:"[有人@我] test",unread:"1"};};};');
    h.run();const s=h.snapshot();
    assert.equal(s.state.status,'stopped');assert.equal(s.state.stopReason,'time_limit');
    assert.equal(s.events.at(-1).detail.reason,'time_limit');assert.equal(h.disk.has(LOCK),false);
    assert.deepEqual(s.state.commands,prior.commands);
    assert.equal(s.events.filter(e=>e.type==='send_attempt').length,0);
});


test('helper battery status is recorded independently without assuming unknown means exempt', () => {
    for (const helperBatteryExempt of [true, false, null]) {
        const h=host({helperBatteryExempt,stopAfterMs:2400});h.run();const s=h.snapshot();
        assert.equal(s.state.health.helperBatteryOptimizationIgnored,helperBatteryExempt);
        assert.equal(s.state.health.batteryOptimizationIgnored,true);
        const start=s.events.find(e=>e.type==='started');
        assert.equal(start.detail.health.helperBatteryOptimizationIgnored,helperBatteryExempt);
        assert.deepEqual(s.state.commands,prior.commands);
    }
});


// Keep the real batch policy, persistence, send ordering and boundary advancement.
// Only native UI reads/actions are replaced with an in-memory conversation.
function ordinaryTextHost(options={}) {
    const h=pageWaitHost(options);
    h.evaluate(`
        var draft='',sendClicks=0,draftWrites=0,clickFails=false,confirmSend=true,attemptSavedBeforeClick=false;
        var oldRow={text:'@jarvis 测试021',sender:'tester',direction:'incoming',simpleText:true,fullyVisible:true};
        var oldAck={text:'收到，测试021（自动回复测试）。',sender:'',direction:'outgoing',simpleText:true,fullyVisible:true};
        var memoryRows=[oldRow,oldAck],memoryObservation;
        groupOK=function(){return true;};
        chatRows=function(){return memoryRows.slice();};
        observation=function(){return memoryObservation;};
        waitForChatReady=function(){};backToList=function(){};
        testNode.text=function(){return draft;};
        testNode.setText=function(value){draftWrites++;draft=value;return true;};
        inputBox=function(){return testNode;};
        findMessage=function(text,side){return memoryRows.some(function(r){return r.direction===side && policy.compact(r.text)===policy.compact(text);}) ? testNode : null;};
        var sendNode={bounds:testNode.bounds,enabled:function(){return true;},click:function(){
            var saved=JSON.parse(files.read(STATE));
            var entry=saved.textReplies['text-'+state.boundaryVersion];
            attemptSavedBeforeClick=!!entry && entry.status==='attempting';
            if(!attemptSavedBeforeClick) throw new Error('Attempt must be durable before click');
            sendClicks++;
            if(clickFails) return false;
            if(confirmSend) memoryRows.push({text:draft,sender:'',direction:'outgoing',simpleText:true,fullyVisible:true});
            draft='';return true;
        }};
        packageName=function(){return {text:function(){return {findOnce:function(){return sendNode;}};}};};
        rememberBoundary(memoryRows);
        function deliverQuestion(text) {
            memoryRows.push({text:text,sender:'tester',direction:'incoming',simpleText:true,fullyVisible:true});
            memoryObservation={preview:'[有人@我] tester: '+text,unread:'1',row:{click:function(){return true;}}};
            processBatch(memoryObservation);
        }
    `);
    return h;
}
test('three separately delivered identical questions each get one unique receipt',()=>{
    const h=ordinaryTextHost();
    for(let i=0;i<3;i++) h.evaluate('deliverQuestion("@jarvis 这个产品怎么申请？");');
    const s=h.snapshot();
    assert.equal(h.evaluate('sendClicks'),3);assert.equal(h.evaluate('attemptSavedBeforeClick'),true);
    assert.deepEqual(Object.keys(s.state.textReplies),['text-1','text-2','text-3']);
    assert.equal(new Set(Object.values(s.state.textReplies).map(x=>x.reply)).size,3);
    assert.ok(Object.values(s.state.textReplies).every(x=>x.status==='outgoing_bubble_observed'));
    assert.equal(s.state.boundaryVersion,4);assert.deepEqual(s.state.commands,prior.commands);
});
test('a failed send keeps a durable attempt and cannot click again for the same boundary',()=>{
    const h=ordinaryTextHost();h.evaluate('clickFails=true;');
    assert.throws(()=>h.evaluate('deliverQuestion("@jarvis 申请需要什么材料？");'),/Send result uncertain/);
    assert.equal(h.snapshot().state.textReplies['text-1'].status,'attempting');
    h.evaluate('clickFails=false;processBatch(memoryObservation);');
    assert.equal(h.evaluate('sendClicks'),1);assert.equal(h.evaluate('draftWrites'),1);
    assert.equal(h.snapshot().state.textReplies['text-1'].status,'attempting');
});
test('an unconfirmed outgoing bubble is never automatically retried',()=>{
    const h=ordinaryTextHost();h.evaluate('confirmSend=false;');
    assert.throws(()=>h.evaluate('deliverQuestion("@jarvis 申请需要什么材料？");'),/Outgoing bubble not confirmed/);
    assert.equal(h.snapshot().state.textReplies['text-1'].status,'uncertain');
    h.evaluate('processBatch(memoryObservation);');
    assert.equal(h.evaluate('sendClicks'),1);
});
test('a receipt already visible before sending is a conflict, not proof of a new reply',()=>{
    const h=ordinaryTextHost();
    h.evaluate('memoryRows.unshift({text:"收到你的消息（自动回复测试，回执 Q1）。",sender:"",direction:"outgoing",simpleText:true,fullyVisible:true});');
    assert.throws(()=>h.evaluate('deliverQuestion("@jarvis 一个新问题");'),/text_receipt_conflict/);
    assert.equal(h.evaluate('sendClicks'),0);assert.equal(h.evaluate('draftWrites'),0);
    assert.deepEqual(h.snapshot().state.textReplies,{});
});
test('starting again keeps receipt history and allocates a fresh boundary number',()=>{
    const first=ordinaryTextHost();first.evaluate('deliverQuestion("@jarvis 相同的问题");');
    const before=first.snapshot().state;
    const next=ordinaryTextHost({ledger:JSON.stringify(before)});
    next.evaluate('deliverQuestion("@jarvis 相同的问题");');
    const after=next.snapshot().state;
    assert.deepEqual(after.textReplies['text-1'],before.textReplies['text-1']);
    assert.ok(after.textReplies['text-3']);assert.equal(after.boundaryVersion,4);
    assert.equal(next.evaluate('sendClicks'),1);assert.deepEqual(after.commands,prior.commands);
});
test('invalid text receipt state cannot be replaced by a fresh ledger during watcher startup',()=>{
    for(const extra of [{textReplies:{}},{boundaryVersion:1,textReplies:[]},{boundaryVersion:-1,textReplies:{}}]) {
        const ledger=JSON.stringify({...prior,...extra});const h=host({ledger});h.run();
        assert.equal(h.disk.get(STATE),ledger);assert.equal(h.snapshot().uiCalls,0);
        assert.equal(h.disk.has(LOCK),false);assert.ok(h.disk.has(BASE+'artifacts/last-start-error.json'));
    }
});


test('agent intake durably queues a verified mention without clicking fixed reply',()=>{
    const h=ordinaryTextHost();
    h.evaluate(`var captured=[];agent={enqueue:function(receipt,question,sender){captured.push({receipt:receipt,question:question,sender:sender});return {body:{event_id:'00000000-0000-4000-8000-000000000001'}};},summary:function(){return {queued:1};}};
        deliverQuestion('@jarvis 订单 A123 卡在哪一步？');`);
    assert.equal(h.evaluate('sendClicks'),0);assert.equal(h.evaluate('draftWrites'),0);
    assert.equal(h.evaluate('captured[0].question'),'订单 A123 卡在哪一步？');
    const saved=h.snapshot().state;assert.equal(saved.textReplies['text-1'].status,'agent_queued');assert.ok(recovery.validLedger(saved));
});
test('approved agent answer checks empty input and message boundary before clicking',()=>{
    const h=ordinaryTextHost();
    h.evaluate(`memoryObservation={unread:'0',preview:'old',row:{click:function(){return true;}}};
        sendNode.click=function(){sendClicks++;memoryRows.push({text:draft,sender:'',direction:'outgoing',simpleText:true,fullyVisible:true});draft='';return true;};
        scrollChatToBottom=function(){};var marked=0;`);
    assert.equal(h.evaluate('sendAgentAnswer("模拟数据：A123 待补资料",function(){marked++;});'),true);
    assert.equal(h.evaluate('marked'),1);assert.equal(h.evaluate('sendClicks'),1);
    const other=ordinaryTextHost();
    other.evaluate(`memoryObservation={unread:'1',preview:'new',row:{click:function(){return true;}}};`);
    assert.throws(()=>other.evaluate('sendAgentAnswer("answer",function(){});'),/出现新消息/);
    assert.equal(other.evaluate('sendClicks+draftWrites'),0);
});

test('agent draft reflow allows a cropped old viewport but rejects a truly appended message',()=>{
    for(const arrival of [false,true]) {
        const h=ordinaryTextHost();
        h.evaluate(`memoryObservation={unread:'0',preview:'old',row:{click:function(){return true;}}};
            var scrollCalls=0;memoryRows.unshift({text:'older',sender:'tester',direction:'incoming',simpleText:true,fullyVisible:true});
            scrollChatToBottom=function(){scrollCalls++;memoryRows.shift();${arrival?"memoryRows.push({text:'new arrival',sender:'tester',direction:'incoming',simpleText:true,fullyVisible:true});":""}};
            sendNode.click=function(){sendClicks++;memoryRows.push({text:draft,sender:'',direction:'outgoing',simpleText:true,fullyVisible:true});draft='';return true;};`);
        if(arrival)assert.throws(()=>h.evaluate('sendAgentAnswer("approved answer",function(){});'),/消息末尾发生变化/);
        else assert.equal(h.evaluate('sendAgentAnswer("approved answer",function(){});'),true);
        assert.equal(h.evaluate('scrollCalls'),1);assert.equal(h.evaluate('sendClicks'),arrival?0:1);
    }
});
