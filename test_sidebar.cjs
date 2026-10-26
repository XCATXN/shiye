const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('worker stays lazy and toolbar click opens before asynchronous wake',async()=>{
  const events={},calls=[];
  vm.runInNewContext(fs.readFileSync(require.resolve('./edge-extension/background.js'),'utf8'),{
    importScripts(){},indexedDB:{},ChatBackupStore:{open:()=>{throw Error('must not open at module load');}},
    ChatBackupPower:{create:()=>({request:async()=>({sleeping:true}),wake:()=>{calls.push('wake');return Promise.resolve();}})},
    chrome:{runtime:{onMessage:{addListener(){}},onInstalled:{addListener:fn=>events.install=fn},onStartup:{addListener:fn=>events.startup=fn}},
      action:{onClicked:{addListener:fn=>events.click=fn},setTitle:async()=>{}},
      sidePanel:{setPanelBehavior:async options=>{calls.push(options);},setOptions:async options=>calls.push(options),open:options=>{calls.push(['open',options]);return Promise.resolve();}},
      alarms:{onAlarm:{addListener(){}}},tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}}}},console});
  assert.deepEqual(calls,[]);assert.equal(events.startup,undefined);
  await events.install();
  assert.equal(calls[0].openPanelOnActionClick,false);assert.equal(calls[1].path,'sleep.html');
  events.click({windowId:7});
  assert.equal(calls[2][0],'open');assert.equal(calls[2][1].windowId,7);assert.equal(calls[3],'wake');
});
test('sidebar manifest is site-scoped, retains DevTools and references packaged local resources',()=>{
  const path=require('node:path'),base=path.join(__dirname,'edge-extension');
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json')));
  assert.deepEqual(manifest.host_permissions,['https://chatgpt.com/*']);
  assert.deepEqual([...manifest.permissions].sort(),['activeTab','alarms','scripting','sidePanel','unlimitedStorage']);
  assert.equal(manifest.action.default_popup,undefined);
  assert.equal(manifest.side_panel.default_path,'panel.html');assert.equal(manifest.devtools_page,'devtools.html');
  for(const file of [manifest.background.service_worker,manifest.side_panel.default_path,...Object.values(manifest.icons)])
    assert.ok(fs.existsSync(path.join(base,file)),file);
  const html=fs.readFileSync(path.join(base,'panel.html'),'utf8');
  for(const match of html.matchAll(/<script src="([^"]+)"/g))assert.ok(fs.existsSync(path.join(base,match[1])));
  assert.ok(!html.includes('unsafe-eval'));
});
test('background controls reject website/content-script senders before reading storage',()=>{
  let listener;
  vm.runInNewContext(fs.readFileSync(require.resolve('./edge-extension/background.js'),'utf8'),{
    importScripts(){},indexedDB:{},ChatBackupStore:{open:()=>Promise.reject(new Error('fixture unavailable'))},ChatBackupPower:{create:()=>({})},
    chrome:{runtime:{id:'fixture',getURL:p=>'chrome-extension://fixture/'+p,onMessage:{addListener:fn=>listener=fn},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
      action:{onClicked:{addListener(){}}},sidePanel:{setPanelBehavior:async()=>{}},alarms:{onAlarm:{addListener(){}}},tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}}}},console});
  for(const sender of [{id:'other',url:'chrome-extension://fixture/panel.html'},
    {id:'fixture',url:'https://chatgpt.com/',tab:{id:1}}, {id:'fixture',url:'chrome-extension://fixture/panel.html',tab:{id:1}}]){
    let response;listener({type:'chat-backup-control/v1',action:'start'},sender,value=>response=value);
    assert.equal(response.ok,false);assert.match(response.error,/备份面板/);
  }
});
