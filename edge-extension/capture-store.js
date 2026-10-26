(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupStore=Object.freeze(api);})(globalThis,function(){
  "use strict";
  function open(indexedDB) {
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open("chat-export-capture-v1",2);let blocked=false;
      request.onupgradeneeded=()=>{
        const db=request.result,has=name=>db.objectStoreNames?.contains(name);
        if(!has("sessions"))db.createObjectStore("sessions",{keyPath:"id"});
        if(!has("pages"))db.createObjectStore("pages",{keyPath:["session_id","sequence"]}).createIndex("by_session","session_id");
        if(!has("jobs"))db.createObjectStore("jobs",{keyPath:"id"});
      };
      request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
      request.onerror=()=>reject(new Error("无法打开本机采集数据库。"));
      request.onblocked=()=>{blocked=true;reject(new Error("请关闭旧版备份面板后重新打开，以完成数据库升级。原记录保留。"));};
    });
  }
  function create(db) {
    function get(store,key){return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error("读取本机记录失败。"));});}
    function pages(id){return new Promise((resolve,reject)=>{const r=db.transaction("pages").objectStore("pages").index("by_session").getAll(id);r.onsuccess=()=>resolve(r.result.sort((a,b)=>a.sequence-b.sequence));r.onerror=()=>reject(new Error("读取原始分页失败。"));});}
    function transaction(action){return new Promise((resolve,reject)=>{
      const tx=db.transaction(["jobs","sessions","pages"],"readwrite");let value=false,reason;
      const stores={jobs:tx.objectStore("jobs"),sessions:tx.objectStore("sessions"),pages:tx.objectStore("pages")};
      tx.oncomplete=()=>resolve(value);
      tx.onerror=tx.onabort=()=>reject(new Error(reason || "本机保存失败，后台已停止后续读取。"));
      action(stores,result=>{value=result;},message=>{reason=message;tx.abort();});
    });}
    function claim(job,session,replacesRun=null){return transaction((s,done,fail)=>{
      const r=s.jobs.get("active");r.onsuccess=()=>{
        if(r.result?.state==="running" && r.result.run_id!==replacesRun){fail("已有后台采集正在运行，请先暂停该任务。");return;}
        if(replacesRun && r.result?.run_id!==replacesRun){fail("后台任务状态已经改变。");return;}
        const existing=s.sessions.get(session.id);existing.onsuccess=()=>{
          if(existing.result?.deleted){fail("这份记录已被删除，不能恢复采集。");return;}
          if(existing.result && existing.result.updated_at!==session.updated_at){fail("记录已在另一个入口更新，请重新选择后继续。");return;}
          session.updated_at=new Date().toISOString();s.sessions.put(session);s.jobs.put(job);done(true);
        };
      };
    });}
    function write(runId,session,entry=null,jobState="running"){return transaction((s,done,fail)=>{
      const r=s.jobs.get("active");r.onsuccess=()=>{
        const job=r.result;
        if(!job || job.run_id!==runId || job.state!=="running" || job.session_id!==session.id)return;
        const existing=s.sessions.get(session.id);existing.onsuccess=()=>{
          if(!existing.result || existing.result.deleted)return;
          if(entry && existing.result.next_sequence!==entry.sequence){fail("保存序号已变化，已阻止重复或旧任务写入。");return;}
          session.updated_at=new Date().toISOString();s.sessions.put(session);
          if(entry)s.pages.add(entry);
          s.jobs.put({...job,state:jobState,updated_at:session.updated_at});done(true);
        };
      };
    });}
    function setSleeping(sleeping){return new Promise((resolve,reject)=>{
      const tx=db.transaction("jobs","readwrite");
      tx.objectStore("jobs").put({id:"power",sleeping:!!sleeping,updated_at:new Date().toISOString()});
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error("无法保存插件休眠状态，界面保留，请稍后重试。"));
    });}
    return {getSession:id=>get("sessions",id),getJob:()=>get("jobs","active"),pages,claim,write,
      getSleeping:async()=>!!(await get("jobs","power"))?.sleeping,setSleeping};
  }
  return {open,create};
});
