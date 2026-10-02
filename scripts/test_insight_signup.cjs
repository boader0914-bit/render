'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {randomBytes}=require('node:crypto');
const {spawn}=require('node:child_process');
const {createConnectedServer}=require('../customer-portal/connected-server.cjs');
const {POLICY_VERSION}=require('./lib/insight_policy.cjs');
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('signup through customer server validates consent and duplicates, stores central profile, and logs in after restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'insight-signup-test-'));
  const backendPort=await port(),frontPort=await port();
  const backend=`http://127.0.0.1:${backendPort}`,origin=`http://127.0.0.1:${frontPort}`,serviceToken=randomBytes(32).toString('hex');
  const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(k.toUpperCase()))),PORT:String(backendPort),HOST:'127.0.0.1',DATA_DIR:dir,OUTPUTS_DIR:path.join(dir,'outputs'),CONFIG_DIR:path.join(dir,'config'),GLAMPING_ADMIN_USER:'fixture-admin',GLAMPING_ADMIN_PASSWORD:'FixtureAdmin2026!',GLAMPING_B2B_USER:'reserved-fixture',GLAMPING_B2B_PASSWORD:'FixtureReserved2026!',TOURISM_VISITOR_MONTHLY_SYNC_ENABLED:'0',TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED:'0',INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:serviceToken,INSIGHT_SIGNUP_ENABLED:'1'};
  let child;
  async function start(){child=spawn(process.execPath,[path.join(__dirname,'glamping_app_server.cjs')],{env,stdio:['ignore','pipe','pipe']});await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Fixture startup timeout')),15000);child.stdout.on('data',c=>{if(String(c).includes('Lodging datalab beta app running')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Fixture exit ${code}`));});});}
  async function stop(){if(child&&!child.killed)await new Promise(r=>{child.once('exit',r);child.kill();});}
  t.after(stop);await start();
  const front=createConnectedServer({origin,backend,serviceToken});await new Promise(r=>front.listen(frontPort,'127.0.0.1',r));t.after(()=>{front.closeAllConnections();front.close();});
  const request=(route,data,headers={})=>fetch(`${origin}/api/customer/v1${route}`,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...headers},...(data?{body:JSON.stringify(data)}:{})});
  const config=await (await request('/config')).json();assert.equal(config.signupEnabled,true);assert.equal(config.termsVersion,POLICY_VERSION);assert.equal(config.termsUrl,'/terms');
  for(const route of ['/signup','/terms','/privacy','/auth.js'])assert.equal((await fetch(origin+route)).status,200);
  for(const kind of ['terms','privacy']){const doc=await(await request(`/policies/${kind}`)).json();assert.equal(doc.version,POLICY_VERSION);assert.ok(doc.sections.length>=6);}
  assert.equal((await(await request('/auth/username?username=fixture-admin')).json()).available,false);
  assert.equal((await(await request('/auth/username?username=fixture-owner')).json()).available,true);
  const p={username:'fixture-owner',password:'FixtureOwner2026!',passwordConfirm:'FixtureOwner2026!',phone:'010-0000-0000',email:'fixture@example.invalid',agreeTerms:true,agreePrivacy:true,confirmAge:true,termsVersion:config.termsVersion,privacyVersion:config.privacyVersion,businessStatus:'owned',projectName:'가상 검수 매장'};
  for(const patch of [{agreeTerms:false},{privacyVersion:'old'},{passwordConfirm:'Different123!'},{businessStatus:'admin'},{phone:'wrong'},{role:'admin'}])assert.equal((await request('/auth/signup',{...p,...patch})).status,400);
  const response=await request('/auth/signup',p);assert.equal(response.status,200);const state=await response.json();const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal(state.token,undefined);assert.equal(JSON.stringify(state).includes(serviceToken),false);assert.equal(state.customer.businessStatus,'owned');assert.equal(state.customer.projectName,p.projectName);assert.equal(state.customer.entitlements.competitorLimit,3);assert.equal(state.customer.entitlements.interestRegionLimit,1);assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await request('/auth/signup',p)).status,409);
  const members=JSON.parse(await fs.readFile(path.join(dir,'customer_db','b2b_members.json'),'utf8')).members;
  assert.equal(members.length,1);assert.equal(members[0].profile.ownershipStatus,'owned');assert.equal(members[0].profile.email,p.email);assert.equal(members[0].consents.termsVersion,POLICY_VERSION);assert.match(members[0].passwordHash,/^pbkdf2_sha256/);assert.equal(JSON.stringify(members).includes(p.password),false);
  const planning={...p,username:'fixture-planning',businessStatus:'planning'};
  const simultaneous=await Promise.all([request('/auth/signup',planning),request('/auth/signup',planning)]);assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
  await stop();await start();
  const resumed=await request('/me',null,{Cookie:cookie});assert.equal(resumed.status,200);assert.equal((await resumed.json()).customer.customerId,state.customer.customerId);
  assert.equal((await request('/auth/logout',{}, {Cookie:cookie,'X-CSRF-Token':state.csrfToken})).status,200);
  assert.equal((await request('/me',null,{Cookie:cookie})).status,401);
  const login=await request('/auth/login',{username:p.username,password:p.password});assert.equal(login.status,200);assert.equal((await login.json()).customer.customerId,state.customer.customerId);
  const admin=await fetch(`${backend}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'fixture-admin',password:'FixtureAdmin2026!'})});
  const listing=await fetch(`${backend}/api/admin/insight-customers`,{headers:{Cookie:admin.headers.get('set-cookie').split(';')[0]}});assert.equal((await listing.json()).customers.length,2);
  env.INSIGHT_SIGNUP_ENABLED='0';await stop();await start();
  assert.equal((await(await request('/config')).json()).signupEnabled,false);
  assert.equal((await request('/auth/signup',{...p,username:'closed-user'})).status,503);
  assert.equal((await request('/auth/login',{username:p.username,password:p.password})).status,200);
});
