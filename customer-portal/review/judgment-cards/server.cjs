'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {validateDraftCatalog}=require('../../knowledge/validate-operating-judgment-cards.cjs');
const ROOT=__dirname;
const CATALOG=path.resolve(ROOT,'../../knowledge/operating-judgment-cards.v1.json');
const routes=new Map([
  ['/',[path.join(ROOT,'index.html'),'text/html; charset=utf-8']],
  ['/index.html',[path.join(ROOT,'index.html'),'text/html; charset=utf-8']],
  ['/app.js',[path.join(ROOT,'app.js'),'text/javascript; charset=utf-8']],
  ['/styles.css',[path.join(ROOT,'styles.css'),'text/css; charset=utf-8']],
  ['/catalog.json',[CATALOG,'application/json; charset=utf-8']]
]);
function createReviewServer(){
  return http.createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...headers,Allow:'GET, HEAD'});res.end('Read-only review');return;}
    let pathname;try{pathname=new URL(req.url,'http://127.0.0.1').pathname;}catch{res.writeHead(400,headers);res.end();return;}
    if(pathname==='/favicon.ico'){res.writeHead(204,headers);res.end();return;}
    const route=routes.get(pathname);if(!route){res.writeHead(404,headers);res.end('Not found');return;}
    try{const bytes=await fs.readFile(route[0]);if(pathname==='/catalog.json'&&!validateDraftCatalog(JSON.parse(bytes.toString('utf8'))).ok)throw Error('DRAFT_POLICY_INVALID');res.writeHead(200,{...headers,'Content-Type':route[1],'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);}
    catch{res.writeHead(503,{...headers,'Content-Type':'text/plain; charset=utf-8'});res.end('검토 자료를 읽지 못했습니다. 파일 준비 상태를 확인하세요.');}
  });
}
if(require.main===module){
  const port=Number(process.argv[2]||0);if(!Number.isSafeInteger(port)||port<0||port>65535)throw Error('Invalid local port');
  const server=createReviewServer();server.listen(port,'127.0.0.1',()=>console.log('Judgment cards review: http://127.0.0.1:'+server.address().port));
}
module.exports={createReviewServer};
