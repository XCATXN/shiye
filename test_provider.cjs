const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const A=require('./edge-extension/provider-core.js'),R=require('./edge-extension/provider-reader.js'),Capture=require('./edge-extension/provider-capture.js');
const C=require('./edge-extension/core.js'),P=require('./edge-extension/platforms.js'),O=require('./edge-extension/organize.js'),Background=require('./edge-extension/background-capture.js'),Router=require('./edge-extension/capture-router.js');
const UUID='11111111-1111-4111-8111-111111111111',GID='0123456789abcdef',KEY='__chat_backup_reader_22222222-2222-4222-8222-222222222222',TICKET='33333333-3333-4333-8333-333333333333';
const ds=A.identity('https://chat.deepseek.com/a/chat/s/'+UUID),gm=A.identity('https://gemini.google.com/app/'+GID);
const descriptor=(p,cursor=null)=>p.provider_id==='deepseek'?{method:'GET',url:'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id='+UUID,conversation_id:p.conversation_id,cursor:null}:{method:'POST',url:'https://gemini.google.com'+(new URL(p.source_url).pathname.startsWith('/u/2/')?'/u/2':'')+'/_/BardChatUi/data/batchexecute?rpcids=hNvQHb',rpc:'hNvQHb',conversation_id:p.conversation_id,cursor,page_size:10,account_slot:new URL(p.source_url).pathname.startsWith('/u/2/')?'2':'0'};
function dsData(){return {code:0,data:{biz_code:0,biz_data:{chat_session:{id:UUID,title:'DeepSeek 测试',current_message_id:4},chat_messages:[
  {message_id:1,parent_id:0,role:'USER',status:'FINISHED',fragments:[{type:'REQUEST',content:'继续'}]},
  {message_id:2,parent_id:1,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'THINK',content:'辅助思考'},{type:'RESPONSE',content:'  原文\n\n保留空格  '}]},
  {message_id:3,parent_id:2,role:'USER',status:'FINISHED',fragments:[{type:'REQUEST',content:'继续'}]},
  {message_id:4,parent_id:3,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'RESPONSE',content:'新回答'}]},
  {message_id:5,parent_id:3,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'RESPONSE',content:'另一分支'}]}
]}}};}
const turn=n=>[['c_'+GID,'r_'+n],[1700000000+n,0],['问题 '+n],[[['rc_'+n,['回答 '+n]]]]];
function gRaw(numbers,next=null){const inner=[numbers.map(turn),next,null],frame=JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify(inner),null,null,null,'generic']]);return ")]}'\n"+frame.length+'\n'+frame+'\n';}
async function entry(p,sequence,body,cursor=null,accepted=true){return {session_id:'capture',sequence,kind:cursor?'api_previous':sequence?'api_head_recheck':'api_head',accepted,request:descriptor(p,cursor),response:{status:200,body_text:body,body_sha256:await A.sha(body)}};}
async function bundle(p=gm){const records=p===gm?[[gRaw([3,2],'tC_old'),null],[gRaw([1]),'tC_old'],[gRaw([3,2],'tC_old'),null]]:[[JSON.stringify(dsData()),null],[JSON.stringify(dsData()),null]];const pages=[];for(const [i,[body,cursor]] of records.entries())pages.push(await entry(p,i,body,cursor));return {schema:A.SCHEMA,...p,title:'测试会话',capture:{id:'capture',...p,mode:'provider_api',state:'provider_complete'},pages};}

function readerHarness(p=gm,{url=p.source_url,token='private-token',fetcher=async()=>({status:200,headers:new Headers({'Content-Type':'application/json'}),text:async()=>p.provider_id==='deepseek'?JSON.stringify(dsData()):gRaw([1])})}={}){
  let cookieReads=0;const calls=[],location={href:url},context=vm.createContext({location,URL,URLSearchParams,AbortController,
    document:{draft:'未发送草稿',querySelectorAll:()=>[]},WIZ_global_data:{SNlM0e:token,cfb2h:'private-build',FdrFJe:'private-sid'},
    localStorage:{getItem(name){assert.equal(name,'userToken');cookieReads++;return JSON.stringify({value:token});}},
    setTimeout(fn,ms){const t=setTimeout(fn,ms);t.unref();return t;},clearTimeout,
    fetch:async(url,options)=>{calls.push({url,options});return fetcher(url,options);}});
  const run=(func,args)=>vm.runInContext(`(${func.toString()})(...${JSON.stringify(args)})`,context),installed=run(R.installInPage,[KEY,p]);
  return {context,calls,location,run,installed,get credentialReads(){return cookieReads;},command:(name,args=[])=>run(R.commandInPage,[KEY,name,args])};
}
async function settle(h){for(let i=0;i<100;i++){const r=h.command('poll',[TICKET]);if(r.state!=='pending')return r;await new Promise(r=>setImmediate(r));}throw Error('timeout');}

