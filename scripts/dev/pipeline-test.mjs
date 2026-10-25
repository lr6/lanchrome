const PORT=9333, EXT='lhjcbgklocfcaphoilhanbafgfmkaikl';
const j=async(p,m='GET')=>(await (await fetch(`http://127.0.0.1:${PORT}${p}`,{method:m})).json());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function mkConn(target){
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  const pend=new Map();const events=[];let id=0;
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}else if(m.method)events.push(m)};
  const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
  const ready=new Promise((r,jj)=>{ws.onopen=r;ws.onerror=jj});
  return {ws,send,events,ready};
}

// ---- fake x.com tab ----
const fakeTarget=await j('/json/new?about:blank','PUT');
const fake=mkConn(fakeTarget);await fake.ready;
await fake.send('Runtime.enable');await fake.send('Page.enable');
await fake.send('Fetch.enable',{patterns:[{urlPattern:'https://x.com/*',requestStage:'Request'}]});

const followingJson = {
  data: { user: { result: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [
      { entryId: 'user-1', content: { itemContent: { user_results: { result: { rest_id: '9000001', core: { screen_name: 'alice', name: 'Alice' } } } } } },
      { entryId: 'user-2', content: { itemContent: { user_results: { result: { rest_id: '9000002', core: { screen_name: 'bob', name: 'Bob' } } } } } },
      { entryId: 'cursor-bottom-1', content: { cursorType: 'Bottom', value: 'CURSOR-1' } }
    ] }
  ] } } } }
};

const followersJson = {
  data: { user: { result: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [
      { entryId: 'user-2', content: { itemContent: { user_results: { result: { rest_id: '9000002', core: { screen_name: 'bob', name: 'Bob' } } } } } },
      { entryId: 'user-3', content: { itemContent: { user_results: { result: { rest_id: '9000003', core: { screen_name: 'carol', name: 'Carol' } } } } } },
      { entryId: 'cursor-bottom-2', content: { cursorType: 'Bottom', value: 'CURSOR-2' } }
    ] },
    { type: 'TimelineTerminateTimeline', direction: 'Top' }
  ] } } } }
};

const page2Json = {
  data: { user: { result: { timeline: { instructions: [
    { type: 'TimelineTerminateTimeline', direction: 'Bottom' }
  ] } } } }
};

let reqs=[];
fake.ws.addEventListener('message',async (ev)=>{
  const m=JSON.parse(ev.data);
  if(m.method!=='Fetch.requestPaused') return;
  const {requestId,request,resourceType}=m.params;
  const url=request.url;
  reqs.push(url);
  let status=204, body='', headers=[];
  if(resourceType==='Document'){
    status=200;
    headers=[{name:'content-type',value:'text/html; charset=utf-8'}];
    body=Buffer.from('<!doctype html><html><head><title>fake x</title></head><body><div id="react-root"></div></body></html>').toString('base64');
  } else if(url.includes('/i/api/graphql/')&&/\/Following(\?|$)/.test(url)){
    status=200;headers=[{name:'content-type',value:'application/json'},{name:'x-rate-limit-remaining',value:'100'}];
    body=Buffer.from(JSON.stringify(url.includes('cursor=')?page2Json:followingJson)).toString('base64');
  } else if(url.includes('/i/api/1.1/friendships/lookup.json')){
    status=200;headers=[{name:'content-type',value:'application/json'},{name:'x-rate-limit-remaining',value:'100'}];
    body=Buffer.from(JSON.stringify([
      {id_str:'9000001',connections:['following']},
      {id_str:'9000002',connections:['following','followed_by']},
      {id_str:'9000003',connections:['followed_by']}
    ])).toString('base64');
  } else if(url.includes('/i/api/1.1/friendships/destroy.json')){
    status=200;headers=[{name:'content-type',value:'application/json'}];
    body=Buffer.from(JSON.stringify({id_str:'9000001'})).toString('base64');
  } else {
    status=204;
  }
  try{ await fake.send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:headers,body:body||undefined}); }catch(e){}
});

await fake.send('Page.navigate',{url:'https://x.com/home'});
await sleep(1500);

// ---- dashboard tab ----
const dashTarget=await j('/json/new?about:blank','PUT');
const dash=mkConn(dashTarget);await dash.ready;
await dash.send('Runtime.enable');await dash.send('Page.enable');
await dash.send('Page.navigate',{url:`chrome-extension://${EXT}/src/ui/dashboard.html#/overview`});
await sleep(2200);
const ev=async(expression,ms=20000)=>{
  const r=await Promise.race([
    dash.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}),
    new Promise(res=>setTimeout(()=>res({timeout:true}),ms))
  ]);
  if(r.timeout) return {timeout:true};
  return r.result?.exceptionDetails?{error:r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text}:r.result?.result?.value;
};

