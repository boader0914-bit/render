'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {getScenario}=require('./fixtures.cjs');
const web=path.resolve(__dirname,'../../web'),fonts=path.resolve(__dirname,'../../../web/fonts');
const files=new Map([
  ['/',[path.join(__dirname,'index.html'),'text/html; charset=utf-8']],
  ['/app.js',[path.join(__dirname,'app.js'),'text/javascript; charset=utf-8']],
  ['/review.css',[path.join(__dirname,'styles.css'),'text/css; charset=utf-8']],
  ['/styles.css',[path.join(web,'styles.css'),'text/css; charset=utf-8']],
  ['/comparison-selection.js',[path.join(web,'comparison-selection.js'),'text/javascript; charset=utf-8']],
  ['/favicon.svg',[path.join(web,'favicon.svg'),'image/svg+xml']],
  ...['Pretendard-Regular.otf','Pretendard-Bold.otf','MaruBuri-Regular.otf'].map(name=>['/fonts/'+name,[path.join(fonts,name),'font/otf']])
]);
function createReviewServer(){
  if(process.env.RENDER||process.env.NODE_ENV==='production')throw Error('LOCAL_REVIEW_ONLY');
  return http.createServer(async(req,res)=>{
    const host=req.headers.host||'';
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return json(403,{error:'LOCAL_REVIEW_ONLY'});
    if(!['GET','HEAD'].includes(req.method))return json(405,{error:'READ_ONLY_REVIEW'});
    let url;try{url=new URL(req.url,'http://'+host);}catch{return json(400,{error:'INVALID_URL'});}
    if(url.pathname==='/api/scenario'){
      const allowed=new Set(['scenario','ownId','start','end','asOf']);
      if([...url.searchParams.keys()].some(k=>!allowed.has(k)||url.searchParams.getAll(k).length!==1))return json(400,{error:'INVALID_REVIEW_SELECTION'});
      try{return json(200,getScenario(Object.fromEntries(url.searchParams)));}catch{return json(400,{error:'INVALID_REVIEW_SELECTION'});}
    }
    const match=files.get(url.pathname);if(!match)return json(404,{error:'NOT_FOUND'});
    try{const stat=await fs.lstat(match[0]);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error();const body=await fs.readFile(match[0]);res.writeHead(200,{'Content-Type':match[1],'Content-Length':body.length});res.end(req.method==='HEAD'?undefined:body);}catch{return json(404,{error:'NOT_FOUND'});}
  });
}
if(require.main===module){const port=Number(process.env.INSIGHT_STAGE1_REVIEW_PORT||0);if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_LOCAL_PORT');const server=createReviewServer();server.listen(port,'127.0.0.1',()=>console.log('인사이트 1단계 로컬 시안: http://127.0.0.1:'+server.address().port+'/ · 가상자료만 표시'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));}
module.exports={createReviewServer};