test('DeepSeek reader is conversation-scoped and keeps its token out of results',async()=>{
  const h=readerHarness(ds);try{h.command('start',[TICKET]);const r=await settle(h);assert.equal(r.state,'done');assert.equal(r.request.url,descriptor(ds).url);assert.equal(h.calls[0].options.headers.Authorization,'Bearer private-token');assert.ok(!JSON.stringify(r).includes('private-token'));assert.equal(h.calls.length,1);assert.equal(h.context.document.draft,'未发送草稿');}finally{h.command('dispose');}
});
test('Gemini reader issues only detail RPC, pins account slot and redacts request credentials',async()=>{
  const p=A.identity('https://gemini.google.com/u/2/app/'+GID),h=readerHarness(p);try{
    h.command('start',[TICKET,'tC_previous']);const r=await settle(h);assert.equal(r.state,'done');assert.equal(A.requestValid(r.request,p),true);
    const call=h.calls[0],url=new URL(call.url),form=new URLSearchParams(call.options.body);assert.equal(url.pathname,'/u/2/_/BardChatUi/data/batchexecute');assert.equal(url.searchParams.get('rpcids'),'hNvQHb');assert.equal(call.options.method,'POST');assert.equal(form.get('at'),'private-token');
    const request=JSON.parse(form.get('f.req'));assert.equal(request[0].length,1);assert.deepEqual(JSON.parse(request[0][0][1]),['c_'+GID,10,'tC_previous',1,[1],[4],null,1]);
    for(const secret of ['private-token','private-build','private-sid'])assert.ok(!JSON.stringify(r).includes(secret));
  }finally{h.command('dispose');}
});
test('structured readers reject arbitrary pages/cursors, stop after identity changes, and omit HTML login pages',async()=>{
  const wrong=readerHarness(gm,{url:'https://example.com/app/'+GID});assert.equal(wrong.installed.ok,false);assert.equal(wrong.calls.length,0);
  const cross=readerHarness(gm,{url:gm.source_url+'?authuser=2'});assert.equal(cross.installed.ok,false);
  const h=readerHarness(ds);try{assert.equal(h.command('start',[TICKET,'tC_other']).ok,false);assert.equal(h.calls.length,0);}finally{h.command('dispose');}
  const html=readerHarness(gm,{fetcher:async()=>({status:403,headers:new Headers({'Content-Type':'text/html'}),text:async()=>'<html>private-token</html>'})});try{html.command('start',[TICKET]);const r=await settle(html);assert.equal(r.code,'unexpected_html');assert.ok(!JSON.stringify(r).includes('private-token'));}finally{html.command('dispose');}
  let resolve;const wait=new Promise(r=>resolve=r),changed=readerHarness(gm,{fetcher:()=>wait});changed.command('start',[TICKET]);changed.context.WIZ_global_data.SNlM0e='other-token';resolve({status:200,headers:new Headers(),text:async()=>gRaw([1])});assert.equal((await settle(changed)).code,'identity_changed');changed.command('dispose');
});
test('DeepSeek current branch keeps duplicate prompts and filters reasoning only in reading profile',async()=>{
  const b=await bundle(ds),reading=await O.prepare(b),all=await O.prepare(b,{profile:'all'});
  assert.deepEqual(reading.messages.map(m=>m.id),['deepseek:1','deepseek:2','deepseek:3','deepseek:4']);assert.equal(reading.messages[1].content.parts[0],'  原文\n\n保留空格  ');assert.equal(reading.messages[0].content.parts[0],reading.messages[2].content.parts[0]);assert.equal(reading.statistics.off_route_nodes_not_included,1);
  assert.equal(all.messages[1].content.parts[0].type,'THINK');assert.equal(reading.checks.capture_recheck_passed,true);assert.match(O.toText(reading),/DeepSeek 会话接口备份/);
});
test('DeepSeek rejects business errors, missing parents, ambiguous leafs, streaming and duplicate IDs',()=>{
  for(const change of [d=>d.data.biz_code=1,d=>d.data.biz_data.chat_messages[1].parent_id=999,d=>d.data.biz_data.chat_session.current_message_id=999,d=>d.data.biz_data.chat_messages[0].has_pending_fragment=true,d=>d.data.biz_data.chat_messages.push(d.data.biz_data.chat_messages[0])]){
    const d=dsData();change(d);assert.throws(()=>A.parse(JSON.stringify(d),ds,descriptor(ds)));
  }
});
test('Gemini pages reverse source turn order, follow cursors, preserve raw frames and recheck the head',async()=>{
  const b=await bundle(),r=await O.prepare(b);assert.deepEqual(r.messages.map(m=>m.content.parts[0]),['问题 1','回答 1','问题 2','回答 2','问题 3','回答 3']);assert.equal(r.checks.capture_recheck_passed,true);assert.equal(r.statistics.data_pages,2);assert.equal(r.scope.official_json,false);assert.match(O.toText(r),/Gemini 会话接口备份/);
  assert.equal(A.frames(gRaw([1])).length,1);assert.throws(()=>A.frames(gRaw([1]).slice(0,-4)),/截断|JSON/);
});
test('Gemini cursor loops, wrong conversation, unrecognized turns and conflicting overlap never silently pass',async()=>{
  const state=A.createState(gm);await A.consume(state,await entry(gm,0,gRaw([3,2],'tC_next')));
  await assert.rejects(A.consume(state,await entry(gm,1,gRaw([1],'tC_next'),'tC_next')),/循环/);
  const bad=gRaw([1]).replaceAll('c_'+GID,'c_deadbeefdeadbeef');assert.throws(()=>A.parse(bad,gm,descriptor(gm)),/另一条/);
  const badTurn=turn(1);badTurn[0]=['c_'+GID,'unknown'];const inner=[[badTurn],null],raw=JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify(inner)]]);assert.throws(()=>A.parse(raw,gm,descriptor(gm)),/编号/);
  const changed=await bundle();changed.pages[2]=await entry(gm,2,gRaw([9,2],'tC_old'));await assert.rejects(O.prepare(changed),/发生变化/);
});
test('Gemini multiple candidates require explicit all-types export and retain alternatives',async()=>{
  const t=turn(1);t[3][0].push(['rc_alternate',['另一候选']]);const raw=JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify([[t],null])]]),b=await bundle();b.pages=[await entry(gm,0,raw),await entry(gm,1,raw)];
  await assert.rejects(O.prepare(b),/多个候选/);const r=await O.prepare(b,{profile:'all'});assert.equal(r.messages.length,3);assert.equal(r.scope.selected_route_only,false);assert.match(O.toText(r),/接口返回轮次及候选回答/);
});
test('provider exports bind hashes, account slots and revalidation evidence',async()=>{
  const corrupt=await bundle();corrupt.pages[0].response.body_text+=' ';await assert.rejects(O.prepare(corrupt),/哈希/);
  const wrong=await bundle();wrong.pages[0].request.account_slot='2';await assert.rejects(O.prepare(wrong),/来源/);
  const partial=await bundle();partial.pages=partial.pages.slice(0,1);partial.capture.state='paused';assert.equal((await O.prepare(partial)).checks.capture_recheck_passed,false);
  partial.capture.state='provider_complete';await assert.rejects(O.prepare(partial),/缺少/);
});

