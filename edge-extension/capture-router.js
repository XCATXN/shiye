(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupCaptureRouter=Object.freeze(api);})(globalThis,function(){
  "use strict";
  function create({store,chatgpt,surface,claude,provider}){
    const engines=new Map();
    function engine(platform,mode){const key=mode==="surface"?"surface":(["deepseek","gemini"].includes(platform)&&provider?"provider":(platform==="claude"&&claude?"claude":(platform&&platform!=="chatgpt"?"surface":"chatgpt")));if(!engines.has(key))engines.set(key,key==="surface"?surface():(key==="provider"?provider():(key==="claude"?claude():chatgpt())));return engines.get(key);}
    async function selected(id){const job=await store.getJob(),key=id||job?.session_id;const record=key?await store.getSession(key):null;return engine(record?.provider_id,record?.mode);}
    return {start:(target,cid,title,options={})=>engine(options.provider_id,options.capture_method).start(target,cid,title,options),
      resume:async(id,target)=>(await selected(id)).resume(id,target),pause:async(id,message)=>(await selected(id)).pause(id,message),
      revalidate:async id=>{const selectedEngine=await selected(id);if(!selectedEngine.revalidate)throw new Error("此记录不支持接口数据重新校验。");return selectedEngine.revalidate(id);},
      status:async()=>(await selected()).status(),restore:async()=>(await selected()).restore(),boot:async()=>(await selected()).boot(),
      pending:async id=>(await selected(id)).pending(id),prepareSleep:async()=>(await selected()).prepareSleep(),
      shutdown:()=>{for(const e of engines.values())e.shutdown();engines.clear();}};
  }
  return {create};
});
