const runtimeTest = require('node:test');
const assertRuntime = require('node:assert/strict');
const fsRuntime = require('node:fs');
const vmRuntime = require('node:vm');
const cryptoRuntime = require('node:crypto').webcrypto;
const CtxCore = require('./edge-extension/core.js');
const CtxOrganize = require('./edge-extension/organize.js');
const CtxReader = require('./edge-extension/page-reader.js');
const WorkerStore = require('./edge-extension/capture-store.js');
const WorkerCapture = require('./edge-extension/background-capture.js');
function verifyDownloadedBundle(output) {
  const result = require('node:child_process').spawnSync('python', ['-c',
    'import json,sys; from verify_capture import validate_bundle; r,p,c=validate_bundle(json.loads(sys.stdin.buffer.read().decode("utf-8"))); print(json.dumps(c))'],
    {cwd:__dirname,input:output,encoding:'utf8'});
  assertRuntime.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
const CIDR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MR1 = '00000000-0000-4000-8000-000000000001';
const MR2 = '00000000-0000-4000-8000-000000000002';
const PAGER = `https://chatgpt.com/backend-api/conversations/${CIDR}?include_has_versions=true&num_turns=10`;
const HEADR = {conversation_id:CIDR,current_node:MR2,messages:[
  {id:MR1,author:{role:'user'},content:{content_type:'text',parts:['测试问题']},create_time:1},
  {id:MR2,author:{role:'assistant'},content:{content_type:'text',parts:['测试回答']},create_time:2}
],page_info:{start_cursor:MR1,end_cursor:MR2,has_previous_page:false,has_next_page:false}};
function requestR(url, status, body, headers = []) {
  return {startedDateTime:'2026-09-13T04:15:00Z',request:{method:'GET',url,
      headers:[{name:'Authorization',value:'runtime-test-placeholder-never-export'}]},
    response:{status,headers},getContent(callback){queueMicrotask(()=>callback(body,''));}};
}
async function waitRuntime(predicate) {
  const until=Date.now()+3000;
  while(!predicate()) {if(Date.now()>until) throw new Error('Runtime fixture did not reach expected state');await new Promise(r=>setTimeout(r,3));}
}
async function panelHarness({entries=[],savedSessions=[],savedPages=[],fetchStatus=200,fetchBody=JSON.stringify(HEADR),failDeleteAt=0,onFetch=null,earlyRequest=null,
  sessionStatus=200,sessionBody={accessToken:'fixture-session-token-never-save',user:{email:'private-session-fixture@example.invalid'}},
  sessionWait=null,promiseApis=false,emitNetworkEvents=true,sidebar=false,initialURL=null,scriptingDenied=false,locks=null,claudeBackend=false,structuredBackend=false}={}) {
  const tables={sessions:new Map(),pages:new Map(),jobs:new Map()}, calls=[], nodes=new Map(), downloads=[], blobs=new Map(), listeners=[], navListeners=[];
  for(const value of savedSessions) tables.sessions.set(value.id,structuredClone(value));
  for(const value of savedPages) tables.pages.set(JSON.stringify([value.session_id,value.sequence]),structuredClone(value));
  let reloads=0, deletionCalls=0;
  function node(tag='div') {return {tag,textContent:'',value:'',disabled:false,children:[],events:{},dataset:{},
    addEventListener(event,fn){this.events[event]=fn;},replaceChildren(){this.children=[];},append(value){this.children.push(value);},
    remove(){},showModal(){this.open=true;},close(){this.open=false;},click(){if(this.tag==='a')downloads.push(blobs.get(this.href));return this.events.click?.();}};}
  const documentEvents={},panelEvents={};
  const document={getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node,body:node('body'),
    addEventListener:(event,fn)=>{documentEvents[event]=fn;},hidden:false};
  function transaction(names=['sessions','pages'],mode='readonly') {
    const scope=Array.isArray(names)?names:[names];
    const snapshots=Object.fromEntries(scope.map(name=>[name,new Map([...tables[name]].map(([k,v])=>[k,structuredClone(v)]))]));
    const tx={scheduled:false,pending:0,aborted:false,finished:false,objectStore(name){return store(name,tx);},
      abort(){if(this.aborted||this.finished)return;this.aborted=true;
        if(mode==='readwrite')for(const name of scope)tables[name]=snapshots[name];
        queueMicrotask(()=>this.onabort?.());}};return tx;
  }
  function complete(tx) {if(!tx.scheduled&&!tx.aborted&&!tx.finished&&tx.pending===0){tx.scheduled=true;queueMicrotask(()=>{
    tx.scheduled=false;if(!tx.aborted&&!tx.finished&&tx.pending===0){tx.finished=true;tx.oncomplete?.();}});}}
  function requestValue(tx,producer) {const req={};tx.pending++;queueMicrotask(()=>{
    if(tx.aborted)return;
    try{req.result=structuredClone(producer());req.onsuccess?.();}
    catch(error){req.error=error;tx.error=error;req.onerror?.();tx.onerror?.();tx.abort();}
    finally{tx.pending--;complete(tx);}});return req;}
  function cursorRequest(name,tx) {
    const req={},keys=[...tables[name].keys()];let i=0;tx.pending++;
    function step(){if(tx.aborted)return;
      let continued=false;
      if(i<keys.length){const key=keys[i++];req.result={value:structuredClone(tables[name].get(key)),
        continue(){continued=true;queueMicrotask(step);}};}else req.result=null;
      try{req.onsuccess?.();}catch(error){tx.error=error;tx.onerror?.();tx.abort();}
      if(!continued){tx.pending--;complete(tx);}}
    queueMicrotask(step);return req;
  }
  function store(name,tx) {return {
    createIndex(){},get(key){return requestValue(tx,()=>tables[name].get(JSON.stringify(key)) || tables[name].get(key));},
    getAll(){return requestValue(tx,()=>[...tables[name].values()]);},openCursor(){return cursorRequest(name,tx);},
    index(){return {getAll(id){return requestValue(tx,()=>[...tables[name].values()].filter(x=>x.session_id===id));},
      getAllKeys(id){return requestValue(tx,()=>[...tables[name].values()].filter(x=>x.session_id===id).map(x=>[x.session_id,x.sequence]));}};},
    put(value){return requestValue(tx,()=>{const key=name==='pages'?JSON.stringify([value.session_id,value.sequence]):value.id;tables[name].set(key,structuredClone(value));return key;});},
    add(value){return requestValue(tx,()=>{const key=JSON.stringify([value.session_id,value.sequence]);if(tables[name].has(key))throw Error('Duplicate fixture key');tables[name].set(key,structuredClone(value));return key;});},
    delete(key){return requestValue(tx,()=>{deletionCalls++;if(failDeleteAt&&deletionCalls===failDeleteAt)throw Error('simulated page deletion failure');tables[name].delete(name==='sessions'?key:JSON.stringify(key));});}
  };}
  const fakeDB={objectStoreNames:{contains:name=>Object.hasOwn(tables,name)},close(){},createObjectStore(name){return store(name,transaction());},transaction};
  const indexedDB={open(){const req={result:fakeDB};queueMicrotask(()=>{req.onupgradeneeded?.();req.onsuccess?.();});return req;}};
  class PanelURL extends URL {}
  PanelURL.createObjectURL=blob=>{const key='blob:fixture-'+blobs.size;blobs.set(key,blob);return key;};
  PanelURL.revokeObjectURL=key=>blobs.delete(key);
  const location={href:initialURL || `https://chatgpt.com/c/${CIDR}`,pathname:`/c/${CIDR}`};
  const pageDocument={title:'测试聊天',draftText:'没有发送的小说草稿',cookie:'lastActiveOrg=00000000-0000-4000-8000-000000000900'};
  const pageContext=vmRuntime.createContext({location,URL,URLSearchParams,document:pageDocument,AbortController,localStorage:{getItem:()=>JSON.stringify({value:'private-provider-token'})},WIZ_global_data:{SNlM0e:'private-provider-token',cfb2h:'private-build',FdrFJe:'private-sid'},
    setTimeout(fn,delay){const t=setTimeout(fn,delay);t.unref();return t;},clearTimeout,
    fetch:async(url,options)=>{
      calls.push({url,method:options.method});
      if(url==='https://chatgpt.com/api/auth/session'){
        if(sessionWait)await sessionWait;
        return {status:sessionStatus,json:async()=>structuredClone(sessionBody)};
      }
      const result=(onFetch ? await onFetch(url,calls.length) : null)||{status:fetchStatus,body:fetchBody};
      const responseHeaders=[{name:'content-type',value:'application/json'}];
      const r=requestR(url,result.status,result.body,responseHeaders);
      r.request.headers=Object.entries(options.headers || {}).map(([name,value])=>({name,value}));
      if(promiseApis)r.getContent=()=>Promise.resolve({content:result.body,encoding:''});
      entries.push(r);
      if(emitNetworkEvents)setImmediate(()=>{for(const fn of listeners)fn(r);});
      return {status:result.status,text:async()=>result.body,headers:new Headers(responseHeaders.map(h=>[h.name,h.value]))};
    }});
  const chrome={devtools:{network:{
    getHAR(callback){if(promiseApis)return Promise.resolve({entries});queueMicrotask(()=>callback({entries}));},
    onRequestFinished:{addListener(fn){listeners.push(fn);if(earlyRequest)queueMicrotask(()=>fn(earlyRequest));}},onNavigated:{addListener(fn){navListeners.push(fn);}}
  },inspectedWindow:{
    reload(){reloads++;for(const fn of navListeners)fn(location.href);},
    eval(code,callback){
      try {
        const value=vmRuntime.runInContext(code,pageContext);
        if(promiseApis)return Promise.resolve({result:value});
        queueMicrotask(()=>callback(value));
      } catch {if(promiseApis)return Promise.resolve({exceptionInfo:{isException:true}});queueMicrotask(()=>callback(undefined,{isException:true}));}
    }
  }}};
  const injections=[],tabListeners={activated:[],updated:[],removed:[],panelClosed:[],panelOpened:[]};
  let worker=null;
  let activeTabId=71,documentId='fixture-document-1',removed=false;
  const otherTab={id:72,windowId:7,active:true,url:'https://example.invalid/video',title:'视频标签'};
  const tabInfo=()=>({id:71,windowId:7,active:activeTabId===71,url:location.href,title:pageDocument.title});
  if(sidebar) {
    delete chrome.devtools;
    chrome.windows={getCurrent:async()=>({id:7})};
    chrome.sidePanel={onClosed:{addListener:fn=>tabListeners.panelClosed.push(fn)},onOpened:{addListener:fn=>tabListeners.panelOpened.push(fn)}};
    chrome.tabs={query:async options=>{assertRuntime.equal(options.windowId,7);return removed?[]:[activeTabId===71?tabInfo():otherTab];},
      onActivated:{addListener:fn=>tabListeners.activated.push(fn)},onUpdated:{addListener:fn=>tabListeners.updated.push(fn)},onRemoved:{addListener:fn=>tabListeners.removed.push(fn)}};
    chrome.scripting={executeScript:async({target,world,func,args})=>{
      injections.push(structuredClone(target));assertRuntime.equal(world,'MAIN');
      if(scriptingDenied || removed || target.tabId!==71 || (target.documentIds && target.documentIds[0]!==documentId))throw Error('Fixture refuses unauthorized/stale tab');
      const value=vmRuntime.runInContext(`(${func.toString()})(...${JSON.stringify(args)})`,pageContext);
      return [{frameId:0,documentId,result:structuredClone(await value)}];
    }};
    const alarms=new Map();
    const workerOptions={store:WorkerStore.create(fakeDB),core:CtxCore,organize:CtxOrganize,
      transport:WorkerCapture.transport(chrome,CtxReader),crypto:cryptoRuntime,locks,
      clock:{setTimeout:(fn,delay)=>setTimeout(fn,Math.min(delay,3)),clearTimeout},
      alarms:{create:async(name,options)=>alarms.set(name,options),clear:async name=>alarms.delete(name),get:async name=>alarms.get(name)}};
    const factory=structuredBackend?require('./edge-extension/provider-capture.js'):(claudeBackend?require('./edge-extension/claude-capture.js'):WorkerCapture);
    if(claudeBackend)Object.assign(workerOptions,{core:require('./edge-extension/claude-core.js'),common:CtxCore,transport:WorkerCapture.transport(chrome,require('./edge-extension/claude-reader.js'))});
    if(structuredBackend)Object.assign(workerOptions,{core:require('./edge-extension/provider-core.js'),common:CtxCore,platforms:require('./edge-extension/platforms.js'),transport:WorkerCapture.transport(chrome,require('./edge-extension/provider-reader.js'))});
    worker=factory.create(workerOptions);await worker.boot();
    chrome.runtime={sendMessage:async m=>{
      try {
        let value;
        if(m.action==='powerStatus')value={sleeping:!!tables.jobs.get('power')?.sleeping};
        else if(m.action==='sleep'){await worker.prepareSleep();await workerOptions.store.setSleeping(true);value={sleeping:true};}
        else if(m.action==='start')value=await worker.start(m.target,m.conversation_id,m.title,{provider_id:m.provider_id,source_url:m.source_url,capture_method:m.capture_method});
        else if(m.action==='resume')value=await worker.resume(m.session_id,m.target);
        else if(m.action==='revalidate')value=await worker.revalidate(m.session_id);
        else if(m.action==='pause')value=await worker.pause(m.session_id);
        else if(m.action==='pending')value=await worker.pending(m.session_id);
        else value=await worker.status();
        return {ok:true,value};
      } catch(error){return {ok:false,error:error.message};}
    }};
    // The worker deliberately has no global tab listeners. Its pinned reader
    // detects navigation/removal while polling, also when every view is closed.
    worker.restartForTest=async()=>{worker.shutdown();worker=factory.create(workerOptions);await worker.boot();};
  }
  const timers=new Map();let nextTimer=0;
  function fakeTimeout(fn,delay) {const key=++nextTimer;timers.set(key,{fn,delay});if(delay<1000)setImmediate(()=>{if(timers.has(key)){timers.delete(key);fn();}});return key;}
  function fakeClear(key){timers.delete(key);}
  const context=vmRuntime.createContext({ChatBackupCore:CtxCore,ChatBackupOrganize:CtxOrganize,ChatBackupPageReader:CtxReader,document,indexedDB,chrome,
    crypto:cryptoRuntime,TextEncoder,TextDecoder,URL:PanelURL,Blob,Date,Map,Set,Promise,structuredClone,
    atob:s=>Buffer.from(s,'base64').toString('binary'),setTimeout:fakeTimeout,clearTimeout:fakeClear,console,
    addEventListener:(event,fn)=>{panelEvents[event]=fn;},navigator:locks ? {locks} : {}});
  vmRuntime.runInContext(fsRuntime.readFileSync(require.resolve('./edge-extension/platforms.js'),'utf8'),context);
  vmRuntime.runInContext(fsRuntime.readFileSync(require.resolve('./edge-extension/browser-context.js'),'utf8'),context);
  vmRuntime.runInContext(fsRuntime.readFileSync(require.resolve('./edge-extension/capture-store.js'),'utf8'),context);
  vmRuntime.runInContext(fsRuntime.readFileSync(require.resolve('./edge-extension/background-client.js'),'utf8'),context);
  vmRuntime.runInContext(fsRuntime.readFileSync(require.resolve('./edge-extension/panel.js'),'utf8'),context);
  await waitRuntime(()=>!nodes.get('start').disabled);
  return {nodes,tables,calls,downloads,pageDocument,injections,get reloads(){return reloads;},get worker(){return worker;},
    click:id=>nodes.get(id).events.click(),state:()=>vmRuntime.runInContext('session',context),
    evaluate:code=>vmRuntime.runInContext(code,context),
    readerKeys:()=>vmRuntime.runInContext('Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith("__chat_backup_reader_"))',pageContext),
    emit:request=>{entries.push(request);for(const fn of listeners)fn(request);},
    navigate:url=>{location.href=url;location.pathname=new URL(url).pathname;for(const fn of navListeners)fn(url);
      for(const fn of tabListeners.updated)fn(71,{url},tabInfo());},
    activate:(tabId,windowId=7)=>{if(windowId===7)activeTabId=tabId;for(const fn of tabListeners.activated)fn({tabId,windowId});},
    hide:()=>{document.hidden=true;documentEvents.visibilitychange?.();},
    pagehide:()=>panelEvents.pagehide?.(),
    sidebarClosed:()=>{for(const fn of tabListeners.panelClosed)fn({windowId:7});},
    sidebarOpened:()=>{for(const fn of tabListeners.panelOpened)fn({windowId:7});},
    remove:()=>{removed=true;location.href='about:blank';for(const fn of tabListeners.removed)fn(71);},
    fireTimers:delay=>{for(const [key,t] of [...timers])if(t.delay===delay){timers.delete(key);t.fn();}},
    async close(){if(worker){panelEvents.pagehide?.();await worker.pause();worker.shutdown();}else await vmRuntime.runInContext('stop("fixture结束", "paused")',context);timers.clear();}};
}

runtimeTest('close-plugin stops pending login, drops UI caches and refuses to reconnect merely on visibility',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait});await h.click('start');const id=h.state().id;
  await waitRuntime(()=>h.calls.length===1);await h.click('sleepPlugin');
  assertRuntime.equal(h.tables.sessions.get(id).state,'paused');assertRuntime.equal(h.tables.jobs.get('power').sleeping,true);
  assertRuntime.equal(h.readerKeys().length,0);assertRuntime.equal(h.state(),null);
  assertRuntime.equal(h.evaluate('db'),null);assertRuntime.equal(h.evaluate('organized'),null);assertRuntime.equal(h.evaluate('backgroundPoll'),null);
  h.sidebarOpened();h.hide();release();await new Promise(r=>setTimeout(r,20));
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.evaluate('backgroundPoll'),null);await h.close();
});
runtimeTest('close-plugin after preview retains every saved response while freeing organized text',async()=>{
  const h=await panelHarness({sidebar:true});await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  await h.click('preview');assertRuntime.ok(h.evaluate('organized'));
  const before=JSON.stringify([...h.tables.pages.values()]);await h.click('sleepPlugin');
  assertRuntime.equal(JSON.stringify([...h.tables.pages.values()]),before);assertRuntime.equal(h.evaluate('organized'),null);
  assertRuntime.equal(h.nodes.get('previewText').textContent,'');assertRuntime.equal(h.tables.jobs.get('power').sleeping,true);await h.close();
});
runtimeTest('diagnostic click reads an existing 403 without reload or network retry',async()=>{
  const failed=requestR(CtxCore.fullRequestURL(CIDR),403,'{"detail":"forbidden fixture"}',[
    {name:'content-type',value:'application/json'},{name:'set-cookie',value:'private-fixture-cookie'}]);
  const h=await panelHarness({entries:[failed]});
  await h.click('startFull');
  assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.calls.length,0);
  assertRuntime.equal(h.state().state,'diagnosed');assertRuntime.equal(h.state().failures[0].status,403);
  await h.click('download');
  const output=await h.downloads[0].text();const parsed=JSON.parse(output);
  assertRuntime.equal(parsed.schema,'chat-export-diagnostic/v1');
  assertRuntime.equal(parsed.pages[0].response.body_text,'{"detail":"forbidden fixture"}');
  assertRuntime.ok(!output.includes('runtime-test-placeholder-never-export'));
  assertRuntime.ok(!output.includes('private-fixture-cookie'));
  await h.close();
});
runtimeTest('cleared network history preserves old denial status without fabricating a response',async()=>{
  const h=await panelHarness({savedSessions:[{id:'prior',conversation_id:CIDR,title:'旧测试',mode:'full',page_count:0,
    started_at:'2026-09-13T04:10:00Z',state:'error',detail:'读取返回 HTTP 403；已停止'}]});
  await h.click('startFull');
  assertRuntime.equal(h.state().previous_failures[0].status,403);
  assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.calls.length,0);assertRuntime.equal(h.reloads,0);
  await h.close();
});
runtimeTest('pagination uses the observed allowed head request and completes without navigation',async()=>{
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))]});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.calls.length,2);
  assertRuntime.ok(h.calls.every(call=>call.url===PAGER));
  assertRuntime.equal(h.state().page_count,1);assertRuntime.equal(h.state().record_count,2);
  assertRuntime.equal([...h.tables.pages.values()].filter(r=>r.accepted).length,2);
  await h.close();
});
runtimeTest('an already open chat with no HAR data starts and finishes without refresh',async()=>{
  const h=await panelHarness({emitNetworkEvents:false});await h.click('start');
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.state().record_count,2);
  assertRuntime.deepEqual(h.calls.map(x=>x.url),['https://chatgpt.com/api/auth/session',PAGER,PAGER]);
  assertRuntime.equal(h.pageDocument.draftText,'没有发送的小说草稿');
  await h.click('download');const output=await h.downloads[0].text();
  assertRuntime.ok(!output.includes('fixture-session-token-never-save'));assertRuntime.ok(!output.includes('private-session-fixture'));
  assertRuntime.ok(JSON.parse(output).pages.every(p=>p.request.transport==='page_fetch'));
  verifyDownloadedBundle(output);await h.close();
});
runtimeTest('an allowed head request denied by the server is recorded and never retried',async()=>{
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))],fetchStatus:403,fetchBody:'{"detail":"denied fixture"}'});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.reloads,0);
  assertRuntime.equal(h.state().last_failure.status,403);
  assertRuntime.equal(h.state().last_failure.phase,'head_request');
  assertRuntime.equal([...h.tables.pages.values()].find(r=>r.kind==='request_failed').response.body_text,'{"detail":"denied fixture"}');
  await h.close();
});

