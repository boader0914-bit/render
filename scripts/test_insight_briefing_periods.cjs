'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createInsightAnalysis}=require('./lib/insight_analysis.cjs');
const {selectionFor,dailyPeriods}=require('./lib/insight_briefing_periods.cjs');
const {fixture,day}=require('./fixtures/insight_briefing_period_fixture.cjs');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const allDays=company=>company.reservationPeriods.months.flatMap(month=>month.weeks.flatMap(week=>week.daily));

test('default briefing enumerates every stored month in order and trims only the outside placeholders',async()=>{
  const f=fixture(),report=await createInsightAnalysis(f.args).briefing(f.customer,'own');
  assert.deepEqual(report.selection,{stayMode:'all_available',month:null,start:null,end:null});
  assert.deepEqual(report.period,{start:'2026-09-10',end:'2026-11-03',days:55});
  assert.deepEqual(report.availablePeriod,{start:'2026-09-10',end:'2026-11-03',months:['2026-09','2026-10','2026-11'],scope:'all'});
  assert.deepEqual(report.availableMonths,['2026-09','2026-10','2026-11']);
  assert.equal(report.mode,'current_briefing');assert.equal(report.asOf,'2026-10-26');assert.equal(report.comparisonPolicy.mode,'historical');
  assert.deepEqual(f.calls.filter(row=>row.type==='detail').map(row=>[row.id,row.month]),[['own','2026-09'],['own','2026-10'],['own','2026-11'],['competitor','2026-09'],['competitor','2026-10'],['competitor','2026-11']]);
  assert.equal(f.maxActive,1);assert.equal(report.companies[0].summary.sold,7);assert.equal(report.companies[0].summary.days,5);
  assert.equal(report.companies[0].summaryQuality.mode,'historical');assert.ok(!report.companies[0].summaryQuality.excludedDates.some(row=>row.codes.includes('OBSERVATION_STALE')));
  const dates=allDays(report.companies[0]);assert.equal(dates.length,55);assert.equal(new Set(dates.map(row=>row.date)).size,55);
  assert.equal(dates.find(row=>row.date==='2026-09-11').missing,true);assert.equal(dates.find(row=>row.date==='2026-09-11').sold,null);
  assert.equal(dates.find(row=>row.date==='2026-09-12').sold,0);assert.equal(dates.find(row=>row.date==='2026-09-12').missing,false);
});

test('month totals and Monday-based weeks retain quantity gaps, partial prices and known subtotals without summing them twice',async()=>{
  const f=fixture(),report=await createInsightAnalysis(f.args).briefing(f.customer,'own'),month=report.companies[0].reservationPeriods.months[0];
  assert.equal(month.month,'2026-09');assert.deepEqual(month.period,{start:'2026-09-10',end:'2026-09-30',days:21});
  assert.equal(month.summary.sold,null);assert.equal(month.summary.estimatedRevenue,null);assert.equal(month.summary.observedDays,3);assert.equal(month.summary.missingDays,18);
  assert.equal(month.summary.knownSoldSubtotal,3);assert.equal(month.summary.knownRevenueSubtotal,250000);assert.equal(month.summary.separatePartialRevenueSubtotal,20000);
  assert.equal(month.weeks[0].weekStart,'2026-09-07');
  assert.equal(month.weeks[0].summary.knownSoldSubtotal,2);assert.equal(month.weeks[0].summary.sold,null);
  const partial=allDays(report.companies[0]).find(row=>row.date==='2026-09-29');
  assert.equal(partial.estimatedRevenue,null);assert.equal(partial.knownRevenueSubtotal,50000);assert.equal(partial.knownPartialRevenue,20000);assert.equal(partial.revenuePartial,true);
  const emptyWeek=month.weeks.find(week=>week.weekStart==='2026-09-14');assert.equal(emptyWeek.summary.quantityStatus,'unknown');assert.equal(emptyWeek.summary.knownSoldSubtotal,null);assert.equal(emptyWeek.summary.knownRevenueSubtotal,null);
});

test('explicit month and custom selectors read only their selected months and do not apply recent-seven-day filtering',async()=>{
  for(const [options,months,period] of [[{stayMode:'month',month:'2026-09'},['2026-09'],{start:'2026-09-01',end:'2026-09-30',days:30}],
    [{stayMode:'custom',start:'2026-09-11',end:'2026-10-27'},['2026-09','2026-10'],{start:'2026-09-11',end:'2026-10-27',days:47}]]) {
    const f=fixture(),report=await createInsightAnalysis(f.args).briefing(f.customer,'own',options);
    assert.deepEqual(report.period,period);assert.equal(report.availablePeriod.scope,'selection');
    assert.deepEqual(f.calls.filter(row=>row.type==='detail'&&row.id==='own').map(row=>row.month),months);
    assert.equal(report.companies[0].summaryQuality.mode,'historical');assert.ok(!report.companies[0].summaryQuality.excludedDates.some(row=>row.codes.includes('OBSERVATION_STALE')));
    assert.equal(allDays(report.companies[0]).length,period.days);
  }
});

