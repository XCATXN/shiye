(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ChatBackupCore = Object.freeze(api);
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
  function checkId(value) { if (typeof value !== "string" || !uuid.test(value)) fail("invalid_id", "消息或游标 ID 格式不受支持。"); return value; }
  function conversationFromPage(url) {
    const u = new URL(url);
    if (u.origin !== "https://chatgpt.com" || u.username || u.password) fail("wrong_page", "请先打开已登录的 ChatGPT 聊天页面。");
    const match = u.pathname.match(/\/c\/([0-9a-f-]+)\/?$/i);
    if (!match) fail("wrong_page", "当前页面不是一条具体聊天。");
    return checkId(match[1]);
  }
  function isConversationRequest(url, cid) {
    try {
      const u = new URL(url), prefixes = [`/backend-api/conversation/${cid}`, `/backend-api/conversations/${cid}`];
      return u.origin === "https://chatgpt.com" && !u.username && !u.password && prefixes.some(p => u.pathname === p || u.pathname.startsWith(p + "/"));
    } catch { return false; }
  }
  function requestURL(cid, before) {
    checkId(cid); checkId(before);
    return `https://chatgpt.com/backend-api/conversations/${cid}/messages?` + new URLSearchParams({before, include_has_versions: "true", num_turns: "10"});
  }
  function pagedHeadURL(cid) {
    checkId(cid);
    return `https://chatgpt.com/backend-api/conversations/${cid}?include_has_versions=true&num_turns=10`;
  }
  function fullRequestURL(cid) {
    checkId(cid);
    return `https://chatgpt.com/backend-api/conversation/${cid}?include_full_conversation=true`;
  }
  function isFullRequest(url, cid) {
    try {
      const u = new URL(url);
      return u.origin === "https://chatgpt.com" && !u.username && !u.password && !u.hash &&
        u.pathname === `/backend-api/conversation/${cid}` &&
        [...u.searchParams].length === 1 && u.searchParams.get("include_full_conversation") === "true";
    } catch { return false; }
  }
  function isPagedHeadRequest(url, cid) {
    try {
      const u = new URL(url);
      return u.origin === "https://chatgpt.com" && !u.username && !u.password && !u.hash &&
        [`/backend-api/conversations/${cid}`, `/backend-api/conversation/${cid}`].includes(u.pathname) &&
        !u.searchParams.has("before") && !u.searchParams.has("after") && !hasFullRequestFlag(url, cid);
    } catch { return false; }
  }
  function hasFullRequestFlag(url, cid) {
    try {
      const u = new URL(url);
      return isConversationRequest(url, cid) && u.searchParams.getAll("include_full_conversation").some(v => v !== "false");
    } catch { return false; }
  }
  function selectObservedHead(entries, cid) {
    return [...(entries || [])].reverse().filter(r => r?.request?.method === "GET" && r.response?.status === 200 &&
      isPagedHeadRequest(r.request.url, cid)).sort((a,b) =>
      (Date.parse(b.startedDateTime) || 0) - (Date.parse(a.startedDateTime) || 0))[0] || null;
  }
  function failureMetadata(request, cid) {
    if (!request?.request || !isConversationRequest(request.request.url, cid)) fail("wrong_failure_scope", "错误记录不属于当前聊天。");
    const headers = {};
    for (const h of request.response?.headers || []) {
      const name = String(h.name).toLowerCase();
      if (["content-type", "cf-mitigated", "retry-after", "x-request-id"].includes(name)) headers[name] = h.value;
    }
    return {status: request.response?.status ?? 0, request_url: safeRequestURL(request.request.url),
      started_at: request.startedDateTime || null, response_headers: headers,
      phase: isFullRequest(request.request.url, cid) ? "full_request" : (isPagedHeadRequest(request.request.url, cid) ? "head_request" : "pagination_request")};
  }
  function beforeFromRequest(url, cid) {
    const u = new URL(url);
    if (u.origin !== "https://chatgpt.com" || u.username || u.password || u.hash || u.pathname !== `/backend-api/conversations/${cid}/messages`) fail("wrong_request", "不是所选聊天的分页请求。");
    const pairs = [...u.searchParams], names = pairs.map(x => x[0]);
    if (pairs.length !== 3 || new Set(names).size !== 3 || !["before", "include_has_versions", "num_turns"].every(k => names.includes(k))) fail("unknown_query", "分页参数发生变化，需要复核。");
    if (u.searchParams.get("num_turns") !== "10" || u.searchParams.get("include_has_versions") !== "true") fail("unknown_query", "分页参数与已验证样本不同。");
    return checkId(u.searchParams.get("before"));
  }
  function safeRequestURL(url) {
    const u = new URL(url), query = new URLSearchParams();
    for (const [k,v] of u.searchParams) if (["before", "include_has_versions", "include_has_variations", "include_full_conversation", "include_message_id", "num_turns"].includes(k)) query.append(k,v);
    return u.origin + u.pathname + (query.size ? "?" + query : "");
  }
  function inspectPage(page, cid) {
    if (!page || !Array.isArray(page.messages) || !page.page_info) fail("unsupported_response", "响应结构与样本不同；已停止。");
    if (page.conversation_id != null && page.conversation_id !== cid) fail("different_conversation", "响应属于其他聊天。");
    if (page.id != null && page.id !== cid) fail("different_conversation", "响应含冲突的聊天 ID。");
    const info = page.page_info;
    if (typeof info.has_previous_page !== "boolean" || typeof info.has_next_page !== "boolean") fail("missing_flags", "响应缺少明确分页标记。");
    const ids = page.messages.map(m => checkId(m && m.id));
    if (!ids.length) fail("empty_page", "返回空页，不能作为完整性证明。");
    if (new Set(ids).size !== ids.length) fail("duplicate_id", "一页中出现重复消息 ID。");
    checkId(info.start_cursor); checkId(info.end_cursor);
    if (!ids.includes(info.start_cursor) || !ids.includes(info.end_cursor)) fail("missing_boundary", "页边界消息未出现在本页。");
    return {start: info.start_cursor, end: info.end_cursor, previous: info.has_previous_page, next: info.has_next_page, ids};
  }
  function validatePair(later, earlier, cid, requestUrl, seen) {
    const a = inspectPage(later, cid), b = inspectPage(earlier, cid), before = beforeFromRequest(requestUrl, cid);
    if (!a.previous || before !== a.start) fail("cursor_mismatch", "请求游标没有衔接上一份响应。");
    if (b.start === before) fail("cursor_stalled", "游标没有前进；不能把重复页当成新页。");
    if (seen.includes(b.start)) fail("cursor_cycle", "出现已访问游标，已停止循环。");
    if (!b.ids.some(id => !a.ids.includes(id))) fail("no_new_messages", "这一页没有新增消息。");
    return b;
  }
  function stable(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
  }
  function payload(message) {
    return {content: message.content ?? null, role: message.author?.role ?? null,
      name: message.author?.name ?? null, create_time: message.create_time ?? null};
  }
  function headSignatureInput(page) {
    return stable({current_node: page.current_node ?? null, end_cursor: page.page_info?.end_cursor,
      messages: page.messages.map(m => ({id:m.id, ...payload(m)}))});
  }
  function emptyTextIds(messages) {
    return messages.filter(m => ["user", "assistant"].includes(m.author?.role) &&
      m.content?.content_type === "text" && Array.isArray(m.content.parts) &&
      m.content.parts.every(p => typeof p === "string" && p.trim() === "")).map(m => m.id);
  }
  function inspectFullConversation(value, cid) {
    if (!value || (value.conversation_id ?? value.id) !== cid) fail("different_conversation", "完整结构响应的聊天 ID 不匹配。");
    if (value.id != null && value.id !== cid) fail("different_conversation", "完整结构响应含冲突的聊天 ID。");
    const mapping = value.mapping;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || !Object.keys(mapping).length) fail("no_full_mapping", "接口没有返回非空 mapping，不能当作完整结构。");
    if (value.page_info?.has_previous_page || value.page_info?.has_next_page || value.is_partial === true || value.truncated === true) fail("partial_mapping", "响应仍标记为部分数据。");
    const keys = Object.keys(mapping), children = new Map(keys.map(k => [k, []])), roots = [], messages = [], messageIds = new Set();
    for (const key of keys) {
      const node = mapping[key];
      if (!node || typeof node !== "object" || node.id !== key || !Object.hasOwn(node, "parent")) fail("invalid_node", "mapping 节点缺少一致的 ID 或明确父节点。");
      if (node.parent === null) roots.push(key);
      else if (!children.has(node.parent)) fail("missing_parent", "mapping 中存在未返回的父节点。");
      else children.get(node.parent).push(key);
      if (node.message != null) {
        const id = checkId(node.message.id);
        if (messageIds.has(id)) fail("duplicate_message_id", "mapping 中存在重复消息 ID。");
        messageIds.add(id); messages.push(node.message);
      }
    }
    if (roots.length !== 1) fail("invalid_roots", "mapping 没有唯一根节点。");
    for (const key of keys) {
      const node = mapping[key];
      if (node.children !== undefined && (!Array.isArray(node.children) || new Set(node.children).size !== node.children.length ||
          node.children.length !== children.get(key).length || node.children.some(c => !children.get(key).includes(c)))) fail("children_mismatch", "mapping 的父子关系相互矛盾。");
    }
    const visited = new Set(), stack = [roots[0]];
    while (stack.length) {
      const key = stack.pop();
      if (visited.has(key)) fail("graph_cycle", "mapping 存在循环。");
      visited.add(key); stack.push(...children.get(key));
    }
    if (visited.size !== keys.length) fail("unreachable_nodes", "mapping 有不能从根节点到达的节点。");
    if (typeof value.current_node !== "string" || !Object.hasOwn(mapping, value.current_node)) fail("missing_current_node", "mapping 中缺少当前节点。");
    const currentPath = new Set(); let node = value.current_node;
    while (node !== null) { currentPath.add(node); node = mapping[node].parent; }
    return {nodes: keys.length, messages: messages.length,
      branch_points: [...children.values()].filter(v => v.length > 1).length,
      off_current_path_nodes: keys.length - currentPath.size,
      empty_text_ids: emptyTextIds(messages), structure_valid: true,
      reference_coverage_verified: false, complete_server_history_verified: false};
  }
  function fullSignatureInput(value) {
    const mapping = Object.create(null);
    for (const [id, node] of Object.entries(value.mapping)) mapping[id] = {
      id: node.id, parent: node.parent, children: node.children ?? null,
      message: node.message == null ? null : {id: node.message.id, ...payload(node.message)}};
    return stable({current_node: value.current_node, mapping});
  }
  function replayHeaders(headers) {
    const result = {};
    for (const entry of headers || []) {
      const name = String(entry.name).toLowerCase();
      if (name.startsWith(":") || /^(sec-|proxy-)/.test(name) || ["cookie", "host", "origin", "referer", "content-length", "accept-encoding", "connection", "user-agent", "if-none-match", "if-modified-since"].includes(name)) continue;
      result[entry.name] = entry.value;
    }
    return result;
  }
  function retryDelay(attempt, retryAfter, now = Date.now()) {
    let ms = Number(retryAfter) * 1000;
    if (retryAfter && !Number.isFinite(ms)) ms = Date.parse(retryAfter) - now;
    if (!retryAfter || !Number.isFinite(ms)) ms = 1500 * 2 ** attempt;
    return Math.min(60000, Math.max(1000, ms));
  }
  function serializedBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return "未统计";
    const units = ["B", "KB", "MB", "GB"];
    let amount = value, unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return `${unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
  }
  function canDeleteStoredSession(value) {
    return !!value && !value.deleted && ["paused", "error", "diagnosed", "route_complete", "mapping_complete", "full_complete","surface_complete","claude_complete","provider_complete"].includes(value.state);
  }
  return {fail, checkId, conversationFromPage, isConversationRequest, requestURL, pagedHeadURL, fullRequestURL, isFullRequest, hasFullRequestFlag, isPagedHeadRequest, selectObservedHead, failureMetadata, beforeFromRequest,
    safeRequestURL, inspectPage, validatePair, stable, payload, headSignatureInput, emptyTextIds,
    inspectFullConversation, fullSignatureInput, replayHeaders, retryDelay, serializedBytes, formatBytes, canDeleteStoredSession};
});