function storedR(id,date,state='error') {return {id,conversation_id:CIDR,title:'记录 '+id,mode:'full',page_count:0,
  started_at:date,updated_at:date,state,detail:'读取返回 HTTP 403'};}
function pageR(id,sequence,body='保存内容') {return {session_id:id,sequence,kind:'full_bootstrap',accepted:true,
  request:{method:'GET',url:PAGER},response:{status:200,body_text:body}};}
runtimeTest('delete is confirmed and removes only the chosen record and all of its responses',async()=>{
  const first=storedR('first','2026-09-13T04:15:00Z'),other=storedR('other','2026-09-13T04:10:00Z');
  const untouchedPage=pageR('other',0,'其他记录原文');
  const h=await panelHarness({savedSessions:[first,other],savedPages:[pageR('first',0,'x'.repeat(6000)),pageR('first',1),untouchedPage]});
  assertRuntime.match(h.nodes.get('storage').textContent,/2 条本地记录/);
  await h.click('deleteRecord');
  assertRuntime.equal(h.nodes.get('deleteDialog').open,true);
  assertRuntime.match(h.nodes.get('deleteDescription').textContent,/记录 first/);
  assertRuntime.equal(h.tables.pages.size,3);
  await h.click('confirmDelete');
  assertRuntime.equal(h.tables.sessions.get('first').deleted,true);
  assertRuntime.equal(h.tables.sessions.get('first').title,undefined);
  assertRuntime.equal(h.tables.pages.size,1);
  assertRuntime.deepEqual(h.tables.pages.get(JSON.stringify(['other',0])),untouchedPage);
  assertRuntime.deepEqual(h.tables.sessions.get('other'),other);
  assertRuntime.equal(h.state().id,'other');
  assertRuntime.match(h.nodes.get('storage').textContent,/1 条本地记录/);
  assertRuntime.equal(h.calls.length,0);assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.downloads.length,0);
  await h.close();
});
runtimeTest('canceling deletion preserves the zero-page record and its hidden bootstrap response',async()=>{
  const item=storedR('only','2026-09-13T04:15:00Z'),body=pageR('only',0,'x'.repeat(6000));
  const h=await panelHarness({savedSessions:[item],savedPages:[body]});
  assertRuntime.match(h.nodes.get('storage').textContent,/KB/);
  await h.click('deleteRecord');await h.click('cancelDelete');
  assertRuntime.deepEqual(h.tables.sessions.get('only'),item);assertRuntime.equal(h.tables.pages.size,1);
  assertRuntime.equal(h.nodes.get('deleteDialog').open,false);await h.close();
});
runtimeTest('deleting the last record clears selection and disables further deletion',async()=>{
  const h=await panelHarness({savedSessions:[storedR('only','2026-09-13T04:15:00Z')],savedPages:[pageR('only',0)]});
  await h.click('deleteRecord');await h.click('confirmDelete');
  assertRuntime.equal(h.state(),null);assertRuntime.equal(h.tables.pages.size,0);
  assertRuntime.equal(h.nodes.get('deleteRecord').disabled,true);
  assertRuntime.match(h.nodes.get('storage').textContent,/0 条本地记录/);
  await h.close();
});
runtimeTest('a stopped partial route can be confirmed and deleted while other records stay intact',async()=>{
  const date='2026-09-13T04:15:00Z';
  const incomplete={...storedR('partial',date,'running'),mode:'pagination',page_count:5,next_sequence:5,record_count:74,
    reading_count:50,auxiliary_count:24,message_count_profile:'reading-v1',history_has_previous:true};
  const other=storedR('other','2026-09-13T04:10:00Z','route_complete');
  const saved=Array.from({length:5},(_,i)=>pageR('partial',i,'raw '+i)),otherPage=pageR('other',0,'keep');
  const locks={request:async(name,options,fn)=>{assertRuntime.equal(name,'chat-backup-active-collector');assertRuntime.equal(options.ifAvailable,true);return fn({name});}};
  const h=await panelHarness({sidebar:true,locks,savedSessions:[incomplete,other],savedPages:[...saved,otherPage]});
  assertRuntime.equal(h.evaluate('active'),false);assertRuntime.equal(h.state().state,'running');
  assertRuntime.equal(h.nodes.get('deleteRecord').disabled,false);
  await h.click('deleteRecord');await h.click('cancelDelete');
  assertRuntime.deepEqual(h.tables.sessions.get('partial'),incomplete);
  await h.click('deleteRecord');await h.click('confirmDelete');
  assertRuntime.equal(h.tables.sessions.get('partial').deleted,true);assertRuntime.equal(h.tables.sessions.get('partial').title,undefined);
  assertRuntime.equal(h.tables.pages.size,1);assertRuntime.deepEqual([...h.tables.pages.values()][0],otherPage);
  assertRuntime.deepEqual(h.tables.sessions.get('other'),other);await h.close();
});
runtimeTest('stored webpage records export raw JSON, organized JSON and TXT with scope labels, then delete normally',async()=>{
  const provider_id='deepseek',source_url='https://chat.deepseek.com/a/chat/s/11111111-1111-4111-8111-111111111111',conversation_id='deepseek:11111111-1111-4111-8111-111111111111';
  const snapshot={schema:'chat-export-surface-snapshot/v1',provider_id,source_url,conversation_id,title:'网页样本',position:{top:0,height:200,viewport:200,at_top:true,at_bottom:true},
    messages:[{source_key:'1:final',role:'user',channel:'final',text:'用户原文',html:'<p>用户原文</p>',attachments:[],notice:null},{source_key:'2:final',role:'assistant',channel:'final',text:'助手原文',html:'<p>助手原文</p>',attachments:[],notice:null}]};
  const body=JSON.stringify(snapshot),hash=require('node:crypto').createHash('sha256').update(body).digest('hex');
  const record={id:'surface-record',provider_id,source_url,conversation_id,title:'网页样本',mode:'surface',state:'surface_complete',started_at:'2026-09-19T00:00:00Z',updated_at:'2026-09-19T00:00:01Z',page_count:1,next_sequence:2,record_count:2,reading_count:2,auxiliary_count:0,message_count_profile:'reading-v1',empty_text_ids:[]};
  const savedPages=[0,1].map(sequence=>({session_id:record.id,sequence,kind:sequence?'surface_recheck':'surface',accepted:true,request:{method:'DOM',url:source_url},response:{body_text:body,body_sha256:hash}}));
  const h=await panelHarness({sidebar:true,savedSessions:[record],savedPages});
  assertRuntime.equal(h.nodes.get('resume').disabled,true);assertRuntime.equal(h.nodes.get('rawCountLabel').textContent,'网页快照');
  await h.click('download');const raw=JSON.parse(await h.downloads[0].text());assertRuntime.equal(raw.schema,'chat-export-surface/v1');assertRuntime.equal(raw.scope.official_json,false);
  h.nodes.get('exportProfile').value='reading';h.nodes.get('exportFormat').value='json';await h.click('organizeDownload');
  const organized=JSON.parse(await h.downloads[1].text());assertRuntime.equal(organized.messages.length,2);assertRuntime.equal(organized.scope.server_history_verified,false);
  h.nodes.get('exportFormat').value='txt';await h.click('organizeDownload');const text=await h.downloads[2].text();assertRuntime.match(text,/网页正文备份 · 完整性待核对/);assertRuntime.match(text,/用户原文/);
  await h.click('deleteRecord');await h.click('confirmDelete');assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.tables.sessions.get(record.id).deleted,true);await h.close();
});
runtimeTest('Claude sidebar captures without refresh, reports route counts, previews and exports both formats, and deletes locally',async()=>{
  const alternate='00000000-0000-4000-8000-000000000003';
  const data={uuid:CIDR,name:'Claude 测试聊天',current_leaf_message_uuid:MR2,chat_messages:[
    {uuid:alternate,parent_message_uuid:MR1,sender:'assistant',content:[{type:'text',text:'旧回答'}]},
    {uuid:MR2,parent_message_uuid:MR1,sender:'assistant',content:[{type:'text',text:'  当前原文\n\n不应改写  '}]},
    {uuid:MR1,parent_message_uuid:null,sender:'human',content:[{type:'text',text:'用户原文'}]}
  ]};
  const h=await panelHarness({sidebar:true,claudeBackend:true,initialURL:'https://claude.ai/chat/'+CIDR,fetchBody:JSON.stringify(data)});
  assertRuntime.equal(h.nodes.get('captureMethodRow').hidden,false);
  await h.click('start');await waitRuntime(()=>h.state()?.state==='claude_complete');
  assertRuntime.equal(h.calls.length,2);assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.pageDocument.draftText,'没有发送的小说草稿');
  assertRuntime.equal(h.state().record_count,3);assertRuntime.equal(h.state().reading_count,2);assertRuntime.equal(h.nodes.get('resume').disabled,true);
  assertRuntime.match(h.nodes.get('countBreakdown').textContent,/其他分支 1/);assertRuntime.match(h.nodes.get('captureBadge').textContent,/会话数据/);
  await h.click('download');const raw=JSON.parse(await h.downloads[0].text());assertRuntime.equal(raw.schema,'chat-export-claude/v1');assertRuntime.equal(raw.scope.official_json,false);
  assertRuntime.equal(raw.pages[0].response.body_text,JSON.stringify(data));
  h.nodes.get('exportProfile').value='reading';h.nodes.get('exportFormat').value='json';await h.click('organizeDownload');
  const organized=JSON.parse(await h.downloads[1].text());assertRuntime.equal(organized.messages.length,2);assertRuntime.equal(organized.messages[1].content.parts[0],'  当前原文\n\n不应改写  ');
  h.nodes.get('exportFormat').value='txt';await h.click('organizeDownload');assertRuntime.match(await h.downloads[2].text(),/Claude 会话接口备份/);
  await h.click('preview');assertRuntime.match(h.nodes.get('previewText').textContent,/当前原文/);
  await h.click('deleteRecord');await h.click('confirmDelete');assertRuntime.equal(h.tables.pages.size,0);await h.close();
});
runtimeTest('Claude failed-record revalidation unlocks exports and preserves original response rows without a request',async()=>{
  const source_url='https://claude.ai/chat/'+CIDR,conversation_id='claude:'+CIDR;
  const data={uuid:CIDR,name:'原有 Claude 记录',current_leaf_message_uuid:MR2,chat_messages:[
    {uuid:MR1,parent_message_uuid:'00000000-0000-4000-8000-000000000000',sender:'human',content:[{type:'text',text:'用户原文'}]},
    {uuid:MR2,parent_message_uuid:MR1,sender:'assistant',content:[{type:'text',text:'助手原文'}]}
  ]};
  const body=JSON.stringify(data),hash=require('node:crypto').createHash('sha256').update(body).digest('hex');
  const record={id:'claude-old',provider_id:'claude',conversation_id,source_url,title:data.name,mode:'claude_api',state:'error',started_at:'2026-10-09T00:00:00Z',updated_at:'2026-10-09T00:00:01Z',page_count:0,next_sequence:2,record_count:0,route_count:0,reading_count:0,auxiliary_count:0,message_count_profile:'reading-v1',empty_text_ids:[]};
  const url=`https://claude.ai/api/organizations/00000000-0000-4000-8000-000000000900/chat_conversations/${CIDR}?tree=true&rendering_mode=messages&render_all_tools=true`;
  const pages=[0,1].map(sequence=>({session_id:record.id,sequence,kind:'claude_tree',accepted:false,request:{method:'GET',url},response:{status:200,body_text:body,body_sha256:hash},validation:{rejection:'旧版根节点误判'}}));
  const h=await panelHarness({sidebar:true,claudeBackend:true,initialURL:source_url,savedSessions:[record],savedPages:pages});
  assertRuntime.equal(h.nodes.get('organizeDownload').disabled,true);assertRuntime.equal(h.nodes.get('revalidateSaved').hidden,false);
  await h.click('revalidateSaved');assertRuntime.equal(h.state().state,'claude_complete');assertRuntime.equal(h.state().record_count,2);assertRuntime.equal(h.calls.length,0);
  assertRuntime.equal(h.nodes.get('organizeDownload').disabled,false);assertRuntime.match(h.nodes.get('pageProgress').textContent,/未访问网页/);
  assertRuntime.deepEqual([...h.tables.pages.values()],pages);await h.click('download');
  const raw=JSON.parse(await h.downloads[0].text());assertRuntime.equal(raw.capture.revalidation.sources.length,2);assertRuntime.equal(raw.pages[0].accepted,false);
  h.nodes.get('exportProfile').value='reading';h.nodes.get('exportFormat').value='json';await h.click('organizeDownload');assertRuntime.equal(JSON.parse(await h.downloads[1].text()).messages.length,2);
  await h.close();
});
for(const provider of ['deepseek','gemini'])runtimeTest(provider+' sidebar completes direct capture and exports scoped JSON/TXT without refresh',async()=>{
  const gid='0123456789abcdef',initialURL=provider==='deepseek'?'https://chat.deepseek.com/a/chat/s/'+CIDR:'https://gemini.google.com/app/'+gid;
  const body=provider==='deepseek'?JSON.stringify({code:0,data:{biz_code:0,biz_data:{chat_session:{id:CIDR,title:'DeepSeek 界面测试',current_message_id:2},chat_messages:[
    {message_id:1,parent_id:0,role:'USER',status:'FINISHED',fragments:[{type:'REQUEST',content:'用户原文'}]},
    {message_id:2,parent_id:1,role:'ASSISTANT',status:'FINISHED',fragments:[{type:'RESPONSE',content:'回答原文'}]}
  ]}}}):JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify([[[['c_'+gid,'r_1'],[1700000000,0],['用户原文'],[[['rc_1',['回答原文']]]]]],null])]]);
  const h=await panelHarness({sidebar:true,structuredBackend:true,initialURL,fetchBody:body});
  assertRuntime.equal(h.nodes.get('captureMethodRow').hidden,false);await h.click('start');await waitRuntime(()=>h.state()?.state==='provider_complete');
  assertRuntime.equal(h.calls.length,2);assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.state().record_count,2);assertRuntime.equal(h.nodes.get('resume').disabled,true);
  await h.click('download');const raw=JSON.parse(await h.downloads[0].text());assertRuntime.equal(raw.schema,'chat-export-provider/v1');assertRuntime.equal(raw.provider_id,provider);assertRuntime.equal(raw.pages[0].response.body_text,body);
  for(const secret of ['private-provider-token','private-sid','private-build'])assertRuntime.ok(!JSON.stringify(raw).includes(secret));
  h.nodes.get('exportProfile').value='reading';h.nodes.get('exportFormat').value='json';await h.click('organizeDownload');const result=JSON.parse(await h.downloads[1].text());assertRuntime.equal(result.messages.length,2);assertRuntime.equal(result.checks.capture_recheck_passed,true);
  h.nodes.get('exportFormat').value='txt';await h.click('organizeDownload');assertRuntime.match(await h.downloads[2].text(),/会话接口备份/);
  await h.click('deleteRecord');await h.click('confirmDelete');assertRuntime.equal(h.tables.pages.size,0);await h.close();
});
runtimeTest('a stale UI first pauses a still-running job before deleting the selected partial capture',async()=>{
  const date='2026-09-13T04:15:00Z';
  const item={...storedR('partial',date,'running'),mode:'pagination',page_count:1,next_sequence:1,record_count:2};
  const locks={request:async(_name,_options,fn)=>fn({})};
  const h=await panelHarness({sidebar:true,locks,savedSessions:[item],savedPages:[pageR('partial',0)]});
  h.tables.jobs.set('active',{id:'active',session_id:'partial',run_id:'fixture-run',state:'running',target:{tabId:71,documentId:'fixture-document-1'}});
  await h.click('deleteRecord');await h.click('confirmDelete');
  assertRuntime.equal(h.tables.jobs.get('active').state,'paused');assertRuntime.equal(h.tables.sessions.get('partial').deleted,true);
  assertRuntime.equal(h.tables.pages.size,0);await h.close();
});
runtimeTest('partial deletion fails closed when the capture lock is held or absent',async()=>{
  const date='2026-09-13T04:15:00Z',item=storedR('partial',date,'waiting');
  for(const locks of [null,{request:async(_name,_options,fn)=>fn(null)}]){
    const h=await panelHarness({savedSessions:[item],savedPages:[pageR('partial',0)],locks});
    await h.click('deleteRecord');await h.click('confirmDelete');
    assertRuntime.equal(h.tables.sessions.get('partial').deleted,undefined);
    assertRuntime.equal(h.tables.pages.size,1);assertRuntime.match(h.nodes.get('deleteError').textContent,/确认采集|仍在采集/);
    await h.click('cancelDelete');await h.close();
  }
});
runtimeTest('a persisted running job blocks deletion inside the same database transaction',async()=>{
  const item=storedR('partial','2026-09-13T04:15:00Z','waiting');
  const locks={request:async(_name,_options,fn)=>fn({})};
  const h=await panelHarness({savedSessions:[item],savedPages:[pageR('partial',0)],locks});
  h.tables.jobs.set('active',{id:'active',session_id:'partial',run_id:'fixture-run',state:'running'});
  await h.click('deleteRecord');await h.click('confirmDelete');
  assertRuntime.equal(h.tables.pages.size,1);assertRuntime.equal(h.tables.sessions.get('partial').deleted,undefined);
  assertRuntime.match(h.nodes.get('deleteError').textContent,/后台仍在采集/);await h.click('cancelDelete');await h.close();
});
runtimeTest('a changed or resumed record cannot be deleted using a stale confirmation',async()=>{
  const item=storedR('only','2026-09-13T04:15:00Z');
  const h=await panelHarness({savedSessions:[item],savedPages:[pageR('only',0)]});
  await h.click('deleteRecord');
  h.tables.sessions.set('only',{...item,state:'running',updated_at:'2026-09-13T04:16:00Z'});
  await h.click('confirmDelete');
  assertRuntime.equal(h.tables.sessions.get('only').state,'running');assertRuntime.equal(h.tables.pages.size,1);
  assertRuntime.match(h.nodes.get('deleteError').textContent,/状态已变化/);await h.click('cancelDelete');await h.close();
});
runtimeTest('a deletion storage error rolls back all response removals',async()=>{
  const item=storedR('only','2026-09-13T04:15:00Z');
  const h=await panelHarness({savedSessions:[item],savedPages:[pageR('only',0),pageR('only',1)],failDeleteAt:2});
  await h.click('deleteRecord');await h.click('confirmDelete');
  assertRuntime.equal(h.tables.pages.size,2);assertRuntime.deepEqual(h.tables.sessions.get('only'),item);
  assertRuntime.match(h.nodes.get('deleteError').textContent,/回滚/);await h.click('cancelDelete');await h.close();
});
runtimeTest('an older open panel cannot recreate a deleted record',async()=>{
  const h=await panelHarness({savedSessions:[storedR('only','2026-09-13T04:15:00Z')]});
  h.tables.sessions.set('only',{id:'only',deleted:true,deleted_at:'2026-09-13T04:17:00Z'});
  await assertRuntime.rejects(()=>h.evaluate('commit({...session,state:"running"})'),/已在本机删除/);
  assertRuntime.equal(h.tables.sessions.get('only').deleted,true);
  assertRuntime.equal(h.tables.sessions.get('only').title,undefined);await h.close();
});
runtimeTest('active capture cannot open a deletion confirmation',async()=>{
  const h=await panelHarness();await h.click('start');
  assertRuntime.equal(h.nodes.get('deleteRecord').disabled,true);await h.click('deleteRecord');
  assertRuntime.notEqual(h.nodes.get('deleteDialog').open,true);await h.close();
});

