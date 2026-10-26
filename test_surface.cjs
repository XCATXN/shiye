const test=require('node:test'),assert=require('node:assert/strict');
const P=require('./edge-extension/platforms.js'),S=require('./edge-extension/surface-core.js'),O=require('./edge-extension/organize.js');
const Capture=require('./edge-extension/surface-capture.js');
const Router=require('./edge-extension/capture-router.js');
const Reader=require('./edge-extension/surface-reader.js');
const URLS={chatgpt:'https://chatgpt.com/c/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  claude:'https://claude.ai/chat/11111111-1111-4111-8111-111111111111',gemini:'https://gemini.google.com/app/a1b2c3d4e5f67890',
  deepseek:'https://chat.deepseek.com/a/chat/s/11111111-1111-4111-8111-111111111111',doubao:'https://www.doubao.com/chat/12345678901234567',
  kimi:'https://www.kimi.com/chat/abcdefghij01234567890',qwen:'https://www.qianwen.com/chat/0123456789abcdef0123456789abcdef',
  yuanbao:'https://yuanbao.tencent.com/chat/exampleBot/11111111-1111-4111-8111-111111111111'};
const identity=P.identify(URLS.deepseek);
const msg=(n,text='消息 '+n)=>({source_key:String(n),role:n%2?'assistant':'user',channel:'final',text,html:'<p>'+text+'</p>',attachments:[],empty:!text,notice:null});
function snap(rows,position={}){return {schema:'chat-export-surface-snapshot/v1',...identity,title:'页面夹具',captured_at:'2026-09-19T00:00:00Z',
  position:{top:100,height:600,viewport:200,at_top:false,at_bottom:false,...position},messages:rows,
  scope:{capture_source:'rendered_page',official_json:false,server_history_verified:false,attachments_downloaded:false}};}
const rows=Array.from({length:8},(_,i)=>msg(i));
const views=[snap(rows.slice(0,4),{top:0,at_top:true}),snap(rows.slice(2,6),{top:200}),snap(rows.slice(4),{top:400,at_bottom:true})];
async function bundle(){
  const pages=[];for(const [i,view] of [views[2],views[1],views[0],views[1],views[2]].entries()){
    const body=JSON.stringify(view);pages.push({session_id:'capture',sequence:i,kind:i===4?'surface_recheck':'surface',accepted:true,request:{method:'DOM',url:identity.source_url},response:{body_text:body,body_sha256:await S.sha(body)}});
  }
  return {schema:S.SCHEMA,provider_id:identity.provider_id,conversation_id:identity.conversation_id,title:'页面夹具',capture:{id:'capture',...identity,mode:'surface',state:'surface_complete'},pages};
}
test('eight platform routes are explicit and foreign/credential-bearing pages are rejected',()=>{
  for(const [id,url] of Object.entries(URLS)){const value=P.identify(url+'?tracking=ignored');assert.equal(value.provider_id,id);assert.equal(value.source_url,url);assert.ok(value.conversation_id);}
  assert.throws(()=>P.identify('https://chat.deepseek.com.evil.test/a/chat/s/11111111-1111-4111-8111-111111111111'));
  assert.throws(()=>P.identify('https://user:secret@claude.ai/chat/11111111-1111-4111-8111-111111111111'));
  assert.throws(()=>P.identify('https://www.kimi.com/chat/history'));
  assert.equal(P.identify('https://www.qianwen.com/',false).provider_id,'qwen');
});
test('page-loading and streaming errors stay actionable, while browser exceptions are sanitized',async()=>{
  for(const message of ['尚未识别到聊天消息。请等待页面载入。','页面仍在生成回答，请等待生成完成后再采集。']){
    const read=Reader.transport({scripting:{executeScript:async()=>[{frameId:0,documentId:'doc',result:{error:message}}]}});
    await assert.rejects(read({tabId:1,documentId:'doc'},identity),e=>e.message===message);
  }
  const read=Reader.transport({scripting:{executeScript:async()=>{throw Error('private page exception must not escape');}}});
  await assert.rejects(read({tabId:1,documentId:'doc'},identity),e=>!e.message.includes('private')&&e.message.includes('原聊天'));
});
test('capture routing keeps legacy ChatGPT jobs and new webpage jobs on their own engines',async()=>{
  const records={old:{id:'old',mode:'pagination'},new:{id:'new',mode:'surface',provider_id:'deepseek'}};let selected='old';
  const calls=[];const make=provider=>Object.fromEntries(['start','resume','status','restore','boot','pause','pending','prepareSleep','shutdown'].map(method=>[method,(...args)=>{calls.push({provider,method,args});return {provider,method};}]));
  const r=Router.create({store:{getJob:async()=>({session_id:selected}),getSession:async id=>records[id]},chatgpt:()=>make('chatgpt'),surface:()=>make('surface')});
  assert.equal((await r.boot()).provider,'chatgpt');selected='new';assert.equal((await r.restore()).provider,'surface');
  assert.equal((await r.prepareSleep()).provider,'surface');assert.equal((await r.pending('old')).provider,'chatgpt');
  await r.start({},'new','new',{provider_id:'deepseek',source_url:URLS.deepseek});
  assert.equal(calls.at(-1).provider,'surface');assert.equal(calls.at(-1).args[3].provider_id,'deepseek');
  r.shutdown();assert.equal(calls.filter(c=>c.method==='shutdown').length,2);
});
test('overlapping DOM windows merge by source order without deleting repeated text',async()=>{
  const b=await bundle();const result=await O.prepare(b);
  assert.equal(result.messages.length,8);assert.deepEqual(result.messages.map(m=>m.content.parts[0]),rows.map(m=>m.text));
  assert.equal(result.scope.server_history_verified,false);assert.equal(result.scope.official_json,false);
  assert.equal(result.checks.webpage_scan_finished,true);assert.match(O.toText(result),/网页正文备份 · 完整性待核对/);
  const index=S.empty();S.merge(index,snap([msg(0,'一样'),msg(1,'一样')]),0);S.merge(index,snap([msg(1,'一样'),msg(2,'一样')]),1);
  assert.equal(index.nodes.length,3);
});
test('ambiguous anonymous duplicate windows and disjoint windows fail instead of guessing',()=>{
  const anon=()=>({...msg(1,'重复'),source_key:null});const index=S.empty();S.merge(index,snap([anon(),anon(),anon()]),0);
  assert.throws(()=>S.merge(index,snap([anon()]),1),/歧义/);
  const other=S.empty();S.merge(other,views[0],0);assert.throws(()=>S.merge(other,views[2],1),/重叠/);
});
test('identical anonymous text in a moved virtual window cannot silently stand in for new messages',()=>{
  const row={...msg(1,'重复'),source_key:null},a=snap([row],{top:0,full_dom_span:false}),b=snap([row],{top:200,full_dom_span:false});
  assert.throws(()=>S.checkMotion(a,b),/缺少稳定消息编号/);
  assert.doesNotThrow(()=>S.checkMotion(a,{...b,position:{...b.position,full_dom_span:true}}));
});