test('explicit upcoming30 preserves the current freshness policy and thirty-day series',async()=>{
  const f=fixture(),report=await createInsightAnalysis(f.args).briefing(f.customer,'own',{stayMode:'upcoming30'});
  assert.deepEqual(report.period,{start:'2026-10-26',end:'2026-11-24',days:30});assert.equal(report.comparisonPolicy.mode,'current');
  assert.equal(report.companies[0].reservationSeries.points.length,30);assert.equal(allDays(report.companies[0]).length,30);
});

test('failed months keep normal company amounts and explain only their failed company and month',async()=>{
  const f=fixture({failMonth:'2026-10'}),report=await createInsightAnalysis(f.args).briefing(f.customer,'own');
  assert.equal(report.companies[0].summary.sold,4);assert.equal(report.companies[0].sourceStatus,'partial');
  assert.ok(report.companies[0].sourceIssues.some(row=>row.month==='2026-10'&&row.code==='COMPANY_SOURCE_UNAVAILABLE'));
  assert.equal(report.companies[0].reservationPeriods.months.find(month=>month.month==='2026-10').summary.quantityStatus,'unknown');
  assert.equal(report.dataQuality.status,'partial');assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
});

for(const options of [{stayMode:'month',month:'2026-09'},{stayMode:'custom',start:'2026-09-11',end:'2026-09-30'}])test(`${options.stayMode} preserves normal September observations when a different-month catalog lookup fails`,async()=>{
  const f=fixture(),before=JSON.stringify(f.rows),normalMonthList=f.reader.companyMonths;
  f.reader.companyMonths=async id=>{if(id==='own')throw Error('PRIVATE_METADATA_FAILURE');return normalMonthList(id);};
  const report=await createInsightAnalysis(f.args).briefing(f.customer,'own',options),own=report.companies.find(company=>company.companyId==='own'),other=report.companies.find(company=>company.companyId==='competitor');
  assert.equal(own.sourceStatus,'partial');assert.equal(other.sourceStatus,'ready');
  assert.equal(own.summary.sold,options.stayMode==='month'?3:1);assert.equal(other.summary.sold,own.summary.sold);
  assert.equal(own.summary.knownRevenueSubtotal,options.stayMode==='month'?250000:50000);
  const issue=own.sourceIssues.find(row=>row.code==='COMPANY_MONTHS_UNAVAILABLE');assert.ok(issue);assert.equal(issue.month,'2026-10');
  assert.deepEqual(issue.period,{start:'2026-10-01',end:'2026-10-31'});
  assert.ok(report.dataQuality.issues.every(row=>row.period.start<=row.period.end));
  assert.equal(allDays(own).length,options.stayMode==='month'?30:20);assert.equal(JSON.stringify(f.rows),before);assert.doesNotMatch(JSON.stringify(report),/PRIVATE_METADATA_FAILURE/);
});

test('an overlapping catalog-error month is clipped to the selected valid interval only',async()=>{
  const f=fixture();f.reader.companyMonths=async()=>{throw Error('metadata failed');};
  const report=await createInsightAnalysis(f.args).briefing(f.customer,'own',{stayMode:'custom',start:'2026-10-24',end:'2026-10-28'});
  assert.equal(report.companies[0].summary.sold,3);
  assert.deepEqual(report.companies[0].sourceIssues.find(row=>row.code==='COMPANY_MONTHS_UNAVAILABLE').period,{start:'2026-10-24',end:'2026-10-28'});
});

test('same company and day are counted once, while conflicting integrated projections remain unknown',async()=>{
  const f=fixture({duplicates:true});f.customer.relations.push({...f.customer.relations[0]});
  const report=await createInsightAnalysis(f.args).briefing(f.customer,'own');assert.equal(report.companies.length,2);assert.equal(report.companies[0].summary.sold,7);
  const company={companyId:'own',rooms:16,days:[day('2026-09-10',2),day('2026-09-10',3)]};
  const periods=dailyPeriods(company,{start:'2026-09-10',end:'2026-09-10'},{asOf:'2026-10-26',mode:'historical'}),row=periods.months[0].weeks[0].daily[0];
  assert.equal(row.sold,null);assert.equal(row.quantityStatus,'conflict');assert.ok(row.codes.includes('DUPLICATE_STAY_DATE'));
});