function collector(p=gm,{responses=null,seed=null}={}){
  let r=seed?structuredClone(seed.capture):null,job=null,count=0,available=true;const pages=structuredClone(seed?.pages||[]),alarm=new Map();
  const h=readerHarness(p,{fetcher:async(_,options)=>{
    count++;if(responses){const item=responses[Math.min(count-1,responses.length-1)];return {status:item.status||200,headers:new Headers(),text:async()=>item.body};}
    let body=JSON.stringify(dsData());if(p===gm){const form=new URLSearchParams(options.body),args=JSON.parse(JSON.parse(form.get('f.req'))[0][0][1]);body=args[2]?gRaw([1]):gRaw([3,2],'tC_old');}
    return {status:200,headers:new Headers(),text:async()=>body};
  }});h.command('dispose');
  const store={getSession:async id=>r?.id===id?structuredClone(r):null,getJob:async()=>job?structuredClone(job):null,pages:async()=>structuredClone(pages),claim:async(j,v,replace)=>{if(job?.state==='running'&&job.run_id!==replace)throw Error('busy');job=structuredClone(j);r=structuredClone(v);},write:async(run,v,page,state='running')=>{if(job?.run_id!==run||job.state!=='running')return false;r=structuredClone(v);r.updated_at=new Date().toISOString();job.state=state;if(page){assert.equal(page.sequence,pages.length);pages.push(structuredClone(page));}return true;}};
  const browser={scripting:{executeScript:async({target,func,args})=>{if(!available||target.tabId!==1||target.documentIds[0]!=='doc')throw Error('unavailable');return [{frameId:0,documentId:'doc',result:h.run(func,args)}];}}};
  const options={store,transport:Background.transport(browser,R),core:A,common:{...C,retryDelay:()=>1},platforms:P,alarms:{create:async(k,v)=>alarm.set(k,v),clear:async k=>alarm.delete(k),get:async k=>alarm.get(k)},clock:{setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,3)),clearTimeout}};
  let engine=Capture.create(options);return {get engine(){return engine;},get record(){return r;},get calls(){return count;},pages,alarm,
    start:()=>engine.start({tabId:1,documentId:'doc'},p.conversation_id,'测试',p),async wait(fn){const end=Date.now()+3000;while(!await fn()){if(Date.now()>end)throw Error('timeout: '+r?.detail);await new Promise(r=>setTimeout(r,2));}},restart(){engine.shutdown();engine=Capture.create(options);return engine.restore();},unavailable(){available=false;},bundle:()=>({schema:A.SCHEMA,...p,title:r.title,capture:r,pages})};
}
test('two structured collectors complete in background and release alarms',async()=>{
  for(const p of [ds,gm]){const h=collector(p);await h.start();await h.wait(()=>h.record.state==='provider_complete');assert.equal(h.calls,p===gm?3:2);assert.equal(h.alarm.size,0);assert.equal((await O.prepare(h.bundle())).messages.length,p===gm?6:4);}
});
test('Gemini pause and worker restart reuse saved cursor pages with a fresh head check',async()=>{
  const h=collector();await h.start();await h.wait(()=>h.record.page_count===1);const id=h.record.id;await h.engine.pause(id);await h.engine.resume(id,{tabId:1,documentId:'doc'});await h.restart();await h.wait(()=>h.record.state==='provider_complete');assert.equal(h.record.id,id);assert.equal((await O.prepare(h.bundle())).messages.length,6);
});
test('provider denial is saved once, without scrolling fallback or infinite retry',async()=>{
  const h=collector(ds,{responses:[{status:403,body:'{"error":"forbidden"}'}]});await h.start();await h.wait(()=>h.record.state==='error');assert.equal(h.calls,1);assert.equal(h.pages[0].accepted,false);assert.equal(h.alarm.size,0);
});
test('provider stored revalidation stays offline and an incomplete revalidated capture can resume',async()=>{
  const b=await bundle();b.capture={...b.capture,state:'error',next_sequence:3,record_count:0};b.pages.forEach(p=>p.accepted=false);const h=collector(gm,{seed:b});h.unavailable();await h.engine.revalidate('capture');assert.equal(h.record.state,'provider_complete');assert.equal(h.calls,0);assert.equal((await O.prepare(h.bundle())).messages.length,6);assert.ok(h.pages.every(p=>p.accepted===false));
  const one=await bundle();one.pages=one.pages.slice(0,1);one.pages[0].accepted=false;one.capture={...one.capture,state:'error',next_sequence:1,record_count:0};const resumed=collector(gm,{seed:one});await resumed.engine.revalidate('capture');assert.equal(resumed.record.state,'paused');await resumed.engine.resume('capture',{tabId:1,documentId:'doc'});await resumed.wait(()=>resumed.record.state==='provider_complete');assert.equal((await O.prepare(resumed.bundle())).messages.length,6);
});
test('provider routing preserves old surface sessions and defaults new DeepSeek/Gemini sessions to API',async()=>{
  const records={old:{provider_id:'gemini',mode:'surface'},new:{provider_id:'deepseek',mode:'provider_api'}};const make=id=>({start:()=>id,resume:()=>id,status:()=>id});
  const router=Router.create({store:{getJob:async()=>({session_id:'new'}),getSession:async id=>records[id]},chatgpt:()=>make('chatgpt'),claude:()=>make('claude'),surface:()=>make('surface'),provider:()=>make('provider')});
  assert.equal(router.start({},'', '',{provider_id:'deepseek'}),'provider');assert.equal(router.start({},'', '',{provider_id:'gemini',capture_method:'surface'}),'surface');assert.equal(await router.resume('old',{}),'surface');assert.equal(await router.status(),'provider');
});