runtimeTest('a refresh after the 30-second notice is captured without clicking resume',async()=>{
  const h=await panelHarness({sessionBody:{}});await h.click('start');
  await waitRuntime(()=>/已改为监听/.test(h.state().detail));h.fireTimers(30000);
  await waitRuntime(()=>/监听保持开启/.test(h.state().detail));
  assertRuntime.equal(h.state().state,'waiting');
  h.navigate(`https://chatgpt.com/c/${CIDR}`);
  h.emit(requestR(PAGER,200,JSON.stringify(HEADR)));
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().record_count,2);assertRuntime.equal(h.calls.filter(c=>c.url===PAGER).length,1);await h.close();
});
runtimeTest('the optional refresh button refreshes exactly once and continues automatically',async()=>{
  const h=await panelHarness({sessionBody:{}});await h.click('start');await waitRuntime(()=>/已改为监听/.test(h.state().detail));await h.click('reloadOnce');
  assertRuntime.equal(h.reloads,1);
  h.emit(requestR(PAGER,200,JSON.stringify(HEADR)));
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.reloads,1);await h.close();
});
runtimeTest('a fast head received during database initialization remains available',async()=>{
  const h=await panelHarness({earlyRequest:requestR(PAGER,200,JSON.stringify(HEADR))});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.calls.length,2);assertRuntime.equal(h.reloads,0);await h.close();
});
runtimeTest('a HAR body works without getContent and an absent redundant body id is bound by the request',async()=>{
  const value=structuredClone(HEADR);delete value.conversation_id;delete value.current_node;
  const url=PAGER.replace('num_turns=10','num_turns=20')+'&include_message_id='+MR2;
  const r=requestR(url,200,'');delete r.getContent;r.response.content={text:JSON.stringify(value)};
  const h=await panelHarness({entries:[r],fetchBody:JSON.stringify(value)});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.calls[0].url,url);assertRuntime.equal(h.state().record_count,2);
  await h.click('download');assertRuntime.equal(verifyDownloadedBundle(await h.downloads[0].text()).selected_path_capture_checks_pass,true);
  await h.close();
});
runtimeTest('an evicted historical body is fetched once and independently rechecked',async()=>{
  const r=requestR(PAGER,200,'');delete r.getContent;
  const h=await panelHarness({entries:[r]});await h.click('start');
  await waitRuntime(()=>h.state()?.state==='route_complete');assertRuntime.equal(h.calls.length,2);await h.close();
});
runtimeTest('an unsupported head is saved and diagnosed instead of silently ignored',async()=>{
  const raw=JSON.stringify({conversation_id:CIDR,new_response_shape:true});
  const h=await panelHarness({entries:[requestR(PAGER,200,raw)],fetchBody:raw});await h.click('start');
  await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.equal(h.state().state,'error');assertRuntime.match(h.state().detail,/已经收到/);
  assertRuntime.equal([...h.tables.pages.values()][0].response.body_text,raw);
  assertRuntime.equal(h.nodes.get('pages').textContent,'1');
  assertRuntime.equal(h.calls.length,1);await h.close();
});
runtimeTest('different conversation identity and a non-latest page cannot complete',async()=>{
  for(const value of [{...HEADR,conversation_id:MR1},{...HEADR,page_info:{...HEADR.page_info,has_next_page:true}}]) {
    const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(value))],fetchBody:JSON.stringify(value)});await h.click('start');
    await waitRuntime(()=>h.state()?.state==='error');
    assertRuntime.equal(h.state().state,'error');assertRuntime.equal(h.state().page_count,0);
    assertRuntime.equal([...h.tables.pages.values()][0].accepted,false);await h.close();
  }
});
runtimeTest('the fresh head changing on its final recheck stays incomplete with both originals preserved',async()=>{
  const changed=structuredClone(HEADR);changed.messages[1].content.parts=['new'];
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))],onFetch:(url,n)=>({status:200,body:JSON.stringify(n===1?HEADR:changed)})});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.match(h.state().detail,/发生变化/);assertRuntime.equal(h.tables.pages.size,2);await h.close();
});
runtimeTest('ordinary mapping is saved and rechecked without requesting the forced-full endpoint',async()=>{
  const root='client-created-root';
  const tree={conversation_id:CIDR,current_node:MR2,mapping:{
    [root]:{id:root,parent:null,children:[MR1],message:null},
    [MR1]:{id:MR1,parent:root,children:[MR2],message:HEADR.messages[0]},
    [MR2]:{id:MR2,parent:MR1,children:[],message:HEADR.messages[1]}}};
  const url=`https://chatgpt.com/backend-api/conversation/${CIDR}`;
  const h=await panelHarness({entries:[requestR(url,200,JSON.stringify(tree))],fetchBody:JSON.stringify(tree)});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='mapping_complete');
  assertRuntime.equal(h.calls.length,2);assertRuntime.equal(h.calls[0].url,url);
  await h.click('download');const bundle=JSON.parse(await h.downloads[0].text());
  assertRuntime.equal(bundle.schema,'chat-export-observed-mapping/v1');assertRuntime.equal(bundle.scope.full_mapping_requested,false);
  assertRuntime.equal(bundle.scope.complete_official_export,false);assertRuntime.equal(bundle.capture.record_count,2);
  assertRuntime.equal(verifyDownloadedBundle(JSON.stringify(bundle)).observed_mapping_read_checks_pass,true);await h.close();
});
runtimeTest('pagination still follows real cursors between the head and earliest page',async()=>{
  const old1='00000000-0000-4000-8000-000000000003',old2='00000000-0000-4000-8000-000000000004';
  const head={...HEADR,page_info:{...HEADR.page_info,has_previous_page:true}};
  const older={messages:HEADR.messages.map((m,i)=>({...m,id:i?old2:old1})),
    page_info:{start_cursor:old1,end_cursor:old2,has_previous_page:false,has_next_page:true}};
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(head))],onFetch:url=>({status:200,body:JSON.stringify(url===PAGER?head:older)})});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.deepEqual(h.calls.map(x=>x.url),[PAGER,CtxCore.requestURL(CIDR,MR1),PAGER]);
  assertRuntime.equal(h.state().record_count,4);assertRuntime.equal(h.state().page_count,2);
  assertRuntime.deepEqual([...h.tables.pages.values()].map(x=>x.kind),['head','previous','head_recheck']);
  await h.click('download');assertRuntime.equal(verifyDownloadedBundle(await h.downloads[0].text()).selected_path_capture_checks_pass,true);await h.close();
});

