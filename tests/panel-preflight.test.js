// Execute the real panel start handler without Android UI or a phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const recovery = require('../run-recovery');
const BASE = '/sdcard/wechat-android-poc/';
const STATE = BASE + 'artifacts/watch-state.json';
const STOP = BASE + 'STOP';
const AUTOX = 'org.autojs.autoxjs.v7';
const HELPER = 'local.wechat.accessibilityhelper';
const panelSource = fs.readFileSync(path.join(__dirname, '../phone-panel.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(__dirname, '../foreground-service.js'), 'utf8');

function host(options={}) {
    const oldState = options.ledger || JSON.stringify({group:'测试1',bot:'jarvis',status:'stopped',commands:{'036':{status:'outgoing_bubble_observed'}},sentThisRun:1});
    const disk = new Map([[STATE,oldState],[STOP,'keep stopped']]);
    const launched = [], activities = [], queried = [], elements = new Map();
    const ui = {layout:()=>{},statusBarColor:()=>{},run:fn=>fn()};
    for (const name of ['statusText','detailText','nextText','hintText','startButton','stopButton','agentButton','modeText',
        'recoverButton','wechatButton','helperButton','settingsButton','batteryButton','shortcutButton']) {
        const element = {text:'',enabled:true,handlers:{},setText(text){this.text=text;},
            setEnabled(value){this.enabled=value;},setVisibility(){},on(event,fn){this.handlers[event]=fn;}};
        elements.set(name,element);ui[name]=element;
    }
    const enabledServices = AUTOX + '/Service:' + (options.readerOnly ? 'com.bjbyhd.screenreader_huawei/Service' : HELPER + '/Service');
    const statuses = {[AUTOX]:Object.hasOwn(options,'autoxExempt') ? options.autoxExempt : true,
        [HELPER]:Object.hasOwn(options,'helperExempt') ? options.helperExempt : true};
    const context = {
        getPackageName:()=>AUTOX,getContentResolver:()=>({}),
        getSystemService: name => ({
            power:{isIgnoringBatteryOptimizations:pkg=>{
                queried.push(pkg);
                if (statuses[pkg] === null) throw new Error('Power manager unavailable');
                return statuses[pkg];
            }},
            accessibility:{isTouchExplorationEnabled:()=>true},
            activity:{getRunningServices:()=>({size:()=>1,get:()=>({foreground:options.foreground !== false,
                service:{getPackageName:()=>AUTOX,getClassName:()=>'com.stardust.autojs.IndependentScriptService'}})})},
        })[name],
    };
    const serviceVm={context,module:{exports:{}}};vm.runInNewContext(serviceSource,serviceVm);
    const ownEngine={getSource:()=>BASE+'phone-panel.js',equals:e=>e===ownEngine,isDestroyed:()=>false};
    vm.runInNewContext(panelSource,{
        ui,context,
        files:{exists:p=>disk.has(p),read:p=>disk.get(p),write:(p,v)=>disk.set(p,v),remove:p=>disk.delete(p),ensureDir:()=>{}},
        require:p=>p===BASE+'foreground-service.js' ? serviceVm.module.exports : p===BASE+'agent-client.js' ? {config:()=>{if(!options.agentConfigured)throw Error('尚未配置智能体连接');return {};}} : {createController:()=>({}),validLedger:recovery.validLedger},
        engines:{myEngine:()=>ownEngine,all:()=>[ownEngine],execScriptFile:p=>launched.push(p)},
        android:{provider:{Settings:{Secure:{getString:()=>enabledServices}}}},
        app:{launchPackage:p=>activities.push(p),startActivity:intent=>activities.push(intent)},
        setTimeout:fn=>fn(),setInterval:()=>{},
    });
    return {disk,oldState,launched,activities,queried,ui,click:name=>elements.get(name).handlers.click()};
}

for (const [field,label] of [['autoxExempt','AutoX'],['helperExempt','微信控件辅助']]) {
    for (const value of [false,null]) {
        test(`${label} battery status ${value} leaves STOP and history untouched and never opens WeChat`,()=>{
            const h=host({[field]:value});h.click('startButton');
            assert.deepEqual(h.launched,[]);assert.deepEqual(h.activities,[]);
            assert.equal(h.disk.get(STOP),'keep stopped');assert.equal(h.disk.get(STATE),h.oldState);
            assert.equal(h.disk.has(BASE+'run-request.json'),false);
            assert.ok(h.ui.hintText.text.startsWith(label));
            assert.match(h.ui.hintText.text,value===null ? /无法确认/ : /尚未豁免/);
            assert.match(h.ui.hintText.text,/不允许/);
        });
    }
}
test('ready panel starts one bounded worker and preserves deduplication history',()=>{
    const h=host();h.click('startButton');
    assert.deepEqual(h.launched,[BASE+'watch-test-group.js']);assert.deepEqual(h.activities,['com.tencent.mm']);
    assert.equal(h.disk.has(STOP),false);assert.equal(h.disk.get(STATE),h.oldState);
    assert.equal(JSON.parse(h.disk.get(BASE+'run-request.json')).maxMinutes,30);
    assert.ok(h.queried.includes(AUTOX));assert.ok(h.queried.includes(HELPER));
    assert.match(h.ui.detailText.text,/AutoX电池优化：已豁免/);
    assert.match(h.ui.detailText.text,/控件辅助电池优化：已豁免/);
});
test('native-reader fallback does not require an unused helper battery exemption',()=>{
    const h=host({readerOnly:true,helperExempt:false});h.click('startButton');
    assert.deepEqual(h.launched,[BASE+'watch-test-group.js']);
    assert.equal(h.disk.get(STATE),h.oldState);
});
test('battery settings button only opens the normal settings list and cannot start replies',()=>{
    const h=host();h.click('batteryButton');
    assert.equal(h.activities.length,1);
    assert.equal(h.activities[0].action,'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
    assert.deepEqual(h.launched,[]);assert.equal(h.disk.get(STOP),'keep stopped');
    assert.equal(h.disk.get(STATE),h.oldState);
});


test('an invalid ordinary-text ledger cannot clear STOP or launch a worker',()=>{
    for(const extra of [{textReplies:{}},{boundaryVersion:1,textReplies:[]},{boundaryVersion:-1,textReplies:{}}]) {
        const h=host({ledger:JSON.stringify({group:'测试1',bot:'jarvis',commands:{},...extra})});
        h.click('startButton');
        assert.equal(h.disk.get(STOP),'keep stopped');assert.equal(h.disk.get(STATE),h.oldState);
        assert.deepEqual(h.launched,[]);assert.deepEqual(h.activities,[]);
        assert.match(h.ui.hintText.text,/历史回执记录异常/);
    }
});

test('agent mode requires provisioned credentials and remains distinct from fixed receipts',()=>{
    const missing=host();missing.click('agentButton');
    assert.deepEqual(missing.launched,[]);assert.equal(missing.disk.get(STOP),'keep stopped');
    assert.match(missing.ui.hintText.text,/尚未配置/);
    const ready=host({agentConfigured:true});ready.click('agentButton');
    assert.equal(JSON.parse(ready.disk.get(BASE+'run-request.json')).mode,'agent');
    assert.deepEqual(ready.launched,[BASE+'watch-test-group.js']);
    const fixed=host();fixed.click('startButton');assert.equal(JSON.parse(fixed.disk.get(BASE+'run-request.json')).mode,'fixed');
});
