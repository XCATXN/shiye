const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const A=require('./edge-extension/claude-core.js'),R=require('./edge-extension/claude-reader.js'),Capture=require('./edge-extension/claude-capture.js');
const C=require('./edge-extension/core.js'),O=require('./edge-extension/organize.js'),Background=require('./edge-extension/background-capture.js'),Router=require('./edge-extension/capture-router.js');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const CID=id(800),ORG=id(900),KEY='__chat_backup_reader_'+id(901),TICKET=id(902),PAGE='https://claude.ai/chat/'+CID;
const expected=A.identity(PAGE),ENDPOINT=`https://claude.ai/api/organizations/${ORG}/chat_conversations/${CID}?tree=true&rendering_mode=messages&render_all_tools=true`;
const message=(n,parent,sender,text)=>({uuid:id(n),parent_message_uuid:parent===null?null:id(parent),sender,created_at:'2026-10-09T00:00:00Z',content:[{type:'text',text}],files:[],attachments:[],truncated:false});
function tree(){return {uuid:CID,name:'Claude 会话夹具',current_leaf_message_uuid:id(4),chat_messages:[
  message(5,3,'assistant','另一版本，不应混入当前路线'),message(3,2,'human','继续'),message(2,1,'assistant','  第一行\n\n第二行  '),message(4,3,'assistant','当前回答'),message(1,null,'human','继续')
]};}
async function bundle(data=tree(),complete=true){
  const pages=[];for(let i=0;i<(complete?2:1);i++){
    const body=JSON.stringify(i?{...data,chat_messages:[...data.chat_messages].reverse()}:data);
    pages.push({session_id:'capture',sequence:i,kind:i?'claude_recheck':'claude_tree',accepted:true,request:{method:'GET',url:ENDPOINT},response:{status:200,body_text:body,body_sha256:await A.sha(body)},validation:{recheck_of_sequence:i?0:null}});
  }
  return {schema:A.SCHEMA,...expected,title:'fixture',capture:{id:'capture',...expected,mode:'claude_api',state:complete?'claude_complete':'paused'},pages};
}
function pageHarness({url=PAGE,cookie=`sessionKey=private-session; lastActiveOrg=${ORG}; unrelated=private-cookie`,fetcher=async()=>({status:200,text:async()=>JSON.stringify(tree()),headers:new Headers({'content-type':'application/json','set-cookie':'never-export'})})}={}){
  const calls=[],location={href:url};let reads=0;
  const document={draft:'用户未发送草稿',get cookie(){reads++;return cookie;}};
  const context=vm.createContext({location,document,URL,AbortController,console,
    setTimeout(fn,ms){const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout,
    fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options,calls.length);}});
  const run=(fn,args)=>vm.runInContext(`(${fn.toString()})(...${JSON.stringify(args)})`,context);
  const installed=run(R.installInPage,[KEY,expected.conversation_id]);
  return {calls,location,document,context,run,installed,get cookieReads(){return reads;},setCookie:value=>cookie=value,command:(command,args=[])=>run(R.commandInPage,[KEY,command,args])};
}
async function settle(h){for(let i=0;i<100;i++){const value=h.command('poll',[TICKET]);if(value.state!=='pending')return value;await new Promise(r=>setImmediate(r));}throw Error('reader did not settle');}

test('Claude reader requests only the selected conversation, keeps cookies in page, and never scrolls',async()=>{
  const h=pageHarness();assert.equal(h.installed.ok,true);assert.equal(h.cookieReads,0);
  try{
    h.command('start',[TICKET]);const r=await settle(h);assert.equal(r.state,'done');assert.equal(r.url,ENDPOINT);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.method,'GET');assert.equal(h.calls[0].options.credentials,'same-origin');assert.equal(h.calls[0].options.redirect,'error');
    assert.equal(h.document.draft,'用户未发送草稿');assert.equal(JSON.stringify(h.calls).includes('private-session'),false);
    for(const text of ['private-session','private-cookie','never-export'])assert.ok(!JSON.stringify(r).includes(text));
    h.command('ack',[TICKET]);h.command('start',[TICKET]);assert.equal((await settle(h)).state,'done');assert.equal(h.calls.length,2);
  }finally{h.command('dispose');}
});

