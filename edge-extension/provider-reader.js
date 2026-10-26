(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupProviderReader=Object.freeze(api);})(globalThis,function(){
  "use strict";
  // Fixed read operations on the user-selected tab. Credentials never leave this closure.
  function installInPage(key,expected){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if(!/^__chat_backup_reader_[0-9a-f-]+$/i.test(key)||!expected||!["deepseek","gemini"].includes(expected.provider_id))return {ok:false,code:"wrong_page"};
    const provider=expected.provider_id,cid=String(expected.conversation_id||"").replace(provider+":","");let origin,path,slot="";
    try{const u=new URL(expected.source_url);origin=u.origin;path=u.pathname.replace(/\/$/,"");slot=path.match(/^\/u\/(\d+)\//)?.[1]||"";
      if(u.username||u.password||u.search||u.hash||expected.conversation_id!==provider+":"+cid)throw Error();
      if(provider==="deepseek"&&(origin!=="https://chat.deepseek.com"||!uuid.test(cid)||path!=="/a/chat/s/"+cid))throw Error();
      if(provider==="gemini"&&(origin!=="https://gemini.google.com"||!/^[a-f0-9]{6,128}$/i.test(cid)||path!==(slot?"/u/"+slot:"")+"/app/"+cid))throw Error();
    }catch{return {ok:false,code:"wrong_page"};}
    function samePage(){try{const u=new URL(location.href);return u.origin===origin&&!u.username&&!u.password&&u.pathname.replace(/\/$/,"")===path&&(!u.searchParams.has("authuser")||u.searchParams.get("authuser")===(slot||"0"));}catch{return false;}}
    if(!samePage())return {ok:false,code:"wrong_page"};if(Object.hasOwn(globalThis,key))return {ok:false,code:"reader_collision"};
    let job=null,disposed=false,idleTimer=null,identityToken=null,requestNumber=100000;
    function credentials(){
      if(provider==="deepseek"){
        let value;try{const stored=localStorage.getItem("userToken");try{const parsed=JSON.parse(stored);value=typeof parsed==="string"?parsed:parsed?.value||parsed?.token;}catch{value=stored;}}catch{return null;}
        if(typeof value!=="string"||!value.trim()||value.length>65536||/[\r\n]/.test(value))return null;
        return {token:value.replace(/^Bearer\s+/i,"")};
      }
      const a=globalThis.WIZ_global_data||globalThis._WIZ_global_data||{};let at=a.SNlM0e,bl=a.cfb2h,sid=a.FdrFJe;
      if(!at||!bl){for(const s of document.querySelectorAll("script")){const text=s.textContent||"";
        for(const [field,name] of [["SNlM0e","at"],["cfb2h","bl"],["FdrFJe","sid"]]){
          const m=text.match(new RegExp('"'+field+'"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")'));
          if(m)try{const v=JSON.parse(m[1]);if(name==="at"&&!at)at=v;if(name==="bl"&&!bl)bl=v;if(name==="sid"&&!sid)sid=v;}catch{}
        }
        if(at&&bl)break;
      }}
      if(typeof at!=="string"||!at||at.length>65536||typeof bl!=="string"||!bl||bl.length>512)return null;
      return {token:at,bl,sid:typeof sid==="string"||typeof sid==="number"?String(sid):null};
    }
    function dispose(){disposed=true;clearTimeout(idleTimer);if(job){job.controller.abort();clearTimeout(job.timeout);job.result=null;}job=null;identityToken=null;delete globalThis[key];return {ok:true};}
    function idle(){clearTimeout(idleTimer);idleTimer=setTimeout(dispose,120000);}
    function fail(j,code,status){if(!disposed&&job===j){j.state="failed";j.result={state:"failed",code,...(Number.isInteger(status)?{http_status:status}:{})};}}
    function current(j){return !disposed&&job===j&&!j.controller.signal.aborted&&samePage();}
    async function run(j){
      try{
        const cred=credentials();if(!cred){fail(j,"login_unavailable");return;}if(identityToken&&identityToken!==cred.token){fail(j,"identity_changed");return;}identityToken=cred.token;
        let actualURL,descriptor,options={credentials:"same-origin",cache:"no-store",redirect:"error",signal:j.controller.signal};
        if(provider==="deepseek"){
          actualURL=origin+"/api/v0/chat/history_messages?chat_session_id="+cid;
          descriptor={method:"GET",url:actualURL,conversation_id:expected.conversation_id,cursor:null};
          options={...options,method:"GET",headers:{Accept:"application/json",Authorization:"Bearer "+cred.token}};
        }else{
          const base=origin+(slot?"/u/"+slot:"")+"/_/BardChatUi/data/batchexecute";
          const query=new URLSearchParams({rpcids:"hNvQHb","source-path":path,bl:cred.bl,_reqid:String(requestNumber++),rt:"c"});if(cred.sid)query.set("f.sid",cred.sid);
          actualURL=base+"?"+query;
          const fReq=JSON.stringify([[["hNvQHb",JSON.stringify(["c_"+cid,10,j.cursor,1,[1],[4],null,1]),null,"generic"]]]);
          options={...options,method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8","X-Same-Domain":"1"},body:new URLSearchParams({"f.req":fReq,at:cred.token}).toString()};
          descriptor={method:"POST",url:base+"?rpcids=hNvQHb",rpc:"hNvQHb",conversation_id:expected.conversation_id,cursor:j.cursor,page_size:10,account_slot:slot||"0"};
        }
        const response=await fetch(actualURL,options);if(!current(j)){fail(j,"page_changed");return;}
        if((response.headers.get("content-type")||"").includes("text/html")){fail(j,"unexpected_html",response.status);return;}
        const body=await response.text();if(!current(j)){fail(j,"page_changed");return;}
        if(credentials()?.token!==identityToken){fail(j,"identity_changed");return;}
        if(body.length>32*1024*1024){fail(j,"response_too_large");return;}
        const headers=[];for(const name of ["content-type","retry-after"]){const value=response.headers.get(name);if(value!==null)headers.push({name,value});}
        j.state="done";j.result={state:"done",request:descriptor,status:response.status,headers,body_text:body};
      }catch{if(job===j&&j.state==="pending")fail(j,samePage()?"network_error":"page_changed");}
      finally{clearTimeout(j.timeout);if(!disposed&&job===j)idle();}
    }
    const api={start(id,cursor=null,...extra){
      if(disposed||!samePage())return {ok:false,code:"wrong_page"};
      if(!uuid.test(id)||extra.length||(cursor!==null&&(provider!=="gemini"||typeof cursor!=="string"||!cursor.startsWith("tC")||cursor.length>65536||/[\x00-\x1f]/.test(cursor))))return {ok:false,code:"blocked_request"};
      if(job)return {ok:false,code:"reader_busy"};clearTimeout(idleTimer);const j={id,cursor,state:"pending",controller:new AbortController(),result:null};job=j;
      j.timeout=setTimeout(()=>{if(job===j&&j.state==="pending"){fail(j,"request_timeout");j.controller.abort();}},45000);void run(j);return {ok:true};
    },poll(id){if(disposed||!job||job.id!==id)return {state:"missing"};if(!samePage()){fail(job,"page_changed");job.controller.abort();}return job.result||{state:"pending"};},
      ack(id){if(!job||job.id!==id||job.state==="pending")return {ok:false};clearTimeout(job.timeout);job.result=null;job=null;idle();return {ok:true};},dispose};
    Object.defineProperty(globalThis,key,{value:api,configurable:true});idle();return {ok:true};
  }
  function commandInPage(key,command,args){if(!/^__chat_backup_reader_[0-9a-f-]+$/i.test(key)||!["start","poll","ack","dispose"].includes(command)||!Array.isArray(args))return {ok:false,code:"blocked_command"};const reader=globalThis[key];return reader?reader[command](...args):{state:"missing",ok:false,code:"reader_missing"};}
  return {installInPage,commandInPage};
});