test('Claude DOM reader uses turn keys across long virtualized messages without trusting React IDs',()=>{
  const expected=P.identify(URLS.claude),saved={document:global.document,location:global.location,getComputedStyle:global.getComputedStyle};
  let top=32000;
  const scroller={clientHeight:948,scrollHeight:33888,get scrollTop(){return top;},getBoundingClientRect:()=>({top:0}),parentElement:null};
  function element(attrs,children=[],rect={top:-6000,bottom:1700}){
    return {nodeType:1,tagName:'DIV',childNodes:children,parentElement:scroller,outerHTML:'<div>fixture</div>',
      getAttribute:name=>attrs[name]??null,getClientRects:()=>[rect],getBoundingClientRect:()=>rect,
      matches:()=>false,closest:()=>null,querySelectorAll:()=>[]};
  }
  const turns=[['UserMessage','turn-9','继续'],['AssistantMessage','turn-9-hub-reply','长回复正文']];
  const elements=turns.map(([role,key,value])=>{
    const body=element({},[{nodeType:3,nodeValue:value}]);
    const e=element({'data-cds':role,'data-turn-key':key,id:'_r_unstable_'});
    e.querySelectorAll=selector=>selector===(role==='UserMessage'?'[data-testid="user-message"]':'[data-perf-reply-text]')?[body]:[];
    return e;
  });
  try{
    global.location={href:expected.source_url};
    global.getComputedStyle=e=>({display:'block',visibility:'visible',overflowY:e===scroller?'auto':'visible'});
    global.document={title:'Claude long transcript fixture',scrollingElement:scroller,
      querySelectorAll:selector=>selector==='[data-cds="UserMessage"],[data-testid="assistant-message"]'?elements:[]};
    const first=S.validate(JSON.parse(Reader.inPage(expected).body_text),expected);
    assert.deepEqual(first.messages.map(m=>m.source_key),['turn-9:final','turn-9-hub-reply:final']);
    assert.deepEqual(first.messages.map(m=>m.text),['继续','长回复正文']);
    top-=787;
    const second=S.validate(JSON.parse(Reader.inPage(expected).body_text),expected);
    assert.equal(second.position.full_dom_span,false);
    assert.doesNotThrow(()=>S.checkMotion(first,second));
    const index=S.empty();S.merge(index,first,0);S.merge(index,second,1);assert.equal(index.nodes.length,2);
    // The old adapter ignored data-turn-key, producing this exact false stop.
    const anonymous=p=>({...p,messages:p.messages.map(m=>({...m,source_key:null}))});
    assert.throws(()=>S.checkMotion(anonymous(first),anonymous(second)),/缺少稳定消息编号/);
    elements[0].getAttribute=name=>({'data-cds':'UserMessage',id:'_r_not_a_message_id_'}[name]??null);
    assert.equal(JSON.parse(Reader.inPage(expected).body_text).messages[0].source_key,null);
  }finally{
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete global[key];else global[key]=value;}
  }
});
test('a pinned latest reply can skip a virtualized middle row without dropping that saved message',()=>{
  const index=S.empty();S.merge(index,snap([msg(4),msg(5),msg(6),msg(7)]),0);
  S.merge(index,snap([msg(2),msg(3),msg(4),msg(5),msg(6),msg(7)]),1);
  S.merge(index,snap([msg(0),msg(1),msg(2),msg(3),msg(4),msg(5),msg(7)]),2);
  assert.deepEqual(index.nodes.map(n=>n.row.source_key),['0','1','2','3','4','5','6','7']);assert.equal(index.orderingUnique,true);
});
test('source-ID overlap retains unresolved order until a later window supplies the missing link',()=>{
  const index=S.empty();S.merge(index,snap([msg(0),msg(2)]),0);S.merge(index,snap([msg(1),msg(2)]),1);
  assert.equal(index.nodes.length,3);assert.equal(index.orderingUnique,false);
  S.merge(index,snap([msg(0),msg(1),msg(2)]),2);assert.equal(index.orderingUnique,true);
  assert.deepEqual(index.nodes.map(n=>n.row.source_key),['0','1','2']);
});
test('changed text, mixed conversations and hash tampering cannot pass DOM export validation',async()=>{
  const index=S.empty();S.merge(index,views[0],0);assert.throws(()=>S.merge(index,snap([msg(2,'被改写'),msg(3)]),1),/已变化/);
  assert.throws(()=>S.validate({...views[0],conversation_id:'kimi:other'},identity),/另一平台或聊天/);
  const b=await bundle();b.pages[0].response.body_text+=' ';await assert.rejects(O.prepare(b),/校验失败/);
});
test('DOM text profiles preserve empty records and separate visible reasoning',async()=>{
  const thought={...msg(2,'可见思考'),source_key:'thought',channel:'analysis'};
  const view=snap([msg(0,''),thought,msg(1,'正文')],{top:0,height:200,at_top:true,at_bottom:true});
  const body=JSON.stringify(view),hash=await S.sha(body),b=await bundle();
  b.pages=[0,1].map(i=>({session_id:'capture',sequence:i,kind:i?'surface_recheck':'surface',accepted:true,request:{method:'DOM',url:identity.source_url},response:{body_text:body,body_sha256:hash}}));
  const reading=await O.prepare(b),all=await O.prepare(b,{profile:'all'});
  assert.equal(reading.messages.length,2);assert.equal(all.messages.length,3);assert.equal(reading.statistics.empty_text_ids.length,1);
  assert.match(O.toText(reading),/原始正文为空/);assert.ok(!reading.messages.some(m=>m.channel==='analysis'));
});
function captureHarness({failClaim=false,frames=views}={}){
  let record=null,job=null,view=frames.length-1,reads=0,disallowed=false;const pages=[],alarms=new Map();
  const store={getSession:async id=>record?.id===id?structuredClone(record):null,getJob:async()=>job?structuredClone(job):null,pages:async()=>structuredClone(pages),
    claim:async(j,r,replace)=>{if(failClaim)throw Error('cannot save job');if(job?.state==='running'&&job.run_id!==replace)throw Error('already running');record=structuredClone(r);job=structuredClone(j);},
    write:async(run,r,entry,state='running')=>{if(job?.run_id!==run||job.state!=='running')return false;record=structuredClone(r);record.updated_at=new Date().toISOString();if(entry){assert.equal(entry.sequence,pages.length);pages.push(structuredClone(entry));}job.state=state;return true;}};
  const read=async(target,expected,action)=>{
    assert.equal(target.documentId,'doc');assert.equal(expected.source_url,identity.source_url);reads++;if(disallowed)throw Error('原聊天已改变');
    if(action==='identity')return {source_url:expected.source_url};
    if(action==='snapshot')return {body_text:JSON.stringify(frames[view]),position:frames[view].position};
    const prior=frames[view].position;if(action==='bottom')view=frames.length-1;if(action==='up')view=Math.max(0,view-1);if(action==='down')view=Math.min(frames.length-1,view+1);
    return {position:frames[view].position,previous_position:prior};
  };
  const options={store,read,core:S,platforms:P,alarms:{create:async(n,v)=>alarms.set(n,v),get:async n=>alarms.get(n),clear:async n=>alarms.delete(n)},
    clock:{setTimeout:(fn,delay)=>setTimeout(fn,Math.min(delay,2)),clearTimeout},crypto:globalThis.crypto};
  let engine=Capture.create(options);
  return {get engine(){return engine;},get record(){return record;},get pages(){return pages;},get reads(){return reads;},alarms,
    changePage(){disallowed=true;},restart(){engine.shutdown();engine=Capture.create(options);return engine.restore();},
    start:()=>engine.start({tabId:7,documentId:'doc'},identity.conversation_id,'网页测试',identity),
    async wait(predicate){const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw Error('capture timeout');await new Promise(r=>setTimeout(r,2));}},
    bundle:()=>({schema:S.SCHEMA,...identity,title:'网页测试',capture:record,pages})};
}
test('surface collector runs without a panel, scans both directions and clears its alarm',async()=>{
  const h=captureHarness();await h.start();await h.wait(()=>h.record.state==='surface_complete');
  assert.equal(h.record.record_count,8);assert.equal(h.alarms.size,0);const result=await O.prepare(h.bundle());assert.equal(result.messages.length,8);assert.equal(result.scope.server_history_verified,false);
});

