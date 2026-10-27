// One-time local provisioning. Never starts the watcher or posts a question.
var BASE='/sdcard/wechat-android-poc/';
var client=require(BASE+'agent-client.js');
var bridge=require(BASE+'agent-bridge.js');
var staging=BASE+'agent-config.staging.json', result=BASE+'artifacts/agent-setup.json';
try {
    if(files.exists(BASE+'watch.lock')) throw new Error('请先停止机器人');
    if(files.exists(staging)) {
        var c=JSON.parse(files.read(staging));
        if(!bridge.validConfig(c)) throw new Error('配置无效');
        var destination=client.directory()+'config.json';
        if(files.exists(destination) && files.read(destination)!==JSON.stringify(c)) throw new Error('已有不同配置，拒绝覆盖');
        client.atomic(destination,c);
        if(!files.remove(staging)) throw new Error('暂存凭证未移除');
    }
    var loaded=client.config();
    var response=client.request(loaded,'GET','/api/outbox');
    if(!response || !Array.isArray(response.items)) throw new Error('后端响应无效');
    files.write(result,JSON.stringify({ok:true,transport:'usb-loopback',deviceId:loaded.deviceId,group:loaded.groupName,outboxCount:response.items.length,at:new Date().toISOString()}));
} catch(e) {
    // Never serialize configuration or raw network exceptions containing request headers.
    files.write(result,JSON.stringify({ok:false,error:e.status ? 'HTTP '+e.status : '配置或连接检查失败，请检查本机和 USB',at:new Date().toISOString()}));
}
