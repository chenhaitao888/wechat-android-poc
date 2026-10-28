const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../mention-policy');
const incoming = (text, sender='tester') => ({text,sender,direction:'incoming',simpleText:true,fullyVisible:true});
const outgoing = text => ({text,sender:'',direction:'outgoing',simpleText:true,fullyVisible:true});
const anchor = [incoming('@jarvis\u2005测试009'),outgoing('收到，测试009（自动回复测试）。')];
function classify(batch, overrides={}, prior={}) {
  const last=batch.at(-1);
  const observed={unread:String(batch.length),preview:'[有人@我] '+last.sender+': '+last.text,...overrides};
  return policy.decide(observed,anchor.concat(batch),anchor,prior);
}
test('genuine mention followed by ordinary text is attributable within the unread boundary',()=>{
  assert.deepEqual(classify([incoming('@jarvis\u2005测试010'),incoming('011')]),{kind:'reply',code:'010',batchSize:2});
});
test('ordinary messages before and after the only mention are allowed',()=>{
  assert.equal(classify([incoming('before'),incoming('@jarvis 测试012'),incoming('after')]).code,'012');
});
test('a copied at-string without the conversation mention badge never replies',()=>{
  assert.equal(classify([incoming('@jarvis 测试013')],{preview:'tester: @jarvis 测试013'}).kind,'skip');
});
test('genuine and copied mentions in the same batch cannot be distinguished and must pause',()=>{
  assert.equal(classify([incoming('@jarvis\u2005测试012'),incoming('@jarvis 测试013')]).reason,'mention_attribution_ambiguous');
});
test('two genuine mentions also pause because per-message metadata is unavailable',()=>{
  assert.equal(classify([incoming('@jarvis\u2005测试014'),incoming('@jarvis\u2005测试015')]).kind,'pause');
});
test('everyone mentions, quoted at-text, and other at-signs cannot validate a candidate',()=>{
  for(const batch of [[incoming('@所有人'),incoming('@jarvis 测试016')],[incoming('quote: @jarvis 测试016')],[incoming('email a@b'),incoming('@jarvis 测试016')]]) assert.equal(classify(batch).kind,'pause');
});
test('messages arriving while entering the group invalidate the unread boundary',()=>{
  assert.equal(classify([incoming('@jarvis 测试017'),incoming('tail'),incoming('new')],{unread:'2'}).reason,'unread_boundary_changed');
});
test('a changed or truncated conversation preview cannot authenticate the batch',()=>{
  assert.equal(classify([incoming('@jarvis 测试018'),incoming('last')],{preview:'[有人@我] tester: last…'}).kind,'pause');
});
test('offscreen, outgoing, media and system rows are refused',()=>{
  for(const row of [{...incoming('tail'),fullyVisible:false},outgoing('tail'),{...incoming('photo'),simpleText:false},{...incoming('system'),sender:''}]) assert.equal(classify([incoming('@jarvis 测试019'),row]).kind,'pause');
});
test('persisted attempts and completed sends are never repeated',()=>{
  for(const status of ['attempting','uncertain','outgoing_bubble_observed']) assert.equal(classify([incoming('@jarvis 测试020')],{}, {'020':{status}}).kind,'already_handled');
});
test('missing or ambiguous baseline refuses attribution',()=>{
  const msg=incoming('@jarvis 测试021'),obs={unread:'1',preview:'[有人@我] tester: '+msg.text};
  assert.equal(policy.decide(obs,[msg],anchor,{}).kind,'pause');
  assert.equal(policy.decide(obs,anchor.concat(anchor,[msg]),anchor,{}).kind,'pause');
});
test('batches larger than five are not opened for automatic processing',()=>{
  assert.equal(classify(Array.from({length:6},(_,i)=>incoming(i===0?'@jarvis 测试022':'text'+i))).reason,'unread_count_unsupported');
});


