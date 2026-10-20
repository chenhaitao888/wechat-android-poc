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
