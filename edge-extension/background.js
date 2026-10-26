"use strict";
// Packaged worker dependencies load synchronously; databases and collectors do not.
importScripts("capture-store.js","background-power.js","core.js","platforms.js","surface-core.js","claude-core.js","provider-core.js","organize.js","page-reader.js","background-capture.js","surface-reader.js","surface-capture.js","claude-reader.js","claude-capture.js","provider-reader.js","provider-capture.js","capture-router.js");
const CAPTURE_ALARM="chat-backup-active-job";
const power=ChatBackupPower.create({
  openDatabase:()=>ChatBackupStore.open(indexedDB),storeFor:db=>ChatBackupStore.create(db),
  alarms:chrome.alarms,alarmName:CAPTURE_ALARM,
  createRunner:store=>{
    const badge=async(record,active)=>{
        await chrome.action.setBadgeText({text:active?"…":(record.state==="surface_complete"?"页":(["route_complete","mapping_complete","claude_complete","provider_complete"].includes(record.state)?(record.review_warnings?.length?"!":"✓"):(record.state==="error"?"!":"")))});
        await chrome.action.setBadgeBackgroundColor({color:record.state==="error"||record.mode==="surface"?"#996019":"#27634d"});
        await chrome.action.setTitle({title:active?`单聊天备份 · 后台采集中 · ${record.page_count || 0} 页 / ${record.record_count || 0} 条`:
          `单聊天备份 · ${record.state==="error"?"采集需要处理":"打开侧栏查看记录"}`});
      };
    return ChatBackupCaptureRouter.create({store,
      chatgpt:()=>ChatBackupBackground.create({store,core:ChatBackupCore,organize:ChatBackupOrganize,transport:ChatBackupBackground.transport(chrome,ChatBackupPageReader),alarms:chrome.alarms,badge}),
      surface:()=>ChatBackupSurfaceCapture.create({store,read:ChatBackupSurfaceReader.transport(chrome),core:ChatBackupSurfaceCore,platforms:ChatBackupPlatforms,alarms:chrome.alarms,badge}),
      claude:()=>ChatBackupClaudeCapture.create({store,transport:ChatBackupBackground.transport(chrome,ChatBackupClaudeReader),core:ChatBackupClaudeCore,common:ChatBackupCore,alarms:chrome.alarms,badge}),
      provider:()=>ChatBackupProviderCapture.create({store,transport:ChatBackupBackground.transport(chrome,ChatBackupProviderReader),core:ChatBackupProviderCore,common:ChatBackupCore,platforms:ChatBackupPlatforms,alarms:chrome.alarms,badge})});
  },
  onSleep:async()=>{
    // Tell every open view to unload its scripts and caches, including a DevTools view.
    await chrome.runtime.sendMessage({type:"chat-backup-power/v1",sleeping:true}).catch(()=>{});
    await chrome.action.setBadgeText({text:""}).catch(()=>{});
    await chrome.action.setTitle({title:"单聊天备份 · 已休眠，点击重新打开"}).catch(()=>{});
    // A static, script-free fallback also covers Edge versions without sidePanel.close.
    await chrome.sidePanel.setOptions({path:"sleep.html",enabled:true}).catch(()=>{});
    if(chrome.sidePanel.close){
      const windows=await chrome.windows.getAll({windowTypes:["normal"]}).catch(()=>[]);
      await Promise.allSettled(windows.map(w=>chrome.sidePanel.close({windowId:w.id})));
    }
  },
  onWake:async()=>{
    await chrome.sidePanel.setOptions({path:"panel.html",enabled:true});
    await chrome.action.setBadgeText({text:""});
    await chrome.action.setTitle({title:"单聊天备份 · 打开侧栏"});
  }
});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(message?.type!=="chat-backup-control/v1")return;
  const respond=value=>{try{reply(value);}catch{/* A closed view does not cancel an accepted operation. */}};
  if(sender.id!==chrome.runtime.id || sender.tab || sender.url!==chrome.runtime.getURL("panel.html")){
    respond({ok:false,error:"此操作只能在备份面板中执行。"});return;
  }
  const actions=["powerStatus","sleep","status","start","resume","revalidate","pause","pending"];
  if(!actions.includes(message.action)){respond({ok:false,error:"不支持的后台操作。"});return;}
  void power.request(message.action,message).then(value=>respond({ok:true,value}),error=>respond({ok:false,error:error.message || "后台操作失败。"}));
  return true;
});
// Only a toolbar click may clear the persistent sleeping flag.
chrome.action.onClicked.addListener(tab=>{
  // Open within the original gesture, before awaiting IndexedDB. The sleep page is
  // replaced with the live panel only after wake has committed.
  const opened=chrome.sidePanel.open({windowId:tab.windowId});
  void Promise.all([opened,power.wake()]).catch(()=>{
    void chrome.action.setTitle({title:"单聊天备份 · 打开失败，请再次点击图标"}).catch(()=>{});
  });
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name===CAPTURE_ALARM)void power.restore().catch(()=>{});
});
chrome.runtime.onInstalled.addListener(async()=>{
  try {
    await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:false});
    const state=await power.request("powerStatus");
    await chrome.sidePanel.setOptions({path:state.sleeping?"sleep.html":"panel.html",enabled:true});
  } catch {console.warn("请重新加载单聊天备份，以完成侧栏配置。");}
});
// No top-level boot, browser-startup handler or global tab listeners. The pinned
// reader checks the original document on each poll; active jobs alone own alarms.
