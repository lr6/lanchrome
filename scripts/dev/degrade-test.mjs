const PORT=9333, EXT='lhjcbgklocfcaphoilhanbafgfmkaikl';
const j=async(p,m='GET')=>(await (await fetch(`http://127.0.0.1:${PORT}${p}`,{method:m})).json());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function mkConn(target){const ws=new WebSocket(target.webSocketDebuggerUrl);const pend=new Map();const events=[];let id=0;ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}else if(m.method)events.push(m)};const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});const ready=new Promise((r,jj)=>{ws.onopen=r;ws.onerror=jj});return {ws,send,events,ready};}

const ft=await j('/json/new?about:blank','PUT');const fake=mkConn(ft);await fake.ready;
await fake.send('Runtime.enable');await fake.send('Page.enable');
await fake.send('Fetch.enable',{patterns:[{urlPattern:'https://x.com/*',requestStage:'Request'}]});
const followingJson = {
  data: { user: { result: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [
      { entryId: 'user-1', content: { itemContent: { user_results: { result: { rest_id: '9000001', core: { screen_name: 'alice', name: 'Alice' } } } } } },
      { entryId: 'user-2', content: { itemContent: { user_results: { result: { rest_id: '9000002', core: { screen_name: 'bob', name: 'Bob' } } } } } }
    ] }
  ] } } } }
};
fake.ws.addEventListener('message',async ev=>{const m=JSON.parse(ev.data);if(m.method!=='Fetch.requestPaused')return;const {requestId,request,resourceType}=m.params;const url=request.url;let status=204,body='',headers=[];
 if(resourceType==='Document'){status=200;headers=[{name:'content-type',value:'text/html; charset=utf-8'}];body=Buffer.from('<!doctype html><html><head><title>fake x</title></head><body></body></html>').toString('base64');}
 else if(url.includes('/i/api/graphql/')&&/\/Following(\?|$)/.test(url)){status=200;headers=[{name:'content-type',value:'application/json'}];body=Buffer.from(JSON.stringify(followingJson)).toString('base64');}
 else if(url.includes('/i/api/graphql/')&&/\/Followers(\?|$)/.test(url)){status=401;headers=[{name:'content-type',value:'application/json'}];body=Buffer.from(JSON.stringify({errors:[{message:'unauthorized'}]})).toString('base64');}
 else if(url.includes('/i/api/1.1/friendships/lookup.json')){status=200;headers=[{name:'content-type',value:'application/json'}];body=Buffer.from(JSON.stringify([{id_str:'9000001',connections:['following']},{id_str:'9000002',connections:['following','followed_by']}])).toString('base64');}
 else status=204;
 try{await fake.send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:headers,body:body||undefined})}catch(e){}
});
await fake.send('Page.navigate',{url:'https://x.com/home'});await sleep(1200);

const dt=await j('/json/new?about:blank','PUT');const dash=mkConn(dt);await dash.ready;
await dash.send('Runtime.enable');await dash.send('Page.enable');
await dash.send('Page.navigate',{url:`chrome-extension://${EXT}/src/ui/dashboard.html`});await sleep(2200);
const ev=async(expression,ms=20000)=>{const r=await Promise.race([dash.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}),new Promise(res=>setTimeout(()=>res({timeout:true}),ms))]);if(r.timeout)return{timeout:true};return r.result?.exceptionDetails?{error:r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text}:r.result?.result?.value};
const now=Date.now();
const seed={lanAccounts:[{id:'42',screenName:'tester',name:'Tester',connectedAt:now}],lanActive:'42',lanSettings:{pageDelayMs:1500,lookupDelayMs:1500,unfollowMinDelayMs:4000,unfollowMaxDelayMs:8000,limitDefault:1000},lanCaptures:{updatedAt:now,operations:{
 Following:{operation:'Following',queryId:'qidF',path:'/i/api/graphql/qidF/Following',fullPath:'/i/api/graphql/qidF/Following',headers:{},variables:JSON.stringify({userId:'42',count:20}),firstVariables:JSON.stringify({userId:'42',count:20}),features:'{}',transactionId:null,requestId:'rF1',at:now},
 Followers:{operation:'Followers',queryId:'qidG',path:'/i/api/graphql/qidG/Followers',fullPath:'/i/api/graphql/qidG/Followers',headers:{},variables:JSON.stringify({userId:'42',count:20}),firstVariables:JSON.stringify({userId:'42',count:20}),features:'{}',transactionId:null,requestId:'rG1',at:now}
}}};
await ev(`chrome.storage.local.clear().then(()=>chrome.storage.local.set(${JSON.stringify(seed)}))`);
const task={id:'ddeg',type:'detect',accountId:'42',account:{id:'42',screenName:'tester',name:'Tester'},status:'running',startedAt:now,updatedAt:now,endedAt:null,params:{limit:null},progress:{},state:{},result:null,error:null};
const sent=await ev(`new Promise(r=>chrome.tabs.query({url:'https://x.com/*'},t=>{if(!t.length)return r({error:'no x tab'});chrome.tabs.sendMessage(t[0].id,${JSON.stringify({type:'lan:cmd',command:'detect',payload:{task}})},res=>r(res||{error:chrome.runtime.lastError?.message}))}))`);
console.log('SENT',JSON.stringify(sent));
const start=Date.now();let final=null;
while(Date.now()-start<60000){const t=await ev(`new Promise(r=>chrome.storage.local.get('lanTask',x=>r(x.lanTask)))`,8000);if(t&&['done','error'].includes(t.status)){final=t;break}await sleep(500)}
console.log('TASK',JSON.stringify({status:final?.status,result:final?.result,error:final?.error,progress:final?.progress},null,2));
const scan=await ev(`new Promise(r=>chrome.storage.local.get('lanScan:42',x=>r(x['lanScan:42'])))`);
console.log('SCAN',JSON.stringify(scan,null,2));
const rels=await ev(`new Promise(r=>chrome.storage.local.get('lanRelations:42',x=>r(x['lanRelations:42'])))`);
console.log('RELS',JSON.stringify(rels,null,2));
fake.ws.close();dash.ws.close();
for(const t of (await j('/json/list')).filter(t=>t.type==='page'&&(t.url.startsWith('chrome-extension://')||t.url.startsWith('https://x.com')))) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
process.exit(0);