runtimeTest('organizing an existing capture downloads TXT and JSON without network calls or modifying records',async()=>{
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))]});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  const beforeSession=JSON.stringify(h.state()),beforePages=JSON.stringify([...h.tables.pages.values()]),calls=h.calls.length;
  await h.click('organizeDownload');
  const txt=await h.downloads[0].text();assertRuntime.match(txt,/测试问题/);assertRuntime.match(txt,/测试回答/);
  assertRuntime.match(txt,/消息 ID/);assertRuntime.equal(h.calls.length,calls);assertRuntime.equal(h.reloads,0);
  h.nodes.get('exportFormat').value='json';await h.click('organizeDownload');
  const result=JSON.parse(await h.downloads[1].text());assertRuntime.equal(result.schema,'chat-export-reading/v1');
  assertRuntime.equal(result.messages.length,2);assertRuntime.equal(result.statistics.repeated_response_messages_removed,2);
  await h.click('preview');assertRuntime.equal(h.nodes.get('previewDetails').open,true);
  assertRuntime.match(h.nodes.get('previewText').textContent,/测试问题/);
  assertRuntime.equal(JSON.stringify(h.state()),beforeSession);assertRuntime.equal(JSON.stringify([...h.tables.pages.values()]),beforePages);
  await h.close();
});
runtimeTest('an organization failure does not downgrade a completed capture or erase original evidence',async()=>{
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))]});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  const first=[...h.tables.pages.keys()][0];h.tables.pages.get(first).response.body_sha256='invalid';
  await h.click('organizeDownload');assertRuntime.equal(h.state().state,'route_complete');
  assertRuntime.equal(h.downloads.length,0);assertRuntime.equal(h.nodes.get('organizeError').hidden,false);
  assertRuntime.match(h.nodes.get('organizeError').textContent,/校验失败/);await h.close();
});

