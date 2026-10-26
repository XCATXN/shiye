const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const R = require('./edge-extension/page-reader.js');
const C = require('./edge-extension/core.js');
const CID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB='00000000-0000-4000-8000-000000000001';
const KEY='__chat_backup_reader_00000000-0000-4000-8000-000000000002';
function harness({url=`https://chatgpt.com/c/${CID}`,sessionStatus=200,token='only-in-page-test-token',authThrows=false,body='{"test":"conversation"}'}={}) {
  const calls=[],location={href:url};
  const context=vm.createContext({location,URL,AbortController,setTimeout(fn,ms){const timer=setTimeout(fn,ms);timer.unref();return timer;},clearTimeout,
    fetch:async(url,options)=>{
      assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');
      calls.push(url);
      if(url==='https://chatgpt.com/api/auth/session') {
        if(authThrows)throw new Error('private-auth-error '+token);
        return {status:sessionStatus,json:async()=>({accessToken:token,user:{email:'never-return-auth-profile@example.invalid'}})};
      }
      assert.equal(options.headers.Authorization,'Bearer '+token);
      return {status:200,text:async()=>body,headers:new Headers({'content-type':'application/json','set-cookie':'private-cookie=not-exported'})};
    }});
  const evaluate=code=>vm.runInContext(code,context);
  const installed=evaluate(R.installCode(KEY,CID));
  return {calls,location,installed,command:(method,args=[])=>evaluate(R.commandCode(KEY,method,args))};
}
async function settled(h) {
  const deadline=Date.now()+2000;
  while(Date.now()<deadline) {
    const result=h.command('poll',[JOB]);if(result.state!=='pending')return result;
    await new Promise(resolve=>setImmediate(resolve));
  }
  throw Error('Fixture reader timed out');
}
test('page reader uses one login lookup across reads and never returns credentials or profile data',async()=>{
  const h=harness();assert.equal(h.installed.ok,true);
  try {
    assert.equal(h.command('start',[JOB,C.pagedHeadURL(CID)]).ok,true);
    const first=await settled(h);assert.equal(first.state,'done');assert.equal(first.body_text,'{"test":"conversation"}');
    const encoded=JSON.stringify(first);
    for(const secret of ['only-in-page-test-token','never-return-auth-profile','private-cookie'])assert.ok(!encoded.includes(secret));
    h.command('ack',[JOB]);
    h.command('start',[JOB,C.requestURL(CID,JOB)]);await settled(h);
    assert.equal(h.calls.filter(url=>url.includes('/api/auth/session')).length,1);
  } finally {h.command('dispose');}
});
test('page reader refuses forced full requests, other chats and foreign destinations before any login read',()=>{
  const h=harness();
  try {
    for(const url of [C.fullRequestURL(CID),C.pagedHeadURL(JOB),C.pagedHeadURL(CID)+'&include_full_conversation=true',
      'https://example.com/export',`https://chatgpt.com/backend-api/conversations/${CID}/versions?message_id=${JOB}`])
      assert.equal(h.command('start',[JOB,url]).ok,false);
    assert.equal(h.calls.length,0);
  } finally {h.command('dispose');}
});
test('page reader refuses installation on a different origin or conversation',()=>{
  for(const url of ['https://example.com/c/'+CID,'https://chatgpt.com/c/'+JOB]) {
    const h=harness({url});assert.equal(h.installed.ok,false);assert.equal(h.calls.length,0);
  }
});
test('session denial and thrown errors expose fixed errors, never raw authentication responses',async()=>{
  for(const options of [{sessionStatus:403},{authThrows:true}]) {
    const h=harness(options);
    try {
      h.command('start',[JOB,C.pagedHeadURL(CID)]);const result=await settled(h);
      assert.equal(result.state,'failed');assert.equal(h.calls.length,1);
      assert.ok(!JSON.stringify(result).includes('only-in-page-test-token'));
      assert.ok(!JSON.stringify(result).includes('private-auth-error'));
    } finally {h.command('dispose');}
  }
});
