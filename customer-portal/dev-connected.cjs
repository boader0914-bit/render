'use strict';
// Local-only review fixture. No production files, credentials, worker connections or schedules.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {createConnectedServer} = require('./connected-server.cjs');
if (process.env.RENDER || process.env.NODE_ENV === 'production') throw new Error('Review fixtures may only run locally');
const root = path.resolve(__dirname,'..');
const backendPort = Number(process.env.INSIGHT_REVIEW_BACKEND_PORT || 57950);
const frontendPort = Number(process.env.INSIGHT_REVIEW_PORT || 57951);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'insight-connected-review-'));
const token = crypto.randomBytes(32).toString('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(key.toUpperCase())));
const stamp = new Date().toISOString();
const password = 'LocalReview2026!';
const reviewUsername = process.env.INSIGHT_REVIEW_USERNAME || 'review-user';
const reviewPassword = process.env.INSIGHT_REVIEW_PASSWORD || password;
if (!/^[a-z0-9._@-]{4,80}$/i.test(reviewUsername) || ['review-admin','fixture-reserved'].includes(reviewUsername.toLowerCase())) throw new Error('Choose a separate review customer username');
const salt = crypto.randomBytes(16).toString('base64url');
const passwordHash = `pbkdf2_sha256$10000$${salt}$${crypto.pbkdf2Sync(reviewPassword,salt,10000,32,'sha256').toString('base64url')}`;
function save(name,data){const file=path.join(dataDir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));}
save('customer_db/b2b_members.json',{schemaVersion:1,members:[{memberId:'insight-fixture-member',username:reviewUsername,role:'b2b',accountType:'test',status:'active',passwordHash,createdAt:stamp}]});
const collectionFixture=require('../scripts/fixtures/insight_collection.cjs').writeInsightCollectionFixture(dataDir);
const names=['검수 예시 글램핑','검수 예시 풀빌라','검수 예시 펜션','검수 예시 캠핑'];
save('company_master/companies.json',{schemaVersion:1,companies:Object.fromEntries(names.map((name,i)=>{
  const companyId=`company-insight-fixture-${i+1}`;
  return [companyId,{companyId,primaryName:name,aliases:[name],addresses:['경남 산청군 단성면'],regions:['산청'],placeIds:[`000000000${i+1}`],runIds:i===0?[collectionFixture.runId]:[],keywords:{},sourceRoles:['admin'],collectionSources:['local_fixture'],manualCorrection:{active:true,lodgingBasisTotal:16+i,source:'admin',updatedAt:stamp},manualCorrectionRevision:1}];
})),sourceIndex:{},duplicateResolutions:{}});
save('config/daily_collection_schedule.json',{enabled:false});
const backend=spawn(process.execPath,[path.join(root,'scripts/glamping_app_server.cjs')],{cwd:root,env:{...env,PORT:String(backendPort),HOST:'127.0.0.1',DATA_DIR:dataDir,OUTPUTS_DIR:path.join(dataDir,'outputs'),CONFIG_DIR:path.join(dataDir,'config'),GLAMPING_ADMIN_USER:'review-admin',GLAMPING_ADMIN_PASSWORD:password,GLAMPING_B2B_ENABLED:'1',GLAMPING_B2B_USER:'fixture-reserved',GLAMPING_B2B_PASSWORD:password,TOURISM_VISITOR_MONTHLY_SYNC_ENABLED:'0',TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED:'0',INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:token,INSIGHT_SIGNUP_ENABLED:'1'},stdio:['ignore','pipe','pipe']});
backend.stdout.on('data',chunk=>{if(String(chunk).includes('Lodging datalab beta app running'))console.log(`로컬 데이터랩 준비: http://127.0.0.1:${backendPort}/admin`);});
backend.stderr.on('data',chunk=>process.stderr.write(chunk));
const front=createConnectedServer({origin:`http://127.0.0.1:${frontendPort}`,backend:`http://127.0.0.1:${backendPort}`,serviceToken:token});
front.listen(frontendPort,'127.0.0.1',()=>console.log(`로컬 인사이트 준비: http://127.0.0.1:${frontendPort} · 가상 업체 데이터만 사용`));
function stop(){backend.kill();front.close();}
process.on('SIGINT',()=>{stop();process.exit(0);});process.on('SIGTERM',()=>{stop();process.exit(0);});
backend.on('exit',code=>{front.close();process.exitCode=code||0;});