test('Claude reader rejects foreign pages, other conversations and supplied arbitrary URLs before a request',async()=>{
  for(const url of ['https://example.com/chat/'+CID,'https://claude.ai/chat/'+id(123),'https://claude.ai.evil.test/chat/'+CID]){
    const h=pageHarness({url});assert.equal(h.installed.ok,false);assert.equal(h.calls.length,0);assert.equal(h.cookieReads,0);
  }
  const h=pageHarness();try{assert.equal(h.command('start',[TICKET,'https://example.com']).ok,false);assert.equal(h.calls.length,0);}finally{h.command('dispose');}
  for(const url of [ENDPOINT.replace(CID,id(777)),ENDPOINT+'&include_other_chats=true',ENDPOINT.replace('claude.ai','claude.ai.evil.test'),ENDPOINT+'&tree=true'])assert.equal(A.requestInfo(url,expected.conversation_id),null);
});

test('Claude reader stops when organization changes or capture is disposed; page exceptions stay private',async()=>{
  let release;const response=new Promise(r=>release=r),h=pageHarness({fetcher:()=>response});
  h.command('start',[TICKET]);h.setCookie('lastActiveOrg='+id(999));release({status:200,text:async()=>'sensitive wrong workspace',headers:new Headers()});
  assert.equal((await settle(h)).code,'organization_changed');h.command('dispose');
  const pending=pageHarness({fetcher:async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('private exception'))))});
  pending.command('start',[TICKET]);pending.command('dispose');assert.equal(pending.calls[0].options.signal.aborted,true);assert.equal(pending.command('poll',[TICKET]).state,'missing');
  const broken=pageHarness({fetcher:async()=>{throw Error('private sessionKey secret');}});broken.command('start',[TICKET]);assert.equal((await settle(broken)).code,'network_error');broken.command('dispose');
  const missing=pageHarness({cookie:'sessionKey=private'});missing.command('start',[TICKET]);assert.equal((await settle(missing)).code,'organization_missing');assert.equal(missing.calls.length,0);missing.command('dispose');
});

test('Claude organization requests bind current branch by parent links, not array order or timestamps',async()=>{
  const b=await bundle(),r=await O.prepare(b);
  assert.deepEqual(r.messages.map(m=>m.id),[1,2,3,4].map(id));assert.deepEqual(r.messages.map(m=>m.content.parts[0]),['继续','  第一行\n\n第二行  ','继续','当前回答']);
  assert.equal(r.statistics.returned_tree_messages,5);assert.equal(r.statistics.off_route_nodes_not_included,1);assert.equal(r.statistics.repeated_response_messages_removed,5);
  assert.equal(r.checks.capture_recheck_passed,true);assert.equal(r.scope.official_export_equivalent,false);assert.equal(r.scope.attachments_downloaded,false);
  assert.match(O.toText(r),/Claude 会话接口备份 · 非官方账号导出/);assert.ok(!O.toText(r).includes('另一版本，不应混入当前路线'));
});

test('Claude graph rejects missing parents, cycles, duplicate IDs, streaming, partial data and missing active leaf',()=>{
  const checks=[
    d=>delete d.current_leaf_message_uuid,
    d=>{d.chat_messages[0].parent_message_uuid=id(12345);},
    d=>{d.chat_messages.find(m=>m.uuid===id(1)).parent_message_uuid=id(4);},
    d=>d.chat_messages.push(d.chat_messages[0]),
    d=>{d.chat_messages[1].is_streaming=true;},
    d=>{d.has_more=true;},d=>{d.uuid=id(777);},
    d=>{delete d.chat_messages[0].parent_message_uuid;}
  ];for(const change of checks){const d=tree();change(d);assert.throws(()=>A.inspect(d,expected.conversation_id));}
});

test('Claude profiles preserve text blocks, blank positions, attachment extracts and unknown structures',async()=>{
  const d=tree(),m=d.chat_messages.find(m=>m.uuid===id(2));
  m.content=[{type:'thinking',thinking:'辅助思考'},{type:'text',text:' A\n\nB '},{type:'tool_use',name:'artifacts',input:{content:'原始作品\n',command:'create'}},{type:'new_kind',value:'保留未知块'}];
  d.chat_messages.find(m=>m.uuid===id(1)).attachments=[{file_name:'设定.txt',extracted_content:'原始附件段落\n不得丢失'}];
  d.chat_messages.find(m=>m.uuid===id(4)).content=[{type:'text',text:''}];
  const b=await bundle(d),reading=await O.prepare(b),all=await O.prepare(b,{profile:'all'});
  assert.deepEqual(reading.messages[1].content.parts,[' A\n\nB ',m.content[2],m.content[3]]);
  assert.deepEqual(all.messages[1].content.parts,[m.content[0],' A\n\nB ',m.content[2],m.content[3]]);
  assert.equal(all.messages[1].metadata.source_record.uuid,id(2));assert.equal(reading.messages[0].metadata.attachments[0].extracted_content,'原始附件段落\n不得丢失');
  assert.ok(reading.statistics.empty_text_ids.includes(id(4)));assert.match(O.toText(reading),/原始正文为空/);assert.match(reading.warnings.join('\n'),/new_kind/);
});

