(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupClaudeReader=Object.freeze(api);})(globalThis,function(){
  "use strict";
  // Installed only after the user starts capture on the pinned Claude tab.
  // Session cookies stay in the page; no account listing, navigation or DOM scrolling.
  function installInPage(key,conversationId){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const cid=typeof conversationId==="string"?conversationId.replace(/^claude:/,""):"";
    function samePage(){try{const u=new URL(location.href);return u.origin==="https://claude.ai"&&!u.username&&!u.password&&u.pathname.replace(/\/$/,"")==="/chat/"+cid;}catch{return false;}}
    function organization(){try{const match=document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]*)/);const value=match?decodeURIComponent(match[1]):"";return uuid.test(value)?value.toLowerCase():null;}catch{return null;}}
    if(!uuid.test(cid)||!/^__chat_backup_reader_[0-9a-f-]+$/i.test(key)||!samePage())return {ok:false,code:"wrong_page"};
    if(Object.prototype.hasOwnProperty.call(globalThis,key))return {ok:false,code:"reader_collision"};
    let org=null,job=null,disposed=false,idleTimer=null;
    function dispose(){disposed=true;clearTimeout(idleTimer);if(job){job.controller.abort();clearTimeout(job.timeout);job.result=null;}job=null;org=null;delete globalThis[key];return {ok:true};}
    function idle(){clearTimeout(idleTimer);idleTimer=setTimeout(dispose,120000);}
    function fail(j,code){if(!disposed&&job===j){j.state="failed";j.result={state:"failed",code};}}
    function current(j){return !disposed&&job===j&&!j.controller.signal.aborted&&samePage()&&organization()===org;}
    async function run(j){
      try{
        if(!samePage()){fail(j,"page_changed");return;}
        const selected=organization();if(!selected){fail(j,"organization_missing");return;}
        if(org&&org!==selected){fail(j,"organization_changed");return;}org=selected;
        const url=`https://claude.ai/api/organizations/${org}/chat_conversations/${cid}?tree=true&rendering_mode=messages&render_all_tools=true`;
        const response=await fetch(url,{method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal:j.controller.signal,headers:{Accept:"application/json"}});
        if(!current(j)){fail(j,samePage()?"organization_changed":"page_changed");return;}
        const body=await response.text();
        if(!current(j)){fail(j,samePage()?"organization_changed":"page_changed");return;}
        if(body.length>32*1024*1024){fail(j,"response_too_large");return;}
        const headers=[];for(const name of ["content-type","retry-after","x-request-id"]){const value=response.headers.get(name);if(value!==null)headers.push({name,value});}
        j.state="done";j.result={state:"done",url,status:response.status,headers,body_text:body};
      }catch{if(job===j&&j.state==="pending")fail(j,samePage()?"network_error":"page_changed");}
      finally{clearTimeout(j.timeout);if(!disposed&&job===j)idle();}
    }
    const api={
      start(id,...extra){
        if(disposed||!samePage())return {ok:false,code:"wrong_page"};
        if(!uuid.test(id)||extra.length)return {ok:false,code:"blocked_request"};
        if(job)return {ok:false,code:"reader_busy"};
        clearTimeout(idleTimer);const j={id,state:"pending",controller:new AbortController(),result:null};job=j;
        j.timeout=setTimeout(()=>{if(job===j&&j.state==="pending"){fail(j,"request_timeout");j.controller.abort();}},45000);
        void run(j);return {ok:true};
      },
      poll(id){if(disposed||!job||job.id!==id)return {state:"missing"};if(!samePage()){fail(job,"page_changed");job.controller.abort();}return job.result||{state:"pending"};},
      ack(id){if(!job||job.id!==id||job.state==="pending")return {ok:false};clearTimeout(job.timeout);job.result=null;job=null;idle();return {ok:true};},
      dispose
    };
    Object.defineProperty(globalThis,key,{value:api,configurable:true});idle();return {ok:true};
  }
  function commandInPage(key,command,args){
    if(!/^__chat_backup_reader_[0-9a-f-]+$/i.test(key)||!["start","poll","ack","dispose"].includes(command)||!Array.isArray(args))return {ok:false,code:"blocked_command"};
    const reader=globalThis[key];return reader?reader[command](...args):{state:"missing",ok:false,code:"reader_missing"};
  }
  return {installInPage,commandInPage};
});
