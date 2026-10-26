(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupSurfaceReader=Object.freeze(api);})(globalThis,function(){
  "use strict";
  // Runs in the selected tab. It only reads message DOM and scrolls its history.
  // No fetch interception, credentials, app state, draft input or hidden API is used.
  function inPage(expected,action="snapshot",restorePosition=null){
    try {
    const current=new URL(location.href);
    if(current.origin+current.pathname.replace(/\/$/,"")!==expected.source_url)throw new Error("目标聊天已变化，网页采集已停止。");
    if(action==="identity")return {source_url:expected.source_url,title:document.title};
    const provider=expected.provider_id;
    const visible=e=>!!e && e.getClientRects().length>0 && getComputedStyle(e).display!=="none" && getComputedStyle(e).visibility!=="hidden";
    const all=(selector,root=document)=>[...root.querySelectorAll(selector)].filter(visible);
    const excluded="script,style,svg,button,[role=button],textarea,input,[contenteditable=true],[aria-hidden=true],.sr-only,.cdk-visually-hidden,.screen-reader-user-query-label,[data-testid=message-actions],[class*=message-action-bar],.segment-user-actions,.segment-assistant-actions,.hyc-common-markdown__code__hd";
    function text(node){
      function read(n){
        if(n.nodeType===3)return n.nodeValue || "";
        if(n.nodeType!==1 || n.matches(excluded) || getComputedStyle(n).display==="none" || getComputedStyle(n).visibility==="hidden")return "";
        if(n.tagName==="BR")return "\n";
        const block=/^(P|DIV|LI|H[1-6]|PRE|BLOCKQUOTE|TR|SECTION)$/.test(n.tagName);
        const value=[...n.childNodes].map(read).join(n.tagName==="TR"?"\t":"");
        return block?"\n"+value+"\n":value;
      }
      return node ? read(node).replace(/\n[\t ]+\n/g,"\n\n").replace(/\n{3,}/g,"\n\n").trim() : "";
    }
    function references(node){
      return [...node.querySelectorAll("img[src],a[href],video[src],audio[src]")].filter(e=>!e.closest('.sr-only,[aria-hidden="true"],[class*="avatar"],[data-testid="message-actions"],[class*="message-action-bar"],.segment-user-actions,.segment-assistant-actions')).map(e=>{
        const raw=e.getAttribute(e.tagName==="A"?"href":"src");let url;try{url=new URL(raw,location.href);}catch{return null;}
        if(!["http:","https:","blob:"].includes(url.protocol) || url.username || url.password)return null;
        return {kind:e.tagName.toLowerCase(),url:url.href,label:e.getAttribute("alt") || e.getAttribute("title") || text(e)};
      }).filter(Boolean);
    }
    let containers=[];
    if(provider==="claude")containers=all('[data-cds="UserMessage"],[data-testid="assistant-message"]');
    else if(provider==="gemini")containers=all('user-query,model-response');
    else if(provider==="deepseek")containers=all('.ds-message');
    else if(provider==="doubao")containers=all('[data-message-id]');
    else if(provider==="kimi")containers=all('.chat-content-item-user,.chat-content-item-assistant');
    else if(provider==="qwen")containers=all('[data-chat-question-wrap],[class*="message-select-wrapper-answer-"]');
    else if(provider==="yuanbao")containers=all('[data-conv-id][data-conv-speaker]');
    else throw new Error("此平台没有网页正文适配器。");
    containers=containers.filter(e=>!e.closest("nav,aside,header,footer,[role=dialog]"));
    if(!containers.length)throw new Error("尚未识别到聊天消息。请等待页面载入；如果页面布局已更新，需要重新适配。");
    // Only choose scrollable ancestors of the actual message area, never the sidebar.
    let scroller=null;
    for(let e=containers[0].parentElement;e;e=e.parentElement){
      if(/auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight>40){scroller=e;break;}
    }
    scroller ||= document.scrollingElement;
    const position=()=>{
      const top=scroller.scrollTop,height=scroller.scrollHeight,viewport=scroller.clientHeight;
      const origin=scroller===document.scrollingElement?0:scroller.getBoundingClientRect().top;
      const rects=containers.map(e=>e.getBoundingClientRect());
      const first=Math.min(...rects.map(r=>r.top-origin+top)),last=Math.max(...rects.map(r=>r.bottom-origin+top));
      return {top,height,viewport,at_top:top<=3,at_bottom:top+viewport>=height-4,
        full_dom_span:first<=viewport&&last>=height-viewport};
    };
    if(["up","down","bottom","restore"].includes(action)){
      const before=position(),step=Math.max(80,Math.floor(scroller.clientHeight*.55));
      if(action==="bottom")scroller.scrollTo({top:scroller.scrollHeight,behavior:"instant"});
      else if(action==="restore")scroller.scrollTo({top:Math.max(0,Number(restorePosition)||0),behavior:"instant"});
      else scroller.scrollBy({top:action==="up"?-step:step,behavior:"instant"});
      return {source_url:expected.source_url,position:position(),previous_position:before};
    }
    if(action!=="snapshot")throw new Error("不支持的网页操作。");
    const streaming=containers.some(e=>e.getAttribute("data-is-streaming")==="true" || e.getAttribute("data-conv-outputting")==="true") ||
      all('button[aria-label*="Stop generating"],button[aria-label="停止生成"],button[aria-label="停止回答"],button[data-testid="stop-button"]').length>0 ||
      all('button,[role="button"]').some(e=>/^(停止生成|停止回答|停止响应|停止输出|停止|stop generating|stop response)$/i.test((e.getAttribute('aria-label')||e.getAttribute('title')||e.innerText||'').trim()));
    if(streaming)throw new Error("页面仍在生成回答，请等待生成完成后再采集。");
    const messages=[];
    function add(container,key,role,bodies,channel="final"){
      const content=bodies.map(text).filter(Boolean).join("\n\n");
      const refs=channel==="final"?references(container):bodies.flatMap(references);
      messages.push({source_key:key?String(key)+":"+channel:null,role,channel,text:content,
        html:channel==="final"?container.outerHTML:bodies.map(e=>e.outerHTML).join("\n"),
        attachments:refs,empty:!content.trim(),notice:!bodies.length?text(container):null});
    }
    for(const e of containers){
      let key=null,role,bodies=[],thoughts=[];
      if(provider==="claude"){
        role=e.getAttribute("data-cds")==="UserMessage"?"user":"assistant";
        bodies=all(role==="user"?'[data-testid="user-message"]':'[data-perf-reply-text]',e);
        // Claude's virtual transcript keeps this turn key when a row unmounts.
        // React IDs and viewport-relative row indexes are not message identities.
        key=e.getAttribute("data-message-id") || e.getAttribute("data-turn-key");
      } else if(provider==="gemini"){
        role=e.tagName.toLowerCase()==="user-query"?"user":"assistant";
        key=e.closest('.conversation-container[id]')?.id;key=key?role+":"+key:null;
        bodies=all(role==="user"?'.query-text-line':'.markdown',e);
      } else if(provider==="deepseek"){
        if(e.querySelector('.ds-assistant-message-main-content,.ds-markdown'))role="assistant";
        else if(e.querySelector('.fbb737a4')||e.classList.contains('d29f3d7d'))role="user";
        else throw new Error("网页消息角色无法识别，请保留原页面以便重新适配。");
        key=e.closest('[data-virtual-list-item-key]')?.getAttribute('data-virtual-list-item-key');
        bodies=all(role==="user"?'.fbb737a4':'.ds-assistant-message-main-content',e);
        if(role==="assistant")thoughts=all('.ds-markdown',e).filter(n=>!n.matches('.ds-assistant-message-main-content'));
      } else if(provider==="doubao"){
        key=e.getAttribute('data-message-id');role=e.closest('[data-reply-message="true"]')?"assistant":"user";
        bodies=role==="user"?all('[data-send-message-collapsed]',e):[e];
      } else if(provider==="kimi"){
        role=e.classList.contains('chat-content-item-user')?"user":"assistant";
        key=e.getAttribute('data-archer-id');bodies=all('.segment-content-box',e);
      } else if(provider==="qwen"){
        role=e.hasAttribute('data-chat-question-wrap')?"user":"assistant";
        key=e.closest('.chat-round[data-chat]')?.getAttribute('data-chat');key=key?role+":"+key:null;
        bodies=all(role==="user"?'.question-text-card':'.qk-markdown',e);
      } else {
        if(!['human','ai'].includes(e.getAttribute('data-conv-speaker')))throw new Error("网页消息角色无法识别，已停止。");
        key=e.getAttribute('data-conv-id');role=e.getAttribute('data-conv-speaker')==="human"?"user":"assistant";
        bodies=all(role==="user"?'.agent-chat__bubble__content':'.hyc-component-reasoner__text .hyc-common-markdown',e);
        if(role==="assistant"){
          thoughts=all('.hyc-component-reasoner__think-content .hyc-common-markdown',e);
          if(!bodies.length)bodies=all('.hyc-common-markdown',e).filter(n=>!n.closest('.hyc-component-reasoner__think-content'));
        }
      }
      if(thoughts.length)add(e,key,"assistant",thoughts,"analysis");
      add(e,key,role,bodies);
    }
    const snapshot={schema:"chat-export-surface-snapshot/v1",provider_id:provider,conversation_id:expected.conversation_id,
      source_url:expected.source_url,title:document.title,captured_at:new Date().toISOString(),position:position(),messages,
      scope:{capture_source:"rendered_page",official_json:false,server_history_verified:false,attachments_downloaded:false}};
    const body=JSON.stringify(snapshot);
    if(body.length>32*1024*1024)throw new Error("单次网页快照超过保护上限，已停止；没有截断正文。");
    return {body_text:body,position:snapshot.position};
    } catch(error) {
      const message=String(error?.message||"");
      return {error:/^(目标聊天|此平台|尚未识别|不支持|页面仍在生成|单次网页|网页消息)/.test(message)?message:"网页读取失败，请重新打开原聊天后继续。"};
    }
  }
  function transport(browser){
    return async(target,expected,action="snapshot",position=null)=>{
      if(!Number.isInteger(target?.tabId) || !target.documentId)throw new Error("缺少原聊天标签标识。");
      let timeout;
      try{
        const results=await Promise.race([browser.scripting.executeScript({target:{tabId:target.tabId,documentIds:[target.documentId]},world:"ISOLATED",func:inPage,args:[expected,action,position]}),
          new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("网页读取超时。")),10000);})]);
        const row=results.find(r=>r.frameId===0);
        if(!row || row.error || row.documentId!==target.documentId)throw new Error("原聊天标签已关闭、刷新或网页布局无法读取。");
        if(row.result?.error)throw Object.assign(new Error(row.result.error),{code:"surface_read"});
        return row.result;
      }catch(error){if(error.code==="surface_read")throw error;throw new Error("原聊天页面无法读取，请确认原标签仍打开，并从工具栏重新打开拾页后继续。");}
      finally{clearTimeout(timeout);}
    };
  }
  return {inPage,transport};
});
