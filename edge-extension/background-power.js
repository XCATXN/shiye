(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupPower=Object.freeze(api);})(globalThis,function(){
  "use strict";
  // No database, capture engine, timer or page listener is started at module load.
  function create({openDatabase,storeFor,createRunner,alarms,alarmName,locks=globalThis.navigator?.locks,onSleep=async()=>{},onWake=async()=>{}}){
    let db=null,store=null,runner=null,sleeping=null,booted=false,tail=Promise.resolve();
    function serial(action){const task=tail.then(action);tail=task.catch(()=>{});return task;}
    async function database(){if(!db){db=await openDatabase();store=storeFor(db);}return store;}
    async function isSleeping(){if(sleeping===null)sleeping=await(await database()).getSleeping();return sleeping;}
    function closeDatabase(){db?.close();db=null;store=null;}
    function idleClose(){if(!runner)closeDatabase();}
    async function engine(boot=true){
      if(!runner)runner=createRunner(await database());
      if(boot && !booted){await runner.boot();booted=true;}
      return runner;
    }
    const asleep=()=>({sleeping:true,active:false,session:null,has_unsaved_response:false});
    async function withCollectorStopped(action){
      if(!locks) return action();
      return locks.request("chat-backup-active-collector",{ifAvailable:true},async lock=>{
        if(!lock)throw new Error("另一个 F12 备份入口仍在采集，请先在那里暂停，再关闭插件。");
        return action();
      });
    }
    async function sleep(){
      if(await isSleeping()){idleClose();await onSleep();return asleep();}
      // Do not boot/restart an interrupted job just to stop it.
      await(await engine(false)).prepareSleep();
      return withCollectorStopped(async()=>{
        await alarms.clear(alarmName);
        await(await database()).setSleeping(true); // Commit before unloading any view.
        sleeping=true;runner.shutdown();runner=null;booted=false;closeDatabase();
        await onSleep();return asleep();
      });
    }
    function request(action,fields={}){return serial(async()=>{
      if(action==="sleep")return sleep();
      if(action==="powerStatus"){
        const value={sleeping:await isSleeping()};idleClose();return value;
      }
      if(await isSleeping()){
        idleClose();
        if(action==="status")return asleep();
        throw new Error("插件已休眠，请点击工具栏中的“单聊天备份”图标重新打开。");
      }
      const r=await engine();
      if(action==="status")return {...await r.status(),sleeping:false};
      if(action==="start")return r.start(fields.target,fields.conversation_id,fields.title,{provider_id:fields.provider_id,source_url:fields.source_url,capture_method:fields.capture_method});
      if(action==="resume")return r.resume(fields.session_id,fields.target);
      if(action==="revalidate")return r.revalidate(fields.session_id);
      if(action==="pause")return r.pause(fields.session_id);
      if(action==="pending")return r.pending(fields.session_id);
      throw new Error("不支持的后台操作。");
    });}
    function wake(){return serial(async()=>{
      await(await database()).setSleeping(false);sleeping=false;idleClose();await onWake();
      return {sleeping:false}; // Reopening never resumes a paused capture automatically.
    });}
    function restore(){return serial(async()=>{
      if(await isSleeping()){await alarms.clear(alarmName);idleClose();return asleep();}
      return(await engine()).restore();
    });}
    return {request,wake,restore};
  }
  return {create};
});
