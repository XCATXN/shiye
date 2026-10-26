(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.ChatBackupPlatforms=Object.freeze(api);})(globalThis,function(){
  "use strict";
  const UUID="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const definitions=[
    {id:"chatgpt",name:"ChatGPT",hosts:["chatgpt.com"],route:new RegExp("/c/("+UUID+")/?$","i"),source:"server"},
    {id:"claude",name:"Claude",hosts:["claude.ai"],route:new RegExp("^/chat/("+UUID+")/?$","i"),source:"claude_api"},
    {id:"gemini",name:"Gemini",hosts:["gemini.google.com"],route:/^\/(?:u\/\d+\/)?app\/([a-f0-9]{6,128})\/?$/i,source:"provider_api"},
    {id:"deepseek",name:"DeepSeek",hosts:["chat.deepseek.com"],route:new RegExp("^/a/chat/s/("+UUID+")/?$","i"),source:"provider_api"},
    {id:"doubao",name:"豆包",hosts:["www.doubao.com","doubao.com"],route:/^\/chat\/(\d{6,40})\/?$/},
    {id:"kimi",name:"Kimi",hosts:["www.kimi.com","kimi.com","kimi.moonshot.cn"],route:/^\/chat\/([a-z0-9_-]{10,128})\/?$/i},
    {id:"qwen",name:"千问",hosts:["www.qianwen.com","qianwen.com"],route:/^\/chat\/([a-z0-9_-]{10,128})\/?$/i},
    {id:"yuanbao",name:"腾讯元宝",hosts:["yuanbao.tencent.com"],route:new RegExp("^/chat/[a-zA-Z0-9_-]+/("+UUID+")/?$","i")}
  ];
  function identify(value,requireConversation=true){
    let url;try{url=new URL(value);}catch{throw new Error("页面网址无效。");}
    if(url.protocol!=="https:" || url.username || url.password || url.port)throw new Error("只支持受支持平台的 HTTPS 页面。");
    const p=definitions.find(item=>item.hosts.includes(url.hostname));
    if(!p)throw new Error("请打开 ChatGPT、Claude、Gemini、DeepSeek、豆包、Kimi、千问或腾讯元宝中的一条聊天。");
    const match=url.pathname.match(p.route);
    if(!match && requireConversation)throw new Error(`已识别 ${p.name}，请先打开一条已保存的聊天，再点击采集。`);
    return {provider_id:p.id,provider_name:p.name,conversation_id:match?(p.id==="chatgpt"?match[1].toLowerCase():p.id+":"+match[1]):null,
      source_url:url.origin+url.pathname.replace(/\/$/,""),capture_source:p.source || "surface"};
  }
  function name(id){return definitions.find(p=>p.id===(id||"chatgpt"))?.name || id || "ChatGPT";}
  function isSurface(value){return !!value && value.provider_id && value.provider_id!=="chatgpt";}
  return {identify,name,isSurface,list:()=>definitions.map(p=>({id:p.id,name:p.name,hosts:[...p.hosts],source:p.source || "surface"}))};
});