test('long keyed messages may span successive scroll positions; anonymous versions still stop safely',async()=>{
  const frames=[...views.map(v=>({...v,position:{...v.position,height:1000,at_bottom:false,full_dom_span:false}})),
    snap(rows.slice(4),{top:600,height:1000,full_dom_span:false}),
    snap(rows.slice(4),{top:800,height:1000,at_bottom:true,full_dom_span:false})];
  const h=captureHarness({frames});await h.start();await h.wait(()=>h.record.state==='surface_complete');
  const result=await O.prepare(h.bundle());assert.equal(result.messages.length,8);assert.equal(h.alarms.size,0);
  assert.deepEqual(result.messages.map(m=>m.content.parts[0]),rows.map(m=>m.text));
  const broken=captureHarness({frames:frames.map(p=>({...p,messages:p.messages.map(m=>({...m,source_key:null}))}))});
  await broken.start();await broken.wait(()=>broken.record.state==='error');
  assert.match(broken.record.detail,/缺少稳定消息编号/);assert.equal(broken.alarms.size,0);
  assert.equal(broken.pages.at(-1).accepted,false);
});
test('a failed webpage job initialization does not leave a periodic wake-up alarm',async()=>{
  const h=captureHarness({failClaim:true});await assert.rejects(h.start(),/cannot save job/);assert.equal(h.alarms.size,0);assert.equal(h.record,null);
});
test('surface pause and worker restart preserve the same record and resume verified snapshots',async()=>{
  const h=captureHarness();await h.start();await h.wait(()=>h.record.page_count>=1);const id=h.record.id;
  await h.engine.pause(id);const before=h.pages.length;assert.equal(h.record.state,'paused');
  await h.engine.resume(id,{tabId:7,documentId:'doc'});await h.wait(()=>h.pages.length>before);
  await h.restart();await h.wait(()=>h.record.state==='surface_complete');
  assert.equal(h.record.id,id);assert.equal(h.record.record_count,8);assert.equal((await O.prepare(h.bundle())).messages.length,8);
});
test('surface sleep preserves raw snapshots and a changed original page stops further collection',async()=>{
  const h=captureHarness();await h.start();await h.wait(()=>h.record.page_count>=1);await h.engine.prepareSleep();
  assert.equal(h.record.state,'paused');assert.ok(h.pages.length);assert.equal(h.alarms.size,0);
  const other=captureHarness();await other.start();await other.wait(()=>other.record.page_count>=1);other.changePage();await other.wait(()=>other.record.state==='error');
  assert.equal(other.alarms.size,0);assert.ok(other.pages.length);assert.ok(other.record.record_count<8);
});
