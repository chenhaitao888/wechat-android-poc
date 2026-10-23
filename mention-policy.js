// Pure, conservative policy for one genuine mention in a bounded unread batch.
// The WeChat badge is conversation-level evidence, never per-message metadata.
var MAX_UNREAD = 5;
function compact(value) { return String(value || "").replace(/[\s\u2005\u200b]+/g, ""); }
function signature(row) { return JSON.stringify([row.direction, row.sender, row.text, row.simpleText]); }
function sameRows(left, right) {
    if (left.length !== right.length) return false;
    for (var i=0;i<left.length;i++) if (signature(left[i]) !== signature(right[i])) return false;
    return true;
}
function pause(reason) { return {kind:"pause", reason:reason}; }
function decide(observed, rows, anchor, commands, textReplies, boundaryVersion) {
    if (!/^\[有人@我\]/.test(observed.preview)) return {kind:"skip",reason:"no_mention_badge"};
    if (!/^[1-5]$/.test(observed.unread)) return pause("unread_count_unsupported");
    if (!anchor || !anchor.length) return pause("missing_baseline");
    var matches=[];
    for(var i=0;i<=rows.length-anchor.length;i++) {
        if(sameRows(rows.slice(i,i+anchor.length),anchor)) matches.push(i+anchor.length);
    }
    if(matches.length!==1) return pause("baseline_not_unique_or_not_visible");
    var batch=rows.slice(matches[0]);
    if(batch.length!==Number(observed.unread)) return pause("unread_boundary_changed");
    for(var j=0;j<batch.length;j++) {
        if(!batch[j].fullyVisible || !batch[j].simpleText || batch[j].direction!=="incoming" || !batch[j].sender) return pause("unsupported_or_hidden_message");
    }
    var last=batch[batch.length-1];
    var preview=observed.preview.replace(/^\[有人@我\]\s*/, "");
    if(compact(preview)!==compact(last.sender+": "+last.text)) return pause("last_message_does_not_match_preview");
    var atCount=0, candidate=null;
    for(var k=0;k<batch.length;k++) {
        var ats=String(batch[k].text).match(/[@＠]/g);
        atCount+=ats ? ats.length : 0;
        var code=/^@jarvis测试(\d{3})$/.exec(compact(batch[k].text));
        if(code) candidate={code:code[1],rowIndex:k};
        else {
            var question=/^@jarvis[\s\u2005\u200b]+([\s\S]*)$/.exec(String(batch[k].text));
            if(question) candidate={question:question[1].replace(/^[\s\u2005\u200b]+|[\s\u2005\u200b]+$/g,""),rowIndex:k};
        }
    }
    if(atCount!==1 || !candidate) return pause("mention_attribution_ambiguous");
    if(candidate.code) {
        if(commands[candidate.code]) return {kind:"already_handled",code:candidate.code,batchSize:batch.length};
        return {kind:"reply",code:candidate.code,batchSize:batch.length};
    }
    if(!candidate.question) return pause("empty_question");
    if(!textReplies || typeof textReplies!=="object" || Array.isArray(textReplies) ||
        typeof boundaryVersion!=="number" || !isFinite(boundaryVersion) || Math.floor(boundaryVersion)!==boundaryVersion ||
        boundaryVersion<1 || boundaryVersion>9007199254740991) return pause("invalid_text_ledger");
    // This is a local unread-boundary receipt, not a WeChat message ID or a text hash.
    var messageId="text-"+boundaryVersion, incoming=batch[candidate.rowIndex], previous=textReplies[messageId];
    if(previous) {
        if(previous.incomingText!==incoming.text || previous.sender!==incoming.sender) return pause("text_receipt_conflict");
        return {kind:"already_handled",messageId:messageId,batchSize:batch.length};
    }
    return {kind:"reply",messageId:messageId,incomingText:incoming.text,sender:incoming.sender,batchSize:batch.length};
}
module.exports={MAX_UNREAD:MAX_UNREAD,compact:compact,signature:signature,sameRows:sameRows,decide:decide};
