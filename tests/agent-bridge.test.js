const test=require('node:test');
const assert=require('node:assert/strict');
const {create,validConfig}=require('../agent-bridge');
const cfg={version:1,baseUrl:'http://127.0.0.1:8660',deviceKey:'d'.repeat(40),deviceId:'phone',groupRef:'test-1',groupName:'测试1'};
const copy=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
function host() {
    let disk,seq=0,now=1800000000000;
    const tasks=new Map(),outbox=[],calls=[],events=[];
    let loseReceive=false,loseAck=false,loseSending=false,offline=false;
    const h={now:()=>now,uuid:()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`,
        load:()=>copy(disk),save:j=>{disk=copy(j);},event:(...e)=>events.push(e),
        request(method,path,body){
            calls.push({method,path,body:copy(body)});
            if(offline)throw Error('offline');
            if(path==='/api/messages') {
                const value=JSON.stringify(body);
                let item=tasks.get(body.event_id);
                if(item)assert.equal(value,item.body);else{item={id:'task_'+String(tasks.size+1).padStart(32,'0'),body:value};tasks.set(body.event_id,item);}
                if(loseReceive){loseReceive=false;throw Error('lost response');}
                return {task_id:item.id};
            }
            if(path==='/api/outbox')return {items:copy(outbox)};
            const [,id,action]=path.match(/\/outbox\/(out_\w+)\/(\w+)/);
            const out=outbox.find(x=>x.id===id);assert.ok(out);
            if(action==='claim') {
                if(out.status!=='pending'){const e=Error('claimed');e.status=409;throw e;}
                out.status='claimed';out.lease_token='lease';return copy(out);
            }
            assert.equal(body.lease_token,'lease');
            if(action==='sending') {
                if(out.status==='sending'){assert.equal(out.attempt,body.attempt_id);return copy(out);}
                assert.equal(out.status,'claimed');out.status='sending';out.attempt=body.attempt_id;
                if(loseSending){loseSending=false;throw Error('lost sending response');}
                return copy(out);
            }
            assert.equal(action,'ack');assert.equal(body.attempt_id,out.attempt);
            if(out.status!=='sending')assert.equal(out.status,body.outcome);
            out.status=body.outcome;out.evidence=body.evidence;
            if(loseAck){loseAck=false;throw Error('lost ack response');}
            return copy(out);
        }};
    function approve(taskId) {
        const item={id:'out_'+String(outbox.length+1).padStart(32,'0'),device:cfg.deviceId,group_ref:cfg.groupRef,task_id:taskId||[...tasks.values()][0].id,
            text:'模拟数据：A123 待补营业执照扫描件。',reply_version:1,status:'pending',expires:now/1000+1800};
        outbox.unshift(item);return item;
    }
    return {h,tasks,outbox,calls,events,approve,read:()=>copy(disk),write:v=>{disk=copy(v);},
        flags:v=>{({loseReceive=loseReceive,loseAck=loseAck,loseSending=loseSending,offline=offline}=v);}};
}
function queued(f){const b=create(cfg,f.h);b.enqueue('text-2','订单 A123 卡在哪一步？','tester');b.sync();return b;}
test('configuration rejects public cleartext, credentials in URL and other groups',()=>{
    assert.ok(validConfig(cfg));
    for(const changes of [{baseUrl:'http://192.168.1.2:8660'},{baseUrl:'http://token@127.0.0.1:8660'},{groupName:'其他群'},{deviceKey:'short'}])assert.ok(!validConfig({...cfg,...changes}));
});
test('lost submit response retries immutable event across restart, identical new question gets new event',()=>{
    const f=host();f.flags({loseReceive:true});let b=queued(f);assert.equal(f.tasks.size,1);assert.equal(b.summary().queued,1);
    const before=f.read().messages['text-2'].body;b=create(cfg,f.h);b.sync();
    assert.equal(f.tasks.size,1);assert.deepEqual(f.read().messages['text-2'].body,before);
    b.enqueue('text-3',before.content,'tester');b.sync();assert.equal(f.tasks.size,2);
});
test('offline queue persists and no unreviewed or foreign task can be delivered',()=>{
    const f=host();f.flags({offline:true});const b=queued(f);assert.equal(b.summary().queued,1);assert.equal(b.next(),null);
    f.flags({offline:false});b.sync();assert.equal(b.next(),null);
    f.approve('task_'+'9'.repeat(32));b.sync();assert.equal(b.next(),null);
    const own=f.approve();own.group_ref='other';b.sync();assert.equal(b.next(),null);
});
test('approved answer has durable attempt before click, one ack, never a second delivery',()=>{
    const f=host();const b=queued(f);f.approve();b.sync();const out=b.next();let clicks=0;
    b.deliver(out,(text,mark)=>{assert.equal(text,out.text);assert.equal(f.read().deliveries[out.id].phase,'armed');mark();
        assert.equal(f.read().deliveries[out.id].phase,'clicking');clicks++;return true;});
    assert.equal(clicks,1);assert.equal(f.outbox[0].status,'outgoing_observed');assert.ok(f.read().deliveries[out.id].acked);
    b.sync();assert.equal(b.next(),null);assert.throws(()=>b.deliver(out,()=>{clicks++;}));assert.equal(clicks,1);
});
test('lost result acknowledgement only retries acknowledgement after restart',()=>{
    const f=host();const b=queued(f);f.approve();b.sync();f.flags({loseAck:true});let clicks=0;
    b.deliver(b.next(),(_,mark)=>{mark();clicks++;return true;});assert.equal(b.summary().awaitingAck,1);
    const restarted=create(cfg,f.h);restarted.sync();assert.equal(restarted.summary().awaitingAck,0);assert.equal(restarted.next(),null);assert.equal(clicks,1);
});
test('lost sending authorization never clicks and reports not_sent with same attempt',()=>{
    const f=host();const b=queued(f);f.approve();b.sync();f.flags({loseSending:true});let clicks=0;
    assert.equal(b.deliver(b.next(),()=>{clicks++;return true;}),false);assert.equal(clicks,0);assert.equal(f.outbox[0].status,'not_sent');
});
test('UI failure before click is not_sent; failure at click is uncertain and cannot retry',()=>{
    for(const afterMark of [false,true]) {
        const f=host();const b=queued(f);f.approve();b.sync();
        assert.throws(()=>b.deliver(b.next(),(_,mark)=>{if(afterMark)mark();throw Error('UI interruption');}));
        assert.equal(f.outbox[0].status,afterMark?'send_uncertain':'not_sent');b.sync();assert.equal(b.next(),null);
    }
});
test('process death at physical click is recovered as uncertain with no resend',()=>{
    const f=host();const b=queued(f);f.approve();b.sync();let crashSnapshot;
    b.deliver(b.next(),(_,mark)=>{mark();crashSnapshot=f.read();return true;});
    f.write(crashSnapshot);f.outbox[0].status='sending';const after=create(cfg,f.h);after.sync();
    assert.equal(f.outbox[0].status,'send_uncertain');assert.equal(after.next(),null);
});
test('corrupt, null or wrong-device journals never reset',()=>{
    for(const value of [null,{}, {version:1,deviceId:'other',groupRef:'test-1',messages:{},deliveries:{}}]){
        const f=host();f.write(value);assert.throws(()=>create(cfg,f.h));assert.deepEqual(f.read(),value);
    }
});
test('same receipt with changed text is rejected before any upload',()=>{
    const f=host();const b=queued(f);assert.throws(()=>b.enqueue('text-2','different','tester'));assert.equal(f.tasks.size,1);
});
test('one sending callback cannot mark two clicks',()=>{
    const f=host();const b=queued(f);f.approve();b.sync();
    assert.throws(()=>b.deliver(b.next(),(_,mark)=>{mark();mark();return true;}),/不能再次点击/);assert.equal(f.outbox[0].status,'send_uncertain');
});
