const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const bridge=require('../agent-bridge');
const source=fs.readFileSync(require('node:path').join(__dirname,'../setup-agent.js'),'utf8');
const BASE='/sdcard/wechat-android-poc/', PRIVATE='/private/agent/';
const old={version:1,baseUrl:'http://127.0.0.1:8660',deviceKey:'d'.repeat(40),deviceId:'phone',groupRef:'test-1',groupName:'测试1'};
const next={...old,baseUrl:'https://bot.company.example',deviceId:'office-phone',backendId:'backend_'+'1'.repeat(32)};
function run(options={}){
 const disk=new Map([[BASE+'STOP','stopped'],[PRIVATE+'config.json',JSON.stringify(old)],[BASE+'agent-config.staging.json',JSON.stringify({config:next,switchBackend:options.switchBackend===true})]]);
 const journal={version:1,deviceId:old.deviceId,groupRef:old.groupRef,messages:{},deliveries:{}};
 if(options.queued)journal.messages['text-1']={status:'queued',body:{local_receipt_id:'text-1',event_id:'00000000-0000-4000-8000-000000000001',group_ref:'test-1',group_name:'测试1',content:'待上报问题'}};
 disk.set(PRIVATE+'queue.json',JSON.stringify(journal));
 if(options.active)disk.set(BASE+'watch.lock','active');
 const requests=[],writes=[];
 const client={directory:()=>PRIVATE,journalPath:c=>PRIVATE+(c.backendId?'queue-'+c.backendId+'.json':'queue.json'),config:()=>JSON.parse(disk.get(PRIVATE+'config.json')),
  atomic:(path,value)=>{writes.push(path);disk.set(path,JSON.stringify(value));},
  request:(config,method,path)=>{requests.push({method,path});if(options.offline)throw Error('untrusted certificate');if(path==='/api/outbox')return {items:[]};return {backend_id:options.wrongBackend?'wrong':next.backendId,device_id:next.deviceId,group_ref:next.groupRef,group_name:next.groupName};}};
 vm.runInNewContext(source,{require:p=>p.endsWith('agent-client.js')?client:bridge,files:{exists:p=>disk.has(p),read:p=>disk.get(p),write:(p,v)=>disk.set(p,v),remove:p=>disk.delete(p)},Date,JSON});
 return {disk,writes,requests,result:JSON.parse(disk.get(BASE+'artifacts/agent-setup.json')),journal:JSON.stringify(journal)};
}
test('switch probes identity, archives config and preserves the old queue without posting',()=>{
 const r=run({switchBackend:true});assert.equal(r.result.ok,true);assert.equal(r.result.switched,true);assert.equal(r.result.transport,'network-https');
 assert.deepEqual(JSON.parse(r.disk.get(PRIVATE+'config.json')),next);assert.equal(r.disk.get(PRIVATE+'queue.json'),r.journal);
 assert.ok(r.writes.some(p=>p.startsWith(PRIVATE+'config-history/')));assert.ok(r.requests.every(r=>r.method==='GET'));assert.equal(r.disk.has(BASE+'agent-config.staging.json'),false);
});
test('missing switch flag, active watcher or queued questions cannot replace connection',()=>{
 for(const o of [{},{switchBackend:true,active:true},{switchBackend:true,queued:true}]){
  const r=run(o);assert.equal(r.result.ok,false);assert.deepEqual(JSON.parse(r.disk.get(PRIVATE+'config.json')),old);assert.deepEqual(r.writes,[]);assert.equal(r.requests.length,0);assert.equal(r.disk.has(BASE+'agent-config.staging.json'),false);
 }
});
test('TLS failure or wrong backend identity leaves old config and journal intact and removes staging secret',()=>{
 for(const o of [{offline:true},{wrongBackend:true}]){
  const r=run({switchBackend:true,...o});assert.equal(r.result.ok,false);assert.deepEqual(JSON.parse(r.disk.get(PRIVATE+'config.json')),old);assert.equal(r.disk.get(PRIVATE+'queue.json'),r.journal);assert.deepEqual(r.writes,[]);assert.equal(r.disk.has(BASE+'agent-config.staging.json'),false);assert.ok(!JSON.stringify(r.result).includes(old.deviceKey));
 }
});
