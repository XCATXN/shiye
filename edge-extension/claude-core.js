(function(root,factory){const api=typeof module==="object"&&module.exports?factory(require("./core.js"),require("./platforms.js")):factory(root.ChatBackupCore,root.ChatBackupPlatforms);if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupClaudeCore=Object.freeze(api);})(globalThis,function(C,P){
  "use strict";
  const SCHEMA="chat-export-claude/v1",REVALIDATION="claude-stored-recheck/v1";
  // Explicit sentinels only. Any other absent parent remains a real gap.
  const ROOTS=new Set(["00000000-0000-0000-0000-000000000000","00000000-0000-4000-8000-000000000000"]);
  const isRoot=value=>value===null||ROOTS.has(value);
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const warning="来源为 Claude 网页会话接口，保留接口返回的数据；未证明与官方账号导出等价，隐藏历史、未返回分支及附件原文件仍可能不在范围内。";
  function identity(value){const p=P.identify(value);if(p.provider_id!=="claude")throw new Error("不是 Claude 聊天来源。");return p;}
  function rawId(cid){if(typeof cid!=="string"||!cid.startsWith("claude:")||!UUID.test(cid.slice(7)))throw new Error("Claude 聊天标识无效。");return cid.slice(7);}
  function requestInfo(value,cid){
    try{
      const u=new URL(value),m=u.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)$/);
      if(u.origin!=="https://claude.ai"||u.username||u.password||u.hash||!m||!UUID.test(m[1])||m[2]!==rawId(cid))return null;
      const fields=[...u.searchParams];if(fields.length!==3||new Set(fields.map(x=>x[0])).size!==3||u.searchParams.get("tree")!=="true"||u.searchParams.get("rendering_mode")!=="messages"||u.searchParams.get("render_all_tools")!=="true")return null;
      return {url:u.href,organization:m[1]};
    }catch{return null;}
  }
  const hasFiles=m=>!!(m.files?.length||m.attachments?.length);
  const auxiliary=b=>["thinking","redacted_thinking","tool_result"].includes(b.type)||(b.type==="tool_use"&&!["artifacts","create_file","visualize:show_widget"].includes(b.name));
  function contentParts(m,profile="reading"){
    if(m.content.length)return m.content.filter(b=>profile==="all"||!auxiliary(b)).map(b=>b.type==="text"?b.text:structuredClone(b));
    return typeof m.text==="string"?[m.text]:[];
  }
  function readingRecord(m){return ["human","assistant"].includes(m.sender)&&m.is_hidden!==true&&m.metadata?.is_visually_hidden_from_conversation!==true&&
    (hasFiles(m)||!m.content.length||m.content.some(b=>!auxiliary(b)));}
  function inspect(data,cid){
    const id=rawId(cid);
    if(!data||typeof data!=="object"||Array.isArray(data)||!Array.isArray(data.chat_messages)||!data.chat_messages.length||data.chat_messages.length>100000)throw new Error("Claude 响应未提供可识别的消息树，原始数据已保留。");
    if(data.uuid!=null&&data.uuid!==id)throw new Error("Claude 响应属于另一条聊天，已停止。");
    if(data.has_more===true||data.has_previous_page===true||data.is_partial===true||data.truncated===true||data.page_info?.has_previous_page===true||data.page_info?.has_next_page===true||data.pagination?.has_more===true)throw new Error("Claude 响应表明还有未返回的内容，不能标记会话读取完成。");
    if(data.is_streaming===true||data.is_generating===true)throw new Error("Claude 仍在生成回答，请结束后重新采集。");
    const nodes=new Map(),children=new Map();
    for(const m of data.chat_messages){
      if(!m||!UUID.test(m.uuid||"")||isRoot(m.uuid)||nodes.has(m.uuid))throw new Error("Claude 消息编号缺失或重复，已停止。");
      if(!Object.hasOwn(m,"parent_message_uuid")||(m.parent_message_uuid!==null&&!UUID.test(m.parent_message_uuid||"")))throw new Error("Claude 消息缺少可靠的父节点，不能猜测顺序。");
      if(typeof m.sender!=="string"||!m.sender||!Array.isArray(m.content)||m.content.some(b=>!b||typeof b!=="object"||typeof b.type!=="string"||(b.type==="text"&&typeof b.text!=="string")))throw new Error("Claude 消息字段不完整，原始数据已保留。");
      if((m.files!=null&&!Array.isArray(m.files))||(m.attachments!=null&&!Array.isArray(m.attachments)))throw new Error("Claude 附件字段格式变化，原始数据已保留。");
      if(m.is_streaming===true||["streaming","in_progress"].includes(m.status))throw new Error("Claude 仍在生成回答，请结束后重新采集。");
      nodes.set(m.uuid,m);children.set(m.uuid,[]);
    }
    for(const m of nodes.values()){
      const parent=m.parent_message_uuid;if(isRoot(parent))continue;
      if(!nodes.has(parent))throw new Error("Claude 消息树存在缺失的父节点，已停止，避免漏段。");
      children.get(parent).push(m.uuid);
    }
    const done=new Set();
    for(const start of nodes.keys()){
      let key=start;const path=new Set();
      while(!isRoot(key)&&!done.has(key)){if(path.has(key))throw new Error("Claude 消息树存在循环，无法确定顺序。");path.add(key);key=nodes.get(key).parent_message_uuid;}
      for(const item of path)done.add(item);
    }
    const leaf=data.current_leaf_message_uuid;if(!UUID.test(leaf||"")||!nodes.has(leaf))throw new Error("Claude 响应缺少当前分支终点，不能按时间猜测路线。");
    const route=[];for(let key=leaf;!isRoot(key);key=nodes.get(key).parent_message_uuid)route.push(nodes.get(key));route.reverse();
    const reading=route.filter(readingRecord),emptyIds=reading.filter(m=>!contentParts(m).some(v=>typeof v==="string"&&v.trim())).map(m=>m.uuid);
    return {nodes,route,current_leaf:leaf,record_count:nodes.size,route_count:route.length,reading_count:reading.length,auxiliary_count:route.length-reading.length,
      off_route_count:nodes.size-route.length,branch_points:[...children.values()].filter(v=>v.length>1).length,empty_text_ids:emptyIds,
      truncated_ids:route.filter(m=>m.truncated===true).map(m=>m.uuid),interrupted_ids:route.filter(m=>m.stop_reason==="user_canceled").map(m=>m.uuid)};
  }
  function signature(data,cid){const info=inspect(data,cid);return C.stable({uuid:rawId(cid),name:data.name,model:data.model,current_leaf_message_uuid:info.current_leaf,chat_messages:[...info.nodes.values()].sort((a,b)=>a.uuid.localeCompare(b.uuid))});}
  async function sha(value){return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,"0")).join("");}
  function bundleIdentity(bundle){
    if(bundle?.schema!==SCHEMA)throw new Error("不是 Claude 会话数据格式。");
    const expected=identity(bundle.capture?.source_url);
    if(bundle.provider_id!=="claude"||bundle.conversation_id!==expected.conversation_id||bundle.capture.conversation_id!==expected.conversation_id)throw new Error("Claude 导出来源不一致。");
    return expected;
  }
  async function checkEntry(p,bundle,seen){
    if(!Number.isInteger(p.sequence)||p.sequence<0||seen.has(p.sequence)||p.session_id!==bundle.capture.id)throw new Error("Claude 原始响应序号或记录来源不一致。");seen.add(p.sequence);
    if(p.request?.method!=="GET"||p.request.headers||!requestInfo(p.request.url,bundle.conversation_id)||typeof p.response?.body_text!=="string"||await sha(p.response.body_text)!==p.response.body_sha256)throw new Error("Claude 原始响应来源或正文校验失败。");
  }
  // Reinterpret saved evidence without modifying its body, hash or old verdict.
  async function reviewStored(bundle){
    const {conversation_id:cid}=bundleIdentity(bundle),seen=new Set(),sources=[];
    let first=null,info=null,firstURL=null,baseline=null;
    for(const p of [...(bundle.pages||[])].sort((a,b)=>a.sequence-b.sequence)){
      await checkEntry(p,bundle,seen);
      if(p.response.status!==200){if(p.accepted===true)throw new Error("已接受的 Claude 响应不是 HTTP 200。");continue;}
      if(!["claude_tree","claude_recheck","claude_rejected"].includes(p.kind))throw new Error("不支持重新校验这类 Claude 响应。");
      const data=JSON.parse(p.response.body_text),current=inspect(data,cid),value=signature(data,cid);
      if(first&&(p.request.url!==firstURL||value!==baseline))throw new Error("已保存的 Claude 响应内容或分支不一致，不能合并为通过。");
      if(!first){first=data;info=current;firstURL=p.request.url;baseline=value;}
      sources.push({sequence:p.sequence,body_sha256:p.response.body_sha256});
    }
    if(!first)throw new Error("没有可重新校验的 HTTP 200 会话数据。");
    return {data:first,info,evidence:{schema:REVALIDATION,tool_version:"0.9.0",checked_at:new Date().toISOString(),sources,
      baseline_sequence:sources[0].sequence,matching_responses:sources.length,rechecked:sources.length>=2}};
  }
  function normalize(m,profile){
    const time=typeof m.created_at==="string"?Date.parse(m.created_at):NaN;
    return {id:m.uuid,author:{role:m.sender==="human"?"user":m.sender},channel:readingRecord(m)?"final":"analysis",
      ...(Number.isFinite(time)?{create_time:time/1000}:{}),content:{content_type:"text",parts:contentParts(m,profile)},
      metadata:{capture_source:"claude_conversation_api",source_sender:m.sender,parent_message_uuid:m.parent_message_uuid,
        attachments:[...structuredClone(m.files||[]),...structuredClone(m.attachments||[])],truncated:m.truncated===true,stop_reason:m.stop_reason??null,
        ...(profile==="all"?{source_record:structuredClone(m)}:{})}};
  }
  async function prepare(bundle,options={}){
    const expected=bundleIdentity(bundle),cid=expected.conversation_id,profile=options.profile||"reading";
    if(bundle.provider_id!=="claude"||bundle.conversation_id!==cid||bundle.capture.conversation_id!==cid||!["reading","all"].includes(profile))throw new Error("Claude 导出来源或整理范围不一致。");
    const pages=[...(bundle.pages||[])].sort((a,b)=>a.sequence-b.sequence),seen=new Set(),sources=[],warnings=[warning];
    const recovered=new Set(),evidence=bundle.capture.revalidation;
    if(evidence){
      if(evidence.schema!==REVALIDATION||!Array.isArray(evidence.sources)||!evidence.sources.length)throw new Error("Claude 重新校验证据格式无效。");
      const wanted=new Set(evidence.sources.map(s=>s.sequence));
      const selected=pages.filter(p=>wanted.has(p.sequence));
      if(wanted.size!==evidence.sources.length||selected.length!==wanted.size)throw new Error("Claude 重新校验证据缺少对应响应。");
      const verified=await reviewStored({...bundle,pages:selected});
      if(C.stable(verified.evidence.sources)!==C.stable(evidence.sources)||verified.evidence.baseline_sequence!==evidence.baseline_sequence)throw new Error("Claude 重新校验证据与原始响应不一致。");
      for(const sequence of wanted)recovered.add(sequence);
      warnings.push("部分响应已用新版规则重新校验；原始响应和当时的判定保持不变。");
    }
    let first=null,firstSequence=null,firstURL=null,rechecked=false,repeated=0,info=null,lastFromStored=false,capturedAt=null;
    for(const [i,p] of pages.entries()){
      await checkEntry(p,bundle,seen);
      const fromStored=recovered.has(p.sequence),kind=fromStored?(p.sequence===evidence.baseline_sequence?"claude_tree":"claude_recheck"):p.kind;
      sources.push({sequence:p.sequence,kind,accepted:p.accepted===true||fromStored,request_url:p.request.url,body_sha256:p.response.body_sha256,
        ...(fromStored?{original_kind:p.kind,original_accepted:p.accepted===true,validated_from_saved_response:true}:{})});
      if(p.accepted!==true&&!fromStored){warnings.push("包含未通过校验的响应，本次整理仅使用已保存且结构有效的数据。");continue;}
      if(p.response.status!==200)throw new Error("Claude 已接受的响应不是 HTTP 200。");
      const data=JSON.parse(p.response.body_text),current=inspect(data,cid);
      if(kind==="claude_tree"){
        if(first)throw new Error("存在多个 Claude 采集起点，不能自动混合。");
        first=data;info=current;firstSequence=p.sequence;firstURL=p.request.url;
      }else if(kind==="claude_recheck"){
        if(!first||p.request.url!==firstURL||(!fromStored&&p.validation?.recheck_of_sequence!==firstSequence)||signature(data,cid)!==signature(first,cid))throw new Error("Claude 两次会话数据不一致，已保留原始响应。");
        rechecked=true;repeated+=current.record_count;
      }else throw new Error("不支持的 Claude 响应类型。");
      lastFromStored=fromStored;capturedAt=p.response.received_at||capturedAt;
      if(options.onProgress)await options.onProgress(i+1,pages.length);
    }
    if(!first)throw new Error("尚无通过结构校验的 Claude 会话数据，请先下载原始 JSON 查看原因。");
    if(bundle.capture.state==="claude_complete"&&!rechecked)throw new Error("Claude 记录缺少成功的结束复核。");
    if(!rechecked)warnings.push("会话数据尚未完成第二次读取复核，本次导出标记为未复核。");
    if(lastFromStored)warnings.push("本次使用已保存的会话响应，数据对应原采集时间，未重新访问当前网页。");
    if(info.empty_text_ids.length)warnings.push(`当前路线有 ${info.empty_text_ids.length} 条空正文，位置及附件资料已保留。`);
    if(info.truncated_ids.length)warnings.push(`接口将 ${info.truncated_ids.length} 条消息标为 truncated，原始标记已保留，需要核对。`);
    if(info.interrupted_ids.length)warnings.push(`${info.interrupted_ids.length} 条回答由用户停止生成，已按接口返回内容保留。`);
    const selected=info.route.filter(m=>profile==="all"||readingRecord(m)),filtered=info.route.filter(m=>!selected.includes(m));
    const messages=selected.map(m=>normalize(m,profile));
    const unknownTypes=[...new Set(info.route.flatMap(m=>m.content.map(b=>b.type)).filter(t=>!["text","thinking","redacted_thinking","tool_use","tool_result","image","document"].includes(t)))];
    if(unknownTypes.length)warnings.push("部分非文本内容类型尚未专门适配，已按原始结构保留："+unknownTypes.join("、"));
    if(info.route.some(m=>!["human","assistant"].includes(m.sender)))warnings.push("出现其他消息角色；正文模式筛除，全部记录模式及原始 JSON 保留。");
    return {schema:"chat-export-reading/v1",tool:{name:"拾页",version:"0.9.0"},provider_id:"claude",conversation_id:cid,title:typeof first.name==="string"?first.name:bundle.title,messages,
      source:{capture_id:bundle.capture.id,capture_state:bundle.capture.state,source_schema:SCHEMA,captured_at:capturedAt||bundle.capture.updated_at,revalidated_at:evidence?.checked_at||null,baseline_sequence:firstSequence,current_node:info.current_leaf,responses:sources},
      scope:{capture_source:"claude_conversation_api",selected_route_only:true,profile,official_json:false,official_export_equivalent:false,all_history_branches_verified:false,attachments_downloaded:false,original_text_blocks_preserved:true,model_rewritten:false},
      checks:{raw_hashes_valid:true,order_from_source_links:true,selected_route_root_reached:true,capture_recheck_passed:rechecked,recheck_source:lastFromStored?"stored_responses":"live_response"},
      statistics:{raw_responses:pages.length,data_pages:1,route_messages:info.route_count,returned_tree_messages:info.record_count,retained_messages:messages.length,filtered_messages:filtered.length,
        repeated_responses_removed:sources.filter(s=>s.accepted&&s.kind==="claude_recheck").length,repeated_response_messages_removed:repeated,overlapping_message_duplicates_removed:0,total_duplicate_occurrences_removed:repeated,
        off_route_nodes_not_included:info.off_route_count,empty_text_ids:messages.filter(m=>!m.content.parts.some(p=>typeof p==="string"&&p.trim())).map(m=>m.id),attachment_or_non_text_ids:messages.filter(m=>m.metadata.attachments.length||m.content.parts.some(p=>typeof p!=="string")).map(m=>m.id),filtered_by_category:{"auxiliary":filtered.length}},
      provenance:Object.fromEntries(selected.map(m=>[m.uuid,[{response_sequence:firstSequence,message_id:m.uuid}]])),filtered_records:filtered.map(m=>({id:m.uuid,category:m.sender,source_refs:[{response_sequence:firstSequence,message_id:m.uuid}]})),warnings};
  }
  return {SCHEMA,warning,identity,rawId,requestInfo,readingRecord,inspect,signature,sha,reviewStored,prepare};
});