test('Claude exports reject source, hashes or recheck tampering and mark an unfinished capture',async()=>{
  const b=await bundle();b.pages[0].response.body_text+=' ';await assert.rejects(O.prepare(b),/校验/);
  const wrong=await bundle();wrong.pages[0].request.headers={Cookie:'not allowed'};await assert.rejects(O.prepare(wrong),/来源/);
  const changed=await bundle(),d=JSON.parse(changed.pages[1].response.body_text);d.chat_messages[0].content[0].text='被改写';changed.pages[1].response.body_text=JSON.stringify(d);changed.pages[1].response.body_sha256=await A.sha(changed.pages[1].response.body_text);await assert.rejects(O.prepare(changed),/不一致/);
  const partial=await O.prepare(await bundle(tree(),false));assert.equal(partial.checks.capture_recheck_passed,false);assert.match(partial.warnings.join('\n'),/未.*复核/);
  const claimed=await bundle(tree(),false);claimed.capture.state='claude_complete';await assert.rejects(O.prepare(claimed),/缺少/);
});

test('Claude graph walks very long histories without recursive parent traversal',()=>{
  const d={uuid:CID,current_leaf_message_uuid:id(12000),chat_messages:Array.from({length:12000},(_,i)=>message(i+1,i?i:null,i%2?'assistant':'human','继续'))};
  const info=A.inspect(d,expected.conversation_id);assert.equal(info.route_count,12000);assert.equal(info.off_route_count,0);
});

function captureHarness({responses=[tree(),tree()],failClaim=false,failWrite=false,savedBundle=null}={}){
  let record=savedBundle?structuredClone(savedBundle.capture):null,job=null,responseIndex=0,available=true;const pages=structuredClone(savedBundle?.pages||[]),alarmMap=new Map(),keys=new Set();
  const h=pageHarness({fetcher:async()=>{const value=responses[Math.min(responseIndex++,responses.length-1)];if(value instanceof Error)throw value;
    return {status:value.status||200,headers:new Headers({'content-type':'application/json'}),text:async()=>typeof value.body==='string'?value.body:JSON.stringify(value)};}});
  h.command('dispose');
  const browser={scripting:{executeScript:async({target,func,args})=>{if(!available||target.tabId!==7||target.documentIds[0]!=='doc')throw Error('target unavailable');
    if(func===R.installInPage)keys.add(args[0]);return [{frameId:0,documentId:'doc',result:h.run(func,args)}];}}};
  const store={getJob:async()=>job?structuredClone(job):null,getSession:async key=>record?.id===key?structuredClone(record):null,pages:async()=>structuredClone(pages),
    claim:async(j,r,replace)=>{if(failClaim)throw Error('save claim failed');if(job?.state==='running'&&job.run_id!==replace)throw Error('busy');record=structuredClone(r);job=structuredClone(j);},
    write:async(run,r,p,state='running')=>{if(failWrite)throw Error('disk full');if(job?.run_id!==run||job.state!=='running')return false;record=structuredClone(r);record.updated_at=new Date().toISOString();job.state=state;if(p){assert.equal(p.sequence,pages.length);pages.push(structuredClone(p));}return true;}};
  const options={store,transport:Background.transport(browser,R),core:A,common:{...C,retryDelay:()=>1},clock:{setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,4)),clearTimeout},crypto:globalThis.crypto,
    alarms:{create:async(n,v)=>alarmMap.set(n,v),clear:async n=>alarmMap.delete(n),get:async n=>alarmMap.get(n)}};
  let engine=Capture.create(options);
  return {get engine(){return engine;},get record(){return record;},pages,alarmMap,h,keys,
    start:()=>engine.start({tabId:7,documentId:'doc'},expected.conversation_id,'Claude',expected),
    async wait(predicate){const until=Date.now()+3000;while(!await predicate()){if(Date.now()>until)throw Error('collector wait timed out: '+record?.detail);await new Promise(r=>setTimeout(r,2));}},
    restart(){engine.shutdown();engine=Capture.create(options);return engine.restore();},unavailable(){available=false;},
    bundle:()=>({schema:A.SCHEMA,...expected,title:record.title,capture:record,pages})};
}

