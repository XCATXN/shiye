const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Power=require('./edge-extension/background-power.js');
function fixture({sleeping=false,unsaved=false,failWrite=false,legacyActive=false,persisted=null}={}){
  const state=persisted || {sleeping,active:true,raw:'original response: keep byte-for-byte'},calls=[];
  const db={close:()=>calls.push('close-db')};
  const store={getSleeping:async()=>{calls.push('read-power');return state.sleeping;},
    setSleeping:async value=>{calls.push('write-power:'+value);if(failWrite)throw Error('storage failed');state.sleeping=value;}};
  const runner={boot:async()=>calls.push('boot'),status:async()=>({active:state.active}),
    prepareSleep:async()=>{calls.push('prepare-sleep');if(unsaved)throw Error('unsaved response');state.active=false;},
    start:async()=>{calls.push('start');state.active=true;},resume:async()=>{calls.push('resume');state.active=true;},
    pause:async()=>{state.active=false;},pending:async()=>state.raw,restore:async()=>calls.push('restore'),shutdown:()=>calls.push('shutdown')};
  const controller=Power.create({openDatabase:async()=>{calls.push('open-db');return db;},storeFor:()=>store,
    createRunner:()=>{calls.push('new-runner');return runner;},alarmName:'capture',alarms:{clear:async()=>calls.push('clear-alarm')},
    locks:{request:async(_,options,fn)=>{assert.equal(options.ifAvailable,true);return fn(legacyActive?null:{});}},
    onSleep:async()=>calls.push('close-views'),onWake:async()=>calls.push('open-view')});
  return {controller,state,calls};
}
test('power controller does no IO or capture work until explicitly called',()=>{assert.deepEqual(fixture().calls,[]);});
test('sleep checkpoints before saving power flag, drops engine and closes storage without deleting raw data',async()=>{
  const f=fixture();await f.controller.request('sleep');
  assert.equal(f.state.active,false);assert.equal(f.state.sleeping,true);assert.equal(f.state.raw,'original response: keep byte-for-byte');
  assert.deepEqual(f.calls,['open-db','read-power','new-runner','prepare-sleep','clear-alarm','write-power:true','shutdown','close-db','close-views']);
  const count=f.calls.length;assert.equal((await f.controller.request('status')).sleeping,true);
  await assert.rejects(f.controller.request('start'),/休眠/);await assert.rejects(f.controller.request('resume'),/休眠/);
  assert.equal(f.calls.length,count,'late polls and starts must not reopen storage or the reader');
});
test('sleep persists across worker restarts and a stale alarm cannot restore a capture',async()=>{
  const f=fixture();await f.controller.request('sleep');
  const fresh=fixture({persisted:f.state});assert.deepEqual(fresh.calls,[]);
  assert.equal((await fresh.controller.restore()).sleeping,true);
  assert.deepEqual(fresh.calls,['open-db','read-power','clear-alarm','close-db']);
});
test('only explicit wake clears sleep; reopening does not start or resume collection',async()=>{
  const f=fixture({sleeping:true});await f.controller.request('powerStatus');await f.controller.wake();
  assert.equal(f.state.sleeping,false);assert.ok(!f.calls.includes('new-runner'));assert.ok(!f.calls.includes('start'));assert.ok(!f.calls.includes('resume'));
  await f.controller.request('status');assert.equal(f.calls.filter(x=>x==='new-runner').length,1);
});
test('unsaved response prevents closing views and remains downloadable',async()=>{
  const f=fixture({unsaved:true});await assert.rejects(f.controller.request('sleep'),/unsaved/);
  assert.equal(f.state.sleeping,false);assert.ok(!f.calls.includes('shutdown'));assert.ok(!f.calls.includes('close-views'));
  assert.equal(await f.controller.request('pending'),f.state.raw);
});
test('failed sleep flag persistence leaves the view and engine available for recovery',async()=>{
  const f=fixture({failWrite:true});await assert.rejects(f.controller.request('sleep'),/storage failed/);
  assert.equal(f.state.sleeping,false);assert.ok(!f.calls.includes('shutdown'));assert.ok(!f.calls.includes('close-views'));
});
test('another active DevTools collector prevents global sleep and is never discarded',async()=>{
  const f=fixture({legacyActive:true});await assert.rejects(f.controller.request('sleep'),/F12/);
  assert.equal(f.state.sleeping,false);assert.ok(!f.calls.includes('close-views'));
});
test('queued stale start cannot race past successful sleep',async()=>{
  const f=fixture();const closed=f.controller.request('sleep'),late=f.controller.request('start');
  await closed;await assert.rejects(late,/休眠/);assert.ok(!f.calls.includes('start'));
});
test('background has no global page/startup listeners and starts no timers or capture engine at load',()=>{
  const registered=[],loaded=[];
  const event=name=>({addListener:()=>registered.push(name)});
  vm.runInNewContext(fs.readFileSync(require.resolve('./edge-extension/background.js'),'utf8'),{
    importScripts:(...files)=>loaded.push(...files),ChatBackupPower:Power,ChatBackupStore:{},indexedDB:{},
    chrome:{runtime:{onMessage:event('message'),onStartup:event('startup'),onInstalled:event('install')},
      action:{onClicked:event('click')},alarms:{onAlarm:event('alarm')},tabs:{onUpdated:event('tab-update'),onRemoved:event('tab-remove')}},
    setTimeout(){throw Error('unexpected timer');},setInterval(){throw Error('unexpected interval');}
  });
  assert.deepEqual(registered,['message','click','alarm','install']);
  assert.deepEqual(loaded,['capture-store.js','background-power.js','core.js','platforms.js','surface-core.js','claude-core.js','provider-core.js','organize.js','page-reader.js','background-capture.js','surface-reader.js','surface-capture.js','claude-reader.js','claude-capture.js','provider-reader.js','provider-capture.js','capture-router.js']);
});
test('sleep fallback page has no scripts, refresh directives or third-party resources',()=>{
  const html=fs.readFileSync(require.resolve('./edge-extension/sleep.html'),'utf8');
  assert.ok(!/<script|http-equiv|https?:\/\//i.test(html));assert.match(html,/再次点击工具栏/);
});
test('native sleep unloads all views and closes our side panels, with a script-free fallback',async()=>{
  let lifecycle;const calls=[],event={addListener(){}};
  const chrome={runtime:{onMessage:event,onInstalled:event,sendMessage:async m=>calls.push(['notify',m.sleeping])},
    action:{onClicked:event,setBadgeText:async()=>{},setTitle:async()=>{}},alarms:{onAlarm:event},
    windows:{getAll:async()=>[{id:7},{id:8}]},
    sidePanel:{setOptions:async o=>calls.push(['path',o.path]),close:async o=>calls.push(['close',o.windowId])}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./edge-extension/background.js'),'utf8'),{
    importScripts(){},indexedDB:{},ChatBackupStore:{},ChatBackupPower:{create:o=>{lifecycle=o;return {};}},chrome
  });
  await lifecycle.onSleep();assert.deepEqual(calls,[['notify',true],['path','sleep.html'],['close',7],['close',8]]);
  calls.length=0;delete chrome.sidePanel.close;await lifecycle.onSleep();assert.deepEqual(calls,[['notify',true],['path','sleep.html']]);
  calls.length=0;await lifecycle.onWake();assert.deepEqual(calls,[['path','panel.html']]);
});
