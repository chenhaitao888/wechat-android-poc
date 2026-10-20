// Lifecycle tests run the deployed script in a memory-only AutoX host.
// Native UI is stubbed; real WeChat behavior is covered by device tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../mention-policy');
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
    const globals = {
        Date: ClockDate,
        files: {
            exists: name => disk.has(name),
            read: name => { if (!disk.has(name)) throw new Error('Missing file'); return disk.get(name); },
            write: (name, data) => disk.set(name, String(data)),
            append: (name, data) => disk.set(name, (disk.get(name) || '') + data),
            ensureDir: () => {},
        },
        require: name => { assert.equal(name, BASE + 'mention-policy.js'); return policy; },
        java: {io:{File}},
        android: {
            os:{SystemClock:{elapsedRealtime:() => now}},
            content:{IntentFilter:function(){}},
            provider:{Settings:{Secure:{getString:() => 'test-accessibility-service'}}},
        },
        context: {
            registerReceiver:() => null,
            getContentResolver:() => ({}),
            getSystemService:() => ({isTouchExplorationEnabled:() => true}),
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
    };
    let context;
    globals.auto = {waitFor:() => {
        // Function declarations have been initialized at this point. Replace only
        // native UI boundaries; the actual lock, ledger, loop and finally execute.
        vm.runInContext('prepareBoundary = function() {}; observation = function() { return null; };', context);
    }};
    context = vm.createContext(globals);
    return {
        run:() => vm.runInContext(source, context, {timeout:2000}),
        disk,
        snapshot:() => ({now,uiCalls,cancelled,keptAwake,state:JSON.parse(disk.get(STATE)),events:(disk.get(BASE+'artifacts/watch-events.jsonl')||'').trim().split('\n').filter(Boolean).map(JSON.parse)}),
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