for(const kind of ['company_capacity','saved_basis','daily_inventory'])test(`${kind} rate warnings agree at month, week and day levels without hiding valid quantities or another company`,async()=>{
  const f=fixture(),before=JSON.stringify(f.rows);
  if(kind==='company_capacity')f.catalog.companies[0].capacityConflict=true;
  if(kind==='saved_basis'||kind==='daily_inventory'){
    const original=f.reader.companyDetail;
    f.reader.companyDetail=async(id,options)=>{const detail=await original(id,options);if(id==='own'){
      if(kind==='saved_basis')detail.integrated.roomBasis.count=17;
      else detail.current.daily.find(row=>row.date==='2026-09-10').inventoryConflict=true;
    }return detail;};
  }
  const report=await createInsightAnalysis(f.args).briefing(f.customer,'own',{stayMode:'custom',start:'2026-09-10',end:'2026-09-10'});
  const own=report.companies.find(company=>company.companyId==='own'),other=report.companies.find(company=>company.companyId==='competitor');
  const month=own.reservationPeriods.months[0],week=month.weeks[0],row=week.daily[0];
  assert.equal(own.summary.reservationRate,null);assert.equal(month.summary.reservationRate,null);assert.equal(week.summary.reservationRate,null);assert.equal(row.reservationRate,null);
  assert.equal(row.quantityStatus,'ready');assert.equal(row.missing,false);assert.equal(row.sold,2);assert.equal(row.estimatedRevenue,200000);
  assert.equal(own.summary.sold,2);assert.equal(own.summary.estimatedRevenue,200000);assert.equal(month.summary.sold,2);assert.equal(week.summary.sold,2);
  assert.equal(other.summary.reservationRate,2/16);assert.equal(allDays(other)[0].reservationRate,2/16);
  assert.equal(JSON.stringify(f.rows),before);
});

test('standalone company and daily inventory conflicts use the same rate policy while missing observations stay unknown',()=>{
  for(const [companyFlag,rowFlag] of [[{capacityConflict:true},{}],[{inventoryConflict:true},{}],[{capacityStatus:'conflict'},{}],[{},{inventoryConflict:true}],[{},{capacityConflict:true}]]){
    const company={companyId:'own',rooms:16,...companyFlag,days:[day('2026-09-10',2,rowFlag)]};
    const tree=dailyPeriods(company,{start:'2026-09-10',end:'2026-09-11'},{asOf:'2026-10-26',mode:'historical'}),month=tree.months[0],row=month.weeks[0].daily[0],missing=month.weeks[0].daily[1];
    assert.equal(row.reservationRate,null);assert.equal(row.sold,2);assert.equal(row.estimatedRevenue,200000);
    assert.equal(month.summary.reservationRate,null);assert.equal(month.weeks[0].summary.reservationRate,null);
    assert.equal(missing.reservationRate,null);assert.equal(missing.sold,null);assert.equal(missing.missing,true);
  }
});

test('empty all-available archives return a real empty period and no invented current-month zero',async()=>{
  const f=fixture({empty:true}),report=await createInsightAnalysis(f.args).briefing(f.customer,'own');
  assert.deepEqual(report.period,{start:null,end:null,days:0});assert.deepEqual(report.availableMonths,[]);
  assert.deepEqual(report.availablePeriod,{start:null,end:null,months:[],scope:'all'});
  for(const company of report.companies){assert.equal(company.summary.sold,null);assert.equal(company.summary.estimatedRevenue,null);assert.equal(company.summaryQuality.reservationRateAvailable,false);assert.deepEqual(company.reservationPeriods,{period:{start:null,end:null,days:0},asOf:'2026-10-26',months:[]});}
  const coverage=report.actions.find(row=>row.key==='coverage');assert.ok(coverage);assert.match(coverage.reason,/숙박일 구간을 확인하지 못했습니다/);assert.doesNotMatch(coverage.reason,/30일|0일|향후/);
  assert.ok(!f.calls.some(row=>row.type==='detail'));
});

test('saved-only uses the same period contract and never reads the normal company adapter',async()=>{
  const f=fixture();f.args.collectionResults={companyMonths:()=>assert.fail('normal month reader'),companyDetail:()=>assert.fail('normal detail reader')};
  const report=await createInsightAnalysis(f.args).briefing(f.customer,'own',{savedOnly:true});
  assert.equal(report.selection.stayMode,'all_available');assert.equal(report.period.start,'2026-09-10');assert.equal(report.calculation.mode,'saved_only');
});

