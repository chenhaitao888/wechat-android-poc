// Durable device queue and one-attempt delivery. No Android/UI globals in this module.
function transport(url) {
    if(url==='http://127.0.0.1:8660') return 'usb-loopback';
    if(typeof url!=='string') return null;
    var match=/^https:\/\/([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?$/.exec(url);
    if(!match || match[1].length>253 || (match[2] && Number(match[2])>65535)) return null;
    var labels=match[1].split('.');
    if(labels.length<2 || !/[a-z]/.test(labels[labels.length-1]) || !labels.every(function(label){return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);})) return null;
    return 'network-https';
}
function validConfig(c) {
    var mode=c && transport(c.baseUrl);
    return c && c.version===1 && !!mode &&
        (mode!=='network-https' || /^backend_[0-9a-f]{32}$/.test(c.backendId||'')) &&
        (c.backendId===undefined || /^backend_[0-9a-f]{32}$/.test(c.backendId)) &&
        typeof c.deviceKey==='string' && /^[A-Za-z0-9_-]{32,200}$/.test(c.deviceKey) &&
        c.groupRef==='test-1' && c.groupName==='测试1' && typeof c.deviceId==='string' && !!c.deviceId;
}
function object(v) { return v && typeof v==='object' && !Array.isArray(v); }
function validJournal(j,c) {
    if(!object(j) || j.version!==1 || j.deviceId!==c.deviceId || j.groupRef!==c.groupRef || j.backendId!==c.backendId || !object(j.messages) || !object(j.deliveries)) return false;
    return Object.keys(j.messages).every(function(k) {
        var m=j.messages[k];
        return object(m) && object(m.body) && m.body.local_receipt_id===k &&
            /^[0-9a-f-]{36}$/.test(m.body.event_id) && m.body.group_ref===c.groupRef && m.body.group_name===c.groupName &&
            typeof m.body.content==='string' && m.body.content.length>0 &&
            ['queued','accepted','failed'].indexOf(m.status)>=0 && (m.status!=='accepted' || /^task_[0-9a-f]{32}$/.test(m.taskId));
    }) && Object.keys(j.deliveries).every(function(k) {
        var d=j.deliveries[k];
        return object(d) && d.id===k && /^out_[0-9a-f]{32}$/.test(k) &&
            typeof d.lease==='string' && typeof d.attemptId==='string' && typeof d.text==='string' &&
            ['claimed','arming','armed','clicking','finished'].indexOf(d.phase)>=0 &&
            (d.phase==='finished' ? !!d.outcome && typeof d.evidence==='string' : !d.outcome) &&
            (!d.outcome || ['outgoing_observed','not_sent','send_uncertain'].indexOf(d.outcome)>=0);
    });
}
function configurationChange(current,next,journal,allowSwitch) {
    if(!validConfig(next)) throw new Error('新配置无效');
    if(!current) return false;
    if(!validConfig(current)) throw new Error('旧配置无效，请先检查');
    var keys=Object.keys(current).concat(Object.keys(next));
    if(keys.every(function(k){return current[k]===next[k];})) return false;
    if(!allowSwitch) throw new Error('已有不同配置，需要明确切换后台');
    if(journal!==undefined) {
        if(!validJournal(journal,current)) throw new Error('旧队列异常，请先检查');
        if(Object.keys(journal.messages).some(function(k){return journal.messages[k].status==='queued';})) throw new Error('还有问题待上报，不能切换后台');
        if(Object.keys(journal.deliveries).some(function(k){return !journal.deliveries[k].acked;})) throw new Error('还有发送结果待核查，不能切换后台');
    }
    return true;
}
function create(c,host) {
    if(!validConfig(c)) throw new Error('智能体连接配置无效，请保持停止并检查。');
    var loaded=host.load();
    var j=loaded===undefined ? {version:1,deviceId:c.deviceId,groupRef:c.groupRef,backendId:c.backendId,messages:{},deliveries:{}} : loaded;
    if(!validJournal(j,c)) throw new Error('智能体队列损坏或设备不匹配，不能清空后重试。');
    var lastError='', items=[];
    function save() { host.save(j); }
    function stamp() { return new Date(host.now()).toISOString(); }
    function failure(e) { lastError=e && e.status ? 'HTTP '+e.status : (transport(c.baseUrl)==='network-https' ? '连接失败，请检查办公网络和服务器' : '连接失败，请检查 USB 和 Mac 后端'); }
    function log(type,detail) { if(host.event) host.event(type,detail); }
    function result(d,outcome,reason) {
        d.outcome=outcome;d.phase='finished';d.evidence=JSON.stringify({attempt:d.attemptId,at:stamp(),observation:reason});save();
        log('agent_delivery_result',{outboxId:d.id,outcome:outcome});
    }
    // Interrupted UI sends are never resumed. Only their same-attempt result may be reported.
    Object.keys(j.deliveries).forEach(function(k) {
        var d=j.deliveries[k];
        if(!d.outcome) result(d,d.phase==='clicking' ? 'send_uncertain' : 'not_sent','进程中断；不重新点击发送');
    });
    function enqueue(receipt,question,sender) {
        question=String(question).replace(/^\s+|\s+$/g,'');
        if(!question || question.length>1000 || !sender || sender.length>1500) throw new Error('问题为空、过长或发言人不可读');
        var existing=j.messages[receipt];
        if(existing) {
            if(existing.body.content!==question || existing.body.sender_display_name!==sender) throw new Error('问题回执冲突，请检查历史');
            return existing;
        }
        if(Object.keys(j.messages).length>=1000) throw new Error('本轮联调队列已满，请保持停止并归档');
        var m={status:'queued',body:{event_id:host.uuid(),group_ref:c.groupRef,group_name:c.groupName,
            content:question,sender_display_name:sender,local_receipt_id:receipt,observed_at:stamp()}};
        j.messages[receipt]=m;save();log('agent_question_queued',{receipt:receipt,eventId:m.body.event_id});return m;
    }
    function report(d) {
        if(d.acked || d.reportBlocked || !d.outcome) return;
        var payload={lease_token:d.lease,attempt_id:d.attemptId};
        try {
            // Safe after a lost /sending response; the server makes this transition idempotent.
            if(!d.serverArmed) {
                host.request('POST','/api/outbox/'+d.id+'/sending',payload);d.serverArmed=true;save();
            }
            host.request('POST','/api/outbox/'+d.id+'/ack',{lease_token:d.lease,attempt_id:d.attemptId,outcome:d.outcome,evidence:d.evidence});
            d.acked=true;save();log('agent_delivery_acked',{outboxId:d.id,outcome:d.outcome});
        } catch(e) {
            failure(e);
            if(e.status>=400 && e.status<500) { d.reportBlocked=true;save(); }
        }
    }
    function sync() {
        lastError='';
        Object.keys(j.deliveries).forEach(function(k){report(j.deliveries[k]);});
        var keys=Object.keys(j.messages);
        for(var i=0;i<keys.length;i++) {
            var m=j.messages[keys[i]];
            if(m.status!=='queued') continue;
            try {
                var received=host.request('POST','/api/messages',m.body);
                if(!received || !/^task_[0-9a-f]{32}$/.test(received.task_id)) throw new Error('响应无效');
                m.taskId=received.task_id;m.status='accepted';save();
                log('agent_question_accepted',{eventId:m.body.event_id,taskId:m.taskId});
            } catch(e) {
                failure(e);if(e.status>=400 && e.status<500) {m.status='failed';save();}
            }
            break;
        }
        items=[];
        try {
            var response=host.request('GET','/api/outbox');
            if(!response || !Array.isArray(response.items)) throw new Error('发件箱响应无效');
            items=response.items;
        } catch(e) { failure(e); }
        return summary();
    }
    function matches(out) {
        return out && /^out_[0-9a-f]{32}$/.test(out.id) && out.group_ref===c.groupRef && out.device===c.deviceId &&
            typeof out.text==='string' && out.text.trim().length>0 && out.text.length<=500 && out.reply_version===1 &&
            out.expires>host.now()/1000 && Object.keys(j.messages).some(function(k){return j.messages[k].status==='accepted' && j.messages[k].taskId===out.task_id;});
    }
    function next() {
        for(var i=items.length-1;i>=0;i--) {
            var out=items[i];
            // Never take a lease belonging to another process, nor any unknown task.
            if(out.status==='pending' && !j.deliveries[out.id] && matches(out)) return out;
        }
        return null;
    }
    function deliver(out,send) {
        if(!matches(out) || out.status!=='pending' || j.deliveries[out.id]) throw new Error('发件项不可发送');
        var claimed;
        try { claimed=host.request('POST','/api/outbox/'+out.id+'/claim',{}); }
        catch(e) { failure(e); return false; }
        if(!matches(claimed) || claimed.id!==out.id || claimed.task_id!==out.task_id || claimed.text!==out.text ||
            claimed.status!=='claimed' || typeof claimed.lease_token!=='string') throw new Error('领取结果不匹配，已暂停');
        var d={id:out.id,text:out.text,taskId:out.task_id,attemptId:host.uuid(),lease:claimed.lease_token,phase:'claimed'};
        j.deliveries[out.id]=d;save();
        try {
            d.phase='arming';save();
            host.request('POST','/api/outbox/'+d.id+'/sending',{lease_token:d.lease,attempt_id:d.attemptId});
            d.serverArmed=true;d.phase='armed';save();
        } catch(e) {
            failure(e);result(d,'not_sent','发送许可未确认，未操作微信发送');report(d);return false;
        }
        try {
            var observed=send(d.text,function(){
                if(d.phase!=='armed') throw new Error('此尝试已进入发送，不能再次点击');
                d.phase='clicking';save();
            });
            if(d.phase!=='clicking') throw new Error('缺少发送前的持久记录');
            result(d,observed ? 'outgoing_observed' : 'send_uncertain',observed ? '本次点击后观察到对应右侧气泡；对方收件需另行确认' : '点击后未确认对应气泡');
            report(d);
            if(!observed) throw new Error('智能体答案发送结果不明，不会自动重发');
            return true;
        } catch(e) {
            if(!d.outcome) result(d,d.phase==='clicking' ? 'send_uncertain' : 'not_sent',d.phase==='clicking' ? '点击发送阶段中断，需人工核查' : '界面检查未通过，未点击发送');
            report(d);throw e;
        }
    }
    function summary() {
        var result={queued:0,accepted:0,failed:0,awaitingAck:0,uncertain:0,error:lastError};
        Object.keys(j.messages).forEach(function(k){result[j.messages[k].status]++;});
        Object.keys(j.deliveries).forEach(function(k){var d=j.deliveries[k];if(!d.acked)result.awaitingAck++;if(d.outcome==='send_uncertain')result.uncertain++;});
        return result;
    }
    return {enqueue:enqueue,sync:sync,next:next,deliver:deliver,summary:summary};
}
module.exports={create:create,validConfig:validConfig,validJournal:validJournal,transport:transport,configurationChange:configurationChange};
