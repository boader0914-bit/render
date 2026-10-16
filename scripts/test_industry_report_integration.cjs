"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),net=require("node:net");
const {spawn}=require("node:child_process"),{once}=require("node:events");
const {seedMonthlyReportFixture}=require("./fixtures/monthly_report_fixture.cjs");
(async()=>{
 const root=path.resolve(__dirname,".."),dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"industry-report-http-"));
 const fixture=await seedMonthlyReportFixture(dataDir,{includePreviousMonth:true});
 const protectedNames=["company_master/companies.json","history/observations.jsonl"],original=await Promise.all(protectedNames.map(n=>fs.readFile(path.join(dataDir,n))));
 const preload=path.join(dataDir,"no-network.cjs"),marker=path.join(dataDir,"network-attempt");
 await fs.writeFile(preload,`global.fetch=async()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'attempt');throw new Error('NETWORK_FORBIDDEN');};`);
 const listener=net.createServer().listen(0,"127.0.0.1");await once(listener,"listening");const port=listener.address().port;await new Promise(r=>listener.close(r));
 let output="";const child=spawn(process.execPath,["--require",preload,path.join(root,"scripts/glamping_app_server.cjs")],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,
  HOST:"127.0.0.1",PORT:String(port),DATA_DIR:dataDir,OUTPUTS_DIR:path.join(dataDir,"outputs"),CONFIG_DIR:path.join(dataDir,"config"),RENDER:"",RENDER_EXTERNAL_URL:"",SEED_OUTPUTS_FROM_REPO:"0",MASTER_DB_WRITE_MODE:"off",COLLECTOR_EXECUTION_MODE:"local",
  GLAMPING_ADMIN_USER:"industry-report-admin",GLAMPING_ADMIN_PASSWORD:"industry-report-fixture-password",GLAMPING_B2B_ENABLED:"0",TOURISM_VISITOR_MONTHLY_SYNC_ENABLED:"0",TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED:"0",KOSIS_API_KEY:"",NAVER_CLIENT_ID:"",NAVER_CLIENT_SECRET:""}});
 child.stdout.on("data",v=>output+=v);child.stderr.on("data",v=>output+=v);const base=`http://127.0.0.1:${port}`;let cookie="";
 async function request(route,body,expectedStatus=200){const r=await fetch(base+route,{method:body?"POST":"GET",headers:{cookie,"user-agent":"industry-report-http-test",...(body?{"content-type":"application/json",origin:base}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,expectedStatus,`${route}: ${data.code||data.error||"unexpected status"}`);return {data,response:r};}
 try{
  let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(base+"/api/health")).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
  const auth=await request("/api/login",{username:"industry-report-admin",password:"industry-report-fixture-password"});cookie=auth.response.headers.get("set-cookie").split(";")[0];
  const input={type:"region",targetId:fixture.regionKey,month:"2026-08",cutoffDate:"2026-08-31",industry:"glamping"};
  const query=`/api/industry-analysis?industry=glamping&region=${fixture.regionKey}&month=2026-08&cutoffDate=2026-08-31`;
  let industry;for(let i=0;i<300;i++){industry=(await request(query)).data;if(industry.storage.status==="ready"&&industry.summary)break;assert.notEqual(industry.storage.status,"failed",JSON.stringify(industry.storage));await new Promise(r=>setTimeout(r,50));}
  assert.equal(industry.storage.status,"ready");assert.ok(industry.storage.resultVersion);
  const preview=(await request("/api/monthly-reports/preview",input)).data,reference=preview.industryBenchmarks.entries.find(e=>e.request.region===fixture.regionKey&&e.request.industry==="glamping");
  assert.ok(reference);assert.deepEqual(reference.request,industry.request);assert.equal(reference.storage.key,industry.storage.key);assert.equal(reference.storage.resultVersion,industry.storage.resultVersion);assert.equal(reference.storage.calculationVersion,industry.storage.calculationVersion);
  for(const key of ["reservationRate","companyCount","coveredCompanyDays","expectedCompanyDays","publicBookings","phoneBookings","estimatedRevenue","publicRevenue","phoneRevenue"])assert.equal(reference.summary[key],industry.summary[key],key);
  const draft=(await request("/api/monthly-reports",{...input,previewToken:preview.previewToken},201)).data;
  const report=draft.report||draft;assert.deepEqual(report.snapshot.industryBenchmarks,preview.industryBenchmarks);
  for(let i=0;i<protectedNames.length;i++)assert.deepEqual(await fs.readFile(path.join(dataDir,protectedNames[i])),original[i],"sources unchanged");
  assert.equal(await fs.stat(marker).then(()=>true,e=>{if(e.code==="ENOENT")return false;throw e;}),false);
  console.log("Industry-report HTTP: same condition, saved result identity and metrics; approved snapshot frozen; no provider requests; source preservation passed");
 }finally{child.kill();if(child.exitCode===null)await once(child,"exit");assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dataDir).startsWith("industry-report-http-"));await fs.rm(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
