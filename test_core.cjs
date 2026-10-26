const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./edge-extension/core.js');
const cid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const a='00000000-0000-4000-8000-000000000001', b='00000000-0000-4000-8000-000000000002';
const c='00000000-0000-4000-8000-000000000003', d='00000000-0000-4000-8000-000000000004';
const page = (ids, previous=true) => ({conversation_id:cid,messages:ids.map(id=>({id})),page_info:{start_cursor:ids[0],end_cursor:ids.at(-1),has_previous_page:previous,has_next_page:true}});
test('project and ordinary chat URLs resolve to the same explicit conversation',()=>{
  assert.equal(C.conversationFromPage(`https://chatgpt.com/g/g-p-example/c/${cid}`),cid);
  assert.equal(C.conversationFromPage(`https://chatgpt.com/c/${cid}?x=1`),cid);
});
test('foreign domains and credential-bearing URLs are rejected',()=>{
  assert.throws(()=>C.conversationFromPage(`https://chatgpt.com.example/c/${cid}`));
  assert.throws(()=>C.conversationFromPage(`https://name:secret@chatgpt.com/c/${cid}`));
});
test('only the selected conversation request path is accepted',()=>{
  assert.equal(C.isConversationRequest(`https://chatgpt.com/backend-api/conversation/${cid}`,cid),true);
  assert.equal(C.isConversationRequest(`https://chatgpt.com/backend-api/conversations/${a}/messages`,cid),false);
  assert.equal(C.isConversationRequest('https://chatgpt.com/api/auth/session',cid),false);
});
test('observed pagination values are preserved and duplicates rejected',()=>{
  const url=C.requestURL(cid,c);
  assert.equal(C.beforeFromRequest(url,cid),c);
  assert.throws(()=>C.beforeFromRequest(url+'&before='+a,cid));
  assert.throws(()=>C.beforeFromRequest(url.replace('num_turns=10','num_turns=100'),cid));
});
test('an old response or cursor cycle fails closed',()=>{
  assert.throws(()=>C.validatePair(page([c,d]),page([c,d]),cid,C.requestURL(cid,c),[c]),/游标没有前进/);
  assert.throws(()=>C.validatePair(page([c,d]),page([a,b]),cid,C.requestURL(cid,c),[a,c]),/已访问游标/);
});
test('a previous-page cursor may advance without inventing parent relationships',()=>{
  const result=C.validatePair(page([c,d]),page([a,b]),cid,C.requestURL(cid,c),[c]);
  assert.equal(result.start,a);assert.equal(result.previous,true);
});
test('empty pages and missing page boundaries fail',()=>{
  const empty=page([a,b]);empty.messages=[];
  assert.throws(()=>C.inspectPage(empty,cid));
  assert.throws(()=>C.inspectPage({...page([a,b]),messages:[{id:a}]},cid));
});
test('content fingerprints preserve whitespace and ignore unrelated metadata',()=>{
  const m={id:a,content:{content_type:'text',parts:['原文 ']},author:{role:'user'},create_time:1};
  assert.equal(C.stable(C.payload(m)),C.stable(C.payload({...m,metadata:{parent_id:b}})));
  assert.notEqual(C.stable(C.payload(m)),C.stable(C.payload({...m,content:{content_type:'text',parts:['原文']}})));
});
test('a changed message or selected endpoint changes the head signature',()=>{
  const head={...page([a,b]),current_node:b};
  assert.notEqual(C.headSignatureInput(head),C.headSignatureInput({...head,current_node:a}));
});
test('cookies and browser-controlled headers are excluded from replay',()=>{
  const headers=C.replayHeaders([{name:'Cookie',value:'never-copy'},{name:'Host',value:'chatgpt.com'},{name:'Sec-Fetch-Site',value:'same-origin'},{name:'Authorization',value:'test-only-placeholder'},{name:'Accept',value:'application/json'}]);
  assert.deepEqual(headers,{Authorization:'test-only-placeholder',Accept:'application/json'});
});
test('saved URL metadata omits unrelated parameters',()=>{
  assert.equal(C.safeRequestURL(C.requestURL(cid,a)+'&unknown_private_value=discard'),C.requestURL(cid,a));
});
test('retry delays are bounded and honor explicit server waits',()=>{
  assert.equal(C.retryDelay(0,'20'),20000);
  assert.equal(C.retryDelay(2,'999999'),60000);
  assert.equal(C.retryDelay(1,null),3000);
});

