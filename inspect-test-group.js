// Read-only diagnostics restricted to the approved test group.
// Requires the reply worker to be stopped; never clicks, types, or sends.
auto.waitFor();
var BASE = "/sdcard/wechat-android-poc/";
var PKG = "com.tencent.mm";
if (files.exists(BASE + "watch.lock")) throw new Error("Stop the reply worker before inspection");
sleep(800);
var label = files.exists(BASE + "inspection-label.txt") ? files.read(BASE + "inspection-label.txt").trim() : "latest";
if (!/^[a-z0-9-]{1,50}$/.test(label)) throw new Error("Invalid inspection label");
var report = {time: new Date().toISOString(), label: label, touchExploration: context.getSystemService("accessibility").isTouchExplorationEnabled(), list: [], chat: [], nativeMessages: []};
function bounds(node) { var b = node.bounds(); return [b.left,b.top,b.right,b.bottom]; }
function visible(node) { if (!node) return false; var b=node.bounds(); return b.width()>0 && b.height()>0 && b.top>=0 && b.bottom<=device.height; }
function describe(node) {
    return {id:String(node.id()||""),text:String(node.text()||""),desc:String(node.desc()||""),className:String(node.className()||""),bounds:bounds(node),clickable:node.clickable(),childCount:node.childCount()};
}
var title = id(PKG+":id/obn").findOnce();
if (visible(title) && /^测试1\(\d+\)$/.test(String(title.text()))) {
    report.screen = "approved_group";
    var nodes = packageName(PKG).find();
    for (var i=0;i<nodes.size();i++) report.chat.push(describe(nodes.get(i)));
    var root = auto.service.getRootInActiveWindow();
    function visit(node, depth) {
        if (!node || depth>40) return;
        if (String(node.getViewIdResourceName()||"")===PKG+":id/bkl") {
            var raw=node.getText(), item={text:String(raw||""),textClass:raw ? String(raw.getClass().getName()) : null,spans:[],actions:[]};
            try {
                if(raw && java.lang.Class.forName("android.text.Spanned").isInstance(raw)) {
                    var spans=raw.getSpans(0,raw.length(),java.lang.Class.forName("java.lang.Object"));
                    for(var s=0;s<spans.length;s++) item.spans.push({type:String(spans[s].getClass().getName()),start:raw.getSpanStart(spans[s]),end:raw.getSpanEnd(spans[s])});
                }
                var actions=node.getActionList();
                for(var a=0;a<actions.size();a++) item.actions.push({id:actions.get(a).getId(),label:String(actions.get(a).getLabel()||"")});
                item.extrasKeys=String(node.getExtras().keySet());
            } catch(e) { item.metadataError=String(e); }
            report.nativeMessages.push(item);
        }
        for(var c=0;c<node.getChildCount();c++) { var child=node.getChild(c); if(child) { visit(child,depth+1); child.recycle(); } }
    }
    try { if(root && String(root.getPackageName())===PKG) visit(root,0); }
    catch(e) { report.nativeInspectionError=String(e); }
    finally { if(root) root.recycle(); }
} else {
    report.screen="conversation_list_or_other";
    var names=id(PKG+":id/kbq").text("测试1").find();
    for(var j=0;j<names.size();j++) {
        if(!visible(names.get(j))) continue;
        var row=names.get(j);
        for(var k=0;row && k<12 && String(row.id())!==PKG+":id/cj1";k++) row=row.parent();
        if(!row || !visible(row)) continue;
        var preview=row.findOne(id(PKG+":id/ht5")),badge=row.findOne(id(PKG+":id/o_u"));
        report.list.push({bounds:bounds(row),preview:preview ? String(preview.text()||"") : "",unread:badge ? String(badge.text()||"") : "0"});
    }
}
files.write(BASE+"artifacts/inspection-"+label+".json",JSON.stringify(report,null,2));
