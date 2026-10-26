(function(root,factory){const api=typeof module==="object"&&module.exports?factory(require("./core.js"),require("./platforms.js")):factory(root.ChatBackupCore,root.ChatBackupPlatforms);if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupSurfaceCore=Object.freeze(api);})(globalThis,function(C,P){
  "use strict";
  const SCHEMA="chat-export-surface/v1";
  const warning="来源为网页正文，完整性待核对；未验证服务端全部历史，隐藏内容、历史分支和附件文件可能不在此范围内。";
  async function sha(value){return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,"0")).join("");}
  function fingerprint(m){return C.stable({source_key:m.source_key||null,role:m.role,channel:m.channel,text:m.text,attachments:m.attachments||[],notice:m.notice||null});}
  function validate(snapshot,expected){
    if(snapshot?.schema!=="chat-export-surface-snapshot/v1")throw new Error("网页快照格式不受支持。");
    const identity=P.identify(snapshot.source_url);
    if(!P.isSurface(identity) || identity.provider_id!==expected.provider_id || identity.conversation_id!==expected.conversation_id ||
       snapshot.provider_id!==expected.provider_id || snapshot.conversation_id!==expected.conversation_id ||
       (expected.source_url && snapshot.source_url!==expected.source_url))throw new Error("网页快照混入另一平台或聊天，已停止合并。");
    if(!Array.isArray(snapshot.messages) || !snapshot.messages.length || snapshot.messages.length>20000)throw new Error("网页快照没有可用的消息记录。");
    const keys=new Set();
    for(const m of snapshot.messages){
      if(!["user","assistant"].includes(m.role) || !["final","analysis"].includes(m.channel) || typeof m.text!=="string" || typeof m.html!=="string" || !Array.isArray(m.attachments))throw new Error("网页消息字段不完整。");
      if(m.source_key!==null && (typeof m.source_key!=="string" || !m.source_key || m.source_key.length>1024 || /[\x00-\x1f]/.test(m.source_key)))throw new Error("网页消息编号不可靠。");
      if(m.source_key){if(keys.has(m.source_key))throw new Error("同一网页快照出现重复消息编号，已停止。");keys.add(m.source_key);}
    }
    const pos=snapshot.position;
    if(!pos || ![pos.top,pos.height,pos.viewport].every(Number.isFinite) || pos.height<0 || pos.viewport<0 ||
      typeof pos.at_top!=="boolean" || typeof pos.at_bottom!=="boolean")throw new Error("缺少网页扫描边界信息。");
    return snapshot;
  }
  function empty(){return {nodes:[],nextId:1,duplicates:0,edges:new Map(),orderingUnique:true};}
  function same(a,b){return (!a.source_key || !b.source_key || a.source_key===b.source_key) && fingerprint(a)===fingerprint(b);}
  function mergeKeys(index,snapshot,sequence){
    const nodes=new Map(index.nodes.map(n=>[n.row.source_key,n]));
    if(nodes.size && !snapshot.messages.some(m=>nodes.has(m.source_key)))throw new Error("相邻网页快照没有可核对的重叠消息，已停止。");
    for(const m of snapshot.messages)if(nodes.has(m.source_key)&&!same(nodes.get(m.source_key).row,m))throw new Error("同一消息的正文或附件引用已变化，已保留原快照并停止。");
    const edges=new Map([...index.edges].map(([k,v])=>[k,new Set(v)]));
    for(const m of snapshot.messages){
      if(!nodes.has(m.source_key))nodes.set(m.source_key,{id:snapshot.provider_id+":"+m.source_key,row:structuredClone(m),refs:[]});
      if(!edges.has(m.source_key))edges.set(m.source_key,new Set());
    }
    // Consecutive mounted rows establish precedence, not adjacency. A site may
    // pin its latest reply while virtualizing a known message in between.
    for(let i=1;i<snapshot.messages.length;i++)edges.get(snapshot.messages[i-1].source_key).add(snapshot.messages[i].source_key);
    const incoming=new Map([...nodes.keys()].map(k=>[k,0]));
    for(const children of edges.values())for(const key of children)incoming.set(key,incoming.get(key)+1);
    const queue=[...nodes.keys()].filter(k=>incoming.get(k)===0),ordered=[];let unique=true;
    while(queue.length){
      if(queue.length>1)unique=false;
      const key=queue.shift();ordered.push(nodes.get(key));
      for(const child of edges.get(key)||[]){incoming.set(child,incoming.get(child)-1);if(incoming.get(child)===0)queue.push(child);}
    }
    if(ordered.length!==nodes.size)throw new Error("网页消息顺序出现冲突，已停止。");
    for(let i=0;i<snapshot.messages.length;i++){
      const n=nodes.get(snapshot.messages[i].source_key);if(n.refs.length)index.duplicates++;
      n.refs.push({response_sequence:sequence,message_index:i});
    }
    index.nodes=ordered;index.edges=edges;index.orderingUnique=unique;return index;
  }
  function merge(index,snapshot,sequence){
    const rows=snapshot.messages,old=index.nodes;
    if(rows.every(m=>m.source_key)&&old.every(n=>n.row.source_key))return mergeKeys(index,snapshot,sequence);
    let offset=0;
    if(old.length){
      const positions=new Map(old.map((n,i)=>[n.row.source_key,i]).filter(([key])=>key));
      const anchored=new Set();rows.forEach((m,i)=>{if(m.source_key && positions.has(m.source_key))anchored.add(positions.get(m.source_key)-i);});
      if(anchored.size>1)throw new Error("网页消息顺序发生变化或出现间断，已保留原快照并停止。");
      if(anchored.size===1)offset=[...anchored][0];
      else {
        const oldPrints=old.map(n=>fingerprint(n.row)),newPrints=rows.map(fingerprint),candidates=[];
        if(oldPrints.length===newPrints.length && oldPrints.every((v,i)=>v===newPrints[i]))candidates.push({shift:0,overlap:rows.length});
        else {
        for(let shift=1-rows.length;shift<old.length;shift++){
          let overlap=0,valid=true;
          for(let i=0;i<rows.length;i++){const j=i+shift;if(j<0 || j>=old.length)continue;overlap++;if(oldPrints[j]!==newPrints[i]){valid=false;break;}}
          if(valid && overlap)candidates.push({shift,overlap});
        }
        }
        if(!candidates.length)throw new Error("相邻网页快照没有可核对的重叠消息，无法保证顺序，已停止。");
        const max=Math.max(...candidates.map(c=>c.overlap)),best=candidates.filter(c=>c.overlap===max);
        if(best.length!==1)throw new Error("重复文字造成消息位置歧义，无法安全去重，已停止。");
        offset=best[0].shift;
      }
      for(let i=0;i<rows.length;i++){const j=i+offset;if(j>=0 && j<old.length && !same(old[j].row,rows[i]))throw new Error("同一消息的正文或附件引用已变化，已保留原快照并停止。");}
    }
    const start=Math.min(0,offset),end=Math.max(old.length,offset+rows.length),merged=[];
    for(let j=start;j<end;j++){
      const row=rows[j-offset],node=old[j];
      if(node){
        if(row){node.refs.push({response_sequence:sequence,message_index:j-offset});index.duplicates++;}
        merged.push(node);
      }else{
        if(!row)throw new Error("网页消息衔接出现缺口。");
        merged.push({id:row.source_key?snapshot.provider_id+":"+row.source_key:"page-message-"+index.nextId++,row:structuredClone(row),refs:[{response_sequence:sequence,message_index:j-offset}]});
      }
    }
    const ids=new Set();for(const n of merged){if(ids.has(n.id))throw new Error("消息编号在不相邻位置重复，已停止合并。");ids.add(n.id);}
    index.nodes=merged;return index;
  }
  function signature(snapshot){return C.stable(snapshot.messages.map(fingerprint));}
  function checkMotion(before,after){
    if(before && !after.messages.some(m=>m.source_key) && signature(before)===signature(after) &&
      Math.abs(before.position.top-after.position.top)>20 && !after.position.full_dom_span)
      throw new Error("滚动后的重复内容缺少稳定消息编号，无法确认是否遗漏，已停止。");
  }
  function tail(snapshot){return snapshot.messages.slice(-2).map(fingerprint);}
  function tailMatches(index,expected){return C.stable(index.nodes.slice(-expected.length).map(n=>fingerprint(n.row)))===C.stable(expected);}
  function counts(index){return {record_count:index.nodes.length,reading_count:index.nodes.filter(n=>n.row.channel!=="analysis").length,
    auxiliary_count:index.nodes.filter(n=>n.row.channel==="analysis").length,empty_text_ids:index.nodes.filter(n=>!n.row.text.trim()).map(n=>n.id)};}
  async function prepare(bundle,options={}){
    if(bundle?.schema!==SCHEMA)throw new Error("不是网页正文采集格式。");
    const expected={provider_id:bundle.provider_id,conversation_id:bundle.conversation_id,source_url:bundle.capture?.source_url};
    if(!expected.source_url || bundle.capture?.conversation_id!==expected.conversation_id)throw new Error("网页采集标识不一致。");
    const profile=options.profile||"reading";if(!["reading","all"].includes(profile))throw new Error("不支持的整理范围。");
    const index=empty(),sources=[],warnings=[warning],seen=new Set();let initialTail=null,topSeen=false,rechecked=false,lastView=null;
    const pages=[...(bundle.pages||[])].sort((a,b)=>a.sequence-b.sequence);
    for(let i=0;i<pages.length;i++){
      const p=pages[i];
      if(!Number.isInteger(p.sequence)||p.sequence<0||seen.has(p.sequence)||p.session_id!==bundle.capture.id)throw new Error("网页快照序号或来源记录不一致。");
      seen.add(p.sequence);
      if(p.request?.method!=="DOM" || p.request.url!==expected.source_url || p.request.headers || typeof p.response?.body_text!=="string" || await sha(p.response.body_text)!==p.response.body_sha256)throw new Error("网页原始快照校验失败。");
      sources.push({sequence:p.sequence,kind:p.kind,accepted:!!p.accepted,source_url:p.request.url,body_sha256:p.response.body_sha256});
      if(!p.accepted){warnings.push("原始数据中有未通过的网页快照，整理仅保留已核对部分。");continue;}
      if(!["surface","surface_recheck"].includes(p.kind))throw new Error("未知的网页快照类型。");
      const snapshot=validate(JSON.parse(p.response.body_text),expected);
      checkMotion(lastView,snapshot);lastView=snapshot;
      if(!initialTail){if(!snapshot.position.at_bottom)throw new Error("网页采集缺少末尾起点。");initialTail=tail(snapshot);}
      merge(index,snapshot,p.sequence);topSeen ||= snapshot.position.at_top;
      rechecked=p.kind==="surface_recheck" && snapshot.position.at_bottom && topSeen && tailMatches(index,initialTail);
      if(p.kind==="surface_recheck" && !rechecked)throw new Error("网页结束复核不一致，不能标记扫描结束。");
      if(options.onProgress)await options.onProgress(i+1,pages.length);
    }
    if(!index.nodes.length)throw new Error("还没有保存可整理的网页消息。");
    if(!index.orderingUnique)throw new Error("网页片段的顺序尚未核对清楚，请继续扫描或先下载原始 JSON。");
    if(bundle.capture.state==="surface_complete" && !rechecked)throw new Error("缺少网页扫描边界或结束复核。");
    if(!rechecked)warnings.push("网页扫描尚未结束，本次导出仅含已保存部分。");
    const selected=index.nodes.filter(n=>profile==="all" || n.row.channel!=="analysis"),filtered=index.nodes.filter(n=>!selected.includes(n));
    const messages=selected.map(n=>({id:n.id,author:{role:n.row.role},channel:n.row.channel,content:{content_type:"text",parts:[n.row.text]},
      metadata:{capture_source:"rendered_page",source_message_key:n.row.source_key,generated_message_id:!n.row.source_key,attachments:n.row.attachments,site_notice:n.row.notice||null}}));
    const emptyIds=selected.filter(n=>!n.row.text.trim()).map(n=>n.id);if(emptyIds.length)warnings.push(`发现 ${emptyIds.length} 条网页正文为空，已保留位置和标记。`);
    return {schema:"chat-export-reading/v1",tool:{name:"拾页",version:"0.9.0"},provider_id:expected.provider_id,
      conversation_id:expected.conversation_id,title:bundle.title,messages,
      source:{capture_id:bundle.capture.id,capture_state:bundle.capture.state,source_schema:SCHEMA,captured_at:bundle.capture.updated_at,responses:sources},
      scope:{capture_source:"rendered_page",selected_route_only:true,profile,official_json:false,server_history_verified:false,attachments_downloaded:false,all_history_branches_verified:false,model_rewritten:false},
      checks:{raw_hashes_valid:true,order_from_source_links:false,order_from_overlapping_snapshots:true,capture_recheck_passed:rechecked,webpage_scan_finished:rechecked},
      statistics:{raw_responses:pages.length,data_pages:pages.length,route_messages:index.nodes.length,retained_messages:selected.length,filtered_messages:filtered.length,
        repeated_responses_removed:0,repeated_response_messages_removed:0,overlapping_message_duplicates_removed:index.duplicates,total_duplicate_occurrences_removed:index.duplicates,
        off_route_nodes_not_included:null,empty_text_ids:emptyIds,attachment_or_non_text_ids:messages.filter(m=>m.metadata.attachments.length).map(m=>m.id),filtered_by_category:{"assistant/analysis":filtered.length}},
      provenance:Object.fromEntries(selected.map(n=>[n.id,n.refs])),filtered_records:filtered.map(n=>({id:n.id,category:"assistant/analysis",source_refs:n.refs})),warnings};
  }
  return {SCHEMA,warning,sha,fingerprint,validate,empty,merge,signature,checkMotion,tail,tailMatches,counts,prepare};
});