const now=Date.now();
const account={id:'42',screenName:'tester',name:'Tester',avatar:null,connectedAt:now,lastDetectAt:null};
const seed={
  lanAccounts:[account],lanActive:'42',
  lanSettings:{pageDelayMs:1500,lookupDelayMs:1500,unfollowMinDelayMs:4000,unfollowMaxDelayMs:8000,limitDefault:1000},
  'lanProtected:42':{'9000003':{id:'9000003',screenName:'carol',name:'Carol',addedAt:now}},
  lanCaptures:{updatedAt:now,operations:{
    Following:{operation:'Following',queryId:'qidF',path:'/i/api/graphql/qidF/Following',fullPath:'/i/api/graphql/qidF/Following',method:'GET',headers:{},variables:JSON.stringify({userId:'42',count:20}),firstVariables:JSON.stringify({userId:'42',count:20}),features:'{}',fieldToggles:null,transactionId:null,requestId:'rF1',at:now},
    Followers:{operation:'Followers',queryId:'qidG',path:'/i/api/graphql/qidG/Followers',fullPath:'/i/api/graphql/qidG/Followers',method:'GET',headers:{},variables:JSON.stringify({userId:'42',count:20}),firstVariables:JSON.stringify({userId:'42',count:20}),features:'{}',fieldToggles:null,transactionId:null,requestId:'rG1',at:now,lastBody:JSON.stringify(followersJson),lastBodyRequestId:'rG1',lastBodyAt:now,lastBodyStatus:200}
  }}
};
await ev(`chrome.storage.local.clear().then(()=>chrome.storage.local.set(${JSON.stringify(seed)}))`);
await sleep(300);

const tabInfo=await ev(`new Promise(r=>chrome.tabs.query({url:'https://x.com/*'},t=>r(t.map(x=>({id:x.id,url:x.url})))))`);
console.log('X TABS', JSON.stringify(tabInfo));

const task={id:'dtest',type:'detect',accountId:'42',account:{id:'42',screenName:'tester',name:'Tester',avatar:null},status:'running',startedAt:now,updatedAt:now,endedAt:null,params:{limit:null},progress:{phase:'准备',message:'',done:0,total:null},state:{},result:null,error:null};
const sent=await ev(`new Promise(r=>chrome.tabs.query({url:'https://x.com/*'},t=>{if(!t.length)return r({error:'no x tab'});chrome.tabs.sendMessage(t[0].id,${JSON.stringify({type:'lan:cmd',command:'detect',payload:{task}})},res=>r(res||{error:chrome.runtime.lastError?.message}))}))`);
console.log('DETECT SENT', JSON.stringify(sent));

async function waitTask(id,timeoutMs=45000){
  const start=Date.now();
  while(Date.now()-start<timeoutMs){
    const t=await ev(`new Promise(r=>chrome.storage.local.get('lanTask',x=>r(x.lanTask)))`,8000);
    if(t&&t.id===id&&['done','error','interrupted','stopped'].includes(t.status)) return t;
    await sleep(500);
  }
  const t=await ev(`new Promise(r=>chrome.storage.local.get('lanTask',x=>r(x.lanTask)))`,8000);
  return {timeout:true,last:t};
}

const dt=await waitTask('dtest');
console.log('DETECT TASK', JSON.stringify({status:dt.status,result:dt.result,progress:dt.progress,error:dt.error,timeout:dt.timeout},null,2));
const rels=await ev(`new Promise(r=>chrome.storage.local.get('lanRelations:42',x=>r(x['lanRelations:42'])))`);
console.log('RELATIONS', JSON.stringify(Object.fromEntries(Object.entries(rels||{}).map(([k,v])=>[k,{sn:v.screenName,following:v.following,followsMe:v.followsMe,protected:!!v.protected,stale:!!v.stale}])),null,2));
const scan=await ev(`new Promise(r=>chrome.storage.local.get('lanScan:42',x=>r(x['lanScan:42'])))`);
console.log('SCAN', JSON.stringify(scan));
console.log('REQUESTS', JSON.stringify(reqs.filter(u=>u.includes('/i/api/')),null,2));

// ---- unfollow ----
const utask={id:'utest',type:'unfollow',accountId:'42',account:{id:'42',screenName:'tester',name:'Tester',avatar:null},status:'running',startedAt:Date.now(),updatedAt:Date.now(),endedAt:null,params:{},progress:{phase:'准备',message:'',done:0,total:2},state:{items:[{id:'9000001',screenName:'alice',name:'Alice'},{id:'9000003',screenName:'carol',name:'Carol'}],index:0,results:[]},result:null,error:null};
const usent=await ev(`new Promise(r=>chrome.tabs.query({url:'https://x.com/*'},t=>{if(!t.length)return r({error:'no x tab'});chrome.tabs.sendMessage(t[0].id,${JSON.stringify({type:'lan:cmd',command:'unfollow',payload:{task:utask}})},res=>r(res||{error:chrome.runtime.lastError?.message}))}))`);
console.log('UNFOLLOW SENT', JSON.stringify(usent));
const ut=await waitTask('utest',30000);
console.log('UNFOLLOW TASK', JSON.stringify({status:ut.status,result:ut.result,progress:ut.progress,error:ut.error,timeout:ut.timeout,state:ut.state},null,2));
const rels2=await ev(`new Promise(r=>chrome.storage.local.get('lanRelations:42',x=>r(x['lanRelations:42'])))`);
console.log('RELATIONS AFTER', JSON.stringify(Object.fromEntries(Object.entries(rels2||{}).map(([k,v])=>[k,{sn:v.screenName,following:v.following,unfollowedAt:!!v.unfollowedAt}])),null,2));
const hist=await ev(`new Promise(r=>chrome.storage.local.get('lanHistory:42',x=>r(x['lanHistory:42'])))`);
console.log('HISTORY', JSON.stringify(hist));

const prob=[...fake.events,...dash.events].filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);
console.log('PROBLEMS', prob.length?prob:'(none)');

fake.ws.close();dash.ws.close();
for(const t of (await j('/json/list')).filter(t=>t.type==='page'&&(t.url.startsWith('chrome-extension://')||t.url.startsWith('https://x.com')))) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
process.exit(0);
