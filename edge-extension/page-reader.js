(function(root,factory){
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChatBackupPageReader = Object.freeze(api);
})(typeof globalThis === "object" ? globalThis : this,function(){
  "use strict";
  // This function runs inside the selected ChatGPT page. Credentials stay in its
  // closure; only conversation responses or fixed error codes can leave it.
  function installInPage(key,cid) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    function samePage() {
      try {
        const u = new URL(location.href), m = u.pathname.match(/\/c\/([0-9a-f-]+)\/?$/i);
        return u.origin === "https://chatgpt.com" && !u.username && !u.password && m && m[1].toLowerCase() === cid.toLowerCase();
      } catch { return false; }
    }
    function allowed(url) {
      try {
        const u = new URL(url);
        if (u.origin !== "https://chatgpt.com" || u.username || u.password || u.hash) return false;
        const head = u.pathname === `/backend-api/conversations/${cid}`;
        const previous = u.pathname === `/backend-api/conversations/${cid}/messages`;
        if (!head && !previous) return false;
        const params = [...u.searchParams];
        return params.length === (head ? 2 : 3) && new Set(params.map(p=>p[0])).size === params.length &&
          u.searchParams.get("include_has_versions") === "true" && u.searchParams.get("num_turns") === "10" &&
          (head || uuid.test(u.searchParams.get("before") || ""));
      } catch { return false; }
    }
    if (!uuid.test(cid) || !/^__chat_backup_reader_[0-9a-f-]+$/i.test(key) || !samePage()) return {ok:false,code:"wrong_page"};
    if (Object.prototype.hasOwnProperty.call(globalThis,key)) return {ok:false,code:"reader_collision"};
    let accessToken = null, job = null, disposed = false, idleTimer = null;
    function dispose() {
      disposed = true; accessToken = null;
      clearTimeout(idleTimer);
      if (job) { job.controller.abort(); clearTimeout(job.timeout); job.result = null; }
      job = null;
      delete globalThis[key];
      return {ok:true};
    }
    function idle() { clearTimeout(idleTimer); idleTimer = setTimeout(dispose,120000); }
    function current(j) { return !disposed && job === j && !j.controller.signal.aborted && samePage(); }
    function fail(j,code,status) {
      if (disposed || job !== j) return;
      j.state = "failed"; j.result = {state:"failed",code};
      if (Number.isInteger(status)) j.result.http_status = status;
    }
    async function run(j) {
      try {
        if (!current(j)) { fail(j,"page_changed"); return; }
        if (!accessToken) {
          j.phase = "session";
          const response = await fetch("https://chatgpt.com/api/auth/session",{
            method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal:j.controller.signal,
            headers:{Accept:"application/json"}
          });
          if (!current(j)) { fail(j,"page_changed"); return; }
          if (response.status !== 200) { fail(j,"session_http",response.status); return; }
          let value;
          try { value = await response.json(); } catch { fail(j,"session_format"); return; }
          if (!current(j)) { fail(j,"page_changed"); return; }
          if (typeof value?.accessToken !== "string" || !value.accessToken.trim() ||
              value.accessToken.length > 65536 || /[\r\n]/.test(value.accessToken)) { fail(j,"login_required"); return; }
          accessToken = value.accessToken;
        }
        if (!current(j)) { fail(j,"page_changed"); return; }
        j.phase = "conversation";
        const response = await fetch(j.url,{
          method:"GET",credentials:"same-origin",cache:"no-store",redirect:"error",signal:j.controller.signal,
          headers:{Accept:"application/json",Authorization:"Bearer "+accessToken}
        });
        if (!current(j)) { fail(j,"page_changed"); return; }
        const raw = await response.text();
        if (!current(j)) { fail(j,"page_changed"); return; }
        if (raw.length > 32*1024*1024) { fail(j,"response_too_large"); return; }
        const headers = [];
        for (const name of ["content-type","retry-after","x-request-id","cf-mitigated"]) {
          const value = response.headers.get(name);
          if (value !== null) headers.push({name,value});
        }
        j.state = "done";
        j.result = {state:"done",url:j.url,status:response.status,headers,body_text:raw};
        if ([401,403].includes(response.status)) accessToken = null;
      } catch {
        // Never expose thrown messages or session bodies: they can contain secrets.
        if (job === j && j.state === "pending") fail(j,samePage() ? "network_error" : "page_changed");
      } finally {
        clearTimeout(j.timeout);
        if (!disposed && job === j) idle();
      }
    }
    const api = {
      start(id,url) {
        if (disposed || !samePage()) return {ok:false,code:"wrong_page"};
        if (!uuid.test(id) || !allowed(url)) return {ok:false,code:"blocked_request"};
        if (job) return {ok:false,code:"reader_busy"};
        clearTimeout(idleTimer);
        const j = {id,url,state:"pending",phase:"session",controller:new AbortController(),result:null};
        job = j;
        j.timeout = setTimeout(()=>{if(job===j && j.state==="pending"){fail(j,"request_timeout");j.controller.abort();}},45000);
        void run(j);
        return {ok:true};
      },
      poll(id) {
        if (disposed || !job || job.id !== id) return {state:"missing"};
        if (!samePage()) { fail(job,"page_changed"); job.controller.abort(); }
        return job.result || {state:"pending",phase:job.phase};
      },
      ack(id) {
        if (!job || job.id !== id || job.state === "pending") return {ok:false};
        clearTimeout(job.timeout); job.result = null; job = null; idle();
        return {ok:true};
      },
      dispose
    };
    Object.defineProperty(globalThis,key,{value:api,configurable:true});
    idle();
    return {ok:true};
  }
  function installCode(key,cid) { return `(${installInPage.toString()})(${JSON.stringify(key)},${JSON.stringify(cid)})`; }
  // Also passed directly to scripting.executeScript. No string evaluation or CSP relaxation.
  function commandInPage(key,command,args) {
    if (!/^__chat_backup_reader_[0-9a-f-]+$/i.test(key) || !["start","poll","ack","dispose"].includes(command) || !Array.isArray(args))
      return {ok:false,code:"blocked_command"};
    const r=globalThis[key];
    return r ? r[command](...args) : {state:"missing",ok:false,code:"reader_missing"};
  }
  function commandCode(key,command,args=[]) {
    if (!["start","poll","ack","dispose"].includes(command)) throw new Error("Unknown reader command");
    return `(${commandInPage.toString()})(${JSON.stringify(key)},${JSON.stringify(command)},${JSON.stringify(args)})`;
  }
  return {installCode,commandCode,installInPage,commandInPage};
});
