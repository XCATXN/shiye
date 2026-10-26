(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupClaudeCapture=Object.freeze(api);})(globalThis,function(){
  "use strict";
  const VERSION="0.9.0",ALARM="chat-backup-active-job";
  function create({store,transport:T,core:A,common:C,clock=globalThis,crypto=globalThis.crypto,alarms,badge=()=>{},locks=globalThis.navigator?.locks}){
    let current=null,starting=false,ready=null,unsaved=null;
    const clone=v=>structuredClone(v),now=()=>new Date().toISOString(),alive=p=>current===p&&!p.cancelled;
    function log(r,text){r.detail=text;r.background_log=[...(r.background_log||[]),`${now()}  ${text}`].slice(-35);}
    function changed(r,active){Promise.resolve(badge(r,active)).catch(()=>{});}
    function applyInfo(record,data,info){return Object.assign(record,{record_count:info.record_count,route_count:info.route_count,reading_count:info.reading_count,auxiliary_count:info.auxiliary_count,off_route_count:info.off_route_count,
      branch_points:info.branch_points,empty_text_ids:info.empty_text_ids,truncated_ids:info.truncated_ids,interrupted_ids:info.interrupted_ids,message_count_profile:"reading-v1",page_count:1,
      title:typeof data.name==="string"&&data.name?data.name.slice(0,500):record.title});}
    function cancel(p){p.cancelled=true;clock.clearTimeout(p.timer);p.wake?.();p.wake=null;}
    function sleep(p,ms){return new Promise(resolve=>{p.wake=resolve;p.timer=clock.setTimeout(()=>{p.wake=null;p.timer=null;resolve();},ms);});}
    async function dispose(p){try{await T.command(p.job.target,p.job.reader_key,"dispose");}catch{}}
    function acquire(){if(!locks)return Promise.resolve(()=>{});return new Promise((resolve,reject)=>{
      locks.request("chat-backup-active-collector",{ifAvailable:true},async lock=>{if(!lock){reject(new Error("另一个备份入口正在采集，请先暂停。"));return;}await new Promise(release=>resolve(release));}).catch(reject);
    });}
    async function status(){const job=await store.getJob();let record=job?.session_id?await store.getSession(job.session_id):null;if(record?.deleted)record=null;if(unsaved&&unsaved.record.id===record?.id)record=unsaved.record;
      return {active:job?.state==="running"&&!unsaved&&!!record,session:record?clone(record):null,has_unsaved_response:!!unsaved};}
    async function finish(p,state,message,entry=null,draft=null){
      if(!alive(p))return false;cancel(p);await alarms.clear(ALARM).catch(()=>{});
      if(!draft)try{draft=await store.getSession(p.record.id);}catch{}draft ||= clone(p.record);draft.state=state;log(draft,message);
      try{const saved=await store.write(p.job.run_id,draft,entry,state);if(saved){p.record=draft;changed(draft,false);}return saved;}
      catch{unsaved={record:{...draft,state:"error",detail:"本机保存失败，请先下载原始 JSON。"},entry};changed(unsaved.record,false);return false;}
      finally{await dispose(p);}
    }
    async function save(p,draft,entry){
      if(!alive(p))return false;
      try{if(!await store.write(p.job.run_id,draft,entry)){cancel(p);return false;}p.record=draft;changed(draft,true);return true;}
      catch{await finish(p,"error","本机保存失败，已停止后续请求。",entry,draft);return false;}
    }
    async function hydrate(record){
      const pages=await store.pages(record.id),accepted=pages.filter(p=>p.accepted);
      for(const p of pages)if(typeof p.response?.body_text!=="string"||await A.sha(p.response.body_text)!==p.response.body_sha256)throw new Error("保存的 Claude 响应校验失败，不能继续。");
      if(!accepted.length&&!record.revalidation){if(record.record_count)throw new Error("Claude 检查点缺少会话响应。");return {baseline:null,baselineURL:null,baselineSequence:null};}
      const value=await A.prepare({schema:A.SCHEMA,provider_id:"claude",conversation_id:record.conversation_id,title:record.title,capture:record,pages});
      const first=pages.find(p=>p.sequence===value.source.baseline_sequence),data=JSON.parse(first.response.body_text),info=A.inspect(data,record.conversation_id);
      if(info.record_count!==record.record_count||value.statistics.route_messages!==record.route_count)throw new Error("Claude 检查点统计与原始数据不一致。");
      return {baseline:A.signature(data,record.conversation_id),baselineURL:first.request.url,baselineSequence:first.sequence};
    }
    async function launch(record,target,recovered=null){
      if(starting||current||unsaved)throw new Error("已有任务或未保存响应，请先处理当前记录。");starting=true;let release;
      try{
        release=await acquire();const page=A.identity((await T.identity(target)).url);
        if(page.conversation_id!==record.conversation_id||page.source_url!==record.source_url)throw new Error("原标签已不是这条 Claude 聊天。");
        const history=await hydrate(record),job={id:"active",session_id:record.id,conversation_id:record.conversation_id,provider_id:"claude",mode:"claude_api",target:clone(target),
          reader_key:"__chat_backup_reader_"+crypto.randomUUID(),run_id:crypto.randomUUID(),state:"running",started_at:now()};
        record.state="waiting";record.background_runner=true;log(record,history.baseline?"正在重新读取并复核已保存的 Claude 会话。":"正在读取 Claude 会话数据；无需滚动，可以关闭侧栏。");
        await alarms.create(ALARM,{periodInMinutes:1});await store.claim(job,record,recovered?.run_id||null);
        const p={job,record,...history,release,cancelled:false,timer:null};current=p;release=null;
        if(recovered?.reader_key)try{await T.command(target,recovered.reader_key,"dispose");}catch{}
        changed(record,true);p.task=run(p).catch(error=>finish(p,error.code==="target_unavailable"?"paused":"error",error.message)).finally(async()=>{await dispose(p);p.release();if(current===p)current=null;});
        return status();
      }catch(error){if(!current)await alarms.clear(ALARM).catch(()=>{});throw error;}
      finally{release?.();starting=false;}
    }
    async function start(target,cid,title,options){
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务。");
      const expected=A.identity(options?.source_url);if(expected.conversation_id!==cid||options.provider_id!=="claude")throw new Error("Claude 采集目标不一致。");
      const record={id:crypto.randomUUID(),title:String(title||"Claude 聊天").slice(0,500),...expected,mode:"claude_api",creator_version:VERSION,
        started_at:now(),state:"waiting",next_sequence:0,page_count:0,record_count:0,route_count:0,reading_count:0,auxiliary_count:0,off_route_count:0,
        branch_points:0,version_ids:[],empty_text_ids:[],message_count_profile:"reading-v1",api_retry_count:0,api_next_attempt_at:0,
        checks:{capture_source:"claude_conversation_api",all_history_branches_verified:false,official_export_equivalent:false}};
      return launch(record,target);
    }
    async function resume(id,target){
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务。");
      const r=await store.getSession(id);if(!r||r.deleted||r.mode!=="claude_api"||r.state==="claude_complete")throw new Error("所选记录不能继续 Claude 会话采集。");
      r.api_retry_count=0;r.api_next_attempt_at=0;return launch(r,target);
    }
    async function revalidate(id){
      if(starting||current||unsaved||(await store.getJob())?.state==="running")throw new Error("请先暂停采集，并处理未保存的数据，再重新校验。");
      starting=true;let release;
      try{
        release=await acquire();const r=await store.getSession(id);
        if(!r||r.deleted||r.mode!=="claude_api")throw new Error("只能重新校验已保存的 Claude 会话记录。");
        const pages=await store.pages(id),review=await A.reviewStored({schema:A.SCHEMA,provider_id:"claude",conversation_id:r.conversation_id,title:r.title,capture:r,pages});
        const draft=applyInfo(clone(r),review.data,review.info);draft.revalidation=review.evidence;draft.state="verifying";
        draft.recheck_source="stored_responses";draft.checks={...draft.checks,selected_route_root_reached:true,returned_tree_links_valid:true,capture_recheck_passed:review.evidence.rechecked};
        draft.api_retry_count=0;draft.api_next_attempt_at=0;
        const job={id:"active",session_id:id,conversation_id:r.conversation_id,provider_id:"claude",mode:"claude_api",operation:"stored_revalidation",run_id:crypto.randomUUID(),state:"running",started_at:now()};
        // Claim/write fence the metadata update; raw pages are never changed.
        await store.claim(job,draft);draft.state=review.evidence.rechecked?"claude_complete":"paused";
        log(draft,review.evidence.rechecked?"已保存的 Claude 会话数据重新校验通过；响应内容一致。本次没有请求网页，数据对应原采集时间。":"已恢复这份 Claude 会话数据；只有一份有效响应，可先整理，点击继续后再读取一次复核。");
        try{if(!await store.write(job.run_id,draft,null,draft.state))throw new Error("记录状态已变化，重新校验结果未写入。");changed(draft,false);}
        catch(error){unsaved={record:{...draft,state:"error",detail:"重新校验结果未能保存，原始数据保留，请下载原始 JSON。"},entry:null};changed(unsaved.record,false);throw error;}
        return status();
      }finally{release?.();starting=false;}
    }
    async function read(p){
      const id=crypto.randomUUID(),started=Date.now(),result=await T.command(p.job.target,p.job.reader_key,"start",[id]);
      if(!alive(p))return null;if(!result?.ok)throw new Error("Claude 读取连接中断，已保存的数据保留；回到原聊天后可以继续。");
      const errors={organization_missing:"当前 Claude 页面没有提供可用的会话读取标识。原聊天未改动，可选择网页备用采集。",organization_changed:"Claude 工作区或登录状态发生变化，已停止以避免混合数据。",
        page_changed:"原 Claude 聊天已切换，请回到原聊天后继续。",request_timeout:"Claude 会话读取超时，已保留检查点，可稍后继续。",response_too_large:"Claude 单次响应超过保护上限，已停止，没有截断正文。",network_error:"Claude 会话请求未成功，已保留检查点，可稍后继续。"};
      while(alive(p)){
        if(Date.now()-started>65000)throw new Error(errors.request_timeout);
        const value=await T.command(p.job.target,p.job.reader_key,"poll",[id]);if(!alive(p))return null;
        if(value?.state==="pending"){await sleep(p,300);continue;}
        if(value?.state==="done"){
          if(!A.requestInfo(value.url,p.record.conversation_id)||!Number.isInteger(value.status)||typeof value.body_text!=="string")throw new Error("Claude 返回的响应与当前请求不一致。");
          await T.command(p.job.target,p.job.reader_key,"ack",[id]);return alive(p)?value:null;
        }
        p.record.direct_read_failure={code:Object.hasOwn(errors,value?.code)?value.code:"reader_missing"};
        throw Object.assign(new Error(errors[value?.code]||"Claude 读取已中断，已有数据保留。"),value?.code==="page_changed"?{code:"target_unavailable"}:{});
      }
      return null;
    }
    async function entry(p,response,kind,accepted,rejection=null){return {session_id:p.record.id,sequence:p.record.next_sequence,kind,accepted,
      request:{method:"GET",url:response.url,transport:"page_fetch"},response:{status:response.status,received_at:now(),body_text:response.body_text,body_sha256:await A.sha(response.body_text)},
      validation:{recheck_of_sequence:kind==="claude_recheck"?p.baselineSequence:null,rejection,official_export_equivalent:false}};}
    async function run(p){
      const installed=await T.install(p.job.target,p.job.reader_key,p.record.conversation_id);if(!alive(p))return;if(!installed?.ok)throw new Error("无法连接原 Claude 页面，请在该页点击拾页图标后再试。");
      while(alive(p)){
        while(alive(p)&&p.record.api_next_attempt_at>Date.now())await sleep(p,Math.min(10000,p.record.api_next_attempt_at-Date.now()));
        if(!alive(p))return;const response=await read(p);if(!response||!alive(p))return;
        if(response.body_text.length>32*1024*1024)throw new Error("Claude 响应超过保护上限，没有截断正文。");
        if(response.status!==200){
          const e=await entry(p,response,"claude_request_failed",false,`http_${response.status}`),draft={...p.record,next_sequence:p.record.next_sequence+1};
          const attempt=draft.api_retry_count||0;
          if([408,429,500,502,503,504].includes(response.status)&&attempt<2){
            draft.api_retry_count=attempt+1;draft.api_next_attempt_at=Date.now()+C.retryDelay(attempt,(response.headers||[]).find(h=>h.name.toLowerCase()==="retry-after")?.value);
            log(draft,`Claude 返回 HTTP ${response.status}，将稍后重试；原始响应已保存。`);if(!await save(p,draft,e))return;continue;
          }
          await finish(p,"error",`Claude 会话接口返回 HTTP ${response.status}，已停止并保存响应。可选择网页备用采集，不会自动滚动。`,e,draft);return;
        }
        let e=null,draft={...p.record,next_sequence:p.record.next_sequence+1,api_retry_count:0,api_next_attempt_at:0};
        try{
          e=await entry(p,response,p.baseline?"claude_recheck":"claude_tree",true);
          const data=JSON.parse(response.body_text),info=A.inspect(data,p.record.conversation_id),signature=A.signature(data,p.record.conversation_id);
          if(p.baseline&&(response.url!==p.baselineURL||signature!==p.baseline))throw new Error("Claude 两次返回的消息或当前分支发生变化，已保留原始响应，请新建采集。");
          applyInfo(draft,data,info);draft.recheck_source="live_response";
          draft.checks={...draft.checks,selected_route_root_reached:true,returned_tree_links_valid:true,capture_recheck_passed:!!p.baseline};
          if(p.baseline){await finish(p,"claude_complete","Claude 会话数据两次读取一致，当前分支已按消息关系整理；与官方全量导出的等价性仍未验证。",e,draft);return;}
          draft.state="verifying";log(draft,`已保存 ${info.record_count} 个消息节点，当前路线 ${info.route_count} 条，正在再次读取复核。`);
          if(!await save(p,draft,e))return;p.baseline=signature;p.baselineURL=response.url;p.baselineSequence=e.sequence;await sleep(p,800);
        }catch(error){
          if(!alive(p))return;
          e ||= await entry(p,response,"claude_rejected",false);e.accepted=false;e.validation.rejection=error instanceof SyntaxError?"响应不是有效 JSON":error.message;
          await finish(p,"error",e.validation.rejection+" 可下载原始 JSON 核对，或选择网页备用采集。",e,{...p.record,next_sequence:p.record.next_sequence+1});return;
        }
      }
    }
    async function pause(id,message="已暂停 Claude 会话采集；原始数据保留，继续时会重新读取核对。"){
      const job=await store.getJob();if(job?.state!=="running"||(id&&id!==job.session_id))return status();
      if(current?.job.run_id===job.run_id){const p=current;await finish(p,"paused",message);await p.task;}
      else{const r=await store.getSession(job.session_id);if(r&&!r.deleted){r.state="paused";log(r,message);await store.write(job.run_id,r,null,"paused");changed(r,false);}await alarms.clear(ALARM);if(job.reader_key)try{await T.command(job.target,job.reader_key,"dispose");}catch{}}
      return status();
    }
    async function restore(){
      if(current||starting||unsaved)return status();const job=await store.getJob();if(job?.state!=="running"){await alarms.clear(ALARM);return status();}
      const r=await store.getSession(job.session_id);if(!r||r.deleted){await alarms.clear(ALARM);return status();}
      if(!await alarms.get(ALARM))return pause(job.session_id,"后台曾中断，已保留 Claude 数据，请回到原聊天后继续。");
      try{return await launch(r,job.target,job);}catch{return pause(job.session_id,"原 Claude 页面无法恢复，数据保留，请回到原聊天后继续。");}
    }
    async function prepareSleep(){if(unsaved)throw new Error("还有未保存的数据，请先下载原始 JSON。");const result=await pause(undefined,"插件已休眠，Claude 会话检查点已保留。");if(current)await current.task;if(unsaved||(await store.getJob())?.state==="running")throw new Error("还有未保存的数据，请先下载原始 JSON。");await alarms.clear(ALARM);return result;}
    return {start,resume,revalidate,pause,status,restore,prepareSleep,boot:()=>ready||(ready=restore()),pending:async id=>unsaved?.record.id===id?clone(unsaved.entry):null,
      shutdown:()=>{if(current){cancel(current);current.release();current=null;}}};
  }
  return {create,VERSION,ALARM};
});