test('Claude collector completes two direct reads, saves raw bodies and releases page readers and alarm',async()=>{
  const h=captureHarness();await h.start();await h.wait(()=>h.record.state==='claude_complete');
  assert.equal(h.h.calls.length,2);assert.equal(h.pages.length,2);assert.equal(h.record.record_count,5);assert.equal(h.record.route_count,4);assert.equal(h.alarmMap.size,0);
  assert.equal(h.pages[0].response.body_text,JSON.stringify(tree()));assert.equal((await O.prepare(h.bundle())).messages.length,4);
  assert.ok([...h.keys].every(key=>!Object.hasOwn(h.h.context,key)));assert.equal(h.h.document.draft,'用户未发送草稿');
});

test('Claude 403 is saved once without silent DOM fallback; changed or invalid responses remain downloadable',async()=>{
  const denied=captureHarness({responses:[{status:403,body:'{"error":"forbidden"}'}]});await denied.start();await denied.wait(()=>denied.record.state==='error');
  assert.equal(denied.h.calls.length,1);assert.equal(denied.pages[0].accepted,false);assert.match(denied.record.detail,/不会自动滚动/);assert.equal(denied.alarmMap.size,0);
  const bad=tree();bad.chat_messages[0].content[0].text='修改过的旧分支';
  const changed=captureHarness({responses:[tree(),bad]});await changed.start();await changed.wait(()=>changed.record.state==='error');assert.equal(changed.pages.length,2);assert.equal(changed.pages[1].accepted,false);
  const partial=await O.prepare(changed.bundle());assert.equal(partial.messages.length,4);assert.equal(partial.checks.capture_recheck_passed,false);
  const shape=captureHarness({responses:[{body:'{"new_server_format":true}'}]});await shape.start();await shape.wait(()=>shape.record.state==='error');assert.equal(shape.pages[0].response.body_text,'{"new_server_format":true}');
});

test('Claude retries transient responses finitely and rechecks a checkpoint after pause and worker restart',async()=>{
  const retry=captureHarness({responses:[{status:503,body:'temporary'},tree(),tree()]});await retry.start();await retry.wait(()=>retry.record.state==='claude_complete');assert.equal(retry.h.calls.length,3);assert.equal(retry.pages[0].accepted,false);assert.equal((await O.prepare(retry.bundle())).messages.length,4);
  const h=captureHarness();await h.start();await h.wait(()=>h.record.page_count===1);const captureId=h.record.id;await h.engine.pause(captureId);assert.equal(h.record.state,'paused');
  await h.engine.resume(captureId,{tabId:7,documentId:'doc'});await h.restart();await h.wait(()=>h.record.state==='claude_complete');assert.equal(h.record.id,captureId);assert.equal((await O.prepare(h.bundle())).messages.length,4);
  const down=captureHarness({responses:[{status:503,body:'temporary'}]});await down.start();await down.wait(()=>down.record.state==='error');assert.equal(down.h.calls.length,3);assert.equal(down.alarmMap.size,0);
});

test('Claude sleep and initialization failures preserve data without leaving active work',async()=>{
  const fail=captureHarness({failClaim:true});await assert.rejects(fail.start(),/save claim/);assert.equal(fail.alarmMap.size,0);
  const h=captureHarness();await h.start();await h.wait(()=>h.record.page_count===1);await h.engine.prepareSleep();assert.equal(h.record.state,'paused');assert.equal(h.alarmMap.size,0);assert.equal(h.pages.length,1);
  const disk=captureHarness({failWrite:true});await disk.start();await disk.wait(async()=>(await disk.engine.status()).has_unsaved_response);const status=await disk.engine.status();assert.equal(status.has_unsaved_response,true);assert.ok(await disk.engine.pending(disk.record.id));await assert.rejects(disk.engine.prepareSleep(),/未保存/);assert.equal(disk.alarmMap.size,0);
});

test('Claude new captures default to API while explicit fallback and old surface resumes retain their original engine',async()=>{
  let selected='old';const records={old:{provider_id:'claude',mode:'surface'},api:{provider_id:'claude',mode:'claude_api'}};
  const make=kind=>Object.fromEntries(['start','resume','status','restore','boot','pause','pending','prepareSleep','shutdown'].map(method=>[method,()=>({kind,method})]));
  const r=Router.create({store:{getJob:async()=>({session_id:selected}),getSession:async id=>records[id]},chatgpt:()=>make('chatgpt'),surface:()=>make('surface'),claude:()=>make('claude')});
  assert.equal(r.start({},'id','title',{provider_id:'claude'}).kind,'claude');assert.equal(r.start({},'id','title',{provider_id:'claude',capture_method:'surface'}).kind,'surface');
  assert.equal((await r.resume('old',{})).kind,'surface');selected='api';assert.equal((await r.restore()).kind,'claude');assert.equal(C.canDeleteStoredSession({state:'claude_complete'}),true);
});

