'use strict';
// Read-only archive adapter. Writes a new derived snapshot outside the archive;
// never writes DataLab, original files, collection settings or published reports.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {applyInventoryEvidence,productEvidence}=require('../../../scripts/inventory_estimation.cjs');
const {readCompanyMasterProjection}=require('../../../scripts/lib/company_master_stream.cjs');
const PRIMARY=['gyeongnam_glamping_20260920_140022','gyeongnam_glamping_20260921_140004','gyeongnam_glamping_20260922_140041'];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const median=v=>{v=v.filter(x=>typeof x==='number'&&Number.isFinite(x)).sort((a,b)=>a-b);return v.length?v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2:null;};
function parseCsv(text){let row=[],cell='',quoted=false;const rows=[];text=text.replace(/^\uFEFF/,'');for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}else cell+=c;}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}if(quoted)throw Error('CSV_UNTERMINATED_QUOTE');const keys=rows.shift()||[];return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(keys.map((k,i)=>[k,r[i]??''])));}
function isLodging(r){return productEvidence(r).kind==='lodging';}
function failed(r){return r.collectionFailed||r.failed||r.error||r.blocked||r.missing||r.queryAttempted===false||r.stockObserved===false||r.inventoryObserved===false;}
function explicitObservation(r){return !failed(r)&&r.stockObserved===true&&r.inventoryObserved===true&&numeric(r.stock)!==null&&numeric(r.bookingCount)!==null;}
function manualRooms(c){if(!c||c.active===false)return null;const n=numeric(c.lodgingBasisTotal);if(Number.isInteger(n)&&n>0)return n;const sum=(c.roomSegments||[]).reduce((a,s)=>a+(numeric(s.count)||0),0);return Number.isInteger(sum)&&sum>0?sum:null;}
async function buildSavedComparison(inputDirectory,outputFile){
  const input=path.resolve(inputDirectory),output=path.resolve(outputFile),outputs=path.join(input,'outputs');
  const folded=p=>process.platform==='win32'?p.toLowerCase():p;
  const inside=(target,base)=>folded(target)===folded(base)||folded(target).startsWith(folded(base)+path.sep);
  const realInput=fs.realpathSync(input);
  let ancestor=path.dirname(output);while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  const realOutput=path.resolve(fs.realpathSync(ancestor),path.relative(ancestor,output));
  if(inside(output,input)||inside(realOutput,realInput))throw Error('OUTPUT_MUST_BE_OUTSIDE_ARCHIVE');
  if(fs.existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS');
  const hashes=new Map();
  function readBytes(file){const p=path.resolve(file);if(!inside(p,input)||!inside(fs.realpathSync(p),realInput))throw Error('ARCHIVE_REFERENCE_ESCAPE');const bytes=fs.readFileSync(p);hashes.set(p,hash(bytes));return bytes;}
  function read(file){return readBytes(file).toString('utf8').replace(/^\uFEFF/,'');}
  const sources=[];const fileIds=new Map();
  function ref(file,suffix=''){const key=path.relative(input,file).replaceAll('\\','/')+suffix;if(!fileIds.has(key)){const id='source-'+(sources.length+1);fileIds.set(key,id);sources.push({id,path:key});}return fileIds.get(key);}
  function loadRun(id){
    const base=path.join(outputs,id),manifestFile=path.join(base,'manifest.json');if(!fs.existsSync(manifestFile))return null;
    const manifest=JSON.parse(read(manifestFile));if(manifest.keyword!=='경남글램핑')return null;
    const csvName=manifest.fileRoles?.overall||'경남글램핑_네이버전체순위.csv',csvFile=path.resolve(base,csvName);
    if(!fs.existsSync(csvFile))return null;
    const top=parseCsv(read(csvFile)).filter(r=>Number(r.overall_rank)>=1&&Number(r.overall_rank)<=20).sort((a,b)=>Number(a.overall_rank)-Number(b.overall_rank));
    const byPlace=new Map(top.map(r=>[String(r.place_id),{row:r,lodging:[],dayuse:[],sourceRefs:[],sourcesByKind:{}}]));
    const seen=new Set();
    for(const x of manifest.detailJsonFiles||[]){const p=byPlace.get(String(x.placeId));if(!p||!x.file||seen.has(x.file))continue;seen.add(x.file);const f=path.resolve(base,x.file);if(!fs.existsSync(f))continue;const raw=JSON.parse(read(f)),rows=Array.isArray(raw)?raw:raw.items||raw.products||[];const kind=x.field==='dayuse_weekly_product_details'?'dayuse':x.field==='weekly_product_details'?'lodging':null;if(!kind||!rows.length)continue;p[kind].push(...rows);p.sourceRefs.push(ref(f));p.sourcesByKind[kind]=true;}
    for(const p of byPlace.values())for(const [column,kind]of [['네이버요일별상품상세JSON','lodging'],['dayUseWeeklyProductDetailsJson','dayuse']]){
      if(p.sourcesByKind[kind])continue;let arr;try{arr=JSON.parse(p.row[column]||'null');}catch{arr=null;}if(Array.isArray(arr)){p[kind]=arr;p.sourceRefs.push(ref(csvFile,'#'+p.row.place_id+':'+column));}
    }
    // Deduplicate references per company/type; disagreement is not silently summed.
    for(const p of byPlace.values())for(const kind of ['lodging','dayuse']){const map=new Map();for(const r of p[kind]){const key=[r.date,r.bizItemId||r.key||r.name].join('|');if(map.has(key)&&JSON.stringify(map.get(key))!==JSON.stringify(r))throw Error('CONFLICTING_PRODUCT_DATE_RECORDS');map.set(key,r);}p[kind]=[...map.values()];}
    return {id,manifest,byPlace,manifestRef:ref(manifestFile),csvRef:ref(csvFile)};
  }
  const all=[];for(const d of fs.readdirSync(outputs,{withFileTypes:true}).filter(d=>d.isDirectory()&&/^gyeongnam_glamping_/.test(d.name)).sort((a,b)=>a.name.localeCompare(b.name))){const r=loadRun(d.name);if(r)all.push(r);}
  const primary=PRIMARY.map(id=>all.find(r=>r.id===id));if(primary.some(r=>!r))throw Error('PRIMARY_RUN_REQUIRED');
  if(primary.some(r=>r.byPlace.size!==20||[...r.byPlace.keys()].some(id=>!/^\d+$/.test(id))))throw Error('PRIMARY_TOP20_IDENTITIES_REQUIRED');
  const targetIds=new Set(primary.flatMap(r=>[...r.byPlace.keys()]));
  const masterFile=path.join(input,'company_master','companies.json');
  readBytes(masterFile);
  const master=await readCompanyMasterProjection(masterFile,{projectCompany:c=>{
    if(c.mergedIntoCompanyId||c.deletedAt)return undefined;
    if(!(c.placeIds||[]).some(v=>targetIds.has(String(v))))return undefined;
    return {companyId:c.companyId,name:c.primaryName,placeIds:(c.placeIds||[]).map(String),manualCorrection:c.manualCorrection,addresses:c.addresses||[]};
  }});
  const companies=[];const maxima=new Map();const productMaxima=new Map();
  for(const r of all)for(const [placeId,p]of r.byPlace){if(!targetIds.has(placeId))continue;const dateTotals=new Map();let max=productMaxima.get(placeId)||{};
    for(const x of p.lodging.filter(isLodging)){const stock=numeric(x.stock??x.rawTotal??x.total);if(stock===null||stock<0||failed(x))continue;const key=String(x.bizItemId||x.key||x.name);max[key]=Math.max(max[key]||0,stock);dateTotals.set(x.date,(dateTotals.get(x.date)||0)+stock);}
    productMaxima.set(placeId,max);maxima.set(placeId,Math.max(maxima.get(placeId)||0,...dateTotals.values()));
  }
  for(const placeId of targetIds){const matches=Object.values(master.companies).filter(c=>c.placeIds.includes(placeId));const c=matches.length===1?matches[0]:null;const observedMaximum=maxima.get(placeId)||0;const override=placeId==='35644668'?16:manualRooms(c?.manualCorrection);
    const sample=primary.map(r=>r.byPlace.get(placeId)).find(Boolean);const rooms=override||observedMaximum||null;
    companies.push({id:c?.companyId||'place:'+placeId,identityStatus:c?'mapped':'mapping_unverified',placeId,name:c?.name||sample?.row['업체명']||placeId,address:(c?.addresses||[]).map(x=>typeof x==='string'?x:x.address||'').filter(Boolean).join(' · ')||sample?.row['주소']||'',capacity:{rooms,observedMaximum,reviewed:!!override,status:override?'reviewed':rooms?'estimated':'missing',source:override?'DB 검수값':'저장 경남글램핑 최대 관측 추정',reviewedAt:c?.manualCorrection?.updatedAt||null,revision:hash(JSON.stringify({rooms,correction:c?.manualCorrection||null})).slice(0,16)},ranks:Object.fromEntries(primary.map(r=>[r.id,Number(r.byPlace.get(placeId)?.row.overall_rank)||null])),correction:c?.manualCorrection||null});
  }
  const daily=[];
  for(const r of primary)for(const [placeId,p]of r.byPlace){const c=companies.find(c=>c.placeId===placeId);const allRaw=[...p.lodging,...p.dayuse];const kindFlags=p.dayuse.length?'present':Number(p.row['데이유즈상품수'])>0?'present':Number(p.row['미분류상품수'])>0?'unknown':'none';
    const prepare=x=>explicitObservation(x)?x:{...x,stockObserved:false,bookingObserved:false,collectionFailed:true};
    const item=applyInventoryEvidence({placeId,weeklyProductDetails:p.lodging.map(prepare),dayUseWeeklyProductDetails:p.dayuse.map(prepare),checkIn:r.manifest.checkIn,bookingRangeDays:r.manifest.bookingRangeDays||31,nightItemCount:Number(p.row['숙박상품수'])||0,dayUseItemCount:Number(p.row['데이유즈상품수'])||0,dayUsePresence:kindFlags,dayUseScheduleStatus:p.dayuse.length?'requested':kindFlags==='present'?'missing':'not_present',inventoryCapacityBaseline:{lodging:c.capacity.rooms,lodgingProducts:productMaxima.get(placeId)||{},...(c.capacity.reviewed?{lodgingOverride:{count:c.capacity.rooms}}:{}),productStockCorrections:c.correction?.productStockCorrections||[]}});
    const rows=item.inventoryEvidence?.lodging?.rows||[];
    for(const row of rows){const raw=p.lodging.filter(x=>x.date===row.date&&isLodging(x));const legacy=raw.some(x=>x.stockObserved===undefined||x.inventoryObserved===undefined);const observed=raw.length>0&&raw.every(explicitObservation);const reasons=[];
      if(legacy)reasons.push('구형 자료: 개별 응답 근거 미확인');if(!observed&&!legacy)reasons.push('상품별 응답 누락 또는 오류');if(row.inventoryConflict||row.capacityConflict)reasons.push('객실 기준과 관측 수량 충돌');if(row.partial)reasons.push('일부 상품 또는 공유 데이유즈 미확인');if(!c.capacity.rooms)reasons.push('객실 기준 미확인');if(!c.capacity.reviewed)reasons.push('객실수 최대 관측 추정 · DB 검수 필요');
      const sharingWarnings=row.sharedDayUseEvidence?.warnings?.map(w=>w.code)||[];
      if(sharingWarnings.length)reasons.push('공유 데이유즈 객실군 검토 필요');
      const valid=observed&&!row.partial&&!row.inventoryConflict&&!row.capacityConflict&&!sharingWarnings.length&&[row.total,row.publicBookings,row.phoneBookings,row.sold,row.available].every(x=>Number.isSafeInteger(x)&&x>=0)&&row.total>0;
      const prices=raw.filter(x=>numeric(x.price)>0&&!failed(x)).map(x=>({id:String(x.bizItemId||x.key||x.name),name:String(x.name||''),price:Number(x.price),conditionStatus:'unverified'}));
      daily.push({runId:r.id,companyId:c.id,placeId,date:row.date,supply:valid?row.total:null,publicBookings:valid?row.publicBookings:null,inferredBookings:valid?row.phoneBookings:null,sold:valid?row.sold:null,rate:valid?row.rate:null,available:valid?row.available:null,quantityStatus:valid?'valid':legacy?'legacy_unverified':'unverified',quantityEvidence:legacy?'legacy_no_per_product_flags':'explicit_inventory_flags',dayUseExcluded:valid?row.sharedDayUseExcluded:null,dayUseSharingPolicy:item.inventoryEvidence?.dayUseSharingPolicy||null,dayUseSharingWarnings:row.sharedDayUseEvidence?.warnings?.map(w=>w.code)||[],priceValues:prices.map(x=>x.price),productPrices:prices,productCount:raw.length,medianProductPrice:median(prices.map(x=>x.price)),priceStatus:prices.length===raw.length&&raw.length?'available':'partial',productSignature:raw.map(x=>String(x.bizItemId||x.key||x.name)).sort().join('|'),capacityRevision:c.capacity.revision,reasons,sourceRefs:[r.manifestRef,...p.sourceRefs],legacyRecordedPublicBookings:legacy?raw.reduce((s,x)=>s+(numeric(x.bookingCount)||0),0):null});
    }
  }
  const runs=primary.map(r=>{const dates=[...new Set(daily.filter(d=>d.runId===r.id).map(d=>d.date))].sort();return {id:r.id,observedAt:r.manifest.collectedAt,observedAtPrecision:'run',start:dates[0],end:dates.at(-1),members:[...r.byPlace.keys()].map(id=>companies.find(c=>c.placeId===id).id),quality:r.manifest.collectionQuality?.status||'unknown',rankRange:'1-20',manifestRef:r.manifestRef};});
  const integrity=[...hashes].map(([file,before])=>({path:path.relative(input,file).replaceAll('\\','/'),sha256:before,unchanged:hash(fs.readFileSync(file))===before}));if(integrity.some(x=>!x.unchanged))throw Error('ARCHIVE_CHANGED_DURING_READ');
  const snapshot={meta:{schemaVersion:1,analysisVersion:'saved-keyword-comparison-2026-10-30.2',archiveDirectoryDate:'2026-10-22',keyword:'경남글램핑',ownerPlaceId:'35644668',defaultRunId:PRIMARY[2],defaultPreviousRunId:PRIMARY[1],defaultStart:'2026-09-22',defaultEnd:'2026-10-20',timezone:'Asia/Seoul',rankRange:'1-20',defaultCohort:'latest',benchmarkIncludesOwner:true,companyUnion:companies.length,sourceType:'saved_historical_originals',capacityBasisApplication:'archive_db_review_applied_retrospectively',historicalRecalculation:true,capacityBasisLabel:'보존 DB의 검수값을 과거 원본에 적용한 로컬 재계산',createdAt:new Date().toISOString(),liveConnected:false,automaticCollection:false},runs,companies:companies.map(({correction,...c})=>c),daily,observations:[],provenance:{sources,sourceFiles:integrity,sourceFilesUnchanged:true,inputDirectory:input,inventoryPolicy:'existing_inventory_estimation_v5',capacityPolicy:'saved_db_correction_then_exact_keyword_historical_maximum',capacityHistoricalRunIds:all.map(r=>r.id),definitions:['예약률=(공개예약+타채널 추정예약)/같은 유효 날짜 공급수량. 월명 포함 상위 20개 표본입니다.','고객 표시 수량 단위는 실이며 기간 합계는 숙박일 수량의 누적입니다.','가격은 숙박 상품×날짜의 양의 공개 표시가격 원자값 전체의 중앙값입니다. 상품 조건 미확인으로 참고 비교만 가능합니다.','9/20 구형 수량 응답은 개별 관측 근거가 없어 예약률과 예약 변화에서 제외합니다. 가격은 별도로 보여줍니다.','관측 사이 순증감은 신규 예약수·실제 예약접수일·실제 리드타임이 아닙니다.','보존 DB 검수와 최대관측 기준을 적용한 로컬 파생값입니다. 현재 운영 서버 자료나 확정 매출이 아닙니다.','공휴일 자료는 이 검토에 연결하지 않았습니다. 월~목 필터도 공휴일을 포함할 수 있습니다.'],policy:{sourceWrites:false,networkCalls:false,collectionRequested:false,scheduleChanged:false,publishedReportsChanged:false}}};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(snapshot)+'\n',{flag:'wx'});return snapshot;
}
if(require.main===module){if(!process.argv[2]||!process.argv[3])throw Error('USAGE: node build-saved-comparison.cjs INPUT_ARCHIVE OUTPUT_JSON');buildSavedComparison(process.argv[2],process.argv[3]).then(s=>console.log(JSON.stringify({output:process.argv[3],companies:s.companies.length,daily:s.daily.length,sourceFiles:s.provenance.sourceFiles.length,allUnchanged:s.provenance.sourceFilesUnchanged}))).catch(e=>{console.error(e.code||e.message);process.exitCode=1;});}
module.exports={buildSavedComparison,parseCsv};
