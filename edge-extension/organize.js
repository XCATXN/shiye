(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"),require("./surface-core.js"),require("./claude-core.js"),require("./provider-core.js"));
  else root.ChatBackupOrganize = Object.freeze(factory(root.ChatBackupCore,root.ChatBackupSurfaceCore,root.ChatBackupClaudeCore,root.ChatBackupProviderCore));
})(typeof globalThis === "object" ? globalThis : this, function (C,S,A,D) {
  "use strict";
  const VERSION = "0.3.1";
  async function sha(text) {
    const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, "0")).join("");
  }
  function reject(message) { throw new Error(message); }
  function readingRecord(message) {
    if (!["user", "assistant"].includes(message.author?.role)) return false;
    if (message.metadata?.is_visually_hidden_from_conversation === true) return false;
    if (["thoughts", "reasoning_recap", "model_editable_context", "user_editable_context"].includes(message.content?.content_type)) return false;
    if (message.author.role === "assistant" &&
        (["analysis", "summary", "notification"].includes(message.channel) ||
         (message.recipient && message.recipient !== "all"))) return false;
    return true;
  }
  function headPage(page, cid) {
    const info = C.inspectPage(page, cid);
    if (info.next || (page.current_node != null && page.current_node !== info.end)) reject("首页没有指向最新页，无法可靠整理。");
    return info;
  }
  async function prepare(bundle, options = {}) {
    if(bundle?.schema==="chat-export-surface/v1")return S.prepare(bundle,options);
    if(bundle?.schema==="chat-export-claude/v1")return A.prepare(bundle,options);
    if(bundle?.schema==="chat-export-provider/v1")return D.prepare(bundle,options);
    const profile = options.profile || "reading";
    if (!["reading", "all"].includes(profile)) reject("不支持的整理范围。");
    const schema = bundle?.schema;
    if (!["chat-export-capture/v1", "chat-export-capture/v2", "chat-export-observed-mapping/v1"].includes(schema)) reject("这份记录是诊断或不支持的格式，没有可整理的聊天正文。");
    const cid = C.checkId(bundle.conversation_id);
    if (bundle.capture?.conversation_id && bundle.capture.conversation_id !== cid) reject("采集记录与聊天 ID 不一致。");
    if (!Array.isArray(bundle.pages) || !bundle.pages.length) reject("尚未保存聊天响应，可以先采集或继续已有记录。");
    const records = [...bundle.pages].sort((a,b) => a.sequence-b.sequence), sequences = new Set();
    const dataPages = [], rawSources = [], warnings = [];
    let head = null, mapping = null, mappingRecord = null, lastPage = null;
    let lastDataSequence = null, rechecked = false, skippedRechecks = 0, skippedRecheckMessages = 0;
    let offRouteCount = 0;
    const seenCursors = [];
    for (let index = 0; index < records.length; index++) {
      const r = records[index], req = r.request || {}, res = r.response || {};
      if (!Number.isInteger(r.sequence) || r.sequence < 0 || sequences.has(r.sequence)) reject("响应序号重复或无效，不能确定可靠顺序。");
      sequences.add(r.sequence);
      if (r.session_id && bundle.capture?.id && r.session_id !== bundle.capture.id) reject("响应混入了另一份采集记录。");
      if (req.method !== "GET" || req.headers || !C.isConversationRequest(req.url, cid)) reject("响应来源与当前聊天不一致，或含有不应导出的请求头。");
      if (typeof res.body_text !== "string" || await sha(res.body_text) !== res.body_sha256) reject(`第 ${r.sequence + 1} 份原始响应校验失败，请保留原始 JSON 复核。`);
      rawSources.push({sequence:r.sequence, kind:r.kind, accepted:r.accepted === true, request_url:C.safeRequestURL(req.url), body_sha256:res.body_sha256});
      if (r.accepted !== true) { warnings.push(`原始记录包含未通过的响应（序号 ${r.sequence}），整理结果仅使用已通过部分。`); continue; }
      if (res.status !== 200) reject("已接受的响应不是 HTTP 200。");
      let page;
      try { page = JSON.parse(res.body_text); } catch { reject("原始响应不是有效 JSON。"); }
      if (schema === "chat-export-capture/v1") {
        if (["head", "head_recheck"].includes(r.kind)) {
          if (!C.isPagedHeadRequest(req.url, cid)) reject("首页响应来源不受支持。");
          headPage(page, cid);
          if (r.kind === "head") {
            if (head) reject("存在多个采集起点，无法自动合并。");
            head = page;
          } else {
            if (!head || C.headSignatureInput(page) !== C.headSignatureInput(head)) reject("结束复核与首页正文不一致，请先核对原始文件。");
            rechecked = true; skippedRechecks++; skippedRecheckMessages += page.messages.length;
            continue;
          }
        } else if (r.kind === "previous") {
          if (!lastPage || r.validation?.parent_page_sequence !== lastDataSequence) reject("分页来源不连续，不能按时间猜测补齐。");
          C.validatePair(lastPage, page, cid, req.url, seenCursors);
        } else reject("存在未知的已接受响应类型，请先下载原始 JSON 复核。");
        const info = C.inspectPage(page, cid);
        seenCursors.push(info.start);
        dataPages.push({record:r, messages:page.messages});
        lastPage = page; lastDataSequence = r.sequence; rechecked = false;
      } else {
        if (r.kind === "full_bootstrap") continue;
        const initialKind = schema === "chat-export-capture/v2" ? "full" : "mapping";
        const normalSource = schema === "chat-export-capture/v2" ? C.isFullRequest(req.url,cid) : C.isPagedHeadRequest(req.url,cid);
        if (!normalSource || ![initialKind, initialKind + "_recheck"].includes(r.kind)) reject("消息结构的来源或响应类型不受支持。");
        const info = C.inspectFullConversation(page,cid);
        if (r.kind === initialKind) {
          if (mapping) reject("存在多个不同的结构快照，无法自动选择。");
          mapping = page; mappingRecord = r; offRouteCount = info.off_current_path_nodes;
        } else {
          if (!mapping || r.validation?.recheck_of_sequence !== mappingRecord.sequence || C.fullSignatureInput(mapping) !== C.fullSignatureInput(page)) reject("消息结构复核不一致，无法可靠整理。");
          rechecked = true; skippedRechecks++; skippedRecheckMessages += info.messages;
        }
      }
      if (options.onProgress) await options.onProgress(index + 1, records.length);
    }
    let ordered = [], complete = false;
    if (schema === "chat-export-capture/v1") {
      if (!head || !dataPages.length) reject("没有已通过校验的聊天数据页。");
      complete = C.inspectPage(lastPage,cid).previous === false && rechecked;
      for (const p of [...dataPages].reverse()) p.messages.forEach((m,i) => ordered.push({message:m, source:{response_sequence:p.record.sequence, message_index:i}}));
    } else {
      if (!mapping) reject("没有已通过校验的消息结构。");
      const route = []; let key = mapping.current_node;
      while (key !== null) {
        const n = mapping.mapping[key];
        if (n.message) route.push({message:n.message, source:{response_sequence:mappingRecord.sequence, node_id:key}});
        key = n.parent;
      }
      ordered = route.reverse(); complete = rechecked;
    }
    const claimsComplete = ["route_complete", "full_complete", "mapping_complete"].includes(bundle.capture?.state);
    if (claimsComplete && !complete) reject("记录标记为完成，但缺少最早边界或成功的结束复核。");
    if (!complete) warnings.push("这份采集尚未完成全部读取与结束复核，导出仅含当前已保存部分。");
    const unique = new Map(), provenance = Object.create(null);
    let overlaps = 0;
    for (const {message, source} of ordered) {
      C.checkId(message?.id);
      if (unique.has(message.id)) {
        if (C.stable(unique.get(message.id)) !== C.stable(message)) reject(`同一消息 ${message.id} 出现不同记录，不能静默去重。请核对原始 JSON。`);
        overlaps++;
      } else { unique.set(message.id,message); provenance[message.id] = []; }
      provenance[message.id].push(source);
    }
    const selected = [], filtered = [], filterCounts = {};
    for (const message of unique.values()) {
      if (profile === "all" || readingRecord(message)) selected.push(message);
      else {
        const category = `${message.author?.role || "unknown"}/${message.content?.content_type || "unknown"}/${message.channel || "none"}`;
        filterCounts[category] = (filterCounts[category] || 0) + 1;
        filtered.push({id:message.id,category,source_refs:provenance[message.id]});
      }
    }
    const emptyIds = C.emptyTextIds(selected);
    if (emptyIds.length) warnings.push(`发现 ${emptyIds.length} 条空正文，已保留消息位置及标记，未猜测或补写。`);
    const attachmentIds = selected.filter(m => (m.metadata?.attachments?.length || 0) > 0 || m.content?.content_type !== "text").map(m=>m.id);
    const retainedRefs = Object.create(null);
    for (const m of selected) retainedRefs[m.id] = provenance[m.id];
    return {
      schema:"chat-export-reading/v1", tool:{name:"单聊天备份",version:VERSION},
      conversation_id:cid, title:bundle.title || "聊天", messages:structuredClone(selected),
      source:{capture_id:bundle.capture?.id || null, capture_state:bundle.capture?.state || null,
        source_schema:schema, source_tool:bundle.tool || null, captured_at:bundle.capture?.updated_at || null,
        current_node:head?.current_node || mapping?.current_node || null, responses:rawSources},
      scope:{selected_route_only:true, profile, text_rewrites_resolved:false, attachments_downloaded:false,
        all_history_branches_verified:false, original_message_text_modified:false},
      checks:{raw_hashes_valid:true, order_from_source_links:true, capture_recheck_passed:complete},
      statistics:{raw_responses:records.length, data_pages:dataPages.length || 1, route_messages:unique.size,
        retained_messages:selected.length, filtered_messages:filtered.length,
        repeated_responses_removed:skippedRechecks, repeated_response_messages_removed:skippedRecheckMessages,
        overlapping_message_duplicates_removed:overlaps, total_duplicate_occurrences_removed:overlaps+skippedRecheckMessages,
        off_route_nodes_not_included:offRouteCount, empty_text_ids:emptyIds, attachment_or_non_text_ids:attachmentIds,
        filtered_by_category:filterCounts},
      provenance:retainedRefs, filtered_records:filtered, warnings:[...new Set(warnings)]
    };
  }
  function messageText(message) {
    const content = message.content;
    if (!content || typeof content !== "object") return "【原始响应未提供正文】";
    let text;
    if (Array.isArray(content.parts)) text = content.parts.map(p => typeof p === "string" ? p : `【非文本内容引用】\n${JSON.stringify(p,null,2)}`).join("\n");
    else if (typeof content.text === "string") text = content.text;
    else if (typeof content.content === "string") text = content.content;
    else text = `【${content.content_type || "非文本内容"} · 原始数据】\n${JSON.stringify(content,null,2)}`;
    if (!text.trim()) text += "【原始正文为空；未补写，请结合相邻消息或旧档核对】";
    if (message.metadata?.attachments?.length) text += `\n\n【附件引用 · 原文件未下载】\n${JSON.stringify(message.metadata.attachments,null,2)}`;
    return text;
  }
  function textBlock(message, index) {
    const roles = {user:"用户",assistant:"助手",system:"系统",tool:"工具",developer:"开发者"};
    let stamp = "";
    if (typeof message.create_time === "number" && Number.isFinite(message.create_time)) {
      const date = new Date(message.create_time*1000);
      if (Number.isFinite(date.valueOf())) stamp = ` · ${date.toISOString()}`;
    }
    return `【${index + 1} · ${roles[message.author?.role] || message.author?.role || "未知角色"}${stamp}】\n消息 ID：${message.id}\n\n${messageText(message)}`;
  }
  function toText(value) {
    const s = value.statistics;
    const surface=value.scope.capture_source==="rendered_page";
    const claude=value.scope.capture_source==="claude_conversation_api",provider=value.scope.capture_source==="provider_conversation_api";
    const providerName={deepseek:"DeepSeek",gemini:"Gemini"}[value.provider_id]||value.provider_id;
    const intro = [value.title, surface?"网页正文备份 · 完整性待核对":(claude?"Claude 会话接口备份 · 非官方账号导出":(provider?providerName+" 会话接口备份 · 非官方账号导出":"已整理的聊天原文 · 非剧情总结")), `聊天 ID：${value.conversation_id}`,
      `范围：${value.scope.selected_route_only===false?"接口返回轮次及候选回答":"当前路线"} · ${value.scope.profile === "reading" ? "正文与附件引用" : "全部记录类型"}`,
      `原始响应 ${s.raw_responses} 份；合并后 ${s.route_messages} 条；保留 ${s.retained_messages} 条；筛除辅助 ${s.filtered_messages} 条；去除重复 ${s.total_duplicate_occurrences_removed} 次。`,
      `${surface?"网页扫描及复核":"采集边界及结束复核"}：${value.checks.capture_recheck_passed ? (surface?"已结束，未验证服务端完整历史":"通过") : "未完成，当前仅为部分数据"}`,
      surface?"保留网页中取得的正文；未恢复隐藏内容和历史版本，附件仅保留引用。":(claude?"正文按接口的当前分支关系排列，原始文本块保留；附件保留接口提供的资料，未下载原文件。其他分支留在原始 JSON 中。":"保留原文、重写及纠错要求；未判断哪些旧稿作废，未恢复缺失历史版本，附件仅保留原始引用。"),
      ...value.warnings.map(w=>"注意："+w), ""].join("\n");
    return intro + "\n" + value.messages.map(textBlock).join("\n\n────────────────────────────────\n\n") + "\n";
  }
  function preview(value) {
    const indices = value.messages.length > 2 ? [0,1,value.messages.length-1] : value.messages.map((_,i)=>i);
    return indices.map((i,j) => `${j === 2 ? "……中间记录在下载文件中完整保留……\n\n" : ""}${textBlock(value.messages[i],i).slice(0,1000)}${textBlock(value.messages[i],i).length > 1000 ? "\n……（本条预览截断，下载保留全文）" : ""}`).join("\n\n────────────────────\n\n");
  }
  return {prepare,toText,preview,messageText,readingRecord};
});
