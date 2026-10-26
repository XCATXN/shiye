(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupClient=Object.freeze(api);})(globalThis,function(){
  "use strict";
  function create(browser){
    const enabled=!browser?.devtools?.network;
    async function call(action,fields={}){
      if(!browser?.runtime?.sendMessage)throw new Error("后台连接不可用，请重新加载扩展后再打开侧栏。");
      let result;
      try {result=await browser.runtime.sendMessage({type:"chat-backup-control/v1",action,...fields});}
      catch {throw new Error("后台暂未连接，请重新打开侧栏。已有采集记录保留。");}
      if(!result?.ok)throw new Error(result?.error || "后台没有返回有效结果。");
      return result.value;
    }
    return {enabled,call};
  }
  return {create};
});