function classifyText(batch, ledger={}, revision=1, overrides={}) {
  const last=batch.at(-1);
  return policy.decide({unread:String(batch.length),preview:'[有人@我] '+last.sender+': '+last.text,...overrides},
    anchor.concat(batch),anchor,{},ledger,revision);
}
test('a short ordinary question receives a local receipt without a test number',()=>{
  const row=incoming('@jarvis\u2005这个产品怎么申请？');
  assert.deepEqual(classifyText([row]),{kind:'reply',messageId:'text-1',incomingText:row.text,sender:'tester',batchSize:1});
});
test('ordinary questions preserve their original spaces and punctuation',()=>{
  const row=incoming('@jarvis Please explain A B.\n谢谢！');
  assert.equal(classifyText([row]).incomingText,row.text);
});
test('the sole ordinary-text mention can have non-mention text on both sides',()=>{
  assert.equal(classifyText([incoming('前文'),incoming('@jarvis 申请流程是什么？'),incoming('补充说明')]).kind,'reply');
});
test('repeated content in a later unread boundary receives a different receipt',()=>{
  const row=incoming('@jarvis 相同的问题');
  const first=classifyText([row]);
  const ledger={[first.messageId]:{status:'outgoing_bubble_observed',incomingText:row.text,sender:row.sender}};
  assert.equal(classifyText([row],ledger,2).messageId,'text-2');
  assert.equal(classifyText([row],ledger,2).kind,'reply');
});
test('the same boundary is never retried after an attempt or uncertain result',()=>{
  const row=incoming('@jarvis 一个问题');
  for(const status of ['attempting','uncertain','outgoing_bubble_observed']) {
    assert.equal(classifyText([row],{'text-1':{status,incomingText:row.text,sender:row.sender}}).kind,'already_handled');
  }
});
test('a reused receipt with changed text or sender pauses instead of hiding a mismatch',()=>{
  const row=incoming('@jarvis 一个问题');
  for(const entry of [{incomingText:'different',sender:row.sender},{incomingText:row.text,sender:'someone else'}]) {
    assert.equal(classifyText([row],{'text-1':{status:'attempting',...entry}}).reason,'text_receipt_conflict');
  }
});
test('empty questions and other nickname prefixes cannot trigger a receipt',()=>{
  assert.equal(classifyText([incoming('@jarvis\u2005   ')]).reason,'empty_question');
  for(const text of ['@jarvis2 问题','@Jarvis 问题','引用：@jarvis 问题']) assert.equal(classifyText([incoming(text)]).kind,'pause');
});
test('copied ordinary mentions and unmentioned text do not reply without the genuine badge',()=>{
  for(const text of ['@jarvis 普通问题','普通问题']) assert.equal(classifyText([incoming(text)],{},1,{preview:'tester: '+text}).kind,'skip');
});
test('multiple ordinary mentions and email at-signs remain ambiguous',()=>{
  assert.equal(classifyText([incoming('@jarvis 问题一'),incoming('@jarvis 问题二')]).kind,'pause');
  assert.equal(classifyText([incoming('@jarvis 请联系 a@b.com')]).kind,'pause');
});
test('ordinary questions require a valid persistent receipt sequence',()=>{
  for(const revision of [undefined,null,0,-1,1.5,'1',Infinity,9007199254740992]) {
    const row=incoming('@jarvis 问题');
    assert.equal(policy.decide({preview:'[有人@我] tester: '+row.text,unread:'1'},anchor.concat([row]),anchor,{}, {},revision).reason,'invalid_text_ledger');
  }
});


test('stable tail requires a unique complete anchor and rejects appended or hidden messages',()=>{
    const {stableTail}=require('../mention-policy');
    const a={text:'a',sender:'t',direction:'incoming',simpleText:true,fullyVisible:true};
    const b={...a,text:'b'},c={...a,text:'c'};
    assert.equal(stableTail([a,b,c],[b,c]),true);
    assert.equal(stableTail([b,c],[b,c]),true);
    assert.equal(stableTail([b,c,a],[b,c]),false);
    assert.equal(stableTail([b,c,b,c],[b,c]),false);
    assert.equal(stableTail([b,{...c,fullyVisible:false}],[b,c]),false);
});


test('observed Xiaomi ellipsis accepts a full recovered question, never the abbreviated preview',()=>{
    const row=incoming('@jarvis\u2005订单A123卡在哪一步？需要补充哪些资料？','你们就偷着乐吧');
    const preview='[有人@我] 你们就偷着乐吧: @jarvis\u2005订单A123卡在…';
    const result=classifyText([row],{},11,{preview});
    assert.equal(result.kind,'reply');assert.equal(result.incomingText,row.text);
    assert.equal(policy.previewMatch(preview.replace(/^\[有人@我\] /,''),row),'truncated');
});
test('ellipsis requires complete sender and meaningful matching body, not a changed or invented suffix',()=>{
    const row=incoming('@jarvis 订单A123卡在哪一步？');
    for(const preview of ['tester: @jarvis 订单B999卡在…','other: @jarvis 订单A123卡在…',
        'test…','tester: @jarvis…','tester: @jarvis 订…','tester: @jarvis 订单A123卡在',
        'tester: @jarvis 订单A123卡在...','tester: @jarvis 订单A123卡在哪一步？…']) {
        assert.equal(classifyText([row],{},1,{preview:'[有人@我] '+preview}).kind,'pause',preview);
    }
});
test('truncated previews retain unread-boundary, visibility, duplicate and ambiguous-mention checks',()=>{
    const row=incoming('@jarvis 订单A123卡在哪一步？');
    const obs={preview:'[有人@我] tester: @jarvis 订单A123卡在…'};
    assert.equal(classifyText([row],{},1,{...obs,unread:'2'}).reason,'unread_boundary_changed');
    assert.equal(classifyText([{...row,fullyVisible:false}],{},1,obs).reason,'unsupported_or_hidden_message');
    assert.equal(classifyText([incoming('@jarvis 粘贴的假@'),row],{},1,obs).reason,'mention_attribution_ambiguous');
    assert.equal(classifyText([row],{'text-1':{status:'agent_queued',incomingText:row.text,sender:row.sender}},1,obs).kind,'already_handled');
    assert.equal(policy.decide({...obs,unread:'1'},[row],anchor,{}, {},1).kind,'pause');
    assert.equal(classifyText([row],{},1,{preview:obs.preview.replace('[有人@我] ','')}).kind,'skip');
});
test('one genuine mention followed by truncated ordinary text still needs one attributable mention',()=>{
    const batch=[incoming('@jarvis 订单A123状态'),incoming('补充说明是这份订单的申请进度')];
    assert.equal(classifyText(batch,{},1,{preview:'[有人@我] tester: 补充说明是这份…'}).kind,'reply');
});