function fullTree() {
  return {conversation_id:cid,current_node:c,mapping:{
    [a]:{id:a,parent:null,children:[b],message:null},
    [b]:{id:b,parent:a,children:[c,d],message:{id:b,author:{role:'user'},content:{content_type:'text',parts:['问题']}}},
    [c]:{id:c,parent:b,children:[],message:{id:c,author:{role:'assistant'},content:{content_type:'text',parts:['当前回答']}}},
    [d]:{id:d,parent:b,children:[],message:{id:d,author:{role:'assistant'},content:{content_type:'text',parts:['旧回答']}}}
  }};
}
test('full request matches the public client code contract exactly',()=>{
  const url=C.fullRequestURL(cid);
  assert.equal(url,`https://chatgpt.com/backend-api/conversation/${cid}?include_full_conversation=true`);
  assert.equal(C.isFullRequest(url,cid),true);
  assert.equal(C.isFullRequest(url+'&other=1',cid),false);
  assert.equal(C.isFullRequest(url.replace('=true','=false'),cid),false);
  assert.equal(C.safeRequestURL(url),url);
});
test('full mapping counts an alternate branch without claiming server completeness',()=>{
  const info=C.inspectFullConversation(fullTree(),cid);
  assert.equal(info.nodes,4);assert.equal(info.messages,3);
  assert.equal(info.branch_points,1);assert.equal(info.off_current_path_nodes,1);
  assert.equal(info.complete_server_history_verified,false);
});
test('full mode refuses flat pages and dangling parents',()=>{
  assert.throws(()=>C.inspectFullConversation(page([a,b]),cid),/mapping/);
  const tree=fullTree();tree.mapping[b].parent='absent';
  assert.throws(()=>C.inspectFullConversation(tree,cid),/父节点/);
});
test('full mode verifies reciprocal child lists and unreachable cycles',()=>{
  const tree=fullTree();tree.mapping[b].children=[c];
  assert.throws(()=>C.inspectFullConversation(tree,cid),/父子关系/);
  const cycle=fullTree();delete cycle.mapping[a].children;delete cycle.mapping[b].children;delete cycle.mapping[d].children;
  cycle.mapping[b].parent=d;cycle.mapping[d].parent=b;
  assert.throws(()=>C.inspectFullConversation(cycle,cid),/不能从根节点/);
});
test('a mapping explicitly marked partial fails',()=>{
  assert.throws(()=>C.inspectFullConversation({...fullTree(),is_partial:true},cid),/部分数据/);
});
test('full signatures include off-route text and hierarchy, not volatile metadata',()=>{
  const tree=fullTree(),same=structuredClone(tree);same.mapping[d].message.metadata={request_id:'different'};
  assert.equal(C.fullSignatureInput(tree),C.fullSignatureInput(same));
  same.mapping[d].message.content.parts=['旧分支发生变化'];
  assert.notEqual(C.fullSignatureInput(tree),C.fullSignatureInput(same));
});
test('empty text is surfaced separately from graph validity',()=>{
  const tree=fullTree();tree.mapping[b].message.content.parts=[''];
  const info=C.inspectFullConversation(tree,cid);
  assert.equal(info.structure_valid,true);assert.deepEqual(info.empty_text_ids,[b]);
});

test('only a previously successful paginated head is selected as request context',()=>{
  const head=`https://chatgpt.com/backend-api/conversations/${cid}?include_has_versions=true&num_turns=10`;
  const entry=(url,status,date)=>({request:{method:'GET',url},response:{status},startedDateTime:date});
  const good=entry(head,200,'2026-09-13T04:00:00Z');
  assert.equal(C.selectObservedHead([entry(C.fullRequestURL(cid),403,'2026-09-13T04:10:00Z'),good],cid),good);
  assert.equal(C.selectObservedHead([entry(head,403,'2026-09-13T04:10:00Z')],cid),null);
});
test('failure metadata exports only the approved response header subset',()=>{
  const record={request:{url:C.fullRequestURL(cid),headers:[{name:'Authorization',value:'not-exported'}]},
    response:{status:403,headers:[{name:'Content-Type',value:'application/json'},{name:'Set-Cookie',value:'not-exported'}]}};
  const value=C.failureMetadata(record,cid);
  assert.deepEqual(value.response_headers,{'content-type':'application/json'});
  assert.equal(value.phase,'full_request');assert.ok(!JSON.stringify(value).includes('not-exported'));
});

test('record size uses encoded bytes and deletion excludes unfinished states',()=>{
  assert.equal(C.serializedBytes({text:'猫'}),new TextEncoder().encode(JSON.stringify({text:'猫'})).byteLength);
  assert.equal(C.formatBytes(0),'0 B');assert.equal(C.formatBytes(1048576),'1.0 MB');
  assert.equal(C.canDeleteStoredSession({state:'running'}),false);
  assert.equal(C.canDeleteStoredSession({state:'error'}),true);
  assert.equal(C.canDeleteStoredSession({state:'route_complete'}),true);
  assert.equal(C.canDeleteStoredSession({state:'error',deleted:true}),false);
});

require('./test_panel_runtime.cjs');
require('./test_organize.cjs');
require('./test_page_reader.cjs');
require('./test_sidebar.cjs');
require('./test_power.cjs');
require('./test_surface.cjs');
require('./test_claude.cjs');
require('./test_provider.cjs');

test('ordinary head recognition allows both client loaders and changing page sizes',()=>{
  for (const path of ['conversation','conversations']) {
    const root=`https://chatgpt.com/backend-api/${path}/${cid}`;
    for (const suffix of ['', '?include_has_versions=true&num_turns=20', `?include_message_id=${b}&include_has_versions=true&num_turns=10&client_variant=sample`])
      assert.equal(C.isPagedHeadRequest(root+suffix,cid),true);
    assert.equal(C.isPagedHeadRequest(root+'/textdocs',cid),false);
    assert.equal(C.isPagedHeadRequest(root+'?before='+b,cid),false);
    for (const suffix of ['?include_full_conversation=true', '?other=1&include_full_conversation=true', '?include_full_conversation=false&include_full_conversation=true']) {
      assert.equal(C.isPagedHeadRequest(root+suffix,cid),false);
      assert.equal(C.hasFullRequestFlag(root+suffix,cid),true);
    }
  }
});
test('rechecks do not replay conditional cache headers',()=>{
  assert.deepEqual(C.replayHeaders([{name:'If-None-Match',value:'old'}, {name:'If-Modified-Since',value:'old'}, {name:'Accept',value:'application/json'}]),{Accept:'application/json'});
});
