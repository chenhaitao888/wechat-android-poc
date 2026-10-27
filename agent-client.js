// AutoX adapter. Credentials and delivery leases live in the app-private directory.
var BASE='/sdcard/wechat-android-poc/';
var bridge=require(BASE+'agent-bridge.js');
function directory() { return String(context.getFilesDir().getAbsolutePath())+'/wechat-agent/'; }
function atomic(path,value) {
    files.ensureDir(path);
    var out=new java.io.FileOutputStream(path+'.tmp');
    try { out.write(new java.lang.String(JSON.stringify(value)).getBytes('UTF-8'));out.getFD().sync(); }
    finally { out.close(); }
    if(!new java.io.File(path+'.tmp').renameTo(new java.io.File(path))) throw new Error('智能体记录保存失败');
}
function config() {
    var p=directory()+'config.json';
    if(!files.exists(p)) throw new Error('尚未配置智能体连接');
    var c=JSON.parse(files.read(p));
    if(!bridge.validConfig(c)) throw new Error('智能体配置无效');
    return c;
}
function request(c,method,path,body) {
    if(!/^\/api\/(messages|outbox(?:\/out_[0-9a-f]{32}\/(?:claim|sending|ack))?)$/.test(path)) throw new Error('设备接口路径无效');
    var conn=new java.net.URL(c.baseUrl+path).openConnection(), input=null;
    try {
        conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(3000);conn.setReadTimeout(3000);
        conn.setUseCaches(false);conn.setRequestMethod(method);conn.setRequestProperty('Authorization','Bearer '+c.deviceKey);
        if(body!==undefined) {
            var bytes=new java.lang.String(JSON.stringify(body)).getBytes('UTF-8');
            conn.setDoOutput(true);conn.setRequestProperty('Content-Type','application/json');conn.setFixedLengthStreamingMode(bytes.length);
            var output=conn.getOutputStream();try { output.write(bytes); } finally { output.close(); }
        }
        var code=Number(conn.getResponseCode());
        if(code<200 || code>=300) { var error=new Error('设备接口 HTTP '+code);error.status=code;throw error; }
        input=conn.getInputStream();
        var buffer=java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE,4096), collected=new java.io.ByteArrayOutputStream();
        var length, deadline=android.os.SystemClock.elapsedRealtime()+5000;
        while((length=input.read(buffer))!==-1) {
            if(collected.size()+length>1024*1024 || android.os.SystemClock.elapsedRealtime()>deadline) throw new Error('设备接口响应超限');
            collected.write(buffer,0,length);
        }
        return JSON.parse(String(collected.toString('UTF-8')));
    } finally { if(input) input.close();conn.disconnect(); }
}
function create(log) {
    var c=config(), journal=directory()+'queue.json';
    return bridge.create(c,{
        now:function(){return Date.now();},uuid:function(){return String(java.util.UUID.randomUUID());},event:log,
        load:function(){return files.exists(journal) ? JSON.parse(files.read(journal)) : undefined;},
        save:function(value){atomic(journal,value);},
        request:function(method,path,body){return request(c,method,path,body);}
    });
}
module.exports={create:create,config:config,atomic:atomic,directory:directory,request:request};
