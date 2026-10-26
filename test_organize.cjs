const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const O = require('./edge-extension/organize.js');
const C = require('./edge-extension/core.js');
const cid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids=Array.from({length:12},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
const headUrl=`https://chatgpt.com/backend-api/conversations/${cid}?include_has_versions=true&num_turns=10`;
const m=(i,text,role='user',type='text')=>({id:ids[i],author:{role},create_time:100-i,content:{content_type:type,parts:[text]}});
function entry(sequence,kind,value,extra={}) {
  const body=JSON.stringify(value);
  return {session_id:'fixture',sequence,kind,accepted:true,
    request:{method:'GET',url:headUrl},response:{status:200,body_text:body,body_sha256:createHash('sha256').update(body).digest('hex')},
    validation:{},...extra};
}
function page(messages,previous=false) {return {conversation_id:cid,current_node:messages.at(-1).id,messages,
  page_info:{start_cursor:messages[0].id,end_cursor:messages.at(-1).id,has_previous_page:previous,has_next_page:false}};}
function bundle(messages) {const p=page(messages);return {schema:'chat-export-capture/v1',conversation_id:cid,title:'测试聊天',capture:{id:'fixture',state:'route_complete'},
  pages:[entry(0,'head',p),entry(1,'head_recheck',p)]};}
function twoPages(conflict=false) {
  const a=m(0,'原文  \n\n'),b=m(1,'继续'),c=m(2,'继续'),d=m(3,'最后一段','assistant');
  const first=page([b,c,d],true),older=page([a,conflict?{...b,content:{content_type:'text',parts:['同 ID 被改写']}}:b]);
  older.page_info.has_next_page=true;
  return {schema:'chat-export-capture/v1',conversation_id:cid,title:'顺序测试',capture:{id:'fixture',state:'route_complete'},pages:[
    entry(0,'head',first),entry(1,'previous',older,{request:{method:'GET',url:C.requestURL(cid,b.id)},validation:{parent_page_sequence:0}}),entry(2,'head_recheck',first)]};
}
test('organizer follows page order, preserves distinct repeated text, and removes only ID duplicates',async()=>{
  const b=twoPages();const before=JSON.stringify(b);const r=await O.prepare(b);
  assert.deepEqual(r.messages.map(m=>m.id),ids.slice(0,4));
  assert.equal(r.messages[0].content.parts[0],'原文  \n\n');
  assert.equal(r.messages.filter(m=>m.content.parts[0]==='继续').length,2);
  assert.equal(r.statistics.overlapping_message_duplicates_removed,1);
  assert.equal(r.statistics.repeated_response_messages_removed,3);
  assert.equal(r.provenance[ids[1]].length,2);
  assert.equal(JSON.stringify(b),before);
  assert.match(O.toText(r),/原文  \n\n/);
});
test('organizer preserves edits, user code, empty text and attachment references while excluding auxiliary records',async()=>{
  const input=[m(0,'隐藏系统','system'),m(1,'工具输出','tool'),m(2,'重写，前文称呼错误'),
    m(3,'原文修订','assistant'),m(4,'','user'),m(5,'思考内容','assistant','thoughts'),
    {...m(6,'辅助调用','assistant'),channel:'analysis'},
    {...m(7,'hidden','assistant'),metadata:{is_visually_hidden_from_conversation:true}},
    {...m(8,'','user','multimodal_text'),content:{content_type:'multimodal_text',parts:['请看这张图',{image_asset_pointer:'file-service://fixture-image'}]},metadata:{attachments:[{id:'fixture-image',name:'资料.png'}]}},
    m(9,'x = 1','user','code'), {...m(10,'已确认时间与座位','assistant'),channel:'commentary'}];
  const r=await O.prepare(bundle(input));
  assert.deepEqual(r.messages.map(m=>m.id),[ids[2],ids[3],ids[4],ids[8],ids[9],ids[10]]);
  assert.deepEqual(r.statistics.empty_text_ids,[ids[4]]);
  const txt=O.toText(r);
  assert.match(txt,/原始正文为空/);assert.match(txt,/重写，前文称呼错误/);
  assert.match(txt,/file-service:\/\/fixture-image/);assert.match(txt,/资料.png/);
  assert.match(txt,/已确认时间与座位/);
  assert.ok(!txt.includes('隐藏系统'));assert.equal(r.scope.original_message_text_modified,false);
  assert.equal((await O.prepare(bundle(input),{profile:'all'})).messages.length,input.length);
});
test('organizer refuses corrupted or conflicting records without producing silently truncated text',async()=>{
  await assert.rejects(O.prepare(twoPages(true)),/静默去重/);
  const b=twoPages();b.pages[1].response.body_text+=' ';
  await assert.rejects(O.prepare(b),/校验失败/);
  const broken=twoPages();broken.pages[1].validation.parent_page_sequence=17;
  await assert.rejects(O.prepare(broken),/来源不连续/);
});
test('partial exports remain clearly marked and cannot claim a completed capture',async()=>{
  const b=twoPages();b.pages=b.pages.slice(0,1);b.capture.state='paused';
  const r=await O.prepare(b);assert.equal(r.checks.capture_recheck_passed,false);
  assert.match(O.toText(r),/部分数据/);assert.equal(r.scope.all_history_branches_verified,false);
  b.capture.state='route_complete';await assert.rejects(O.prepare(b),/缺少最早边界/);
});
test('mapping organization follows parent links and keeps unselected branches in the raw backup',async()=>{
  const root='root'; const value={conversation_id:cid,current_node:ids[1],mapping:{
    [root]:{id:root,parent:null,message:null},[ids[0]]:{id:ids[0],parent:root,message:m(0,'问题')},
    [ids[1]]:{id:ids[1],parent:ids[0],message:m(1,'当前回答','assistant')},[ids[2]]:{id:ids[2],parent:ids[0],message:m(2,'旧分支回答','assistant')}}};
  const b={schema:'chat-export-observed-mapping/v1',conversation_id:cid,capture:{id:'fixture',state:'mapping_complete'},pages:[
    entry(0,'mapping',value),entry(1,'mapping_recheck',value,{validation:{recheck_of_sequence:0}})]};
  const r=await O.prepare(b);assert.deepEqual(r.messages.map(m=>m.id),ids.slice(0,2));
  assert.equal(r.statistics.off_route_nodes_not_included,1);assert.equal(r.checks.capture_recheck_passed,true);
  assert.equal(JSON.parse(b.pages[0].response.body_text).mapping[ids[2]].message.content.parts[0],'旧分支回答');
});
test('diagnostic records and foreign responses cannot be treated as story data',async()=>{
  await assert.rejects(O.prepare({schema:'chat-export-diagnostic/v1'}),/诊断/);
  const b=bundle([m(0,'正文')]);b.pages[0].request.url='https://example.com/private';
  await assert.rejects(O.prepare(b),/来源/);
});