runtimeTest('cached reading output cannot be downloaded after the record was deleted elsewhere',async()=>{
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))]});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');await h.click('preview');
  const id=h.state().id;h.tables.sessions.set(id,{id,deleted:true});
  await h.click('organizeDownload');assertRuntime.equal(h.downloads.length,0);
  assertRuntime.match(h.nodes.get('organizeError').textContent,/已在本机删除/);
  assertRuntime.equal(h.nodes.get('previewDetails').hidden,true);await h.close();
});

runtimeTest('missing HAR direct capture traverses earlier pages and verifies the latest head',async()=>{
  const earlierIds=['00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
  const head={...HEADR,page_info:{...HEADR.page_info,has_previous_page:true}};
  const older={messages:HEADR.messages.map((m,i)=>({...m,id:earlierIds[i]})),
    page_info:{start_cursor:earlierIds[0],end_cursor:earlierIds[1],has_previous_page:false,has_next_page:true}};
  const h=await panelHarness({emitNetworkEvents:false,onFetch:url=>({status:200,body:JSON.stringify(url===PAGER?head:older)})});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.deepEqual(h.calls.map(c=>c.url),['https://chatgpt.com/api/auth/session',PAGER,CtxCore.requestURL(CIDR,MR1),PAGER]);
  assertRuntime.equal(h.state().page_count,2);assertRuntime.equal(h.state().record_count,4);assertRuntime.equal(h.reloads,0);
  assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('stale HAR content is never mistaken for the fresh capture starting point',async()=>{
  const latest=structuredClone(HEADR);latest.messages[1].content.parts=['更新后的正文'];
  const h=await panelHarness({entries:[requestR(PAGER,200,JSON.stringify(HEADR))],fetchBody:JSON.stringify(latest)});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(JSON.parse([...h.tables.pages.values()][0].response.body_text).messages[1].content.parts[0],'更新后的正文');
  assertRuntime.equal(h.reloads,0);await h.close();
});
runtimeTest('HAR without reusable login headers uses the current page login instead of reloading',async()=>{
  const r=requestR(PAGER,200,JSON.stringify(HEADR));r.request.headers=[];
  const h=await panelHarness({entries:[r],emitNetworkEvents:false});await h.click('start');
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.calls[0].url,'https://chatgpt.com/api/auth/session');assertRuntime.equal(h.reloads,0);await h.close();
});
runtimeTest('Promise-style DevTools APIs support both observed and empty network histories',async()=>{
  for(const entries of [[],[requestR(PAGER,200,JSON.stringify(HEADR))]]) {
    const h=await panelHarness({entries,promiseApis:true});await h.click('start');
    await waitRuntime(()=>h.state()?.state==='route_complete');
    assertRuntime.equal(h.state().record_count,2);assertRuntime.equal(h.reloads,0);await h.close();
  }
});
runtimeTest('a denied login session is not retried and its private response is never saved',async()=>{
  const h=await panelHarness({sessionStatus:403});await h.click('start');await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.reloads,0);
  assertRuntime.equal(h.state().direct_read_failure.http_status,403);
  assertRuntime.ok(!JSON.stringify(h.state()).includes('fixture-session-token-never-save'));
  assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('a denied directly read conversation preserves its error and stops without retry',async()=>{
  const h=await panelHarness({fetchStatus:403,fetchBody:'{"detail":"fixture denied"}',emitNetworkEvents:false});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.equal(h.calls.length,2);assertRuntime.equal(h.state().last_failure.status,403);
  assertRuntime.equal(h.tables.pages.size,1);assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('pausing while login is pending prevents the following conversation request',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sessionWait,emitNetworkEvents:false});await h.click('start');await h.click('pause');
  assertRuntime.equal(h.state().state,'paused');release();await new Promise(r=>setTimeout(r,10));
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('switching conversations while login is pending stops the old capture',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sessionWait,emitNetworkEvents:false});await h.click('start');
  h.navigate('https://chatgpt.com/c/00000000-0000-4000-8000-000000000003');await waitRuntime(()=>h.state()?.state==='paused');
  release();await new Promise(r=>setTimeout(r,10));
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('a stored partial capture resumes with an empty HAR without needing a refresh',async()=>{
  const hash=value=>require('node:crypto').createHash('sha256').update(value).digest('hex');
  const head={...HEADR,page_info:{...HEADR.page_info,has_previous_page:true}},body=JSON.stringify(head);
  const earlierIds=['00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004'];
  const older={messages:HEADR.messages.map((m,i)=>({...m,id:earlierIds[i]})),
    page_info:{start_cursor:earlierIds[0],end_cursor:earlierIds[1],has_previous_page:false,has_next_page:true}};
  const record={id:'saved-partial',title:'已暂停聊天',conversation_id:CIDR,mode:'pagination',state:'paused',
    started_at:'2026-09-13T04:00:00Z',updated_at:'2026-09-13T04:01:00Z',next_sequence:1,page_count:1,record_count:2,
    last_page_sequence:0,seen_start_cursors:[MR1],version_ids:[],empty_text_ids:[],head_signature:hash(CtxCore.headSignatureInput(head)),
    message_hashes:Object.fromEntries(head.messages.map(m=>[m.id,hash(CtxCore.stable(CtxCore.payload(m)))]))};
  const saved={session_id:record.id,sequence:0,kind:'head',accepted:true,request:{method:'GET',url:PAGER},
    response:{status:200,body_text:body,body_sha256:hash(body)},validation:{parent_page_sequence:null}};
  const h=await panelHarness({savedSessions:[record],savedPages:[saved],emitNetworkEvents:false,onFetch:url=>({status:200,body:JSON.stringify(url===PAGER?head:older)})});
  await h.click('resume');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().record_count,4);assertRuntime.equal(h.reloads,0);
  await h.click('download');verifyDownloadedBundle(await h.downloads[0].text());await h.close();
});

runtimeTest('native sidebar captures, rechecks, organizes and exports with no DevTools API',async()=>{
  const h=await panelHarness({sidebar:true,emitNetworkEvents:false});
  assertRuntime.equal(h.calls.length,0,'opening the sidebar must not fetch any login or chat');
  await h.click('start');
  assertRuntime.ok(h.evaluate('active') || h.state()?.state==='route_complete',JSON.stringify({detail:h.nodes.get('detail').textContent,state:h.state(),worker:await h.worker.status(),calls:h.calls}));
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.reloads,0);assertRuntime.equal(h.state().record_count,2);
  assertRuntime.deepEqual(h.calls.map(x=>x.url),['https://chatgpt.com/api/auth/session',PAGER,PAGER]);
  assertRuntime.ok(h.injections.every(i=>i.tabId===71));
  assertRuntime.ok(h.injections.slice(1).some(i=>i.documentIds?.[0]==='fixture-document-1'));
  assertRuntime.equal(h.readerKeys().length,0);assertRuntime.equal(h.nodes.get('reloadOnce').hidden,true);
  await h.click('download');const raw=await h.downloads[0].text();verifyDownloadedBundle(raw);
  for(const secret of ['fixture-session-token','private-session-fixture'])assertRuntime.ok(!raw.includes(secret));
  h.nodes.get('exportFormat').value='json';await h.click('organizeDownload');
  const reading=JSON.parse(await h.downloads[1].text());
  assertRuntime.deepEqual(reading.messages.map(m=>m.id),[MR1,MR2]);
  assertRuntime.equal(h.pageDocument.draftText,'没有发送的小说草稿');await h.close();
});
runtimeTest('switching to a video and hiding the sidebar keeps collecting only the original chat',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait,emitNetworkEvents:false});
  await h.click('start');h.activate(72);h.hide();
  assertRuntime.equal(h.evaluate('active'),true);
  assertRuntime.equal(h.nodes.get('targetTitle').textContent,'测试聊天');
  release();await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.calls.length,3);assertRuntime.equal(h.readerKeys().length,0);
  assertRuntime.ok(h.injections.every(i=>i.tabId===71));assertRuntime.equal(h.tables.pages.size,2);await h.close();
});
runtimeTest('sidebar ignores tab activity in another browser window',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait});await h.click('start');h.activate(99,8);
  assertRuntime.equal(h.evaluate('active'),true);release();
  await waitRuntime(()=>h.state()?.state==='route_complete');await h.close();
});
runtimeTest('original tab navigation and removal cancel background reads and preserve the checkpoint',async()=>{
  for(const action of ['navigate','remove']) {
    let release;const sessionWait=new Promise(resolve=>{release=resolve;});
    const h=await panelHarness({sidebar:true,sessionWait});await h.click('start');
    if(action==='navigate')h.navigate('https://chatgpt.com/c/'+MR1);else h[action]();
    await waitRuntime(()=>h.state()?.state==='paused');release();await new Promise(r=>setTimeout(r,10));
    assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.tables.pages.size,0);await h.close();
  }
});
runtimeTest('closing every panel while login is pending does not stop the worker; reopening attaches to the same finished job',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait});await h.click('start');const id=h.state().id;
  h.activate(72);h.sidebarClosed();h.pagehide();release();
  await waitRuntime(()=>h.tables.sessions.get(id)?.state==='route_complete');
  assertRuntime.equal(h.tables.sessions.size,1);assertRuntime.equal(h.calls.length,3);
  assertRuntime.equal(h.readerKeys().length,0);h.sidebarOpened();
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().id,id);assertRuntime.equal(h.nodes.get('messages').textContent,'2');
  assertRuntime.equal(h.nodes.get('targetTitle').textContent,'测试聊天');assertRuntime.match(h.nodes.get('targetHint').textContent,/已完成/);
  await h.click('download');verifyDownloadedBundle(await h.downloads[0].text());await h.close();
});
runtimeTest('a sleeping worker recovers the same job after all panels are closed without repeating saved data pages',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait});await h.click('start');const id=h.state().id;
  h.sidebarClosed();h.pagehide();await h.worker.restartForTest();release();
  await waitRuntime(()=>h.tables.sessions.get(id)?.state==='route_complete');
  assertRuntime.equal(h.tables.sessions.size,1);assertRuntime.equal(h.tables.sessions.get(id).page_count,1);
  assertRuntime.equal([...h.tables.pages.values()].filter(p=>p.kind==='head').length,1);
  assertRuntime.equal(h.tables.jobs.get('active').state,'route_complete');h.sidebarOpened();
  await waitRuntime(()=>h.state()?.state==='route_complete');await h.close();
});
runtimeTest('worker recovery resumes after a saved page and fences the old in-flight response',async()=>{
  const olderIds=[3,4].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
  const head={...HEADR,page_info:{...HEADR.page_info,has_previous_page:true}};
  const older={messages:HEADR.messages.map((m,i)=>({...m,id:olderIds[i]})),page_info:{start_cursor:olderIds[0],end_cursor:olderIds[1],has_previous_page:false,has_next_page:true}};
  let release,oldRequest=true;const gate=new Promise(r=>{release=r;});
  const h=await panelHarness({sidebar:true,onFetch:async url=>{
    if(url!==PAGER && oldRequest){oldRequest=false;await gate;}
    return {status:200,body:JSON.stringify(url===PAGER?head:older)};
  }});
  await h.click('start');const id=h.state().id;h.sidebarClosed();h.pagehide();
  await waitRuntime(()=>h.tables.sessions.get(id)?.page_count===1 && !oldRequest);
  await h.worker.restartForTest();release();
  await waitRuntime(()=>h.tables.sessions.get(id)?.state==='route_complete');
  const saved=[...h.tables.pages.values()];assertRuntime.equal(saved.filter(p=>p.kind==='head').length,1);
  assertRuntime.equal(saved.filter(p=>p.kind==='previous').length,1);assertRuntime.equal(h.tables.sessions.get(id).record_count,4);
  h.sidebarOpened();await waitRuntime(()=>h.state()?.state==='route_complete');await h.click('download');verifyDownloadedBundle(await h.downloads[0].text());await h.close();
});
runtimeTest('background server rejection is preserved and never restarted after panels close',async()=>{
  const h=await panelHarness({sidebar:true,fetchStatus:403,fetchBody:'{"detail":"denied fixture"}'});
  await h.click('start');const id=h.state().id;h.sidebarClosed();h.pagehide();
  await waitRuntime(()=>h.tables.sessions.get(id)?.state==='error');const calls=h.calls.length;
  await h.worker.restartForTest();await new Promise(r=>setTimeout(r,10));
  assertRuntime.equal(h.calls.length,calls);assertRuntime.equal(calls,2);
  assertRuntime.equal([...h.tables.pages.values()][0].response.body_text,'{"detail":"denied fixture"}');
  assertRuntime.equal(h.tables.jobs.get('active').state,'error');h.sidebarOpened();await h.close();
});
runtimeTest('background completion requires an unchanged head and retains both differing originals',async()=>{
  let heads=0;const changed=structuredClone(HEADR);changed.messages[1].content.parts=['changed fixture'];
  const h=await panelHarness({sidebar:true,onFetch:()=>({status:200,body:JSON.stringify(++heads===1?HEADR:changed)})});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.equal(h.tables.pages.size,2);assertRuntime.equal([...h.tables.pages.values()][1].accepted,false);
  assertRuntime.equal(h.state().page_count,1);assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('explicit background pause retains the checkpoint, then resume finishes the same capture',async()=>{
  const ids=[3,4].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
  const head={...HEADR,page_info:{...HEADR.page_info,has_previous_page:true}},older={messages:HEADR.messages.map((m,i)=>({...m,id:ids[i]})),
    page_info:{start_cursor:ids[0],end_cursor:ids[1],has_previous_page:false,has_next_page:true}};
  let release,blocked=true;const gate=new Promise(r=>{release=r;});
  const h=await panelHarness({sidebar:true,onFetch:async url=>{if(url!==PAGER && blocked)await gate;return {status:200,body:JSON.stringify(url===PAGER?head:older)};}});
  await h.click('start');const id=h.state().id;
  await waitRuntime(()=>h.tables.sessions.get(id)?.page_count===1);await h.click('pause');
  assertRuntime.equal(h.state().state,'paused');assertRuntime.equal(h.tables.sessions.get(id).next_sequence,h.tables.pages.size);
  blocked=false;release();await h.click('resume');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().id,id);assertRuntime.equal(h.state().record_count,4);await h.close();
});
runtimeTest('navigation of the original background chat still stops a capture while watching another tab',async()=>{
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait});await h.click('start');h.activate(72);h.hide();
  h.navigate('https://chatgpt.com/c/'+MR1);await waitRuntime(()=>h.state()?.state==='paused');
  release();await new Promise(r=>setTimeout(r,10));
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.readerKeys().length,0);assertRuntime.equal(h.tables.pages.size,0);await h.close();
});
runtimeTest('hidden capture traverses multiple pages, while counts exclude tool-directed assistant text',async()=>{
  const ids=[3,4,5,6,7].map(n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'));
  const head={...HEADR,messages:[HEADR.messages[0],
    {id:ids[0],author:{role:'system'},content:{content_type:'text',parts:['system fixture']}},
    {id:ids[1],author:{role:'assistant'},recipient:'python',content:{content_type:'text',parts:['tool call fixture']}},
    {id:ids[2],author:{role:'assistant'},content:{content_type:'thoughts',thoughts:[]}},HEADR.messages[1]],
    page_info:{...HEADR.page_info,has_previous_page:true}};
  const older={messages:HEADR.messages.map((m,i)=>({...m,id:ids[i+3]})),page_info:{start_cursor:ids[3],end_cursor:ids[4],has_previous_page:false,has_next_page:true}};
  let release;const sessionWait=new Promise(resolve=>{release=resolve;});
  const h=await panelHarness({sidebar:true,sessionWait,emitNetworkEvents:false,onFetch:url=>({status:200,body:JSON.stringify(url===PAGER?head:older)})});
  await h.click('start');h.activate(72);h.hide();release();await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().record_count,7);assertRuntime.equal(h.state().reading_count,4);assertRuntime.equal(h.state().auxiliary_count,3);
  assertRuntime.match(h.nodes.get('countBreakdown').textContent,/正文与附件 4 条.*辅助记录 3 条/);
  assertRuntime.match(h.nodes.get('pageProgress').textContent,/最早页.*通过/);
  assertRuntime.deepEqual(h.calls.map(c=>c.url),['https://chatgpt.com/api/auth/session',PAGER,CtxCore.requestURL(CIDR,MR1),PAGER]);
  assertRuntime.ok(h.injections.every(i=>i.tabId===71));await h.click('download');verifyDownloadedBundle(await h.downloads[0].text());await h.close();
});
runtimeTest('older saved records get a deduplicated display count without changing saved bodies or inventing completion',async()=>{
  const first=await panelHarness();await first.click('start');await waitRuntime(()=>first.state()?.state==='route_complete');
  const record=structuredClone(first.state()),pages=[...first.tables.pages.values()];await first.close();
  for(const field of ['reading_count','auxiliary_count','message_count_profile','history_has_previous'])delete record[field];
  record.state='paused';record.creator_version='0.4.0';
  const h=await panelHarness({sidebar:true,savedSessions:[record],savedPages:pages});
  assertRuntime.equal(h.state().reading_count,2);assertRuntime.equal(h.state().auxiliary_count,0);
  assertRuntime.match(h.nodes.get('pageProgress').textContent,/等待结束复核/);
  assertRuntime.equal(h.tables.sessions.get(record.id).message_count_profile,undefined);
  assertRuntime.deepEqual([...h.tables.pages.values()],pages);
  await h.click('resume');await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().reading_count,2);assertRuntime.equal(h.state().record_count,2);await h.close();
});
runtimeTest('sidebar on non-chat pages or without site permission preserves existing finished records',async()=>{
  const saved=storedR('completed','2026-09-13T04:15:00Z','route_complete');
  for(const options of [{initialURL:'https://example.com/'},{scriptingDenied:true}]) {
    const h=await panelHarness({sidebar:true,savedSessions:[saved],...options});await h.click('start');
    assertRuntime.equal(h.calls.length,0);assertRuntime.deepEqual(h.state(),saved);
    assertRuntime.match(h.nodes.get('detail').textContent,/ChatGPT|允许/);await h.close();
  }
});
runtimeTest('sidebar login format failure stops clearly without a nonexistent Network fallback',async()=>{
  const h=await panelHarness({sidebar:true,sessionBody:{user:{name:'private-fixture'}}});
  await h.click('start');await waitRuntime(()=>h.state()?.state==='error');
  assertRuntime.equal(h.evaluate('active'),false);assertRuntime.equal(h.nodes.get('reloadOnce').hidden,true);
  assertRuntime.equal(h.calls.length,1);assertRuntime.equal(h.readerKeys().length,0);await h.close();
});
runtimeTest('a sidebar resumes a checkpoint created by the DevTools collector in the same database format',async()=>{
  const old=await panelHarness({emitNetworkEvents:false});await old.click('start');
  await waitRuntime(()=>old.state()?.state==='route_complete');
  const record=structuredClone(old.state());record.state='paused';record.creator_version='0.3.1';
  const pages=[...old.tables.pages.values()];await old.close();
  const h=await panelHarness({sidebar:true,savedSessions:[record],savedPages:pages});await h.click('resume');
  await waitRuntime(()=>h.state()?.state==='route_complete');
  assertRuntime.equal(h.state().id,record.id);assertRuntime.equal(h.state().record_count,2);
  assertRuntime.equal(h.state().creator_version,'0.3.1');
  await h.click('download');verifyDownloadedBundle(await h.downloads[0].text());
  await h.click('deleteRecord');await h.click('confirmDelete');
  assertRuntime.equal(h.tables.pages.size,0);assertRuntime.equal(h.tables.sessions.get(record.id).deleted,true);await h.close();
});
runtimeTest('DevTools and sidebar cannot collect concurrently, and pausing releases ownership',async()=>{
  let held=false,releaseLogin;const sessionWait=new Promise(resolve=>{releaseLogin=resolve;});
  const locks={async request(name,options,run){
    assertRuntime.equal(options.ifAvailable,true);
    if(held)return run(null);
    held=true;try{return await run({name});}finally{held=false;}
  }};
  const first=await panelHarness({locks,sessionWait}),second=await panelHarness({locks,sidebar:true});
  await first.click('start');await second.click('start');
  assertRuntime.equal(second.calls.length,0);assertRuntime.equal(second.tables.sessions.size,0);
  assertRuntime.match(second.nodes.get('detail').textContent,/另一个/);
  await first.click('pause');releaseLogin();await second.click('start');
  await waitRuntime(()=>second.state()?.state==='route_complete');assertRuntime.equal(held,false);
  await first.close();await second.close();
});
