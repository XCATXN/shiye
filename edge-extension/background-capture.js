(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupBackground=Object.freeze(api);})(globalThis,function(){
  "use strict";
  const VERSION="0.9.0",ALARM="chat-backup-active-job";
  function transport(browser,R) {
    async function invoke(target,func,args){
      if(!Number.isInteger(target?.tabId) || typeof target.documentId!=="string" || !target.documentId)throw new Error("缺少原聊天标签标识，请回到聊天后点击继续。");
      let deadline;
      try {
        const rows=await Promise.race([browser.scripting.executeScript({target:{tabId:target.tabId,documentIds:[target.documentId]},world:"MAIN",func,args}),
          new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error()),8000);})]);
        const row=rows.find(r=>r.frameId===0);
        if(!row || row.error || row.documentId!==target.documentId)throw new Error();
        return row.result;
      } catch {throw Object.assign(new Error("原聊天标签已关闭、刷新或无法访问，请回到原聊天后点击继续。"),{code:"target_unavailable"});}
      finally {clearTimeout(deadline);}
    }
    function identity(){return {url:location.href,title:document.title};}
    return {identity:t=>invoke(t,identity,[]),install:(t,key,cid)=>invoke(t,R.installInPage,[key,cid]),
      command:(t,key,command,args=[])=>invoke(t,R.commandInPage,[key,command,args])};
  }
  function create({store,transport:T,core:C,organize:O,clock=globalThis,crypto=globalThis.crypto,alarms,badge=()=>{},locks=globalThis.navigator?.locks}) {
    let current=null,starting=false,ready=null,ephemeralFailure=null;
    const now=()=>new Date().toISOString(),clone=value=>structuredClone(value);
    const sha=async text=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,"0")).join("");
    const alive=p=>current===p && !p.cancelled;
    function log(record,text){record.detail=text;record.background_log=[...(record.background_log||[]),`${now()}  ${text}`].slice(-35);}
    async function acquire(){
      if(!locks)return ()=>{};
      return new Promise((resolve,reject)=>{locks.request("chat-backup-active-collector",{ifAvailable:true},async lock=>{
        if(!lock){reject(new Error("另一个备份入口正在采集，请先在那里暂停。"));return;}
        await new Promise(release=>resolve(release));
      }).catch(()=>reject(new Error("无法取得后台采集锁，请稍后重试。")));});
    }
    function sleep(p,ms){return new Promise(resolve=>{p.wake=resolve;p.timer=clock.setTimeout(()=>{p.timer=null;p.wake=null;resolve();},ms);});}
    function cancel(p){p.cancelled=true;clock.clearTimeout(p.timer);p.wake?.();p.wake=null;}
    async function dispose(p){try{await T.command(p.job.target,p.job.reader_key,"dispose");}catch{} }
    function changed(record,active){Promise.resolve(badge(record,active)).catch(()=>{});}
    async function status(){
      const job=await store.getJob();let record=job?.session_id ? await store.getSession(job.session_id) : null;
      if(record?.deleted)record=null;
      if(ephemeralFailure && ephemeralFailure.record.id===record?.id)record=ephemeralFailure.record;
      if(record){record=clone(record);delete record.message_hashes;}
      return {active:job?.state==="running" && !ephemeralFailure && !!record,session:record,has_unsaved_response:!!ephemeralFailure?.entry};
    }
    async function hydrate(record){
      record.message_hashes ||= {};record.version_ids ||= [];record.empty_text_ids ||= [];record.seen_start_cursors ||= [];
      record.reading_count ||= 0;record.auxiliary_count ||= 0;record.message_count_profile="reading-v1";
      const entries=await store.pages(record.id);
      if(!entries.length){if(record.page_count)throw new Error("检查点缺少原始响应，已停止恢复。");return {record,last:null};}
      if(!record.page_count && !entries.some(e=>e.accepted && ["head","previous","mapping"].includes(e.kind)))return {record,last:null};
      const schema=record.mode==="mapping" ? "chat-export-observed-mapping/v1" : "chat-export-capture/v1";
      const prepared=await O.prepare({schema,conversation_id:record.conversation_id,title:record.title,capture:record,pages:entries});
      const messages=new Map();let last=null;
      for(const entry of entries){if(!entry.accepted || !["head","previous","mapping"].includes(entry.kind))continue;
        const page=JSON.parse(entry.response.body_text);
        for(const m of page.messages || Object.values(page.mapping).map(n=>n.message).filter(Boolean))messages.set(m.id,m);
        if(entry.sequence===record.last_page_sequence)last=page;
      }
      const hashes={};for(const m of messages.values())hashes[m.id]=await sha(C.stable(C.payload(m)));
      if(messages.size!==record.record_count)throw new Error("记录计数与原始响应不一致，已停止恢复。");
      record.message_hashes=hashes;record.reading_count=[...messages.values()].filter(O.readingRecord).length;
      record.auxiliary_count=messages.size-record.reading_count;record.message_count_profile="reading-v1";
      if(last)record.history_has_previous=last.page_info.has_previous_page;
      if(record.mode!=="mapping" && record.page_count && !last)throw new Error("找不到最后一个有效分页检查点。");
      return {record,last,prepared};
    }
    async function launch(record,target,recoveredJob=null){
      if(starting || current || ephemeralFailure)throw new Error("已有后台任务或尚未保存的响应，请先处理当前任务。");
      starting=true;let release;
      try {
        release=await acquire();
        const info=await T.identity(target);
        if(C.conversationFromPage(info.url)!==record.conversation_id)throw new Error("原标签已不是这份记录所属的聊天。");
        const hydrated=await hydrate(record);
        const job={id:"active",session_id:record.id,conversation_id:record.conversation_id,target:clone(target),run_id:crypto.randomUUID(),
          reader_key:"__chat_backup_reader_"+crypto.randomUUID(),state:"running",started_at:now()};
        record.state="waiting";record.background_runner=true;
        if(!recoveredJob){record.background_retry_count=0;record.background_retry_url=null;record.background_next_attempt_at=0;}
        log(record,recoveredJob ? "后台已恢复，正在复核首页后接着采集。" : "后台采集已启动，可以关闭侧栏；请保留原聊天标签。");
        await alarms.create(ALARM,{periodInMinutes:1});
        await store.claim(job,record,recoveredJob?.run_id || null);
        const p={job,record,last:hydrated.last,release,cancelled:false,timer:null};current=p;release=null;
        if(recoveredJob?.reader_key)try{await T.command(target,recoveredJob.reader_key,"dispose");}catch{}
        changed(record,true);
        // Never return the long-running loop from a runtime message listener.
        p.task=run(p).catch(error=>error.code==="target_unavailable" ? finish(p,"paused",error.message) : fail(p,error.message)).finally(async()=>{
          await dispose(p);p.release();if(current===p)current=null;
        });
        return status();
      } catch(error){if(!current)await alarms.clear(ALARM).catch(()=>{});throw error;}
      finally {starting=false;release?.();}
    }
    async function start(target,cid,title){
      C.checkId(cid);
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务，重新打开侧栏即可查看。");
      const record={id:crypto.randomUUID(),title:String(title || "聊天").slice(0,500),conversation_id:cid,mode:"pagination",creator_version:VERSION,
        started_at:now(),state:"waiting",next_sequence:0,page_count:0,record_count:0,last_page_sequence:null,head_signature:null,
        message_hashes:{},version_ids:[],empty_text_ids:[],seen_start_cursors:[],reading_count:0,auxiliary_count:0,message_count_profile:"reading-v1",
        checks:{all_history_branches_verified:false,complete_current_server_conversation:false,official_export_equivalent:false}};
      return launch(record,target);
    }
    async function resume(id,target){
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务，无需再次点击继续。");
      const record=await store.getSession(id);
      if(!record || record.deleted || !["pagination","mapping",undefined].includes(record.mode))throw new Error("所选记录不能继续后台采集。");
      if(["route_complete","mapping_complete"].includes(record.state))throw new Error("这份记录已经完成。");
      return launch(record,target);
    }
    async function finish(p,state,message,entry=null,record=null){
      if(!alive(p))return false;
      cancel(p);
      await alarms.clear(ALARM).catch(()=>{});
      // A response transaction already in flight may have committed since pause was clicked.
      // Read after cancellation so pausing cannot roll the checkpoint back over that response.
      let draft=record;
      if(!draft){try{draft=await store.getSession(p.record.id);}catch{} }
      draft ||= clone(p.record);draft.state=state;log(draft,message);
      try {
        const saved=await store.write(p.job.run_id,draft,entry,state);
        if(saved){p.record=draft;changed(draft,false);}return saved;
      } catch {
        ephemeralFailure={record:{...draft,state:"error",detail:"本机保存失败；请重新打开侧栏下载现有数据及暂存响应。"},entry};
        changed(ephemeralFailure.record,false);return false;
      } finally {await dispose(p);}
    }
    async function fail(p,message,entry=null,record=null){return finish(p,"error",message || "后台读取失败，现有数据保留。",entry,record);}
    async function pause(id,message="用户暂停后台采集；已保存的分页可继续或下载。"){
      const job=await store.getJob();
      if(!job || job.state!=="running" || (id && job.session_id!==id))return status();
      if(current?.job.run_id===job.run_id){
        const p=current;await finish(p,"paused",message);await p.task;
      } else {
        const record=await store.getSession(job.session_id);
        if(record && !record.deleted){record.state="paused";log(record,message);await store.write(job.run_id,record,null,"paused");changed(record,false);}
        await alarms.clear(ALARM);
        if(job.reader_key)try{await T.command(job.target,job.reader_key,"dispose");}catch{}
      }
      return status();
    }
    async function restore(){
      if(starting || current || ephemeralFailure)return status();
      const job=await store.getJob();
      if(job?.state!=="running"){await alarms.clear(ALARM);return status();}
      const record=await store.getSession(job.session_id);
      if(!record || record.deleted){await alarms.clear(ALARM);return status();}
      if(!await alarms.get(ALARM)){await pause(job.session_id,"后台任务曾中断，已保留检查点。请回到原聊天后点击继续。");return status();}
      // Only the exact original document may resume automatically; never search other tabs.
      try {return await launch(record,job.target,job);}
      catch {await pause(job.session_id,"原聊天标签已关闭、刷新或后台恢复失败。已保留检查点，请回到原聊天后点击继续。");return status();}
    }
    async function read(p,url){
      const id=crypto.randomUUID(),key=p.job.reader_key,startedAt=Date.now();
      const start=await T.command(p.job.target,key,"start",[id,url]);
      if(!alive(p))return null;
      if(!start?.ok)throw new Error("后台读取连接已中断，现有数据保留。可回到原聊天后点击继续。");
      while(alive(p)){
        if(Date.now()-startedAt>65000)throw new Error("后台读取超时，检查点已保留；请回到原聊天后点击继续。");
        const value=await T.command(p.job.target,key,"poll",[id]);
        if(!alive(p))return null;
        if(value?.state==="pending"){await sleep(p,300);continue;}
        if(value?.state==="done"){
          if(value.url!==url || typeof value.body_text!=="string" || !Number.isInteger(value.status))throw new Error("后台响应与当前请求不一致。");
          await T.command(p.job.target,key,"ack",[id]);return alive(p)?value:null;
        }
        const codes=["session_http","login_required","session_format","page_changed","wrong_page","request_timeout","network_error","response_too_large","reader_missing"];
        p.record.direct_read_failure={code:codes.includes(value?.code)?value.code:"reader_missing"};
        if(Number.isInteger(value?.http_status))p.record.direct_read_failure.http_status=value.http_status;
        if(["page_changed","wrong_page"].includes(value?.code))throw Object.assign(new Error("原聊天已切换，后台已暂停。回到原聊天后可点击继续。"),{code:"target_unavailable"});
        if(value?.code==="session_http")throw new Error(`登录读取返回 HTTP ${value.http_status || 0}，已停止，不会反复重试被拒绝的请求。`);
        if(["login_required","session_format"].includes(value?.code))throw new Error("当前页面未提供可用登录状态，已停止；登录响应未保存。");
        throw new Error("后台读取中断、超时或原聊天发生变化。已保留数据，可回到原聊天后点击继续。");
      }
      return null;
    }
    async function entry(p,response,kind,accepted,rejection=null){return {session_id:p.record.id,sequence:p.record.next_sequence,kind,accepted,
      request:{method:"GET",url:C.safeRequestURL(response.url),transport:"page_fetch"},
      response:{status:response.status,received_at:now(),body_sha256:await sha(response.body_text),body_text:response.body_text},
      validation:{parent_page_sequence:kind==="previous"?p.record.last_page_sequence:null,
        recheck_of_sequence:kind==="mapping_recheck"?p.record.mapping_page_sequence:null,rejection,all_history_branches_verified:false}};}
    async function save(p,draft,e,terminal=null){
      if(!alive(p))return false;
      if(terminal)return finish(p,terminal,draft.detail,e,draft);
      try {
        const ok=await store.write(p.job.run_id,draft,e);
        if(!ok){cancel(p);return false;}p.record=draft;changed(draft,true);return true;
      } catch {await fail(p,"本机保存失败，已停止后台请求。请下载现有记录。",e,draft);return false;}
    }
    async function run(p){
      const installed=await T.install(p.job.target,p.job.reader_key,p.record.conversation_id);
      if(!alive(p))return;if(!installed?.ok)throw new Error("无法连接原聊天标签，后台任务已停止。");
      let head=true;
      while(alive(p)){
        const cid=p.record.conversation_id;
        if(!head && p.record.page_count>=2000){await finish(p,"paused","已达到 2,000 页保护上限，请先核对现有数据。");return;}
        const url=head?C.pagedHeadURL(cid):C.requestURL(cid,C.inspectPage(p.last,cid).start);
        while(alive(p) && p.record.background_retry_url===url && p.record.background_next_attempt_at>Date.now()){
          await sleep(p,Math.min(10000,p.record.background_next_attempt_at-Date.now()));
          if(alive(p) && C.conversationFromPage((await T.identity(p.job.target)).url)!==cid)throw new Error("原聊天标签已改变。");
        }
        if(!alive(p))return;
        const response=await read(p,url);if(!response || !alive(p))return;
        if(response.body_text.length>32*1024*1024)throw new Error("单页响应超过保护上限，后台已停止。");
        if(response.status!==200){
          const attempt=p.record.background_retry_url===url ? p.record.background_retry_count || 0 : 0;
          if(![401,403].includes(response.status) && [0,408,429,500,502,503,504].includes(response.status) && attempt<3){
            const retryAfter=(response.headers||[]).find(h=>h.name.toLowerCase()==="retry-after")?.value;
            const draft=clone(p.record);draft.background_retry_url=url;draft.background_retry_count=attempt+1;draft.background_next_attempt_at=Date.now()+C.retryDelay(attempt,retryAfter);
            log(draft,`分页暂时返回 HTTP ${response.status}，稍后重试当前页。`);
            if(!await save(p,draft,null))return;continue;
          }
          const e=await entry(p,response,"request_failed",false,`http_${response.status}`),draft=clone(p.record);draft.next_sequence++;
          draft.last_failure=C.failureMetadata({request:{url,method:"GET"},response:{status:response.status,headers:response.headers}},cid);
          draft.failures=[...(draft.failures||[]),draft.last_failure];
          await fail(p,`读取返回 HTTP ${response.status}，后台已停止并保留错误响应。`,e,draft);return;
        }
        let page,e,kind=head?"head_rejected":"previous_rejected",draft=clone(p.record),terminal=null;
        if(draft.background_retry_url===url){draft.background_retry_count=0;draft.background_retry_url=null;draft.background_next_attempt_at=0;}
        try {
          page=JSON.parse(response.body_text);
          if(head && (page?.mapping || p.record.mode==="mapping")){
            if(p.record.head_signature)throw new Error("响应从分页变成了结构，已停止，避免混合数据。");
            const info=C.inspectFullConversation(page,cid),signature=await sha(C.fullSignatureInput(page));
            kind=p.record.mapping_signature?"mapping_recheck":"mapping";
            if(p.record.mapping_signature && p.record.mapping_signature!==signature)throw new Error("两次结构内容不一致，已保留响应供核对。");
            e=await entry(p,response,kind,true);draft.next_sequence++;
            if(kind==="mapping"){
              const messages=Object.values(page.mapping).map(n=>n.message).filter(Boolean);
              Object.assign(draft,{mode:"mapping",mapping_signature:signature,mapping_page_sequence:e.sequence,mapping_structure:info,
                record_count:info.messages,branch_points:info.branch_points,empty_text_ids:info.empty_text_ids,page_count:draft.page_count+1,
                reading_count:messages.filter(O.readingRecord).length,auxiliary_count:messages.filter(m=>!O.readingRecord(m)).length,message_count_profile:"reading-v1",state:"verifying"});
              log(draft,"消息结构已保存，正在重新读取复核。");
            } else {terminal="mapping_complete";log(draft,"消息结构两次读取一致；历史分支是否完整仍需另行核对。");}
          } else {
            const info=C.inspectPage(page,cid);
            if(head){
              if(info.next || (page.current_node!=null && page.current_node!==info.end))throw new Error("首页不是当前聊天的最新一页。");
              kind=p.record.head_signature?"head_recheck":"head";
              if(kind==="head_recheck" && await sha(C.headSignatureInput(page))!==p.record.head_signature)throw new Error("聊天首页已经变化，已停止。请新建采集，现有原文保留。");
            } else {kind="previous";C.validatePair(p.last,page,cid,url,draft.seen_start_cursors);}
            e=await entry(p,response,kind,true);draft.next_sequence++;
            if(kind!=="head_recheck"){
              for(const m of page.messages){
                const hash=await sha(C.stable(C.payload(m))),old=draft.message_hashes[m.id];
                if(old && old!==hash)throw new Error("同一消息 ID 出现不同正文，已停止以免混合分支。");
                if(!old){if(O.readingRecord(m))draft.reading_count++;else draft.auxiliary_count++;}
                draft.message_hashes[m.id]=hash;
              }
              draft.record_count=Object.keys(draft.message_hashes).length;
              draft.version_ids=[...new Set([...draft.version_ids,...page.messages.filter(m=>m.metadata?.has_versions===true).map(m=>m.id)])];
              draft.empty_text_ids=[...new Set([...draft.empty_text_ids,...C.emptyTextIds(page.messages)])];
              draft.seen_start_cursors.push(info.start);draft.page_count++;draft.last_page_sequence=e.sequence;draft.history_has_previous=info.previous;
              if(kind==="head")draft.head_signature=await sha(C.headSignatureInput(page));
              draft.state=info.previous?"running":"verifying";
              log(draft,`后台已保存 ${draft.page_count} 页、${draft.record_count} 条记录。${info.previous?"继续读取更早消息。":"正在进行结束复核。"}`);
            } else if(p.last && !C.inspectPage(p.last,cid).previous){
              terminal="route_complete";log(draft,"当前路线已到最早页，结束复核通过。历史分支和空正文仍需另行核对。");
            } else {draft.state="running";log(draft,"首页复核一致，继续读取未完成的分页。");}
          }
        } catch(error){
          e=await entry(p,response,kind,false,error.code || "validation_failed");draft=clone(p.record);draft.next_sequence++;
          await fail(p,error.message || "响应校验失败，已保留原文。",e,draft);return;
        }
        if(!await save(p,draft,e,terminal) || !alive(p))return;
        if(["head","previous"].includes(kind))p.last=page;
        head=p.record.mode==="mapping" || !C.inspectPage(p.last,cid).previous;
        await sleep(p,head?0:350);
      }
    }
    async function targetChanged(tabId){const job=await store.getJob();if(job?.state==="running" && job.target.tabId===tabId)await pause(job.session_id,"原聊天标签已关闭、刷新或跳转，后台已暂停。回到原聊天后可继续。");}
    async function prepareSleep(){
      const result=await pause(undefined,"插件已休眠；检查点已保存，重新打开后可点击继续。");
      if(ephemeralFailure)throw new Error("还有未成功保存的状态或响应，请先下载原始 JSON，再处理休眠。现有数据没有清除。");
      if((await store.getJob())?.state==="running")throw new Error("后台任务尚未安全停止，请稍后重试。");
      await alarms.clear(ALARM);
      return result;
    }
    return {start,resume,pause,status,restore,targetChanged,prepareSleep,alarmName:ALARM,
      pending:async id=>ephemeralFailure && ephemeralFailure.record.id===id ? clone(ephemeralFailure.entry) : null,
      // Used only by a worker shutdown/restart test; unloading a UI never calls it.
      shutdown:()=>{if(current){cancel(current);current.release();current=null;}},
      boot:()=>ready || (ready=restore())};
  }
  return {create,transport,VERSION,ALARM};
});
