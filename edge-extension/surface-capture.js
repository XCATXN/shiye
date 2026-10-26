(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupSurfaceCapture=Object.freeze(api);})(globalThis,function(){
  "use strict";
  const ALARM="chat-backup-active-job",VERSION="0.9.0";
  function create({store,read,core:S,platforms:P,alarms,clock=globalThis,crypto=globalThis.crypto,locks=globalThis.navigator?.locks,badge=()=>{}}){
    let current=null,starting=false,ready=null,unsaved=null;
    const clone=v=>structuredClone(v),now=()=>new Date().toISOString(),alive=p=>current===p&&!p.cancelled;
    function log(r,text){r.detail=text;r.background_log=[...(r.background_log||[]),`${now()}  ${text}`].slice(-35);}
    const changed=(r,active)=>{Promise.resolve(badge(r,active)).catch(()=>{});};
    async function status(){const job=await store.getJob();let r=job?.session_id?await store.getSession(job.session_id):null;if(r?.deleted)r=null;if(unsaved&&unsaved.record.id===r?.id)r=unsaved.record;
      return {active:job?.state==="running"&&!unsaved&&!!r,session:r?clone(r):null,has_unsaved_response:!!unsaved};}
    function cancel(p){p.cancelled=true;clock.clearTimeout(p.timer);p.wake?.();p.wake=null;}
    function sleep(p,ms){return new Promise(resolve=>{p.wake=resolve;p.timer=clock.setTimeout(()=>{p.timer=null;p.wake=null;resolve();},ms);});}
    function acquire(){if(!locks)return Promise.resolve(()=>{});return new Promise((resolve,reject)=>{
      locks.request("chat-backup-active-collector",{ifAvailable:true},async lock=>{if(!lock){reject(new Error("另一个备份入口正在采集，请先暂停。"));return;}await new Promise(release=>resolve(release));}).catch(reject);
    });}
    async function restorePosition(p){if(p.originalTop!=null)try{await read(p.job.target,p.expected,"restore",p.originalTop);}catch{} }
    async function finish(p,state,message,entry=null,draft=null){
      if(!alive(p))return;cancel(p);await alarms.clear(ALARM).catch(()=>{});
      draft ||= await store.getSession(p.record.id);draft ||= clone(p.record);draft.state=state;log(draft,message);
      try{if(await store.write(p.job.run_id,draft,entry,state)){p.record=draft;changed(draft,false);}}
      catch{unsaved={record:{...draft,state:"error",detail:"本机保存失败，请先下载原始 JSON。"},entry};changed(unsaved.record,false);}
      await restorePosition(p);
    }
    async function hydrate(record){
      const entries=await store.pages(record.id),index=S.empty();let initialTail=null,topSeen=false,lastSignature=null;
      for(const entry of entries){
        if(await S.sha(entry.response.body_text)!==entry.response.body_sha256)throw new Error("保存的网页快照校验失败，不能继续。");
        if(!entry.accepted)continue;
        const page=S.validate(JSON.parse(entry.response.body_text),record);initialTail ||= S.tail(page);topSeen ||= page.position.at_top;
        S.merge(index,page,entry.sequence);lastSignature=S.signature(page);
      }
      if(index.nodes.length!==(record.record_count||0))throw new Error("已保存网页消息与统计不一致，已停止恢复。");
      return {index,initialTail,topSeen,lastSignature};
    }
    async function launch(record,target,recovered=null){
      if(current||starting||unsaved)throw new Error("已有任务或未保存的响应，请先处理。");starting=true;let release;
      try{
        release=await acquire();
        const expected=P.identify(record.source_url);
        if(!P.isSurface(expected)||expected.provider_id!==record.provider_id||expected.conversation_id!==record.conversation_id)throw new Error("平台或聊天标识不一致。");
        await read(target,expected,"identity");const history=await hydrate(record);
        const job={id:"active",session_id:record.id,conversation_id:record.conversation_id,provider_id:record.provider_id,target:clone(target),run_id:crypto.randomUUID(),state:"running",started_at:now()};
        record.state="waiting";record.scan_phase="seek_end";record.background_runner=true;
        log(record,"网页正文采集已启动，可关闭侧栏；将自动滚动原聊天。完整性待核对。");
        await alarms.create(ALARM,{periodInMinutes:1});await store.claim(job,record,recovered?.run_id||null);
        const p={job,record,expected,...history,release,cancelled:false,timer:null,originalTop:null,steps:0};current=p;release=null;changed(record,true);
        p.task=run(p).catch(error=>finish(p,"error",error.message)).finally(()=>{p.release();if(current===p)current=null;});
        return status();
      }catch(error){if(!current)await alarms.clear(ALARM).catch(()=>{});throw error;}
      finally{release?.();starting=false;}
    }
    async function start(target,cid,title,options){
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务。");
      const expected=P.identify(options?.source_url);
      if(expected.provider_id!==options?.provider_id||expected.conversation_id!==cid||!P.isSurface(expected))throw new Error("网页采集目标不一致。");
      const record={id:crypto.randomUUID(),title:String(title||expected.provider_name).slice(0,500),conversation_id:cid,source_url:expected.source_url,
        provider_id:expected.provider_id,mode:"surface",creator_version:VERSION,started_at:now(),state:"waiting",next_sequence:0,page_count:0,record_count:0,
        reading_count:0,auxiliary_count:0,message_count_profile:"reading-v1",version_ids:[],empty_text_ids:[],scan_phase:"seek_end",
        checks:{capture_source:"rendered_page",server_history_verified:false,all_history_branches_verified:false,official_export_equivalent:false}};
      return launch(record,target);
    }
    async function resume(id,target){
      if((await store.getJob())?.state==="running")throw new Error("后台已有采集任务。");
      const record=await store.getSession(id);if(!record||record.deleted||record.mode!=="surface"||record.state==="surface_complete")throw new Error("所选记录不能继续网页采集。");
      return launch(record,target);
    }
    async function snapshot(p){
      for(let attempt=0;attempt<10;attempt++){
        try{return await read(p.job.target,p.expected,"snapshot");}
        catch(error){if(!alive(p))return null;if(!error.message.includes("尚未识别")||attempt===9)throw error;await sleep(p,1000);}
      }
    }
    async function saveSnapshot(p,result,kind="surface",force=false){
      if(!alive(p)||!result)return null;
      const entry={session_id:p.record.id,sequence:p.record.next_sequence,kind,accepted:true,
        request:{method:"DOM",url:p.expected.source_url},response:{body_text:result.body_text,body_sha256:await S.sha(result.body_text),received_at:now(),format:"rendered_page"}};
      if(!alive(p))return null;
      let page;
      try{
        page=S.validate(JSON.parse(result.body_text),p.expected);
        S.checkMotion(p.lastView,page);p.lastView=page;
        const sig=S.signature(page),newTop=page.position.at_top&&!p.topSeen;
        if(!force && !newTop && sig===p.lastSignature)return page;
        if(!p.initialTail){if(!page.position.at_bottom)throw new Error("网页末尾尚未稳定，请稍后再试。");p.initialTail=S.tail(page);}
        S.merge(p.index,page,entry.sequence);
        if((page.position.at_bottom&&S.fingerprint(page.messages.at(-1))!==p.initialTail.at(-1)) ||
          (p.index.orderingUnique&&!S.tailMatches(p.index,p.initialTail)))throw new Error("网页末尾已变化，已停止；请等待聊天稳定后重新采集。");
        p.topSeen ||= page.position.at_top;
        if(kind==="surface_recheck" && (!p.topSeen||!page.position.at_bottom))throw new Error("网页扫描没有到达首尾边界。");
        if(kind==="surface_recheck" && !p.index.orderingUnique)throw new Error("网页片段的顺序仍有歧义，已停止；请保留原始 JSON 复核。");
        const draft={...p.record,...S.counts(p.index),next_sequence:p.record.next_sequence+1,
          page_count:p.record.page_count+(kind==="surface"?1:0),state:kind==="surface_recheck"?"surface_complete":"running"};
        draft.checks={...draft.checks,webpage_top_observed:p.topSeen,webpage_scan_finished:kind==="surface_recheck"};
        log(draft,kind==="surface_recheck"?"网页扫描结束，正文完整性仍待核对；这不是官方全量导出。":`已保存 ${draft.record_count} 条网页记录，正在扫描并核对顺序。`);
        if(kind==="surface_recheck")await finish(p,"surface_complete",draft.detail,entry,draft);
        else {
          try{if(!await store.write(p.job.run_id,draft,entry)){cancel(p);return null;}p.record=draft;p.lastSignature=sig;changed(draft,true);}
          catch{await finish(p,"error","本机保存失败，请先下载原始 JSON。",entry,draft);}
        }
      }catch(error){
        entry.accepted=false;entry.validation={rejection:error.message};
        const draft={...p.record,next_sequence:p.record.next_sequence+1};await finish(p,"error",error.message,entry,draft);return null;
      }
      return page;
    }
    async function run(p){
      const moved=await read(p.job.target,p.expected,"bottom");p.originalTop=moved.previous_position?.top;
      let page=null;
      for(let i=0;alive(p)&&i<10;i++){
        await sleep(p,800);const result=await snapshot(p);if(!alive(p))return;
        if(result?.position.at_bottom){page=await saveSnapshot(p,result,"surface",true);break;}
        await read(p.job.target,p.expected,"bottom");
      }
      if(!alive(p))return;
      if(!page){await finish(p,"error","未能稳定定位网页末尾，请等待页面载入后继续。");return;}
      let phase="up",stable=0,prior=null;
      while(alive(p)){
        if(++p.steps>2000){await finish(p,"paused","网页扫描达到保护上限，已保存部分可导出或继续。");return;}
        p.record.scan_phase=phase;
        const edge=phase==="up"?page.position.at_top:page.position.at_bottom;
        if(edge){
          const key=S.signature(page)+":"+page.position.height;
          stable=key===prior?stable+1:1;prior=key;
          if(stable>=3){
            if(phase==="down"){
              const final=await snapshot(p);if(alive(p))await saveSnapshot(p,final,"surface_recheck",true);return;
            }
            phase="down";stable=0;prior=null;
          }
        }else{stable=0;prior=null;await read(p.job.target,p.expected,phase);}
        await sleep(p,800);if(!alive(p))return;
        const result=await snapshot(p);page=await saveSnapshot(p,result);if(!page||!alive(p))return;
      }
    }
    async function pause(id,message="用户暂停网页采集；已保存部分可整理、下载或继续。"){
      const job=await store.getJob();if(!job||job.state!=="running"||(id&&id!==job.session_id))return status();
      if(current?.job.run_id===job.run_id){const p=current;await finish(p,"paused",message);await p.task;}
      else{const record=await store.getSession(job.session_id);if(record&&!record.deleted){record.state="paused";log(record,message);await store.write(job.run_id,record,null,"paused");}await alarms.clear(ALARM);}
      return status();
    }
    async function restore(){
      if(current||starting||unsaved)return status();const job=await store.getJob();
      if(job?.state!=="running"){await alarms.clear(ALARM);return status();}
      const record=await store.getSession(job.session_id);if(!record||record.deleted){await alarms.clear(ALARM);return status();}
      if(!await alarms.get(ALARM))return pause(job.session_id,"后台任务曾中断，已保留网页快照，请打开原聊天后继续。");
      try{return await launch(record,job.target,job);}catch{return pause(job.session_id,"原聊天页面无法恢复，已保留网页快照；请回到原聊天后继续。");}
    }
    async function prepareSleep(){const result=await pause(undefined,"插件已休眠，网页采集检查点已保留。");if(current)await current.task;if(unsaved||(await store.getJob())?.state==="running")throw new Error("还有未保存数据或未停止的任务，请先下载原始 JSON。");await alarms.clear(ALARM);return result;}
    return {start,resume,pause,status,restore,prepareSleep,boot:()=>ready||(ready=restore()),
      pending:async id=>unsaved?.record.id===id?clone(unsaved.entry):null,
      shutdown:()=>{if(current){cancel(current);current.release();current=null;}}};
  }
  return {create,ALARM,VERSION};
});
