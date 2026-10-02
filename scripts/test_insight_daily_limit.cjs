'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {createInsightStore}=require('./lib/insight_store.cjs');
const companies=['a','b'].map(id=>({companyId:'cmp_'+id,name:id,placeIds:[id]})),catalog={companies,regions:[]};
function fixture(t) {
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'insight-daily-')),'data.sqlite');
  let clock=Date.parse('2026-10-02T14:59:00Z'),store=createInsightStore({file,now:()=>clock});
  t.after(()=>store.close());
  const c=store.ensure({memberId:'user',username:'user',role:'b2b'}),cid=c.customerId;
  const cmd=(action,payload,id=randomUUID())=>({revision:store.get(cid).revision,requestKey:id,action,payload});
  for(const company of companies)store.update(cid,cmd('add-company',{kind:'competitor',companyId:company.companyId}),catalog);
  return {cid,cmd,get store(){return store;},nextDay(){clock+=60000;},reopen(){store.close();store=createInsightStore({file,now:()=>clock});}};
}
const payload=(id='cmp_a',mode='inspect')=>({companyId:id,checkIn:'2026-10-04',bookingRangeDays:30,dayUseMode:mode});
test('account daily limit spans companies, dates and modes; retries reuse their receipt and midnight KST resets it',t=>{
  const f=fixture(t);const first=f.cmd('collect',payload());
  f.store.preparation(f.cid,first,companies[0]);
  f.store.preparation(f.cid,first,companies[0]);
  f.store.preparation(f.cid,f.cmd('collect',payload()),companies[0]);
  assert.equal(f.store.requests(f.cid).length,1);
  for(const p of [payload('cmp_b'),payload('cmp_a','detail'),{...payload(),checkIn:'2026-10-05'}])
    assert.throws(()=>f.store.preparation(f.cid,f.cmd('collect',p),companies.find(c=>c.companyId===p.companyId)),{code:'DAILY_COLLECTION_LIMIT',statusCode:429});
  assert.equal(f.store.collectionAllowance(f.cid).resetsAt,'2026-10-02T15:00:00.000Z');
  f.reopen();assert.equal(f.store.collectionAllowance(f.cid).canRequest,false);
  const stale=f.cmd('collect',payload('cmp_b'));f.nextDay();
  f.store.preparation(f.cid,stale,companies[1]);
  assert.equal(f.store.requests(f.cid).length,2);assert.equal(f.store.collectionAllowance(f.cid).used,1);
});
test('concurrent stale commands cannot obtain a second claim; failed/blocked receipt does not replenish the daily request',t=>{
  const f=fixture(t),a=f.cmd('collect',payload()),b=f.cmd('collect',payload('cmp_b'));
  f.store.preparation(f.cid,a,companies[0]);
  assert.throws(()=>f.store.preparation(f.cid,b,companies[1]),{code:'STALE_REVISION'});
  const req=f.store.requests(f.cid)[0],scope={checkIn:'2026-10-04',bookingRangeDays:30};
  const {job}=f.store.reservePreparation(f.cid,req.requestId,companies[0],scope,f.cid);
  f.store.updatePreparationJob(job.jobId,'blocked','보호 중단');
  assert.equal(f.store.collectionAllowance(f.cid).canRequest,false);
  assert.throws(()=>f.store.preparation(f.cid,f.cmd('collect',payload('cmp_b')),companies[1]),{code:'DAILY_COLLECTION_LIMIT'});
});
test('legacy preparation requests and reads do not consume quota; admin customer view alone is exempt',t=>{
  const f=fixture(t);
  f.store.preparation(f.cid,f.cmd('prepare-data',{companyId:'cmp_a'}),companies[0]);
  assert.equal(f.store.collectionAllowance(f.cid).used,0);
  const admin=f.store.ensure({memberId:'insight-admin:fixture',username:'admin',role:'b2b',accountKind:'admin_preview'});
  const cmd=(action,payload)=>({revision:f.store.get(admin.customerId).revision,requestKey:randomUUID(),action,payload});
  for(const c of companies){f.store.update(admin.customerId,cmd('add-company',{kind:'competitor',companyId:c.companyId}),catalog);f.store.preparation(admin.customerId,cmd('collect',payload(c.companyId)),c);}
  assert.equal(f.store.collectionAllowance(admin.customerId).limit,null);assert.equal(f.store.collectionAllowance(admin.customerId).canRequest,true);
  assert.equal(f.store.collectionAllowance(f.cid).limit,1);
});
