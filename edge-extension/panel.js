"use strict";
const C = ChatBackupCore;
const O = ChatBackupOrganize;
const R = ChatBackupPageReader;
const H = ChatBackupBrowserContext.create(globalThis.chrome,C,R);
const B = ChatBackupClient.create(globalThis.chrome);
const APP_VERSION = "0.9.0";
const P=globalThis.ChatBackupPlatforms;
let targetProvider="chatgpt";
const platformName=id=>P?.name(id)||id||"ChatGPT";
const hasStructured=id=>["claude","deepseek","gemini"].includes(id);
const powerAvailable=!!globalThis.chrome?.runtime?.sendMessage;
let powerSleeping=false;
const $ = id => document.getElementById(id);
let db, session = null, lastPage = null, active = false, processing = false;
let waitingHead = null, expectedURL = null, readerHeaders = null, retryCount = 0;
let timer = null, unsavedEntry = null, uiBusy = false, requestEpoch = 0;
let storageSizes = null, deleteTarget = null, selectionEpoch = 0;
let preparingHead = false, headContext = null;
const observedHeads = [];
let organized = null, exportContextKey = null, exportWorking = false;
let readerMode = "observed", pageReaderKey = null, pageReadTicket = null, pageReadTimer = null;
let actionNotice = null, pendingStop = null, contextEpoch = 0;
let captureLeaseRelease = null;
const MESSAGE_COUNT_PROFILE = "reading-v1";
const UNFINISHED_STATES = ["waiting","running","verifying","full_reading","full_verifying"];
const canOfferDelete = value => C.canDeleteStoredSession(value) || (!!value && !value.deleted && UNFINISHED_STATES.includes(value.state));
let backgroundPoll=null,backgroundSessionId=null,backgroundUnsaved=false,viewClosed=false,backgroundReady=!B.enabled,lastBackgroundError=null;
const labels = {waiting: "等待网页数据", running: "正在采集", paused: "采集已暂停",
  verifying: "正在复核", route_complete: "当前路线采集完成", error: "采集需要复核",
  mapping_complete: "网页结构复核通过",surface_complete:"网页扫描已结束",claude_complete:"会话数据复核通过",provider_complete:"会话数据复核通过",
  full_reading: "正在读取结构", full_verifying: "正在复核结构", full_complete: "结构已保存，待验收",
  diagnosed: "诊断已保存"};
const numberLabel = value => Number(value || 0).toLocaleString("zh-CN");

