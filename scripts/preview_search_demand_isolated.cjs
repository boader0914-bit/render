"use strict";
// Local fixture UI only. This helper never imports the application server,
// reads runtime keys, starts a provider/scheduler, or touches production data.
const http=require("node:http"),fs=require("node:fs/promises"),path=require("node:path");
const {createSearchDemandStore}=require("./lib/search_demand_store.cjs");
const {createSearchDemandService}=require("./lib/search_demand_service.cjs");
const {createSearchDemandHttpHandler}=require("./lib/search_demand_http.cjs");
const root=path.resolve(__dirname,".."),args=process.argv.slice(2);
if(args.length!==2||args[0]!=="--copy")throw Error("Usage: --copy <validated-isolated-copy-directory>");
async function main(){
  const copy=path.resolve(args[1]);
  const proof=JSON.parse(await fs.readFile(path.join(copy,"validation.json"),"utf8"));
  const provenance=JSON.parse(await fs.readFile(path.join(copy,"provenance.json"),"utf8"));
  if(proof.status!=="verified_exact_row_copy"||proof.scope.copiedNormalizedRows!==1)throw Error("VALIDATED_COPY_REQUIRED");
  const clock=()=>Date.parse(provenance.sourceObservedAt)+1000;
  const store=createSearchDemandStore({rootDir:path.join(copy,"store"),clock});
  const service=createSearchDemandService({store,clock,readRegisteredKeywords:async()=>[proof.keyword]});
  const send=(res,status,body,type="application/json; charset=utf-8")=>{res.writeHead(status,{"Content-Type":type});res.end(typeof body==="string"||Buffer.isBuffer(body)?body:JSON.stringify(body));};
  const handler=createSearchDemandHttpHandler({service,send,requireAdmin:()=>true});
  const files={"/search-demand-analysis.js":"web/search-demand-analysis.js","/search-demand-analysis.css":"web/search-demand-analysis.css"};
  const shell='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>검색 수요 분석 · 실자료 단일행 사본 검증</title><link rel="stylesheet" href="/search-demand-analysis.css"><style>body{margin:0;background:#f4f7fb;color:#182a43;font:14px/1.6 system-ui}#copy-banner{padding:14px 24px;background:#fff3d5;color:#674b14;border-bottom:1px solid #dcc48a}main{padding:24px;max-width:1450px;margin:auto}button,input,select{font:inherit}</style><div id="copy-banner"><b>로컬 격리 검증 · 운영 화면 아님</b> · 실제 경남글램핑 한 행 사본 · 연관 전체·12개월 트렌드 실자료 미검수 · 공급자 호출 0</div><main><div id="searchDemandDashboard"></div></main><script src="/search-demand-analysis.js"></script><script>SearchDemandAnalysis.show(document.getElementById("searchDemandDashboard"),'+JSON.stringify({keyword:proof.keyword,day:proof.day,month:proof.day.slice(0,7)})+');</script></html>';
  const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,"http://127.0.0.1");if(await handler(req,res,url,{role:"fixture-admin"}))return;if(req.method!=="GET"){send(res,405,{code:"LOCAL_GET_ONLY"});return;}if(url.pathname==="/"){send(res,200,shell,"text/html; charset=utf-8");return;}if(files[url.pathname]){send(res,200,await fs.readFile(path.join(root,files[url.pathname])),url.pathname.endsWith(".css")?"text/css; charset=utf-8":"application/javascript; charset=utf-8");return;}send(res,404,{code:"LOCAL_NOT_FOUND"});}catch{send(res,503,{code:"LOCAL_COPY_UNAVAILABLE"});}});
  server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/',copyOnly:true,operatingAdmin:false,providerCalls:0})));
}
main().catch(()=>{console.error("LOCAL_COPY_PREVIEW_UNAVAILABLE");process.exitCode=1;});
