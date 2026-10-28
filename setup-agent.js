// Stopped-device provisioning. Existing queues remain in app-private storage.
var BASE='/sdcard/wechat-android-poc/';
var client=require(BASE+'agent-client.js');
var bridge=require(BASE+'agent-bridge.js');
var staging=BASE+'agent-config.staging.json', result=BASE+'artifacts/agent-setup.json';
try {
    if(files.exists(BASE+'watch.lock') || !files.exists(BASE+'STOP')) throw new Error('请先停止机器人');
    var loaded, switched=false;
    if(files.exists(staging)) {
        var request=JSON.parse(files.read(staging));
        var c=request.config || request;
        if(!bridge.validConfig(c)) throw new Error('配置无效');
        var destination=client.directory()+'config.json';
        var previous=files.exists(destination) ? client.config() : null;
        var oldJournal=previous && files.exists(client.journalPath(previous)) ? JSON.parse(files.read(client.journalPath(previous))) : undefined;
        switched=bridge.configurationChange(previous,c,oldJournal,request.switchBackend===true);
        var target=client.journalPath(c);
        if(files.exists(target) && !bridge.validJournal(JSON.parse(files.read(target)),c)) throw new Error('目标队列不匹配');
        // Check the new endpoint before replacing credentials; standard Android TLS verification stays enabled.
        var response=client.request(c,'GET','/api/outbox');
        if(!response || !Array.isArray(response.items)) throw new Error('后端响应无效');
        if(c.backendId) {
            var info=client.request(c,'GET','/api/device-info');
            if(info.backend_id!==c.backendId || info.device_id!==c.deviceId || info.group_ref!==c.groupRef || info.group_name!==c.groupName) throw new Error('后端身份不匹配');
        }
        if(switched) client.atomic(client.directory()+'config-history/'+Date.now()+'.json',previous);
        client.atomic(destination,c);
        loaded=c;
    } else {
        loaded=client.config();
        var response=client.request(loaded,'GET','/api/outbox');
        if(!response || !Array.isArray(response.items)) throw new Error('后端响应无效');
    }
    if(files.exists(staging) && !files.remove(staging)) throw new Error('暂存凭证未移除');
    files.write(result,JSON.stringify({ok:true,transport:bridge.transport(loaded.baseUrl),switched:switched,deviceId:loaded.deviceId,group:loaded.groupName,outboxCount:response.items.length,at:new Date().toISOString()}));
} catch(e) {
    files.write(result,JSON.stringify({ok:false,error:e.status ? 'HTTP '+e.status : '配置或连接检查失败；保持停止，检查网络、旧队列和切换选项',at:new Date().toISOString()}));
} finally {
    // Do not leave a device credential on shared storage even when the probe fails.
    if(files.exists(staging)) files.remove(staging);
}
