(function(root,factory){
  const api=factory();
  if(typeof module==="object" && module.exports) module.exports=api;
  else root.ChatBackupBrowserContext=Object.freeze(api);
})(typeof globalThis==="object" ? globalThis : this,function(){
  "use strict";
  // Both entry points share the same collector and IndexedDB. Only page access differs.
  function create(browser,core,reader) {
    const hasNetwork=!!browser?.devtools?.network;
    const available=hasNetwork || !!(browser?.scripting?.executeScript && browser?.tabs && browser?.windows);
    let windowId=null, target=null;
    const readerTargets=new Map();
    function evaluated(code) {
      return new Promise((resolve,reject)=>{
        let settled=false;
        const timer=setTimeout(()=>done(undefined,true),8000);
        function done(result,exception) {
          if(settled)return;settled=true;clearTimeout(timer);
          if(exception && (typeof exception!=="object" || exception.isException || exception.isError || exception.code || exception.description || exception.value))
            reject(new Error("无法在所检查的聊天页面执行读取。"));
          else resolve(result);
        }
        try {
          const value=browser.devtools.inspectedWindow.eval(code,done);
          if(value?.then)value.then(result=>{
            if(Array.isArray(result))done(result[0],result[1]);
            else if(result && (Object.hasOwn(result,"result") || Object.hasOwn(result,"exceptionInfo")))done(result.result,result.exceptionInfo);
            else if(result!==undefined)done(result);
          },()=>done(undefined,true));
        } catch {done(undefined,true);}
      });
    }
    async function init() {
      if(!available)throw new Error("请从 Edge 工具栏的“单聊天备份”图标打开侧栏。");
      if(!hasNetwork)windowId=(await browser.windows.getCurrent()).id;
    }
    async function currentTab() {
      if(windowId===null)await init();
      const tabs=await browser.tabs.query({active:true,windowId});
      if(!tabs[0] || !Number.isInteger(tabs[0].id))throw new Error("找不到当前窗口的活动标签，请选择要备份的聊天。");
      return tabs[0];
    }
    function checkedPage(info) {
      const platforms=globalThis.ChatBackupPlatforms;
      try {
        if(platforms){const found=platforms.identify(info?.url);return found.provider_id==="chatgpt"?{conversation_id:found.conversation_id,title:info.title||"聊天"}:{...found,title:info.title||found.provider_name};}
        return {conversation_id:core.conversationFromPage(info?.url),title:info.title || "聊天"};
      } catch(error){throw new Error(platforms?error.message:"请先切换到已登录的 ChatGPT 聊天，再点击“采集当前聊天”。");}
    }
    async function injected(binding,func,args=[]) {
      if(!binding)throw new Error("请先选择要采集的聊天标签。");
      try {
        const injectionTarget={tabId:binding.tabId};
        if(binding.documentId)injectionTarget.documentIds=[binding.documentId];
        else injectionTarget.frameIds=[0];
        const results=await browser.scripting.executeScript({target:injectionTarget,world:"MAIN",func,args});
        const result=results.find(item=>item.frameId===0);
        if(!result || result.error)throw new Error();
        return result;
      } catch {
        // Browser/page exceptions may contain page data. Show a fixed actionable error only.
        throw new Error("无法连接聊天标签。请确认原聊天仍打开，并允许拾页读取该页面；在原标签上点击工具栏图标后再采集或继续。");
      }
    }
    function readIdentity(){return {url:location.href,title:document.title};}
    async function bindIdentity() {
      if(hasNetwork)return identity();
      const tab=await currentTab();
      if(typeof tab.url!=="string")throw new Error("请在要采集的聊天标签上点击工具栏“拾页”图标，再开始采集，以取得当前页面的临时读取权限。");
      const selected=checkedPage(tab); // Bind once to the tab chosen when the user clicks.
      const binding={tabId:tab.id};
      const result=await injected(binding,readIdentity);
      const info=checkedPage(result.result);
      if(info.conversation_id!==selected.conversation_id)throw new Error("目标聊天正在跳转，请等页面稳定后重新点击采集。");
      target={...binding,documentId:result.documentId};
      return info;
    }
    async function identity() {
      if(hasNetwork)return checkedPage(await evaluated("({url:location.href,title:document.title})"));
      return checkedPage((await injected(target,readIdentity)).result);
    }
    async function preview() {
      if(hasNetwork)return identity();
      return checkedPage(await currentTab());
    }
    async function installReader(key,cid) {
      if(hasNetwork)return evaluated(reader.installCode(key,cid));
      const binding={...target};readerTargets.set(key,binding);
      return (await injected(binding,reader.installInPage,[key,cid])).result;
    }
    async function readerCommand(key,command,args=[]) {
      if(hasNetwork)return evaluated(reader.commandCode(key,command,args));
      const binding=readerTargets.get(key);
      try {return (await injected(binding,reader.commandInPage,[key,command,args])).result;}
      finally {if(command==="dispose")readerTargets.delete(key);}
    }
    function networkLog(timeoutMs=5000) {
      if(!hasNetwork)return Promise.resolve([]);
      return new Promise((resolve,reject)=>{
        let settled=false;
        const timer=setTimeout(failed,timeoutMs);
        function done(value){if(settled)return;settled=true;clearTimeout(timer);resolve(value?.entries || []);}
        function failed(){if(settled)return;settled=true;clearTimeout(timer);reject(new Error("现有网络记录暂不可用。"));}
        try {
          const result=browser.devtools.network.getHAR(done);
          if(result?.then)result.then(value=>{if(value!==undefined)done(value);},failed);
        } catch {failed();}
      });
    }
    function listen({request,navigate,changed,closed,opened}) {
      if(hasNetwork) {
        browser.devtools.network.onRequestFinished.addListener(request);
        browser.devtools.network.onNavigated.addListener(url=>{navigate(url);changed();});
      } else {
        browser.tabs.onActivated.addListener(info=>{
          if(info.windowId!==windowId)return;
          // Choosing a video/another tab does not change the bound capture target.
          changed();
        });
        browser.tabs.onUpdated.addListener((tabId,change,tab)=>{
          if(target?.tabId===tabId && (change.url || change.status==="loading"))navigate(change.url || tab?.url || null);
          if(tab?.windowId===windowId && tab.active && (change.url || change.title || change.status))changed();
        });
        browser.tabs.onRemoved.addListener(tabId=>{if(target?.tabId===tabId)navigate(null);changed();});
        browser.sidePanel?.onClosed?.addListener(info=>{if(info.windowId===windowId)closed?.();});
        browser.sidePanel?.onOpened?.addListener(info=>{if(info.windowId===windowId)opened?.();});
      }
    }
    return {available,hasNetwork,init,bindIdentity,identity,preview,installReader,readerCommand,networkLog,listen,
      binding:()=>target ? {...target} : null,
      evaluateObserved:code=>{if(!hasNetwork)throw new Error("侧栏不使用开发者工具请求通道。");return evaluated(code);},
      reload:()=>{if(!hasNetwork)throw new Error("侧栏直接读取聊天，无需刷新。");browser.devtools.inspectedWindow.reload();}};
  }
  return {create};
});