test('new and fallback collectors report idle for missing or deleted records',async()=>{
  for(const removed of [false,true]){
    const store={getJob:async()=>removed?{session_id:'deleted',state:'running'}:null,getSession:async()=>({id:'deleted',deleted:true})};
    const engines=[Capture.create({store,core:A,common:C}),require('./edge-extension/surface-capture.js').create({store})];
    for(const engine of engines){const value=await engine.status();assert.equal(value.active,false);assert.equal(value.session,null);}
  }
});

test('Claude recognizes both explicit root sentinels while rejecting any other missing parent',()=>{
  for(const root of ['00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-000000000000']){
    const data=tree();data.chat_messages.find(m=>m.uuid===id(1)).parent_message_uuid=root;const before=JSON.stringify(data);
    const info=A.inspect(data,expected.conversation_id);assert.equal(info.route_count,4);assert.equal(JSON.stringify(data),before);
    data.chat_messages.push({...message(10,null,'human','fake root'),uuid:root});assert.throws(()=>A.inspect(data,expected.conversation_id),/编号/);
  }
  const missing=tree();missing.chat_messages.find(m=>m.uuid===id(1)).parent_message_uuid=id(123456);assert.throws(()=>A.inspect(missing,expected.conversation_id),/缺失/);
});

async function rejectedBundle(complete=true){
  const data=tree();data.chat_messages.find(m=>m.uuid===id(1)).parent_message_uuid=id(0);
  const b=await bundle(data,complete);Object.assign(b.capture,{state:'error',next_sequence:b.pages.length,page_count:0,record_count:0,route_count:0,reading_count:0,auxiliary_count:0});
  for(const p of b.pages){p.kind='claude_tree';p.accepted=false;p.validation={rejection:'旧版根节点误判'};}
  return b;
}

test('saved response review restores old rejected data without rewriting evidence or trusting old verdicts',async()=>{
  const b=await rejectedBundle(),before=JSON.stringify(b),review=await A.reviewStored(b);
  assert.equal(JSON.stringify(b),before);assert.equal(review.evidence.rechecked,true);
  b.capture.revalidation=review.evidence;b.capture.state='claude_complete';
  const value=await O.prepare(b);assert.equal(value.messages.length,4);assert.equal(value.checks.recheck_source,'stored_responses');assert.equal(value.checks.capture_recheck_passed,true);
  assert.equal(value.source.responses[0].original_accepted,false);assert.ok(b.pages.every(p=>p.accepted===false));
  b.capture.revalidation.sources[0].body_sha256='0'.repeat(64);await assert.rejects(O.prepare(b),/重新校验/);
  const tampered=await rejectedBundle();tampered.pages[0].response.body_text+=' ';await assert.rejects(A.reviewStored(tampered),/校验/);
  const changed=await rejectedBundle(),other=JSON.parse(changed.pages[1].response.body_text);other.chat_messages[0].content[0].text='不同';changed.pages[1].response.body_text=JSON.stringify(other);changed.pages[1].response.body_sha256=await A.sha(changed.pages[1].response.body_text);await assert.rejects(A.reviewStored(changed),/不一致/);
});

test('offline revalidation updates counts with no page access, and a single snapshot still needs a live recheck',async()=>{
  const b=await rejectedBundle(),h=captureHarness({savedBundle:b});h.unavailable();const before=JSON.stringify(h.pages);
  await h.engine.revalidate(b.capture.id);assert.equal(h.record.state,'claude_complete');assert.equal(h.record.record_count,5);assert.equal(h.record.reading_count,4);
  assert.equal(h.h.calls.length,0);assert.equal(h.keys.size,0);assert.equal(h.alarmMap.size,0);assert.equal(JSON.stringify(h.pages),before);
  assert.equal((await O.prepare(h.bundle())).checks.capture_recheck_passed,true);
  const single=await rejectedBundle(false),data=JSON.parse(single.pages[0].response.body_text),resume=captureHarness({savedBundle:single,responses:[data]});
  await resume.engine.revalidate(single.capture.id);assert.equal(resume.record.state,'paused');assert.equal((await O.prepare(resume.bundle())).checks.capture_recheck_passed,false);
  await resume.engine.resume(single.capture.id,{tabId:7,documentId:'doc'});await resume.wait(()=>resume.record.state==='claude_complete');
  assert.equal(resume.h.calls.length,1);assert.equal(resume.pages.length,2);assert.equal(resume.pages[0].accepted,false);
  const result=await O.prepare(resume.bundle());assert.equal(result.checks.capture_recheck_passed,true);assert.equal(result.checks.recheck_source,'live_response');
});