function note(text) {
  const rows = ($("log").textContent + `\n${new Date().toLocaleTimeString()}  ${text}`).trim().split("\n");
  $("log").textContent = rows.slice(-35).join("\n");
  $("logCount").textContent = Math.min(rows.length,35);
}
function render(detail) {
  const surface=session?.mode==="surface",claude=session?.mode==="claude_api",provider=session?.mode==="provider_api";
  const unfinished = session && !active && !processing && !uiBusy && UNFINISHED_STATES.includes(session.state);
  $("state").textContent = !backgroundReady ? "正在连接后台" : (unfinished ? "这份采集尚未完成" : (session ? (labels[session.state] || session.state) : "等待开始"));
  $("detail").textContent = detail || actionNotice || (unfinished ? "回到对应聊天后点击“继续”，从保存的检查点恢复。现有数据仍可下载。" : session?.detail) || "打开要备份的聊天，点击“采集当前聊天”。";
  $("pages").textContent = numberLabel(session?.next_sequence);
  $("messages").textContent = numberLabel(session?.record_count);
  $("versions").textContent = surface?"—":numberLabel(["full", "mapping","claude_api","provider_api"].includes(session?.mode) ? session.branch_points : session?.version_ids?.length);
  $("rawCountLabel").textContent=surface?"网页快照":"原始响应";
  $("sourceNotice").hidden=!(surface || targetProvider!=="chatgpt");
  $("sourceNotice").textContent=hasStructured(targetProvider)&&$("captureMethod").value!=="surface"?platformName(targetProvider)+" 会话数据采集无需滚动。保留原始响应并复核消息与分页，仍需区分官方全量导出。":"网页正文 · 完整性待核对。将自动滚动原聊天；这不是官方全量导出。";
  $("captureMethodRow").hidden=!hasStructured(targetProvider)||!B.enabled;
  $("captureMethod").disabled=active||processing||uiBusy;
  $("emptyCount").textContent = numberLabel(session?.empty_text_ids?.length);
  const counted=hasMessageCounts(session);
  $("countBreakdown").textContent=counted ? `正文与附件 ${numberLabel(session.reading_count)} 条 · 辅助记录 ${numberLabel(session.auxiliary_count)} 条` :
    "总记录按消息 ID 去重，包含正文、系统、工具及思考等信息。";
  $("pageProgress").textContent=session?.history_has_previous === true ?
    `已保存 ${numberLabel(session.page_count)} 个数据页 · 还有更早消息` :
    (session?.history_has_previous === false ? (session.state === "route_complete" ? "已到最早页 · 结束复核通过" : "已到最早页 · 等待结束复核") : "读取到最早页并完成复核后结束，不按消息数量停止。");
  $("branchLabel").textContent = ["full", "mapping","claude_api","provider_api"].includes(session?.mode) ? (session?.provider_id==="gemini"?"候选分歧":"结构分叉") : "版本标记";
  $("captureBadge").textContent = session?.mode === "diagnostic" ? "仅诊断" : (B.enabled && active ? "后台采集" : "当前路线");
  $("statusCard").dataset.tone = !session ? "idle" : (["route_complete","mapping_complete","full_complete","claude_complete","provider_complete"].includes(session.state) ? "success" :
    (session.state === "error" ? "error" : (active ? "busy" : "warning")));
  $("quality").dataset.warning = session?.empty_text_ids?.length ? "true" : "false";
  $("quality").textContent = session?.mode === "diagnostic" ? "这是错误诊断，不是聊天备份。" : (session?.empty_text_ids?.length ? `发现 ${session.empty_text_ids.length} 条空文本记录，需要与旧档或附件核对。` : "正文与官方参考文件的一致性仍需另行核对。");
  if(surface){
    $("captureBadge").textContent=platformName(session.provider_id)+" · 网页正文";
    $("pageProgress").textContent=session.state==="surface_complete"?"网页首尾扫描及复核已结束，服务端完整历史未验证。":`已保存 ${numberLabel(session.page_count)} 份网页快照 · ${session.scan_phase==="down"?"正在复核消息顺序":"正在加载网页消息"}`;
    $("quality").dataset.warning="true";
    $("quality").textContent="网页正文 · 完整性待核对。"+(session.empty_text_ids?.length?` ${session.empty_text_ids.length} 条正文为空。`:"");
  }
  if(claude){
    $("captureBadge").textContent="Claude · 会话数据";
    $("countBreakdown").textContent=`当前路线正文 ${numberLabel(session.reading_count)} 条 · 辅助 ${numberLabel(session.auxiliary_count)} 条 · 其他分支 ${numberLabel(session.off_route_count)} 条`;
    $("pageProgress").textContent=session.state==="claude_complete"?(session.recheck_source==="stored_responses"?"已存响应重新校验通过 · 本次未访问网页":"已按消息树核对当前路线 · 两次读取一致"):(session.page_count?"原始会话已保存 · 等待第二次读取复核":"直接读取会话数据 · 无需滚动");
    $("quality").textContent="保留接口原始数据；与官方账号全量导出的等价性未验证。"+(session.empty_text_ids?.length?` ${session.empty_text_ids.length} 条正文为空。`:"")+(session.truncated_ids?.length?` ${session.truncated_ids.length} 条带 truncated 标记。`:"");
    if(session.empty_text_ids?.length||session.truncated_ids?.length){$("quality").dataset.warning="true";if(session.state==="claude_complete")$("statusCard").dataset.tone="warning";}
  }
  if(provider){
    $("captureBadge").textContent=platformName(session.provider_id)+" · 会话数据";
    $("countBreakdown").textContent=`正文 ${numberLabel(session.reading_count)} 条 · 辅助 ${numberLabel(session.auxiliary_count)} 条`+(session.off_route_count==null?" · 历史分支范围待核对":` · 其他分支 ${numberLabel(session.off_route_count)} 条`);
    $("pageProgress").textContent=session.state==="provider_complete"?(session.recheck_source==="stored_responses"?"已存响应重新校验通过 · 本次未访问网页":"接口历史边界和首页复核已通过"):`已保存 ${numberLabel(session.page_count)} 份数据 · ${session.history_has_previous?"正在按游标读取更早消息":"等待首页复核"}`;
    $("quality").textContent="会话接口数据 · 与官方全量导出的等价性未验证。"+(session.review_warnings?.length?" "+session.review_warnings.join(" "):"")+(session.empty_text_ids?.length?` ${session.empty_text_ids.length} 条记录没有文本正文。`:"");
    if(session.provider_id==="gemini"||session.review_warnings?.length||session.empty_text_ids?.length){$("quality").dataset.warning="true";if(session.state==="provider_complete")$("statusCard").dataset.tone="warning";}
  }
  $("identity").textContent = session ? `${session.title} · ${session.conversation_id}` : "";
  $("start").disabled = active || processing || uiBusy || !!deleteTarget || !db || !!unsavedEntry || !backgroundReady || backgroundUnsaved;
  $("startFull").disabled = $("start").disabled;
  $("revalidateSaved").hidden=!B.enabled||!(claude||provider)||!session?.next_sequence;
  $("revalidateSaved").disabled=$("start").disabled||!(claude||provider)||!session?.next_sequence;
  $("resume").disabled = active || processing || uiBusy || !!deleteTarget || !!unsavedEntry || !backgroundReady || backgroundUnsaved || !session || session.mode === "diagnostic" || ["route_complete", "mapping_complete", "full_complete","surface_complete","claude_complete","provider_complete"].includes(session.state);
  $("reloadOnce").hidden = !H.hasNetwork || !(active && waitingHead && !expectedURL && !processing && !preparingHead);
  $("reloadOnce").disabled = uiBusy || preparingHead || processing || !active || !waitingHead || !!expectedURL;
  $("pause").disabled = !active || processing || uiBusy || !!deleteTarget;
  $("download").disabled = !session || processing || uiBusy || !!deleteTarget;
  $("sessions").disabled = active || processing || uiBusy || !!deleteTarget;
  $("deleteRecord").disabled = !db || active || processing || uiBusy || !!deleteTarget || !!unsavedEntry || backgroundUnsaved || !canOfferDelete(session);
  $("deleteRecord").title = backgroundUnsaved ? "还有未保存的响应，请先下载原始 JSON。" :
    (active ? "请先暂停正在采集的任务。" : "只删除所选记录在扩展中的本地数据。");
  $("confirmDelete").disabled = uiBusy || !deleteTarget;
  $("cancelDelete").disabled = uiBusy;
  $("sleepPlugin").disabled = !powerAvailable || !db || uiBusy || processing || !!deleteTarget || !!unsavedEntry || backgroundUnsaved || powerSleeping;
  renderStorage();
  renderExport();
}
async function refreshPageContext() {
  if(powerSleeping)return;
  const epoch=++contextEpoch;
  if(session && active) {
    targetProvider=session.provider_id||"chatgpt";$("platformLabel").textContent="采集对象 · "+platformName(targetProvider);
    $("targetTitle").textContent=session.title;
    $("targetHint").textContent=B.enabled ? (active ? "后台正在采集 · 可以关闭此侧栏" :
      (["route_complete","mapping_complete"].includes(session.state) ? "后台采集已完成 · 可整理或下载" : "后台任务已停止 · 已保存的记录保留")) :
      "已锁定此聊天 · 可以切换标签、窗口或应用";
    return;
  }
  try {
    const info=await H.preview();
    if(epoch!==contextEpoch || active)return;
    $("targetTitle").textContent=info.title;
    targetProvider=info.provider_id||"chatgpt";$("platformLabel").textContent="采集对象 · "+platformName(targetProvider);
    $("sourceNotice").hidden=targetProvider==="chatgpt" && session?.mode!=="surface";
    $("targetHint").textContent=session?.conversation_id===info.conversation_id&&["route_complete","mapping_complete","surface_complete","claude_complete","provider_complete"].includes(session.state)?"采集已完成 · 可整理或下载":(targetProvider==="chatgpt"?"点击采集即可开始 · 无需刷新":(hasStructured(targetProvider)&&$("captureMethod").value!=="surface"?"直接读取会话数据 · 无需滚动":"网页正文备用采集 · 将自动滚动原聊天"));
  } catch {
    if(epoch!==contextEpoch || active)return;
    if(session?.background_runner){
      $("targetTitle").textContent=session.title;targetProvider=session.provider_id||"chatgpt";
      $("platformLabel").textContent="上次采集 · "+platformName(targetProvider);
      $("targetHint").textContent=["route_complete","mapping_complete","surface_complete","claude_complete","provider_complete"].includes(session.state)?"后台采集已完成 · 可整理或下载":"后台任务已停止 · 已保存的记录保留";return;
    }
    $("targetTitle").textContent="请选择受支持的 AI 聊天";
    $("targetHint").textContent="已有备份仍可整理、下载和管理";
  }
}
function hasMessageCounts(value) {
  return value?.message_count_profile === MESSAGE_COUNT_PROFILE && Number.isInteger(value.reading_count) && value.reading_count>=0 &&
    Number.isInteger(value.auxiliary_count) && value.auxiliary_count>=0 && value.reading_count+value.auxiliary_count === (["claude_api","provider_api"].includes(value.mode)?value.route_count:value.record_count);
}
async function populateMessageCounts(value) {
  if(!value || value.mode === "diagnostic" || !Number.isInteger(value.record_count) || hasMessageCounts(value))return;
  const entries=await allPages(value.id), messages=new Map();
  let lastInfo=null;
  for(const entry of entries) {
    if(!entry.accepted || !["head","previous","mapping","full"].includes(entry.kind))continue;
    let page;try {page=JSON.parse(entry.response.body_text);} catch {return;}
    const items=Array.isArray(page.messages) ? page.messages : Object.values(page.mapping || {}).map(n=>n.message).filter(Boolean);
    for(const message of items) {
      if(typeof message?.id!=="string")return;
      if(!messages.has(message.id))messages.set(message.id,message);
    }
    if(page.page_info)lastInfo=page.page_info;
  }
  if(messages.size!==(value.record_count || 0))return; // Never guess the number for old or incomplete storage.
  value.reading_count=[...messages.values()].filter(O.readingRecord).length;
  value.auxiliary_count=messages.size-value.reading_count;
  value.message_count_profile=MESSAGE_COUNT_PROFILE;
  if(lastInfo)value.history_has_previous=lastInfo.has_previous_page;
}
function renderExport() {
  const key = session ? `${session.id}|${session.updated_at || ""}|${session.next_sequence || 0}|${$("exportProfile").value || "reading"}` : null;
  if (key !== exportContextKey) {
    organized = null; exportContextKey = key;
    $("organizeError").hidden = true; $("organizeError").textContent = "";
    $("previewDetails").hidden = true; $("previewDetails").open = false; $("previewText").textContent = "";
  }
  const locked = active || processing || uiBusy || !!deleteTarget || !db || !!unsavedEntry || backgroundUnsaved;
  const hasData = !!session && session.mode !== "diagnostic" && (session.page_count || 0) > 0;
  $("organizeDownload").disabled = locked || !hasData;
  $("preview").disabled = locked || !hasData;
  $("exportProfile").disabled = locked;
  $("exportFormat").disabled = locked;
  if (!exportWorking) {
    if (organized) {
      const s = organized.statistics;
      $("organizeSummary").textContent = `保留 ${numberLabel(s.retained_messages)} 条 · 筛除 ${numberLabel(s.filtered_messages)} 条辅助 · 去除 ${numberLabel(s.total_duplicate_occurrences_removed)} 次重复` +
        (s.empty_text_ids.length ? ` · ${s.empty_text_ids.length} 条空正文已标记` : "") +
        (organized.checks.capture_recheck_passed ? "" : " · 部分采集，尚待复核");
    } else $("organizeSummary").textContent = active ? "采集完成或暂停后，即可整理已保存的原文。" :
      (session?.mode === "diagnostic" ? "当前为诊断记录，可下载原始 JSON 查看错误证据。" : "已有记录可直接整理，无需重新采集。");
  }
}
function openDatabase() {
  return ChatBackupStore.open(indexedDB);
}
async function syncBackground(selectLatest=false) {
  if(!B.enabled || viewClosed || !db)return;
  try {
    const state=await B.call("status");if(viewClosed)return;
    if(state.sleeping){enterSleep();return;}
    backgroundReady=true;lastBackgroundError=null;const wasActive=active,previousId=session?.id;
    backgroundUnsaved=state.has_unsaved_response;
    if(state.active && state.session) {
      backgroundSessionId=state.session.id;session=state.session;active=true;
    } else {
      active=false;
      if(state.session && (selectLatest || session?.id===backgroundSessionId))session=state.session;
      backgroundSessionId=null;
    }
    if(session?.background_log?.length){$("log").textContent=session.background_log.join("\n");$("logCount").textContent=session.background_log.length;}
    if(previousId!==session?.id || wasActive!==active || selectLatest)await refreshList();
    render();void refreshPageContext();
  } catch(error) {
    if(viewClosed)return;
    actionNotice=error.message;if(lastBackgroundError!==error.message)note(error.message);lastBackgroundError=error.message;render();
  }
}
function pollBackground() {
  if(viewClosed || !B.enabled || backgroundPoll!==null)return;
  backgroundPoll=setTimeout(async()=>{backgroundPoll=null;await syncBackground();pollBackground();},750);
}
function reconnectBackground(){
  if(!B.enabled || powerSleeping)return;viewClosed=false;clearTimeout(backgroundPoll);backgroundPoll=null;
  void syncBackground(true).finally(pollBackground);
}
async function startBackground(resuming) {
  const id=session?.id,identity=await H.bindIdentity(),target=H.binding();
  if(resuming && identity.conversation_id!==session.conversation_id)throw new Error("请回到这份记录的原聊天，再点击继续。");
  await B.call(resuming?"resume":"start",resuming?{session_id:id,target}:{target,conversation_id:identity.conversation_id,title:identity.title,provider_id:identity.provider_id||"chatgpt",source_url:identity.source_url,capture_method:hasStructured(identity.provider_id)?($("captureMethod").value||"structured"):undefined});
  await syncBackground(true);
}
function dbRead(store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("读取本机记录失败。"));
  });
}
function allSessions() {
  return new Promise((resolve, reject) => {
    const request = db.transaction("sessions").objectStore("sessions").getAll();
    request.onsuccess = () => resolve(request.result.filter(item => !item.deleted).sort((a,b) => b.started_at.localeCompare(a.started_at)));
    request.onerror = () => reject(new Error("读取采集列表失败。"));
  });
}
function allPages(id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction("pages").objectStore("pages").index("by_session").getAll(id);
    request.onsuccess = () => resolve(request.result.sort((a,b) => a.sequence-b.sequence));
    request.onerror = () => reject(new Error("读取原始分页失败。"));
  });
}
function commit(draft, entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(entry ? ["sessions", "pages"] : ["sessions"], "readwrite");
    let rejectedDeletedRecord = false;
    const sessionsStore = tx.objectStore("sessions"), existing = sessionsStore.get(draft.id);
    existing.onsuccess = () => {
      if (existing.result?.deleted) { rejectedDeletedRecord = true; tx.abort(); return; }
      draft.updated_at = new Date().toISOString();
      sessionsStore.put(draft);
      if (entry) tx.objectStore("pages").add(entry);
    };
    tx.oncomplete = () => {
      session = draft;
      if (entry && unsavedEntry?.sequence === entry.sequence) unsavedEntry = null;
      if (storageSizes) {
        const size = storageSizes.get(draft.id) || {sessionBytes:0,pageBytes:0};
        size.sessionBytes = C.serializedBytes(draft);
        if (entry) size.pageBytes += C.serializedBytes(entry);
        storageSizes.set(draft.id,size);
      }
      render(); resolve();
    };
    tx.onerror = tx.onabort = () => {
      if (entry && !rejectedDeletedRecord) unsavedEntry = entry;
      reject(new Error(rejectedDeletedRecord ? "这条记录已在本机删除，已停止旧面板写回。请开始新采集。" : "本机保存失败，已停止后续请求；请下载现有记录。"));
    };
  });
}
async function refreshList() {
  const sessions = await allSessions();
  if (!sessions.some(item => item.id === session?.id)) { session = sessions[0] || null; lastPage = null; }
  const selectedId = session?.id;
  $("sessions").replaceChildren();
  for (const item of sessions) {
    const option = document.createElement("option"); option.value = item.id;
    option.textContent = `${["surface","claude_api","provider_api"].includes(item.mode)?platformName(item.provider_id)+" · ":""}${item.title} · ${new Date(item.started_at).toLocaleString()} · ${item.mode === "diagnostic" ? "诊断" : (item.record_count || 0) + " 条消息"}`;
    $("sessions").append(option);
  }
  if (!sessions.length) { const option = document.createElement("option"); option.textContent = "尚无采集记录"; option.value = ""; $("sessions").append(option); }
  if (selectedId) $("sessions").value = selectedId;
  else $("sessions").value = "";
  await refreshStorage();
}
function renderStorage() {
  if (!storageSizes) { $("storage").textContent = "本地记录大小尚未统计。"; return; }
  let total = 0;
  for (const size of storageSizes.values()) total += size.sessionBytes + size.pageBytes;
  const selected = storageSizes.get(session?.id);
  $("storage").textContent = `${storageSizes.size} 条本地记录 · 全部约 ${C.formatBytes(total)}` +
    (selected ? ` · 所选约 ${C.formatBytes(selected.sessionBytes + selected.pageBytes)}` : "");
}
async function refreshStorage() {
  try {
    storageSizes = await new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "pages"], "readonly"), sessions = new Map(), pages = new Map();
      const sr = tx.objectStore("sessions").openCursor();
      sr.onsuccess = () => { const cursor=sr.result; if(!cursor)return; const value=cursor.value;
        if(!value.deleted)sessions.set(value.id,C.serializedBytes(value)); cursor.continue(); };
      const pr = tx.objectStore("pages").openCursor();
      pr.onsuccess = () => { const cursor=pr.result; if(!cursor)return; const value=cursor.value;
        pages.set(value.session_id,(pages.get(value.session_id)||0)+C.serializedBytes(value)); cursor.continue(); };
      tx.oncomplete = () => resolve(new Map([...sessions].map(([id,bytes])=>[id,{sessionBytes:bytes,pageBytes:pages.get(id)||0}])));
      tx.onerror = tx.onabort = () => reject(new Error("空间统计暂不可用。"));
    });
    renderStorage();
  } catch { storageSizes = null; $("storage").textContent = "空间统计暂不可用；记录仍可下载和管理。"; }
}
function requestDelete() {
  if (active || processing || uiBusy || deleteTarget || unsavedEntry || backgroundUnsaved || !canOfferDelete(session)) return;
  if ($("sessions").value !== session.id) { note("所选记录正在加载，请稍后再操作。"); return; }
  deleteTarget = {id:session.id,title:session.title,started_at:session.started_at,updated_at:session.updated_at};
  const size = storageSizes?.get(session.id);
  $("deleteDescription").textContent = `${session.title} · ${new Date(session.started_at).toLocaleString()}` +
    (size ? ` · 约 ${C.formatBytes(size.sessionBytes+size.pageBytes)}` : "");
  $("deleteError").textContent = "";
  $("deleteDialog").showModal(); render();
}
function cancelDelete() {
  if (uiBusy) return;
  deleteTarget = null; $("deleteDialog").close(); render();
}
function deleteLocalRecord(target) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "pages", "jobs"], "readwrite");
    const sessionsStore = tx.objectStore("sessions"), pagesStore = tx.objectStore("pages"), jobsStore = tx.objectStore("jobs");
    let reason = null, removed = 0;
    const existing = sessionsStore.get(target.id);
    existing.onsuccess = () => {
      const current = existing.result;
      if (current && !current.deleted && (!canOfferDelete(current) || current.updated_at !== target.updated_at)) {
        reason = "这条记录的状态已变化，请先暂停采集并重新选择后再删除。"; tx.abort(); return;
      }
      const job = jobsStore.get("active");
      job.onsuccess = () => {
        if(job.result?.state === "running" && job.result.session_id === target.id) {
          reason = "后台仍在采集这条记录，已取消删除。请先暂停再试。"; tx.abort(); return;
        }
        const keys = pagesStore.index("by_session").getAllKeys(target.id);
        keys.onsuccess = () => {
          if (!keys.result.every(key => Array.isArray(key) && key[0] === target.id)) {
            reason = "本地索引与所选记录不一致，已取消删除。"; tx.abort(); return;
          }
          for (const key of keys.result) pagesStore.delete(key);
          removed = keys.result.length;
          // Keep only an opaque deletion marker so an older open panel cannot resurrect this record.
          sessionsStore.put({id:target.id,deleted:true,deleted_at:current?.deleted_at || new Date().toISOString()});
        };
      };
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = tx.onabort = () => reject(new Error(reason || "删除未完成；本次删除事务已回滚。"));
  });
}
async function confirmDelete() {
  if (active || processing || uiBusy || backgroundUnsaved || !deleteTarget) return;
  uiBusy = true; render();
  const target = {...deleteTarget}; let deleted = false;
  try {
    if(B.enabled){
      const status=await B.call("status");
      if(status.has_unsaved_response)throw new Error("后台还有未保存的响应，请先下载原始 JSON。");
      if(status.active && status.session?.id===target.id){
        const paused=await B.call("pause",{session_id:target.id});
        if(paused.active || paused.has_unsaved_response)throw new Error("后台尚未安全暂停，已取消删除。");
        const fresh=await dbRead("sessions",target.id);
        if(!fresh || fresh.deleted || fresh.started_at!==target.started_at)throw new Error("这条记录已变化，请重新选择后再删除。");
        target.updated_at=fresh.updated_at;
      }
    }
    const deleteWithLock=()=>deleteLocalRecord(target);
    let removed;
    const locks=globalThis.navigator?.locks;
    if(locks?.request){
      removed=await locks.request("chat-backup-active-collector",{ifAvailable:true},lock=>{
        if(!lock)throw new Error("另一个入口仍在采集，请先暂停后再删除。");
        return deleteWithLock();
      });
    } else if(UNFINISHED_STATES.includes(session?.state))throw new Error("浏览器无法确认采集任务已经停止，已取消删除。");
    else removed=await deleteWithLock();
    deleted = true;
    requestEpoch++; clearWatchdog(); readerHeaders = null; expectedURL = null; waitingHead = null;
    if (session?.id === target.id) { session = null; lastPage = null; }
    storageSizes?.delete(target.id);
    deleteTarget = null; $("deleteDialog").close();
    await refreshList();
    note(`已删除所选本地记录及 ${removed} 份原始响应。原聊天和下载文件不受影响。`);
  } catch (error) {
    if (deleted) note("所选本地记录已删除，但列表刷新失败；请重新打开面板。");
    else $("deleteError").textContent = error.message;
  } finally { uiBusy = false; render(); }
}
async function sha(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const pageIdentity = () => H.identity();
function clearWatchdog() { clearTimeout(timer); timer = null; }
async function stop(message, state = "error") {
  requestEpoch++;
  active = false; waitingHead = null; expectedURL = null;
  clearWatchdog(); readerHeaders = null; headContext = null; preparingHead = false;
  await releasePageReader();
  if (processing) pendingStop={message,state};
  else {
    pendingStop=null;
    if(session) {
      try { await commit({...session, state, detail: message}); }
      catch { session.state = "error"; session.detail = "本机数据库无法写入，请下载现有数据。"; }
    }
    releaseCaptureLease();
  }
  note(message); render(message);
  void refreshPageContext();
}
function setWatchdog() {
  clearWatchdog();
  timer = setTimeout(() => {
    if (!active || processing) return;
    if (waitingHead && !expectedURL) {
      const detail = "仍在等待网页数据，监听保持开启。可点击“刷新一次并采集”，也可手动刷新；收到响应后会自动继续，无需再点继续。";
      commit({...session, detail}).catch(e => stop(e.message)); note(detail);
    }
    else retryExpected("网络请求超时", null);
  }, session?.mode === "full" && !waitingHead ? 120000 : 30000);
}
const networkLog = timeoutMs => H.networkLog(timeoutMs);
function acquireCaptureLease() {
  // DevTools and the sidebar can both be open. Never let two collectors write concurrently.
  if(!globalThis.navigator?.locks)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    navigator.locks.request("chat-backup-active-collector",{ifAvailable:true},async lock=>{
      if(!lock){reject(new Error("另一个聊天备份面板正在采集。请先在那个面板暂停，再从这里开始。"));return;}
      await new Promise(release=>{captureLeaseRelease=release;resolve();});
    }).catch(()=>reject(new Error("无法取得本机采集锁，请关闭另一个备份面板后重试。")));
  });
}
function releaseCaptureLease() {captureLeaseRelease?.();captureLeaseRelease=null;}
async function prepareHead(reason) {
  const epoch = ++requestEpoch;
  clearWatchdog(); preparingHead = true;
  readerHeaders = null; waitingHead = reason; expectedURL = null;
  let candidate;
  try {
    await commit({...session, state: reason === "finish" ? "verifying" : "waiting",
      detail: reason === "initial" ? "正在读取当前聊天的最新首页，不刷新页面。" : "正在重新读取首页，核对采集期间内容是否变化。"});
    let entries = [];
    if (!headContext) {
      try { entries = await networkLog(1500); } catch (error) { note(error.message); }
    }
    if (!active || epoch !== requestEpoch) return;
    candidate = H.hasNetwork ? (reason !== "initial" && headContext ? headContext :
      C.selectObservedHead([...entries, ...observedHeads], session.conversation_id)) : null;
  } finally { if (epoch === requestEpoch) preparingHead = false; }
  if (!active || epoch !== requestEpoch) return;
  if (candidate) {
    readerHeaders = C.replayHeaders(candidate.request.headers);
    expectedURL = candidate.request.url;
    if (readerMode !== "direct" && !Object.entries(readerHeaders).some(([name,value])=>name.toLowerCase()==="authorization" && typeof value === "string" && value.trim())) {
      readerMode = "direct"; expectedURL = C.pagedHeadURL(session.conversation_id);
    }
    note("正在读取最新首页，已有请求只用于提供读取信息，不沿用旧正文。");
    await issueExpected();
  } else {
    readerMode = "direct";
    expectedURL = C.pagedHeadURL(session.conversation_id);
    await commit({...session, detail:"正在通过当前页面的登录状态直接读取聊天。"});
    note("已改用直接读取，无需刷新聊天页面。");
    await issueExpected();
  }
}
async function reloadOnce() {
  if (!active || !waitingHead || expectedURL || preparingHead || processing) return;
  const identity = await pageIdentity();
  if (identity.conversation_id !== session.conversation_id) throw new Error("请回到当前记录所属的聊天。");
  note("按你的点击刷新一次，采集监听保持开启。");
  H.reload();
  setWatchdog();
}
async function startNew(mode = "pagination") {
  if (mode !== "pagination") return diagnoseFull();
  await releasePageReader(); readerMode = "observed";
  const identity = await H.bindIdentity();
  if(identity.provider_id && identity.provider_id!=="chatgpt")throw new Error("该平台请从工具栏“拾页”侧栏开始采集。F12 兼容入口仍支持 ChatGPT。");
  await acquireCaptureLease();
  active = true;
  session = {id: crypto.randomUUID(), ...identity, mode, creator_version: APP_VERSION, started_at: new Date().toISOString(),
    state: "waiting", detail: "初始化采集", next_sequence: 0, page_count: 0, record_count: 0,
    message_hashes: {}, version_ids: [], empty_text_ids: [], seen_start_cursors: [], last_page_sequence: null,
    reading_count:0,auxiliary_count:0,message_count_profile:MESSAGE_COUNT_PROFILE,
    head_signature: null, checks: {all_history_branches_verified: false,
      complete_current_server_conversation: false, official_export_equivalent: false}};
  lastPage = null; headContext = null; retryCount = 0; unsavedEntry = null;
  await commit(session); void refreshPageContext(); await refreshList(); await prepareHead("initial");
}
async function resume() {
  if (!session) return;
  if(["surface","claude_api","provider_api"].includes(session.mode))throw new Error("请从工具栏“拾页”侧栏继续这份采集。");
  await releasePageReader();
  const identity = await H.bindIdentity();
  if (identity.conversation_id !== session.conversation_id) throw new Error("请回到这份记录所属的聊天，再点击继续。");
  readerMode = "observed";
  if (session.mode === "full") {
    await diagnoseFull(); return;
  }
  await populateMessageCounts(session);
  if (session.last_page_sequence != null) {
    const saved = await dbRead("pages", [session.id, session.last_page_sequence]);
    if (!saved?.accepted) throw new Error("找不到最后一个已保存检查点。");
    lastPage = JSON.parse(saved.response.body_text);
  }
  await acquireCaptureLease();
  active = true; retryCount = 0;
  void refreshPageContext();
  await prepareHead(session.head_signature || session.mapping_signature ? "resume" : "initial");
}
async function fingerprints(page) {
  const result = {};
  for (const message of page.messages) result[message.id] = await sha(C.stable(C.payload(message)));
  return result;
}
async function saveEntry(url, raw, status, kind, page, accepted, rejection) {
  const draft = structuredClone(session), sequence = draft.next_sequence++;
  const entry = {session_id: session.id, sequence, kind, accepted,
    request: {method: "GET", url: C.safeRequestURL(url), transport:readerMode === "direct" ? "page_fetch" : "devtools_network"},
    response: {status, received_at: new Date().toISOString(), body_sha256: await sha(raw), body_text: raw},
    validation: {parent_page_sequence: kind === "previous" ? session.last_page_sequence : null,
      recheck_of_sequence: kind === "full_recheck" ? session.full_page_sequence : (kind === "mapping_recheck" ? session.mapping_page_sequence : null),
      rejection: rejection || null, all_history_branches_verified: false}};
  if (accepted && ["head", "previous"].includes(kind)) {
    const hashes = await fingerprints(page);
    for (const [id, hash] of Object.entries(hashes)) {
      if (draft.message_hashes[id] && draft.message_hashes[id] !== hash) C.fail("content_conflict", "同一消息 ID 出现了不同正文、作者或时间。已停止，需检查是否切换了分支。");
    }
    if(hasMessageCounts(draft))for(const message of page.messages) {
      if(!Object.hasOwn(draft.message_hashes,message.id)) {
        if(O.readingRecord(message))draft.reading_count++;else draft.auxiliary_count++;
      }
    }
    Object.assign(draft.message_hashes, hashes);
    draft.record_count = Object.keys(draft.message_hashes).length;
    draft.version_ids = [...new Set([...draft.version_ids, ...page.messages.filter(m => m.metadata?.has_versions === true).map(m => m.id)])];
    draft.empty_text_ids = [...new Set([...(draft.empty_text_ids || []), ...C.emptyTextIds(page.messages)])];
    draft.seen_start_cursors.push(page.page_info.start_cursor);
    draft.page_count++; draft.last_page_sequence = sequence;
    draft.history_has_previous=page.page_info.has_previous_page;
    if (kind === "head") draft.head_signature = await sha(C.headSignatureInput(page));
    draft.state = "running"; draft.detail = "原始分页已写入本机，继续读取更早内容。";
  }
  if (accepted && kind === "full") {
    const info = C.inspectFullConversation(page, session.conversation_id);
    draft.full_signature = await sha(C.fullSignatureInput(page));
    draft.full_page_sequence = sequence;
    draft.full_structure = info;
    draft.record_count = info.messages;
    const records=Object.values(page.mapping).map(n=>n.message).filter(Boolean);
    draft.reading_count=records.filter(O.readingRecord).length;draft.auxiliary_count=records.length-draft.reading_count;draft.message_count_profile=MESSAGE_COUNT_PROFILE;
    draft.branch_points = info.branch_points;
    draft.empty_text_ids = info.empty_text_ids;
    draft.page_count++;
    draft.state = "full_verifying";
    draft.detail = "完整 mapping 已保存，正在再读一次比较消息内容和父子关系。";
  }
  if (accepted && kind === "mapping") {
    const info = C.inspectFullConversation(page, session.conversation_id);
    draft.mode = "mapping";
    draft.mapping_signature = await sha(C.fullSignatureInput(page));
    draft.mapping_page_sequence = sequence;
    draft.mapping_structure = info;
    draft.record_count = info.messages; draft.branch_points = info.branch_points;
    const records=Object.values(page.mapping).map(n=>n.message).filter(Boolean);
    draft.reading_count=records.filter(O.readingRecord).length;draft.auxiliary_count=records.length-draft.reading_count;draft.message_count_profile=MESSAGE_COUNT_PROFILE;
    draft.empty_text_ids = info.empty_text_ids;
    draft.page_count++; draft.state = "verifying";
    draft.detail = "网页返回的 mapping 原文已保存，正在重新读取以核对内容和关系。";
  }
  await commit(draft, entry);
  if (accepted && ["head", "previous"].includes(kind)) lastPage = page;
}
function responseText(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {settled=true;reject(new Error("读取响应正文超时，已暂停。"));}, timeoutMs || (session?.mode === "full" ? 120000 : 30000));
    const receive = (content, encoding) => {
      if (settled) return; settled = true;
      clearTimeout(deadline);
      if (typeof content !== "string") { reject(new Error("浏览器没有返回响应正文。")); return; }
      try {
        if (encoding === "base64") content = new TextDecoder().decode(Uint8Array.from(atob(content), c => c.charCodeAt(0)));
        resolve(content);
      } catch { reject(new Error("响应编码无法解析。")); }
    };
    if (typeof request.response?.content?.text === "string") receive(request.response.content.text, request.response.content.encoding);
    else if (typeof request.getContent === "function") {
      try {
        const result = request.getContent(receive);
        if (result?.then) result.then(value=>{
          if (typeof value === "string") receive(value,"");
          else if (Array.isArray(value)) receive(value[0],value[1]);
          else if (value !== undefined) receive(value?.content,value?.encoding);
        },()=>{if(!settled){settled=true;clearTimeout(deadline);reject(new Error("浏览器已无法读取响应正文。"));}});
      } catch { clearTimeout(deadline); reject(new Error("浏览器已无法读取这条历史响应。")); }
    } else { clearTimeout(deadline); reject(new Error("浏览器未提供这条历史请求的响应正文。")); }
  });
}
async function releasePageReader() {
  clearTimeout(pageReadTimer); pageReadTimer = null; pageReadTicket = null;
  const key = pageReaderKey; pageReaderKey = null;
  if (key) { try { await H.readerCommand(key,"dispose"); } catch { /* Navigation can already have destroyed the page context. */ } }
}
function directFailureMessage(result) {
  if (result.code === "session_http") return `读取当前登录状态返回 HTTP ${result.http_status || 0}。请先确认网页登录正常；工具没有刷新页面，也不会重复尝试被拒绝的请求。`;
  const messages = {
    login_required:"当前页面没有提供有效登录状态。请确认已登录后再点采集，无需靠反复刷新触发请求。",
    session_format:"登录状态的响应格式发生变化，已停止直接读取。登录响应未写入记录。",
    page_changed:"页面已切换到其他聊天，直接读取已停止。",
    wrong_page:"当前页面不再是这份记录所属的聊天，已停止读取。",
    request_timeout:"直接读取超时，已保留现有记录。可点击继续重新连接，无需先刷新页面。",
    network_error:"直接读取发生网络错误，已保留现有记录。可点击继续重新连接。",
    response_too_large:"单页响应超过读取上限，已停止并保留此前记录。",
    reader_missing:"页面读取连接已结束，可点击继续重新连接。"
  };
  return messages[result.code] || "无法建立当前页面的读取连接，已保留记录；没有刷新页面。";
}
async function beginDirectRead(url, epoch) {
  clearWatchdog(); clearTimeout(pageReadTimer);
  if (!pageReaderKey) {
    const key = "__chat_backup_reader_" + crypto.randomUUID();
    pageReaderKey = key;
    const installed = await H.installReader(key,session.conversation_id);
    if (!active || epoch !== requestEpoch || pageReaderKey !== key) {
      try { await H.readerCommand(key,"dispose"); } catch { /* Context may be gone. */ }
      return;
    }
    if (!installed?.ok) throw new Error(directFailureMessage(installed || {}));
  }
  if (!active || epoch !== requestEpoch || expectedURL !== url) return;
  const ticket = {key:pageReaderKey,id:crypto.randomUUID(),url,epoch};
  pageReadTicket = ticket;
  const started = await H.readerCommand(ticket.key,"start",[ticket.id,url]);
  if (!active || epoch !== requestEpoch || pageReadTicket !== ticket) return;
  if (!started?.ok) throw new Error(directFailureMessage(started || {}));
  function relevant() { return active && requestEpoch === ticket.epoch && expectedURL === ticket.url && pageReadTicket === ticket; }
  function failed(error) { if (active && requestEpoch === ticket.epoch) void stop(error.message); }
  async function poll() {
    if (!relevant()) return;
    const result = await H.readerCommand(ticket.key,"poll",[ticket.id]);
    if (!relevant()) return;
    if (result?.state === "pending") {
      $("detail").textContent = result.phase === "session" ? "正在确认当前页面的登录状态，不刷新页面。" :
        (waitingHead ? "正在直接读取聊天首页，不刷新页面。" : "正在直接读取更早消息。");
      pageReadTimer = setTimeout(()=>poll().catch(failed),250);
      return;
    }
    if (result?.state === "done") {
      if (result.url !== ticket.url || typeof result.body_text !== "string" || !Number.isInteger(result.status)) throw new Error("页面返回的读取结果与当前请求不一致，已停止。");
      await H.readerCommand(ticket.key,"ack",[ticket.id]);
      if (!relevant()) return;
      pageReadTicket = null; pageReadTimer = null;
      await handleRequest({capture_transport:"page_reader",request:{method:"GET",url:ticket.url,headers:[]},
        response:{status:result.status,headers:result.headers || []},getContent:callback=>callback(result.body_text,"")});
      return;
    }
    const knownCodes = ["session_http","session_format","login_required","page_changed","wrong_page","request_timeout","network_error","response_too_large","reader_missing"];
    const failure = {code:knownCodes.includes(result?.code) ? result.code : "reader_missing"};
    if (Number.isInteger(result?.http_status) && result.http_status >= 100 && result.http_status <= 599) failure.http_status = result.http_status;
    await commit({...session,direct_read_failure:failure});
    if (!relevant()) return;
    if (H.hasNetwork && ["login_required","session_format"].includes(failure.code)) {
      await releasePageReader();
      if (!active || requestEpoch !== ticket.epoch) return;
      readerMode = "observed"; expectedURL = null; readerHeaders = null;
      const detail = "当前登录接口未提供可用的读取信息，已改为监听网页自身的请求。请确认网页已登录；也可使用下方的手动刷新作为备用。";
      await commit({...session,detail});
      if (!active || requestEpoch !== ticket.epoch) return;
      note(detail); setWatchdog(); render();
      return;
    }
    await stop(directFailureMessage(failure));
  }
  pageReadTimer = setTimeout(()=>poll().catch(failed),100);
}
async function issueExpected() {
  if (!active || !expectedURL) return;
  const epoch = requestEpoch;
  const identity = await pageIdentity();
  if (!active || epoch !== requestEpoch) return;
  if (identity.conversation_id !== session.conversation_id) throw new Error("页面已切换到其他聊天，采集停止。");
  if (readerMode === "direct") { await beginDirectRead(expectedURL,epoch); return; }
  if (!readerHeaders) throw new Error("没有取得网页自己的请求信息；请点击继续重新读取首页。");
  const url = expectedURL, cid = session.conversation_id;
  if (C.hasFullRequestFlag(url, cid)) throw new Error("强制完整接口保持停用，不会再次请求。");
  // The URL is built only from the supplied, verified endpoint and a response cursor.
  // Headers are kept in this panel's memory, never included in saved records or logs.
  const code = `(function(){const u=new URL(location.href);if(u.origin!=="https://chatgpt.com"||!u.pathname.endsWith("/c/"+${JSON.stringify(cid)}))return false;void fetch(${JSON.stringify(url)},{method:"GET",credentials:"include",cache:"no-store",headers:${JSON.stringify(readerHeaders)}}).catch(function(){});return true;})()`;
  const started = await H.evaluateObserved(code);
  if (!started) throw new Error("所检查页面不再是目标聊天。");
  if (active && expectedURL === url && epoch === requestEpoch && !processing) setWatchdog();
}
async function retryExpected(reason, retryAfter) {
  if (!active || !expectedURL) return;
  clearWatchdog();
  if (retryCount >= 3) { await stop(reason + "；重试仍未成功，已保留检查点。"); return; }
  const delay = C.retryDelay(retryCount++, retryAfter), anchor = expectedURL;
  note(`${reason}，${Math.ceil(delay/1000)} 秒后重试同一页。`);
  timer = setTimeout(() => { if (active && expectedURL === anchor) issueExpected().catch(e => stop(e.message)); }, delay);
}
async function advance() {
  if (!active || !lastPage) return;
  const info = C.inspectPage(lastPage, session.conversation_id);
  if (!info.previous) { await prepareHead("finish"); return; }
  if (session.page_count >= 2000) { await stop("已达到本次 2,000 页保护上限，请先核对现有数据。", "paused"); return; }
  requestEpoch++; retryCount = 0; expectedURL = C.requestURL(session.conversation_id, info.start);
  const anchor = expectedURL;
  timer = setTimeout(() => { if (active && expectedURL === anchor) issueExpected().catch(e => stop(e.message)); }, 350);
}
async function queueFullRead() {
  await stop("完整接口已返回 403，自动读取暂时停用。可点击“完整模式诊断”收集现有错误记录。");
}
async function recordFailure(request) {
  const failure = C.failureMetadata(request, session.conversation_id);
  let raw = null;
  try { raw = await responseText(request, 5000); } catch (error) { failure.body_unavailable_reason = error.message; }
  failure.body_available = raw !== null;
  if (raw !== null) {
    if (raw.length > 262144) {
      failure.original_body_sha256 = await sha(raw);
      raw = raw.slice(0, 262144); failure.body_truncated = true;
    }
    await saveEntry(request.request.url, raw, failure.status, "request_failed", null, false, `http_${failure.status}`);
    failure.response_sequence = session.next_sequence - 1;
  }
  await commit({...session, failures: [...(session.failures || []), failure], last_failure: failure});
  return failure;
}
async function diagnoseFull() {
  const identity = await H.bindIdentity();
  const previous = (await allSessions()).filter(s => s.conversation_id === identity.conversation_id &&
    s.mode === "full" && /HTTP\s*(401|403)/i.test(s.detail || ""));
  active = false; waitingHead = null; expectedURL = null; readerHeaders = null; requestEpoch++; clearWatchdog();
  await releasePageReader();
  session = {id: crypto.randomUUID(), ...identity, mode: "diagnostic", creator_version: APP_VERSION,
    started_at: new Date().toISOString(), state: "waiting", detail: "只读取现有记录，不刷新、不重试完整接口。",
    next_sequence: 0, page_count: 0, record_count: 0, version_ids: [], empty_text_ids: [], failures: [],
    previous_failures: previous.map(s => ({session_id:s.id, started_at:s.started_at,
      status:Number((s.detail.match(/HTTP\s*(401|403)/i) || [])[1]), body_was_not_saved:true})),
    checks:{diagnostic_only:true,no_new_full_request:true,complete_current_server_conversation:false}};
  await commit(session); await refreshList();
  const entries = await networkLog();
  const failed = entries.filter(r => r.request?.method === "GET" && C.isFullRequest(r.request.url, identity.conversation_id) && r.response?.status >= 400).slice(-5);
  processing = true; render();
  try { for (const request of failed) await recordFailure(request); }
  finally { processing = false; }
  const detail = failed.length ? `已记录 ${failed.length} 条现有完整接口错误。请下载诊断；没有刷新网页或再次发送完整请求。` :
    (previous.length ? "已找到之前的 401/403 状态记录，但旧版没有保存错误正文，当前 Network 中也已没有该响应。请下载诊断，不必再次请求完整接口。" :
    "当前 Network 和本机记录中没有可读取的完整接口错误。已保存诊断状态，不会为了取样而重复请求被拒绝的接口。");
  await commit({...session, state:"diagnosed", detail}); await refreshList(); note(detail);
}
async function handleRequest(request) {
  if (readerMode === "direct" && request.capture_transport !== "page_reader") return;
  if (!active || processing || preparingHead || !session || request.request?.method !== "GET") return;
  const epoch = requestEpoch;
  const url = request.request.url;
  if (!C.isConversationRequest(url, session.conversation_id)) return;
  const headReason = waitingHead;
  if (headReason && !C.isPagedHeadRequest(url, session.conversation_id)) return;
  if (!headReason) {
    if (!expectedURL) return;
    try {
      if (session.mode === "full") { if (!C.isFullRequest(url, session.conversation_id)) return; }
      else if (C.beforeFromRequest(url, session.conversation_id) !== C.beforeFromRequest(expectedURL, session.conversation_id)) return;
    }
    catch { return; }
  }
  const status = request.response.status;
  if (status !== 200) {
    if ([401,403].includes(status) || headReason) {
      processing = true; clearWatchdog(); render();
      try { await recordFailure(request); }
      finally { processing = false; }
      await stop(`读取 ${headReason ? "聊天首页" : "当前分页"} 返回 HTTP ${status}，已停止并保存能取得的错误信息。请下载诊断；刷新并不能保证解除拒绝。`); return;
    }
    if ([0, 408, 429, 500, 502, 503, 504].includes(status)) {
      const header = (request.response.headers || []).find(h => h.name.toLowerCase() === "retry-after");
      await retryExpected(`读取返回 ${status || "网络错误"}`, header?.value); return;
    }
    await stop(`读取返回 HTTP ${status}；请确认登录和网页访问正常。工具不会绕过访问限制。`); return;
  }
  processing = true; render();
  let raw, page, evidenceSaved = false, recheckMapping = false;
  try {
    raw = await responseText(request);
    if (!active || epoch !== requestEpoch) return;
    if (raw.length > 32 * 1024 * 1024) throw new Error("单页超过测试版的 32 MiB 字符保护上限，需单独处理。");
    try { page = JSON.parse(raw); } catch { throw new Error("已经收到聊天响应，但内容不是 JSON。原始响应会保存，便于定位。"); }
    if (headReason) {
      if (!page || typeof page !== "object") throw new Error("已经收到聊天响应，但结构不受支持。原文会保留。");
      if ([page.conversation_id, page.id].some(id => id != null && id !== session.conversation_id)) throw new Error("响应中的聊天 ID 与当前请求不一致，原文会保留供核对。");
      const supported = (Array.isArray(page.messages) && page.page_info) || (page.mapping && typeof page.mapping === "object");
      if (!supported) throw new Error("已经收到聊天响应，但没有 messages/page_info 或 mapping。原文会保存，请下载结果供核对。");
      headContext = request;
      readerHeaders = C.replayHeaders(request.request.headers);
    }
    clearWatchdog();
    if (!active) return;
    if (headReason && (page.mapping || session.mode === "mapping")) {
      if (session.head_signature) throw new Error("首页从分页变成了 mapping。已保留原文，请新建采集，避免混合两种结构。");
      const info = C.inspectFullConversation(page, session.conversation_id);
      const signature = await sha(C.fullSignatureInput(page));
      if (!session.mapping_signature) {
        await saveEntry(url, raw, status, "mapping", page, true); evidenceSaved = true;
        recheckMapping = true;
        note(`已保存网页返回的 ${info.messages} 条消息，${info.branch_points} 个分叉节点；正在复核。`);
      } else {
        if (signature !== session.mapping_signature) {
          await saveEntry(url, raw, status, "mapping_recheck", page, false, "mapping_changed"); evidenceSaved = true;
          throw new Error("两次网页结构的正文或关系不一致。已保存两次原文，请另行核对。");
        }
        await saveEntry(url, raw, status, "mapping_recheck", page, true); evidenceSaved = true;
        active = false; waitingHead = null; expectedURL = null; readerHeaders = null; headContext = null;
        await releasePageReader();
        await commit({...session, state: "mapping_complete",
          detail: "网页正常请求返回的消息结构已保存，两次读取一致。没有请求强制完整接口；是否包含全部旧版本仍需与官方参考文件核对。"});
        await refreshList(); return;
      }
    } else if (headReason) {
      const info = C.inspectPage(page, session.conversation_id);
      if (info.next || (page.current_node != null && page.current_node !== info.end)) throw new Error("首页不是当前聊天的最新一页，不能建立采集起点。");
      if (headReason === "initial") {
        await saveEntry(url, raw, status, "head", page, true); evidenceSaved = true;
      } else {
        if (await sha(C.headSignatureInput(page)) !== session.head_signature) {
          await saveEntry(url, raw, status, "head_recheck", page, false, "head_changed"); evidenceSaved = true;
          throw new Error("聊天首页在采集期间发生变化。请开始新采集；现有数据已保留。");
        }
        await saveEntry(url, raw, status, "head_recheck", page, true); evidenceSaved = true;
      }
      waitingHead = null; expectedURL = null;
      if (headReason === "finish") {
        active = false; readerHeaders = null; headContext = null;
        await releasePageReader();
        await commit({...session, state: "route_complete", detail: "已验证当前路线分页到头，且首页内容未变化。历史分支、附件及官方全量等价性尚未验证。"});
        note("分页采集和首尾复核结束。请下载原始 JSON 后交给 Codex 与官方文件核对。");
        await refreshList(); return;
      }
    } else {
      C.validatePair(lastPage, page, session.conversation_id, url, session.seen_start_cursors);
      await saveEntry(url, raw, status, "previous", page, true); evidenceSaved = true;
      expectedURL = null;
    }
    note(`已保存 ${session.page_count} 页，${session.record_count} 条不同消息。`);
  } catch (error) {
    if (typeof raw === "string" && !unsavedEntry && !evidenceSaved) {
      try { await saveEntry(url, raw, status, session?.mode === "full" ? "full_rejected" : (headReason ? "head_rejected" : "previous_rejected"), page, false, error.code || "validation_failed"); } catch { /* Keep the pending entry in memory for download. */ }
    }
    await stop(error.message); return;
  } finally {
    processing = false;
    if(pendingStop) {
      const stopped=pendingStop;pendingStop=null;
      await stop(stopped.message,stopped.state);
    }
    if(!active) {releaseCaptureLease();void refreshPageContext();}
    render();
  }
  if (active && recheckMapping) await prepareHead("finish");
  else if (active && !waitingHead) await advance();
}
async function exportBundle() {
  if (!session) throw new Error("请先选择一份采集记录。");
  const id = session.id;
  // Read state and response pages together so exporting a checkpoint cannot mix two commits.
  const snapshot = await new Promise((resolve,reject) => {
    const tx = db.transaction(["sessions","pages"],"readonly");
    const sr = tx.objectStore("sessions").get(id), pr = tx.objectStore("pages").index("by_session").getAll(id);
    tx.oncomplete = () => resolve({record:sr.result, entries:pr.result});
    tx.onerror = tx.onabort = () => reject(new Error("读取导出快照失败，原始记录仍保留在本机。"));
  });
  const record = snapshot.record;
  if (!record || record.deleted) throw new Error("这份本地记录已不可用，请重新选择。");
  const entries = snapshot.entries.sort((a,b)=>a.sequence-b.sequence);
  if(B.enabled && backgroundUnsaved){
    const pending=await B.call("pending",{session_id:id});
    if(pending && !entries.some(p=>p.sequence===pending.sequence))entries.push(pending);
  }
  if (unsavedEntry?.session_id === id && !entries.some(p => p.sequence === unsavedEntry.sequence)) entries.push(unsavedEntry);
  const publicSession = {...record}; delete publicSession.message_hashes;
  return {schema: record.mode==="provider_api"?"chat-export-provider/v1":(record.mode==="claude_api"?"chat-export-claude/v1":(record.mode==="surface"?"chat-export-surface/v1":(record.mode === "diagnostic" ? "chat-export-diagnostic/v1" : (record.mode === "mapping" ? "chat-export-observed-mapping/v1" : (record.mode === "full" ? "chat-export-capture/v2" : "chat-export-capture/v1"))))),
    ...(["surface","claude_api","provider_api"].includes(record.mode)?{provider_id:record.provider_id}:{}),
    tool: {name: "单聊天备份", version: record.creator_version || "0.1.0", exporter_version: APP_VERSION},
    conversation_id: record.conversation_id, title: record.title, capture: publicSession, pages: entries,
    scope: {diagnostic_only: record.mode === "diagnostic", selected_route_only: record.mode === "pagination" || record.mode === "surface" || !record.mode, full_mapping_requested: record.mode === "full", observed_mapping: record.mode === "mapping", all_history_branches_verified: false,
      attachments_downloaded: false, complete_official_export: false,
      ...(record.mode==="surface"?{capture_source:"rendered_page",server_history_verified:false,official_json:false}:{}),
      ...(record.mode==="claude_api"?{capture_source:"claude_conversation_api",returned_tree_preserved:true,official_json:false}:{}),
      ...(record.mode==="provider_api"?{capture_source:"provider_conversation_api",provider_id:record.provider_id,official_json:false}:{}),
      note: record.mode==="surface"?"Rendered webpage snapshots are hashed. This is not an official data export; server history completeness is unverified.":"Only decoded response bodies are hashed. Request authorization headers are never exported."}};
}
function safeTitle(title) { return (title || "聊天").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0,60); }
function downloadFile(content, filename, mime) {
  const blob = new Blob([content], {type:mime});
  const link = document.createElement("a"), objectURL = URL.createObjectURL(blob);
  link.href = objectURL; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
}
async function download() {
  const bundle = await exportBundle(), s = bundle.capture;
  const type = s.mode==="provider_api"?platformName(s.provider_id)+"会话原始数据":(s.mode==="claude_api"?"Claude会话原始数据":(s.mode==="surface"?"网页快照_完整性待核对":(s.mode === "diagnostic" ? "诊断" : (s.mode === "mapping" ? "网页结构" : (s.mode === "full" ? "完整结构" : "原始分页")))));
  downloadFile(JSON.stringify(bundle,null,2),`${safeTitle(s.title)}_${type}_${s.id.slice(0,8)}.json`,"application/json;charset=utf-8");
  note("已下载原始 JSON。");
}
async function prepareOrganized() {
  if (active || processing || unsavedEntry) throw new Error("请先完成或暂停采集；原始 JSON 随时可保存当前记录。");
  if (organized) {
    const fresh = await dbRead("sessions",session.id);
    if (!fresh || fresh.deleted) { organized = null; $("previewDetails").hidden = true; $("previewText").textContent = ""; throw new Error("这份记录已在本机删除，请重新选择。"); }
    if (fresh.updated_at === organized.source.captured_at) return organized;
    organized = null;
  }
  exportWorking = true;
  $("organizeError").hidden = true;
  $("organizeSummary").textContent = "正在读取并校验原始响应…";
  try {
    const bundle = await exportBundle();
    const result = await O.prepare(bundle,{profile:$("exportProfile").value || "reading",onProgress:async(done,total)=>{
      $("organizeSummary").textContent = `正在校验与整理 · ${done} / ${total} 份响应`;
      if (done % 8 === 0) await new Promise(resolve=>setTimeout(resolve,0));
    }});
    organized = result;
    return result;
  } finally { exportWorking = false; renderExport(); }
}
async function previewOrganized() {
  const value = await prepareOrganized();
  $("previewText").textContent = O.preview(value);
  $("previewDetails").hidden = false; $("previewDetails").open = true;
}
async function downloadOrganized() {
  const value = await prepareOrganized(), format = $("exportFormat").value === "json" ? "json" : "txt";
  const name = value.scope.profile === "reading" ? "整理正文" : "合并全部类型";
  const part = (value.scope.capture_source==="rendered_page"?"_网页正文_完整性待核对":(value.scope.capture_source==="claude_conversation_api"?"_Claude会话数据":(value.scope.capture_source==="provider_conversation_api"?"_"+platformName(value.provider_id)+"会话数据":"")))+(value.checks.capture_recheck_passed ? "" : "_部分采集");
  const filename = `${safeTitle(value.title)}_${name}${part}_${value.source.capture_id.slice(0,8)}.${format}`;
  downloadFile(format === "json" ? JSON.stringify(value,null,2) : O.toText(value),filename,
    format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8");
  note(`已导出 ${numberLabel(value.statistics.retained_messages)} 条整理记录（${format.toUpperCase()}）。原始记录保留。`);
}
function bindButton(id, action, readOnly = false) {
  $(id).addEventListener("click", async () => {
    if (uiBusy || !db) return;
    uiBusy = true; actionNotice = null; render();
    try {
      if(powerAvailable && ["start","resume","startFull"].includes(id)){
        if((await B.call("powerStatus")).sleeping){enterSleep();return;}
      }
      await action();
    } catch (error) {
      if (readOnly) { $("organizeError").textContent = error.message; $("organizeError").hidden = false; note(error.message); }
      else if(B.enabled) {actionNotice=error.message;note(error.message);await syncBackground();}
      else if(!active && ["start","startFull","resume"].includes(id)) {actionNotice=error.message;note(error.message);}
      else await stop(error.message);
    }
    finally { uiBusy = false; render(); }
  });
}
bindButton("start", () => B.enabled ? startBackground(false) : startNew("pagination")); bindButton("startFull", diagnoseFull);
bindButton("resume", () => B.enabled ? startBackground(true) : resume());
bindButton("revalidateSaved",async()=>{await B.call("revalidate",{session_id:session.id});await syncBackground(true);});
bindButton("pause",async()=>{if(B.enabled){await B.call("pause",{session_id:session?.id});await syncBackground();}else await stop("用户暂停；已保存的分页可以下载或继续采集。", "paused");});
bindButton("download", download, true);
bindButton("organizeDownload", downloadOrganized, true);
bindButton("preview", previewOrganized, true);
bindButton("reloadOnce", reloadOnce);
$("exportProfile").addEventListener("change", renderExport);
$("deleteRecord").addEventListener("click", requestDelete);
$("cancelDelete").addEventListener("click", cancelDelete);
$("confirmDelete").addEventListener("click", confirmDelete);
$("deleteDialog").addEventListener("cancel", event => { event.preventDefault(); cancelDelete(); });
$("sessions").addEventListener("change", async () => {
  if (active || processing || deleteTarget) return;
  const id = $("sessions").value, epoch = ++selectionEpoch;
  uiBusy = true; render();
  try {
    const selected = id ? await dbRead("sessions", id) : null;
    if (epoch !== selectionEpoch) return;
    session = selected?.deleted ? null : selected;
    await populateMessageCounts(session);
    lastPage = null; await refreshStorage();
  } catch (error) { note(error.message); }
  finally { if (epoch === selectionEpoch) { uiBusy = false; render(); } }
});
(async () => {
  if(powerAvailable && (await B.call("powerStatus")).sleeping){enterSleep();return;}
  if(powerSleeping)return;
  await H.init();
  if(powerSleeping)return;
  // Start listening before opening/scanning storage. Fast chat loads must not be lost.
  H.listen({request:request => {
    if (readerMode === "direct") return; // The direct reader returns its body; do not process the same request twice.
    try {
      const match = new URL(request.request?.url).pathname.match(/^\/backend-api\/conversations?\/([0-9a-f-]+)$/i);
      if (match && C.isPagedHeadRequest(request.request.url, match[1])) {
        observedHeads.push(request); if (observedHeads.length > 30) observedHeads.shift();
      }
    } catch { /* Unrelated requests do not enter the capture buffer. */ }
    handleRequest(request).catch(e => stop(e.message));
  },navigate:url => {
    if(B.enabled)return; // The worker owns navigation protection and all capture lifecycle changes.
    if (!active) return;
    try { if (H.hasNetwork && waitingHead && !expectedURL && C.conversationFromPage(url) === session.conversation_id) { readerHeaders = null; headContext = null; setWatchdog(); return; } } catch { /* Navigation to another page is a pause. */ }
    void stop("原聊天标签已关闭、刷新或跳转，采集已暂停。回到原聊天后点击继续。", "paused");
  },changed:()=>{void refreshPageContext();},closed:pauseForClose,opened:reconnectBackground});
  db = await openDatabase();
  if(powerSleeping){db.close();db=null;return;}
  const sessions = await allSessions(); session = sessions[0] || null;
  await populateMessageCounts(session);
  await refreshList(); render(); void refreshPageContext();
  if(B.enabled){await syncBackground(true);pollBackground();}
})().catch(e => { $("detail").textContent = e.message; });
function pauseForClose() {
  if(B.enabled){viewClosed=true;clearTimeout(backgroundPoll);backgroundPoll=null;return;} // Closing a view never sends pause to the worker.
  if(active)void stop("备份面板已关闭，采集已暂停。已保存的数据可以下载或继续。","paused");
  else void releasePageReader();
}
function enterSleep(){
  if(powerSleeping)return;
  powerSleeping=true;viewClosed=true;contextEpoch++;requestEpoch++;
  clearTimeout(backgroundPoll);backgroundPoll=null;clearWatchdog();clearTimeout(pageReadTimer);pageReadTimer=null;
  active=false;organized=null;session=null;lastPage=null;storageSizes=null;
  observedHeads.length=0;readerHeaders=null;headContext=null;waitingHead=null;
  $("previewText").textContent="";$("log").textContent="";
  db?.close();db=null;
  globalThis.location?.replace(chrome.runtime.getURL("sleep.html"));
}
$("sleepPlugin").addEventListener("click",async()=>{
  if($("sleepPlugin").disabled)return;
  uiBusy=true;render("正在停止任务并保存检查点，随后进入休眠…");
  try {
    if(!B.enabled && active)await stop("插件已休眠；检查点已保存，重新打开后可继续。","paused");
    if(processing || unsavedEntry)throw new Error("仍有数据尚未保存，请先下载原始 JSON，再关闭插件。");
    await B.call("sleep");enterSleep();
  } catch(error){if(!powerSleeping){actionNotice=error.message;note(error.message);}}
  finally {uiBusy=false;if(!powerSleeping)render();}
});
chrome?.runtime?.onMessage?.addListener((message,sender)=>{
  if(message?.type==="chat-backup-power/v1" && message.sleeping && sender.id===chrome.runtime.id)enterSleep();
});
if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("pagehide",pauseForClose);
if (typeof globalThis.addEventListener === "function") globalThis.addEventListener("pageshow",reconnectBackground);
if(B.enabled && typeof document.addEventListener==="function")document.addEventListener("visibilitychange",()=>{if(!document.hidden && viewClosed)reconnectBackground();});
$("captureMethod").addEventListener("change",()=>{render();void refreshPageContext();});
// A hidden panel can still collect its bound ChatGPT tab. Only actual closure/navigation pauses it.
render();
