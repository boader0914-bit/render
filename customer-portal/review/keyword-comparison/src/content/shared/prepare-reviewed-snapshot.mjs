import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const app=path.resolve(here,'../../..');
const rawPath=path.resolve(process.argv[2]);
const enginePath=path.resolve(process.argv[3]);
const raw=JSON.parse(fs.readFileSync(rawPath,'utf8'));
const existing=JSON.parse(fs.readFileSync(path.join(app,'src/data.json'),'utf8'));
if(raw.meta?.keyword!=='경남글램핑'||raw.meta.liveConnected!==false||raw.meta.automaticCollection!==false)throw Error('SAVED_ONLY_POLICY_REQUIRED');
const files=(raw.provenance.sources||[]).map(source=>typeof source==='string'?source:source.path||source.file).filter(Boolean);
const source={label:'경남글램핑 보존 상품·날짜 관측',description:'9/20·21·22 저장 원본을 읽기 전용으로 정규화한 자료. 현재 운영 서버와 미연결.',files,coverage:{start:'2026-09-20',end:'2026-10-22',timezone:'Asia/Seoul'},metricDefinitions:[
  {label:'추정 예약률',definition:'정상 수량의 (공개예약+타채널 추정예약) 합계 ÷ 같은 유효 공급 합계. 표본은 월명을 포함한다.',formula:'sum(sold)/sum(supply)'},
  {label:'숙박상품 표시가격 중앙값',definition:'양의 숙박상품×숙박일 표시가격을 모은 중앙값. 실제 객단가·실결제액이 아니며 상품 조건이 일치하는지 미확인.'},
  {label:'공개예약 순변화',definition:'같은 업체·숙박일·상품구성·객실 기준의 현재 공개예약 합계 − 이전 공개예약 합계. 실제 신규 예약 건수나 리드타임 아님.'},
  {label:'자료 확보율',definition:'유효한 업체·숙박일 수 ÷ 선택 표본의 기대 업체·숙박일 수. 수량과 가격의 유효성은 별도.'}
],caveats:['2026/10/22 폴더에 보존된 과거 원본이며 최신 운영 상태를 확인한 자료가 아니다.','구형 개별 응답 미확인·수량 충돌은 정상 0으로 바꾸지 않는다.','DB 검수 기준이 없는 업체는 최대관측 추정으로 별도 경고한다.','쿠폰 사용·실결제·실제 예약접수일이 없어 효과와 실제 리드타임을 계산하지 않는다.'],evidenceFlow:[{title:'저장 원본 읽기',detail:'manifest의 정확 경남글램핑 키워드를 확인하고 상위 20개와 외부 JSON/인라인 CSV 상품 상세를 결합한다. 같은 회사·상세종류는 외부 본문을 우선한다.'},{title:'객실·예약 근거',detail:'저장 DB 검수값과 상품별 최대관측, 공유 데이유즈·런치/디너 재사용 보정을 적용한다. 개별 관측 플래그가 없는 구형 수량은 보류한다.'},{title:'동일 조건 비교',detail:'수집 회차·업체 표본·숙박일·요일을 먼저 제한하고 예약률의 분자/분모를 다시 합산한다. 순변화는 동일 상품구성·공급·검수 버전만 비교한다.'}],methods:[{language:'javascript',code:'Source builder: customer-portal/analysis/keyword-comparison/build-saved-comparison.cjs; pure projection: customer-portal/analysis/keyword-comparison/compare.mjs. Original source refs and hashes are retained in the comparison payload.'}]};
const membership=raw.runs.flatMap(run=>run.members.map(companyId=>{const company=raw.companies.find(c=>c.id===companyId);return {runId:run.id,observedAt:run.observedAt,companyId,placeId:company?.placeId,name:company?.name,rank:company?.ranks?.[run.id]??null};}));
const products=raw.daily.flatMap(day=>(day.productPrices||[]).map(product=>({runId:day.runId,companyId:day.companyId,placeId:day.placeId,date:day.date,...product,sourceRefs:day.sourceRefs})));
const snapshot={id:existing.id,surface:'dashboard',title:'경남글램핑 · 월명 비교',generatedAt:raw.meta.createdAt,status:'reviewed',buildStatus:process.argv.includes('--complete')?'complete':'updating',filters:[],queries:{comparison_payload:{rows:[{payload:JSON.stringify(raw)}],payloadColumns:['payload'],source:{...source,label:'저장 비교 입력과 계산 근거'}},company_daily:{rows:raw.daily,source},rank_membership:{rows:membership,source:{...source,label:'검색 회차별 상위 20개 업체 목록'}},product_observations:{rows:products,source:{...source,label:'상품×숙박일 표시가격 근거'}}}};
fs.writeFileSync(path.join(app,'src/data.json'),JSON.stringify(snapshot));
fs.copyFileSync(enginePath,path.join(here,'comparison-engine.mjs'));
console.log(JSON.stringify({appId:snapshot.id,rows:raw.daily.length,productRows:products.length,engineSha256:crypto.createHash('sha256').update(fs.readFileSync(enginePath)).digest('hex'),sourceWrites:false,scheduleChanged:false}));