test('legacy detail discovery is a single projected read and preserves older observations without month or timestamp fabrication',async()=>{
  const f=fixture();let reads=0;const legacy={companyDetail:async()=>{reads++;return {legacyObservationView:true,current:{daily:[day('2026-09-01',2),day('2026-10-02',1)]}};}};
  f.args.collectionResults=legacy;f.customer.relations=f.customer.relations.slice(0,1);
  const report=await createInsightAnalysis(f.args).briefing(f.customer,'own');
  assert.equal(reads,1);assert.deepEqual(report.period,{start:'2026-09-01',end:'2026-10-02',days:32});assert.equal(report.companies[0].summary.sold,3);
});

test('period selection validates strict real dates, irrelevant fields, reversed ranges and bounded spans',()=>{
  for(const value of [{stayMode:'invalid'},{stayMode:'month',month:'2026-13'},{stayMode:'month',month:'2026-09',start:'2026-09-01'},{stayMode:'custom',start:'2026-02-30',end:'2026-03-03'},
    {stayMode:'custom',start:'2026-10-02',end:'2026-10-01'},{stayMode:'custom',start:'2000-01-01',end:'2026-10-26'},{stayMode:'all_available',month:'2026-09'},{stayMode:'upcoming30',end:'2026-11-01'}])assert.throws(()=>selectionFor(value,'2026-10-26'),{code:'INVALID_PERIOD'});
});

test('a later observation cannot expand the data boundary or enter the as-of-today report',async()=>{
  const f=fixture();f.rows['2026-09'].unshift(day('2026-09-01',9,{collectedAt:'2026-10-27T01:00:00Z'}));
  f.rows['2026-10'].push(day('2026-10-25',9,{collectedAt:'2026-10-27T01:00:00Z'}));
  const before=JSON.stringify(f.rows),report=await createInsightAnalysis(f.args).briefing(f.customer,'own');
  assert.equal(report.period.start,'2026-09-10');assert.equal(report.companies[0].summary.sold,7);
  const row=allDays(report.companies[0]).find(row=>row.date==='2026-10-25');assert.equal(row.sold,null);assert.ok(row.codes.includes('OBSERVATION_AFTER_CUTOFF'));
  assert.equal(JSON.stringify(f.rows),before,'read views never rewrite the stored source projection');
});

test('the authenticated central route accepts canonical period modes and refuses duplicate, extra or incoherent query conditions before reading',async t=>{
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'insight-briefing-period-http-')),store=createInsightStore({file:path.join(root,'members.sqlite')});let server;
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('insight-briefing-period-http-'));await fs.rm(root,{recursive:true,force:true});});
  const c=store.ensure({memberId:'test-period-member',username:'test-period-member',role:'b2b'});
  store.update(c.customerId,{revision:c.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId:'own'}},f.catalog);
  const token=store.session(c.customerId),serviceToken='test-period-service-credential-with-at-least-32-characters';
  const handler=createInsightHttp({store,serviceToken,catalog:async()=>f.catalog,memberActive:async()=>true,analysis:createInsightAnalysis(f.args)});
  server=http.createServer((req,res)=>handler.internal(req,res,new URL(req.url,'http://fixture')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=(query,session=token)=>fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/reports/briefing?ownId=own${query}`,{headers:{Authorization:'Bearer '+serviceToken,'X-Insight-Session':session}});
  assert.equal((await get('','')).status,401);
  for(const [query,mode] of [['','all_available'],['&stayMode=month&month=2026-09','month'],['&stayMode=custom&start=2026-09-10&end=2026-09-13','custom'],['&stayMode=upcoming30','upcoming30'],['&savedOnly=1&stayMode=all_available','all_available']]) {
    const response=await get(query);assert.equal(response.status,200);assert.equal((await response.json()).selection.stayMode,mode);
  }
  const before=f.calls.length;
  for(const query of ['&stayMode=month','&stayMode=month&month=2026-09&month=2026-10','&stayMode=all_available&month=2026-09','&stayMode=custom&start=2026-02-30&end=2026-03-01','&stayMode=month&month=2026-09&asOf=2026-09-30','&stayMode=upcoming30&stayMode=month'])assert.equal((await get(query)).status,400);
  assert.equal(f.calls.length,before);assert.equal(store.requests(c.customerId).length,0);
});
