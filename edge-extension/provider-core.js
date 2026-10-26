(function(root,factory){const api=typeof module==="object"&&module.exports?factory(require("./core.js"),require("./platforms.js")):factory(root.ChatBackupCore,root.ChatBackupPlatforms);if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupProviderCore=Object.freeze(api);})(globalThis,function(C,P){
  "use strict";
  const SCHEMA="chat-export-provider/v1",VERSION="0.9.0";
  const clone=x=>structuredClone(x),sha=async text=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,"0")).join("");
  function identity(url){const value=P.identify(url);if(!["deepseek","gemini"].includes(value.provider_id))throw new Error("不支持该平台的结构化会话读取。");return value;}
  function rawId(expected){return expected.conversation_id.slice(expected.provider_id.length+1);}
  function validCursor(value){return value===null||(typeof value==="string"&&value.startsWith("tC")&&value.length<=65536&&!/[\x00-\x1f]/.test(value));}
  function requestValid(req,expected){
    if(!req||req.headers||req.body||req.conversation_id!==expected.conversation_id||!Object.hasOwn(req,"cursor")||!validCursor(req.cursor))return false;
    const id=rawId(expected);
    if(expected.provider_id==="deepseek")return req.method==="GET"&&req.cursor===null&&req.url==="https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id="+id;
    const slot=new URL(expected.source_url).pathname.match(/^\/u\/(\d+)\//)?.[1]||"";
    return req.method==="POST"&&req.rpc==="hNvQHb"&&req.page_size===10&&req.account_slot===(slot||"0")&&req.url==="https://gemini.google.com"+(slot?"/u/"+slot:"")+"/_/BardChatUi/data/batchexecute?rpcids=hNvQHb";
  }
  function record(id,role,parts,source,extra={}){return {id,author:{role},channel:["user","assistant"].includes(role)?"final":"analysis",content:{content_type:"text",parts},metadata:{source_record:source,...extra}};}
  function deepseek(raw,expected){
    const envelope=JSON.parse(raw),biz=envelope?.data;
    if((envelope.code!==undefined&&envelope.code!==0)||biz?.biz_code!==0)throw new Error("DeepSeek 未返回成功的历史消息结果，原始响应已保留。");
    const data=biz.biz_data,session=data?.chat_session,rows=data?.chat_messages;
    if(!session||!Array.isArray(rows)||!rows.length||rows.length>100000)throw new Error("DeepSeek 历史消息格式变化或为空。");
    for(const key of ["id","chat_session_id"])if(session[key]!=null&&session[key]!==rawId(expected))throw new Error("DeepSeek 返回了另一条聊天。");
    if(data.has_more===true||data.has_previous_page===true||data.page_info?.has_previous_page===true)throw new Error("DeepSeek 响应还有未返回的历史，当前不能判定读取结束。");
    const key=value=>{if((Number.isSafeInteger(value)&&value>=0)||(typeof value==="string"&&/^(0|[1-9]\d*)$/.test(value)))return String(value);throw new Error("DeepSeek 消息编号格式不受支持。");};
    const nodes=new Map(),parents=new Map(),children=new Map(),warnings=[];
    for(const m of rows){
      const id=key(m.message_id);if(nodes.has(id)||!Object.hasOwn(m,"parent_id"))throw new Error("DeepSeek 消息编号重复或缺少父节点。");
      const role=typeof m.role==="string"?m.role.toLowerCase():"";if(!["user","assistant","system","tool"].includes(role))throw new Error("DeepSeek 消息角色格式变化，原始响应已保留。");
      if((m.attachments!=null&&!Array.isArray(m.attachments))||(m.files!=null&&!Array.isArray(m.files)))throw new Error("DeepSeek 附件结构变化，原始响应已保留。");
      if(m.status==="WIP"||m.has_pending_fragment===true)throw new Error("DeepSeek 仍有未完成的生成片段，请生成结束后采集。");
      if(m.incomplete_message||m.status&&m.status!=="FINISHED")warnings.push(`消息 ${id} 的来源状态为 ${m.status||"incomplete"}，按返回内容保留，未补写。`);
      let parts=[],allParts=[];
      if(Array.isArray(m.fragments)&&m.fragments.length){
        for(const f of m.fragments){
          if(!f||typeof f.type!=="string")throw new Error("DeepSeek 消息片段字段不完整。");
          const text=["REQUEST","RESPONSE","TEMPLATE_RESPONSE"].includes(f.type);
          if(text&&typeof f.content!=="string")throw new Error("DeepSeek 正文片段不是文本，已停止避免丢失。");
          const value=text?f.content:clone(f);allParts.push(value);
          if(text||!["THINK","TOOL_SEARCH","TOOL_OPEN","TIP"].includes(f.type))parts.push(value);
        }
      }else if(typeof m.content==="string"){parts=[m.content];allParts=[m.content];}
      else if(m.fragments!=null&&!Array.isArray(m.fragments))throw new Error("DeepSeek 消息片段格式变化。");
      nodes.set(id,{message:record("deepseek:"+id,role,parts,clone(m),{source_message_id:id,parent_message_id:m.parent_id,attachments:[...clone(m.attachments||[]),...clone(m.files||[])],source_status:m.status||null,
        references:clone((m.fragments||[]).flatMap(f=>f.references||[])),citation_fragments:clone((m.fragments||[]).filter(f=>["TOOL_SEARCH","TOOL_OPEN"].includes(f.type)))}),allParts});
      parents.set(id,m.parent_id===null?null:key(m.parent_id));children.set(id,[]);
    }
    const root=p=>p===null||(p==="0"&&!nodes.has("0"));
    for(const [id,p] of parents){if(root(p))continue;if(!nodes.has(p))throw new Error("DeepSeek 消息树有缺失父节点，不能标记完整路线。");children.get(p).push(id);}
    const done=new Set();for(const start of nodes.keys()){let k=start;const seen=new Set();while(!root(k)&&!done.has(k)){if(seen.has(k))throw new Error("DeepSeek 消息树有循环。");seen.add(k);k=parents.get(k);}for(const k of seen)done.add(k);}
    const leaf=key(session.current_message_id);if(!nodes.has(leaf))throw new Error("DeepSeek 未提供有效的当前分支终点。");
    const ordered=[];for(let k=leaf;!root(k);k=parents.get(k))ordered.push(nodes.get(k));ordered.reverse();
    return {provider_id:"deepseek",records:[...nodes.values()],ordered,next_cursor:null,title:typeof session.title==="string"?session.title:null,
      branch_points:[...children.values()].filter(a=>a.length>1).length,off_route_count:nodes.size-ordered.length,warnings,
      signature:C.stable({leaf,rows:[...nodes.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,n])=>n.message.metadata.source_record)})};
  }
  // Parse complete JSON frames. A framing length is never used to slice or repair text.
  function frames(raw){
    let at=raw.startsWith(")]}'")?raw.indexOf("\n")+1:0;const result=[];
    while(at<raw.length){
      while(/\s/.test(raw[at]||"")&&at<raw.length)at++;if(at>=raw.length)break;
      const length=raw.slice(at).match(/^\d+\s*\r?\n/);if(length){at+=length[0].length;continue;}
      if(raw[at]!=="[")throw new Error("Gemini 响应帧格式变化，原文已保留。");
      const start=at;let depth=0,string=false,escape=false,closed=false;
      for(;at<raw.length;at++){const ch=raw[at];if(string){if(escape)escape=false;else if(ch==="\\")escape=true;else if(ch==='"')string=false;continue;}
        if(ch==='"')string=true;else if(ch==="["||ch==="{")depth++;else if(ch==="]"||ch==="}"){depth--;if(depth===0){at++;closed=true;break;}}}
      if(!closed)throw new Error("Gemini 响应帧被截断，不能继续整理。");result.push(JSON.parse(raw.slice(start,at)));
    }
    return result;
  }
  function candidateText(body){
    if(typeof body==="string")return body;
    if(Array.isArray(body)&&typeof body[0]==="string")return body[0];
    if(Array.isArray(body)&&Array.isArray(body[0])){
      const chunks=[];for(const p of body[0]){if(typeof p==="string")chunks.push(p);else if(Array.isArray(p)&&typeof p[0]==="string")chunks.push(p[0]);else if(p!==null)throw new Error("Gemini 正文中有未识别片段，已保留原始数据。");}
      return chunks.join("");
    }
    if(body==null)return "";throw new Error("Gemini 正文结构尚未适配，已保留原始数据。");
  }
  function gemini(raw,expected,req){
    const matches=[];
    function visit(x,depth=0){if(!Array.isArray(x)||depth>4)return;if(x[0]==="wrb.fr"){if(x[1]==="hNvQHb")matches.push(x);return;}for(const v of x)visit(v,depth+1);}
    for(const frame of frames(raw))visit(frame);
    if(matches.length!==1||typeof matches[0][2]!=="string")throw new Error("Gemini 没有返回唯一有效的会话详情结果。");
    const inner=JSON.parse(matches[0][2]);if(!Array.isArray(inner)||!Array.isArray(inner[0]))throw new Error("Gemini 返回的不是已适配的会话轮次结构。");
    const tokens=inner.slice(1).filter(x=>typeof x==="string"&&x.startsWith("tC"));if(new Set(tokens).size>1)throw new Error("Gemini 返回多个分页游标，不能猜测。");
    const next=tokens[0]||null;if(!validCursor(next))throw new Error("Gemini 分页游标格式不受支持。");
    const turns=inner[0],ordered=[],records=[],warnings=[],ids=new Set(),ambiguous=[];let nonText=false;
    if(!turns.length&&req.cursor===null)throw new Error("Gemini 首页没有可核对的消息。");
    const conv="c_"+rawId(expected),turnId=m=>{if(Array.isArray(m)){if(typeof m[0]==="string"&&m[0].startsWith("c_")&&m[0]!==conv)throw new Error("Gemini 响应混入另一条聊天。");return typeof m[1]==="string"&&m[1].startsWith("r_")?m[1]:m[0];}return m;};
    const add=(m,allParts=m.content.parts)=>{if(ids.has(m.id))throw new Error("Gemini 同一页重复消息编号。");ids.add(m.id);const n={message:m,allParts};ordered.push(n);records.push(n);};
    for(const turn of [...turns].reverse()){
      if(!Array.isArray(turn)||!Array.isArray(turn[2]))throw new Error("Gemini 有无法识别的轮次，已停止，避免跳过正文。");
      const rid=turnId(turn[0]);if(typeof rid!=="string"||!/^r_[a-zA-Z0-9_-]{1,128}$/.test(rid))throw new Error("Gemini 轮次缺少稳定编号。");
      const u=turn[2][0],text=typeof u==="string"?u:(Array.isArray(u)&&typeof u[0]==="string"?u[0]:null);
      if(text===null)throw new Error("Gemini 提问正文结构尚未适配。");
      const userExtras=[...(Array.isArray(u)?u.slice(1):[]),...turn[2].slice(1)];add(record("gemini:"+rid+":user","user",[text],clone(turn[2]),{source_turn_id:rid,source_id_metadata:clone(turn[0]),source_timestamp:clone(turn[1]),source_user_payload:clone(turn[2]),attachments:userExtras.some(v=>v!=null)?[{kind:"gemini_user_payload",data:clone(userExtras)}]:[]}));
      let candidates=turn[3]?.[0];if(Array.isArray(candidates)&&typeof candidates[0]==="string")candidates=[candidates];
      if(!Array.isArray(candidates))throw new Error("Gemini 回答节点格式变化。");
      if(candidates.length>1){ambiguous.push(rid);warnings.push("轮次 "+rid+" 返回多个候选回答，当前选中版本尚未核验。");}
      if(!candidates.length)warnings.push("轮次 "+rid+" 没有返回回答节点。");
      for(const [i,c] of candidates.entries()){
        if(!Array.isArray(c)||typeof c[0]!=="string"||!/^rc_[a-zA-Z0-9_-]{1,128}$/.test(c[0]))throw new Error("Gemini 回答缺少稳定编号。");
        const text=candidateText(c[1]),parts=[text],structured=i===0?turn[3]?.[12]:null;
        if(!text&&structured){parts.push({kind:"gemini_structured_content",data:clone(structured)});nonText=true;warnings.push("部分回答仅提供结构化非文本内容，已原样保留，正文需另行核对。");}
        add(record("gemini:"+c[0],"assistant",parts,clone(c),{source_turn_id:rid,source_timestamp:clone(turn[1]),candidate_index:i,candidate_count:candidates.length,source_model_payload:clone(turn[3]),attachments:[]}));
      }
    }
    return {provider_id:"gemini",records,ordered,next_cursor:next,branch_points:ambiguous.length,off_route_count:null,warnings,ambiguous,non_text:nonText,
      signature:C.stable(turns)};
  }
  function parse(raw,expected,req){if(!requestValid(req,expected))throw new Error("会话响应请求范围不一致。");return expected.provider_id==="deepseek"?deepseek(raw,expected):gemini(raw,expected,req);}
  function createState(expected){return {expected,head:null,headSequence:null,pending:null,ended:false,rechecked:false,records:new Map(),order:[],byCursor:new Map(),refs:new Map(),dataPages:0,duplicates:0,warnings:[],sources:[],seenSequences:new Set(),ambiguous:[],nonText:false,branchPoints:0,offRoute:null,title:null,lastDataSequence:null};}
  async function consume(state,entry,{recover=false}={}){
    const e=entry;
    if(!Number.isInteger(e.sequence)||e.sequence<0||state.seenSequences.has(e.sequence)||!requestValid(e.request,state.expected)||typeof e.response?.body_text!=="string"||await sha(e.response.body_text)!==e.response.body_sha256)throw new Error("会话响应序号、来源或哈希校验失败。");
    state.seenSequences.add(e.sequence);const source={sequence:e.sequence,kind:e.kind,accepted:e.accepted===true,body_sha256:e.response.body_sha256,request:clone(e.request)};
    state.sources.push(source);
    if(e.response.status!==200){if(e.accepted)throw new Error("接受的会话响应不是 HTTP 200。");state.warnings.push("包含请求失败的原始响应，整理只使用通过校验的数据。");return null;}
    if(!e.accepted&&!recover){state.warnings.push("包含未通过校验的响应，已保存但未合入正文。");return null;}
    const page=parse(e.response.body_text,state.expected,e.request),cursor=e.request.cursor;
    if(cursor===null&&state.head){
      if(page.signature!==state.head.signature)throw new Error("会话首页或消息树内容发生变化，已保留响应，请新建采集。");
      source.kind="api_head_recheck";source.accepted=true;state.duplicates+=page.records.length;
      if(state.ended)state.rechecked=true;return page;
    }
    if(cursor!==null&&state.byCursor.has(cursor)){
      if(page.signature!==state.byCursor.get(cursor).signature)throw new Error("同一分页游标返回了不同内容。");
      source.accepted=true;state.duplicates+=page.records.length;return page;
    }
    if(page.next_cursor!==null&&(page.next_cursor===cursor||state.byCursor.has(page.next_cursor)))throw new Error("会话分页游标出现循环，已停止。");
    if(cursor!==null&&(!state.head||cursor!==state.pending))throw new Error("会话分页未按已返回的游标衔接。");
    const existing=state.records,newOrder=[],overlap=[];
    for(const n of page.records){const old=existing.get(n.message.id);if(old&&C.stable(old.message)!==C.stable(n.message))throw new Error("同一消息的内容出现冲突，不能静默覆盖。");}
    for(const n of page.ordered){if(existing.has(n.message.id))overlap.push(n.message.id);else newOrder.push(n.message.id);}
    if(cursor!==null&&page.records.length&&!newOrder.length)throw new Error("分页没有新增消息，已停止避免重复循环。");
    // Cursor order is authoritative; overlapping boundary messages must preserve it.
    const mergedOrder=cursor===null?page.ordered.map(n=>n.message.id):[...newOrder,...state.order];
    const positions=new Map(mergedOrder.map((id,i)=>[id,i]));
    for(let i=1;i<page.ordered.length;i++)if(positions.get(page.ordered[i-1].message.id)>=positions.get(page.ordered[i].message.id))throw new Error("分页中的消息顺序冲突。");
    for(const [i,n] of page.records.entries()){if(!existing.has(n.message.id))existing.set(n.message.id,n);else state.duplicates++;const refs=state.refs.get(n.message.id)||[];refs.push({response_sequence:e.sequence,message_index:i});state.refs.set(n.message.id,refs);}
    if(cursor===null){state.head=page;state.headSequence=e.sequence;state.title=page.title||null;}
    state.byCursor.set(cursor,page);state.order=mergedOrder;state.pending=page.next_cursor;state.ended=page.next_cursor===null;state.rechecked=false;state.dataPages++;state.lastDataSequence=e.sequence;
    state.warnings.push(...page.warnings);state.ambiguous.push(...(page.ambiguous||[]));state.nonText ||= !!page.non_text;state.branchPoints+=page.branch_points||0;state.offRoute=page.off_route_count;source.accepted=true;
    if(recover&&e.accepted!==true){source.original_accepted=false;source.validated_from_saved_response=true;}
    return page;
  }
  function counts(state){const selected=state.order.map(id=>state.records.get(id).message),reading=selected.filter(m=>["user","assistant"].includes(m.author.role));return {record_count:state.records.size,route_count:selected.length,reading_count:reading.length,auxiliary_count:selected.length-reading.length,branch_points:state.branchPoints,off_route_count:state.offRoute,empty_text_ids:reading.filter(m=>!m.content.parts.some(p=>typeof p==="string"&&p.trim())).map(m=>m.id),review_warnings:[...new Set(state.warnings)],ambiguous_count:new Set(state.ambiguous).size,history_has_previous:!state.ended};}
  function savedRecovery(bundle){
    const evidence=bundle.capture?.revalidation;if(!evidence)return new Set();
    if(evidence.schema!=="provider-stored-recheck/v1"||!Array.isArray(evidence.sources)||!evidence.sources.length)throw new Error("重新校验证据格式无效。");
    const pages=new Map(bundle.pages.map(p=>[p.sequence,p])),seen=new Set();for(const s of evidence.sources){const p=pages.get(s.sequence);if(seen.has(s.sequence)||!p||p.response.body_sha256!==s.body_sha256)throw new Error("重新校验证据与原始数据不一致。");seen.add(s.sequence);}return seen;
  }
  async function replay(bundle,{recover=false}={}){
    if(bundle?.schema!==SCHEMA)throw new Error("不是受支持的结构化会话文件。");const expected=identity(bundle.capture?.source_url);
    if(expected.conversation_id!==bundle.conversation_id||expected.provider_id!==bundle.provider_id||bundle.capture.conversation_id!==expected.conversation_id)throw new Error("会话文件标识不一致。");
    const state=createState(expected);for(const e of [...(bundle.pages||[])].sort((a,b)=>a.sequence-b.sequence)){if(e.session_id!==bundle.capture.id)throw new Error("原始响应混入了其他采集记录。");await consume(state,e,{recover:recover===true||(recover instanceof Set&&recover.has(e.sequence))});}
    return state;
  }
  async function prepare(bundle,options={}){
    const evidence=bundle.capture?.revalidation,recover=savedRecovery(bundle);
    const state=await replay(bundle,{recover}),profile=options.profile||"reading";if(!["reading","all"].includes(profile))throw new Error("整理范围不受支持。");
    if(!state.head)throw new Error("没有通过解析和校验的会话数据，请先下载原始 JSON。");
    if(bundle.capture.state==="provider_complete"&&!state.rechecked)throw new Error("会话缺少最早边界或首页复核。");
    if(profile==="reading"&&state.ambiguous.length)throw new Error("Gemini 返回了多个候选回答，当前版本选择未核验。可用“全部记录类型”导出候选，或选择网页备用采集。");
    const rows=state.order.map(id=>state.records.get(id)),chosen=rows.filter(n=>profile==="all"||["user","assistant"].includes(n.message.author.role)),filtered=rows.filter(n=>!chosen.includes(n)),categories={};
    for(const n of filtered){const key=n.message.author.role+"/"+n.message.channel;categories[key]=(categories[key]||0)+1;}
    const messages=chosen.map(n=>{const m=clone(n.message);if(profile==="all")m.content.parts=clone(n.allParts);else delete m.metadata.source_record;return m;});
    const stats=counts(state),warning=`来源为 ${P.name(bundle.provider_id)} 网页会话数据，未证明与官方账号全量导出等价；附件仅保留返回资料，未下载原文件。`;
    const warnings=[warning,...stats.review_warnings];if(!state.rechecked)warnings.push("尚未完成历史边界和首页复核，本次仅包含已保存部分。");if(evidence)warnings.push("使用了重新校验的已保存响应，原始数据和旧判定未改写。");if(stats.empty_text_ids.length)warnings.push(`${stats.empty_text_ids.length} 条记录没有文本正文，位置与非文本资料已保留。`);
    return {schema:"chat-export-reading/v1",tool:{name:"拾页",version:VERSION},provider_id:bundle.provider_id,conversation_id:bundle.conversation_id,title:state.title||bundle.title,messages,
      source:{capture_id:bundle.capture.id,capture_state:bundle.capture.state,source_schema:SCHEMA,captured_at:bundle.pages.at(-1)?.response.received_at||bundle.capture.updated_at,responses:state.sources},
      scope:{capture_source:"provider_conversation_api",provider_id:bundle.provider_id,profile,selected_route_only:!state.ambiguous.length,official_json:false,all_history_branches_verified:false,attachments_downloaded:false,original_text_blocks_preserved:true},
      checks:{raw_hashes_valid:true,order_from_source_links:bundle.provider_id==="deepseek",order_from_cursor_pages:bundle.provider_id==="gemini",capture_recheck_passed:state.rechecked},
      statistics:{raw_responses:bundle.pages.length,data_pages:state.dataPages,route_messages:rows.length,retained_messages:messages.length,filtered_messages:rows.length-messages.length,repeated_responses_removed:state.sources.filter(s=>s.kind==="api_head_recheck").length,repeated_response_messages_removed:state.duplicates,overlapping_message_duplicates_removed:0,total_duplicate_occurrences_removed:state.duplicates,off_route_nodes_not_included:stats.off_route_count,empty_text_ids:stats.empty_text_ids,attachment_or_non_text_ids:messages.filter(m=>m.metadata.attachments?.length||m.content.parts.some(p=>typeof p!=="string")).map(m=>m.id),filtered_by_category:categories},
      provenance:Object.fromEntries(chosen.map(n=>[n.message.id,state.refs.get(n.message.id)])),filtered_records:filtered.map(n=>({id:n.message.id,category:n.message.author.role+"/"+n.message.channel,source_refs:state.refs.get(n.message.id)})),warnings:[...new Set(warnings)]};
  }
  return {SCHEMA,VERSION,identity,requestValid,validCursor,parse,frames,createState,consume,counts,replay,savedRecovery,prepare,sha};
});
