(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupProviderCapture=Object.freeze(api);})(globalThis,function(){
  "use strict";
  const VERSION="0.9.0",ALARM="chat-backup-active-job";
  function create({store,transport:T,core:A,common:C,platforms:P,clock=globalThis,crypto=globalThis.crypto,alarms,locks=globalThis.navigator?.locks,badge=()=>{}}){
    let current=null,starting=false,ready=null,unsaved=null;
    const clone=v=>structuredClone(v),now=()=>new Date().toISOString(),alive=p=>current===p&&!p.cancelled;
    const asBundle=(r,pages)=>({schema:A.SCHEMA,provider_id:r.provider_id,conversation_id:r.conversation_id,title:r.title,capture:r,pages});
    function log(r,message){r.detail=message;r.background_log=[...(r.background_log||[]),now()+"  "+message].slice(-35);}
    function changed(r,active){Promise.resolve(badge(r,active)).catch(()=>{});}
    function cancel(p){p.cancelled=true;clock.clearTimeout(p.timer);p.wake?.();p.wake=null;}
    function sleep(p,ms){return new Promise(resolve=>{p.wake=resolve;p.timer=clock.setTimeout(()=>{p.timer=null;p.wake=null;resolve();},ms);});}
    async function dispose(p){if(p.job.reader_key)try{await T.command(p.job.target,p.job.reader_key,"dispose");}catch{}}
    async function acquire(){if(!locks)return ()=>{};return new Promise((resolve,reject)=>{locks.request("chat-backup-active-collector",{ifAvailable:true},async lock=>{if(!lock){reject(new Error("另一个备份入口正在采集，请先暂停。"));return;}await new Promise(release=>resolve(release));}).catch(reject);});}
    async function status(){const job=await store.getJob();let r=job?.session_id?await store.getSession(job.session_id):null;if(r?.deleted)r=null;if(unsaved&&unsaved.record.id===r?.id)r=unsaved.record;return {active:job?.state==="running"&&!!r&&!unsaved,session:r?clone(r):null,has_unsaved_response:!!unsaved};}
    async function finish(p,state,message,entry=null,draft=null){
      if(!alive(p))return false;cancel(p);await alarms.clear(ALARM).catch(()=>{});if(!draft)try{draft=await store.getSession(p.record.id);}catch{}draft ||= clone(p.record);draft.state=state;log(draft,message);
      try{const saved=await store.write(p.job.run_id,draft,entry,state);if(saved){p.record=draft;changed(draft,false);}return saved;}
      catch{unsaved={record:{...draft,state:"error",detail:"本机保存失败，请先下载原始 JSON。"},entry};changed(unsaved.record,false);return false;}
      finally{await dispose(p);}
    }
    async function save(p,draft,entry){if(!alive(p))return false;try{if(!await store.write(p.job.run_id,draft,entry)){cancel(p);return false;}p.record=draft;changed(draft,true);return true;}catch{await finish(p,"error","本机保存失败，已停止后续请求。",entry,draft);return false;}}
    function applyState(record,state){Object.assign(record,A.counts(state),{page_count:state.dataPages,message_count_profile:"reading-v1",title:state.title||record.title,
      checks:{...record.checks,capture_recheck_passed:state.rechecked,pagination_boundary_observed:state.ended,official_export_equivalent:false}});return record;}
    async function hydrate(r){const pages=await store.pages(r.id);if(!pages.length){if(r.record_count)throw new Error("检查点缺少原始响应。");return A.createState(A.identity(r.source_url));}
      const bundle=asBundle(r,pages),state=await A.replay(bundle,{recover:A.savedRecovery(bundle)});if(state.records.size!==(r.record_count||0))throw new Error("检查点统计与已验证的原始数据不一致。");return state;}
    async function launch(r,target,recovered=null){
      if(current||starting||unsaved)throw new Error("已有任务或未保存数据，请先处理。");starting=true;let release;
      try{
        release=await acquire();const expected=A.identity(r.source_url),live=A.identity((await T.identity(target)).url);if(live.source_url!==expected.source_url||live.conversation_id!==r.conversation_id)throw new Error("原标签不是这份记录的聊天。");
        const state=await hydrate(r),job={id:"active",session_id:r.id,provider_id:r.provider_id,conversation_id:r.conversation_id,mode:"provider_api",target:clone(target),reader_key:"__chat_backup_reader_"+crypto.randomUUID(),run_id:crypto.randomUUID(),state:"running",started_at:now()};
        r.state="waiting";r.background_runner=true;log(r,`${P.name(r.provider_id)} 会话读取已启动，无需滚动；可关闭侧栏。`);
        await alarms.create(ALARM,{periodInMinutes:1});await store.claim(job,r,recovered?.run_id||null);
        const p={job,record:r,expected,state,release,cancelled:false,timer:null};current=p;release=null;
        if(recovered?.reader_key)try{await T.command(target,recovered.reader_key,"dispose");}catch{}
        changed(r,true);p.task=run(p).catch(error=>finish(p,error.code==="target_unavailable"?"paused":"error",error.message)).finally(async()=>{await dispose(p);p.release();if(current===p)current=null;});return status();
      }catch(error){if(!current)await alarms.clear(ALARM).catch(()=>{});throw error;}finally{release?.();starting=false;}
    }
    async function start(target,cid,title,options){
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务。");const expected=A.identity(options?.source_url);if(expected.conversation_id!==cid||expected.provider_id!==options.provider_id)throw new Error("采集目标不一致。");
      const r={id:crypto.randomUUID(),...expected,title:String(title||expected.provider_name).slice(0,500),mode:"provider_api",creator_version:VERSION,started_at:now(),state:"waiting",next_sequence:0,page_count:0,record_count:0,route_count:0,reading_count:0,auxiliary_count:0,message_count_profile:"reading-v1",version_ids:[],branch_points:0,empty_text_ids:[],review_warnings:[],checks:{capture_source:"provider_conversation_api",official_export_equivalent:false}};return launch(r,target);
    }
    async function resume(id,target){if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务。");const r=await store.getSession(id);if(!r||r.deleted||r.mode!=="provider_api"||r.state==="provider_complete")throw new Error("这份记录不能继续采集。");return launch(r,target);}
    async function read(p,cursor){
      const id=crypto.randomUUID(),started=Date.now(),res=await T.command(p.job.target,p.job.reader_key,"start",[id,cursor]);if(!alive(p))return null;if(!res?.ok)throw new Error("页面读取连接中断，请在原聊天页点击拾页图标后继续。");
      const messages={login_unavailable:"当前页面未提供可用登录信息，未读取其他账号；可选择网页备用采集。",identity_changed:"登录状态发生变化，已停止以免混合数据。",unexpected_html:"网页返回了非会话页面，未保存登录或验证页面；请确认原网页能正常访问。",page_changed:"原聊天已切换，采集已停止。",response_too_large:"响应超过保护上限，已停止，没有截断正文。",request_timeout:"会话读取超时，已有数据保留。",network_error:"会话请求未成功，已有数据保留。"};
      while(alive(p)){
        if(Date.now()-started>65000)throw new Error(messages.request_timeout);const value=await T.command(p.job.target,p.job.reader_key,"poll",[id]);if(!alive(p))return null;
        if(value?.state==="pending"){await sleep(p,300);continue;}
        if(value?.state==="done"){
          if(!A.requestValid(value.request,p.expected)||value.request.cursor!==cursor||typeof value.body_text!=="string"||!Number.isInteger(value.status))throw new Error("返回的会话数据与本次请求不一致。");
          await T.command(p.job.target,p.job.reader_key,"ack",[id]);return alive(p)?value:null;
        }
        throw Object.assign(new Error(messages[value?.code]||"页面读取已中断，已有数据保留。"),value?.code==="page_changed"?{code:"target_unavailable"}:{});
      }
      return null;
    }
    async function run(p){
      const installed=await T.install(p.job.target,p.job.reader_key,p.expected);if(!alive(p))return;if(!installed?.ok)throw new Error("无法连接原聊天页，请从该页的工具栏重新打开拾页。");
      let cursor=null,retries=0,steps=0;
      while(alive(p)){
        if(++steps>2005){await finish(p,"paused","达到分页保护上限，已保留现有数据；请核对后继续。");return;}
        const response=await read(p,cursor);if(!response||!alive(p))return;
        const entry={session_id:p.record.id,sequence:p.record.next_sequence,kind:cursor===null?(p.state.head?"api_head_recheck":"api_head"):"api_previous",accepted:true,request:response.request,
          response:{status:response.status,body_text:response.body_text,body_sha256:await A.sha(response.body_text),received_at:now()},validation:{parent_page_sequence:p.state.lastDataSequence}};
        if(!alive(p))return;
        const draft={...p.record,next_sequence:p.record.next_sequence+1};
        if(response.status!==200){
          entry.accepted=false;entry.kind="request_failed";entry.validation.rejection="http_"+response.status;
          if([408,429,500,502,503,504].includes(response.status)&&retries<2){log(draft,`接口返回 HTTP ${response.status}，保存响应后稍后重试。`);if(!await save(p,draft,entry))return;await sleep(p,C.retryDelay(retries++,(response.headers||[]).find(h=>h.name==="retry-after")?.value));continue;}
          await finish(p,"error",`会话接口返回 HTTP ${response.status}，已保存响应，不会自动切换成滚动采集。`,entry,draft);return;
        }
        retries=0;
        try{
          await A.consume(p.state,entry);applyState(draft,p.state);draft.recheck_source="live_response";
          if(p.state.rechecked){await finish(p,"provider_complete",`${P.name(draft.provider_id)} 返回的数据已保存，历史边界和首页已复核。${draft.ambiguous_count?"存在多个候选回答，正文版本仍需核对。":"与官方全量导出的等价性仍未验证。"}`,entry,draft);return;}
          draft.state=p.state.ended?"verifying":"running";log(draft,`已保存 ${draft.record_count} 个消息节点，${p.state.ended?"正在复核首页":"继续按接口游标读取更早消息"}。`);
          if(!await save(p,draft,entry))return;cursor=p.state.ended?null:p.state.pending;await sleep(p,350);
        }catch(error){if(!alive(p))return;entry.accepted=false;entry.validation.rejection=error instanceof SyntaxError?"响应不是已适配的 JSON 格式":error.message;await finish(p,"error",entry.validation.rejection+" 原始响应已保存，可下载核对或使用网页备用采集。",entry,{...p.record,next_sequence:p.record.next_sequence+1});return;}
      }
    }
    async function revalidate(id){
      if(starting||current||unsaved||(await store.getJob())?.state==="running")throw new Error("请先暂停采集并处理未保存的数据。");starting=true;let release;
      try{
        release=await acquire();const r=await store.getSession(id);if(!r||r.deleted||r.mode!=="provider_api")throw new Error("不是可重新校验的会话记录。");
        const pages=await store.pages(id),state=await A.replay(asBundle(r,pages),{recover:true});if(!state.head)throw new Error("没有可校验的会话响应。");
        const draft=applyState(clone(r),state);draft.revalidation={schema:"provider-stored-recheck/v1",checked_at:now(),sources:pages.map(p=>({sequence:p.sequence,body_sha256:p.response.body_sha256}))};draft.recheck_source="stored_responses";
        const job={id:"active",session_id:id,provider_id:r.provider_id,mode:"provider_api",operation:"stored_revalidation",run_id:crypto.randomUUID(),state:"running",started_at:now()};draft.state="verifying";await store.claim(job,draft);
        draft.state=state.rechecked?"provider_complete":"paused";log(draft,state.rechecked?"已存会话数据重新校验通过，本次没有访问网页。":"已存数据已重新校验，可整理现有部分，继续采集后完成剩余分页或复核。");
        try{if(!await store.write(job.run_id,draft,null,draft.state))throw new Error("记录已变化，未写入校验结果。");changed(draft,false);}catch(error){unsaved={record:{...draft,state:"error",detail:"校验结果保存失败，原始数据保留。"},entry:null};throw error;}return status();
      }finally{release?.();starting=false;}
    }
    async function pause(id,message="采集已暂停，原始会话数据保留。"){
      const job=await store.getJob();if(job?.state!=="running"||(id&&id!==job.session_id))return status();
      if(current?.job.run_id===job.run_id){const p=current;await finish(p,"paused",message);await p.task;}
      else{const r=await store.getSession(job.session_id);if(r&&!r.deleted){r.state="paused";log(r,message);await store.write(job.run_id,r,null,"paused");}await alarms.clear(ALARM);if(job.reader_key)try{await T.command(job.target,job.reader_key,"dispose");}catch{}}
      return status();
    }
    async function restore(){if(current||starting||unsaved)return status();const job=await store.getJob();if(job?.state!=="running"){await alarms.clear(ALARM);return status();}const r=await store.getSession(job.session_id);if(!r||r.deleted){await alarms.clear(ALARM);return status();}if(!await alarms.get(ALARM))return pause(job.session_id,"后台曾中断，已保留数据，请回到原聊天后继续。");try{return await launch(r,job.target,job);}catch{return pause(job.session_id,"原聊天无法恢复，已有数据保留，请回到原聊天后继续。");}}
    async function prepareSleep(){if(unsaved)throw new Error("仍有未保存数据，请先下载原始 JSON。");const value=await pause(undefined,"插件已休眠，采集检查点保留。");if(current)await current.task;if(unsaved||(await store.getJob())?.state==="running")throw new Error("仍有未保存数据或未停止任务。");await alarms.clear(ALARM);return value;}
    return {start,resume,revalidate,pause,status,restore,prepareSleep,boot:()=>ready||(ready=restore()),pending:async id=>unsaved?.record.id===id?clone(unsaved.entry):null,shutdown:()=>{if(current){cancel(current);current.release();current=null;}}};
  }
  return {create,VERSION,ALARM};
});
