'use strict';
// Annotate an authored snapshot; reviewed rows and original provenance remain intact.
const version='saved-operating-actions-v1';
const quantityIds=['operating-direction-summary','operating-priority-dates','operating-selected-date'];
const priceIds=['operating-selected-products','operating-coupon-scenario'];
function withDefinitions(source,definitions,flow){
  const next={...source};
  const labels=new Set(definitions.map(x=>x.label));
  next.metricDefinitions=[...(source.metricDefinitions||[]).filter(x=>!labels.has(x.label)),...definitions];
  next.evidenceFlow=[...(source.evidenceFlow||[]).filter(x=>x.title!==flow.title),flow];
  next.methods=[...(source.methods||[]).filter(x=>!String(x.code).includes(version)),{
    language:'javascript',
    code:`${version}: customer-portal/review/keyword-comparison/src/content/shared/operating-actions.mjs exports computeOperatingActions(snapshot, comparisonModel, options) and computeCouponScenario(inputs). Pure projection, no IO or execution. UI coupon inputs are explicit hypothetical assumptions; reviewed rows are unchanged.`
  }];
  return next;
}
function annotateActionProvenance(snapshot,buildStatus='complete'){
  if(!snapshot?.queries?.company_daily||!snapshot?.queries?.product_observations)throw Error('REVIEWED_QUERIES_REQUIRED');
  const quantityDefinitions=[
    {label:'운영 비교 예약률 · 월명 제외',componentIds:quantityIds,definition:'선택 표본에서 월명을 제외하고 같은 숙박일의 유효 업체만 사용한다. 공개예약+타채널 추정 합계를 같은 유효 공급 합계로 나눈다. 미확인 업체는 유효 분자·분모에서 제외하되 기대 업체 수에는 남긴다. 기존 상위 20개 KPI는 월명을 포함하므로 대상이 다르다.',formula:'sum(peer.sold)/sum(peer.supply)'},
    {label:'관측일 기준 남은 일수',componentIds:quantityIds,definition:'선택 회차의 observedAt을 Asia/Seoul 날짜로 바꾼 뒤 숙박일과의 날짜 차이를 계산한다. 과거 관측 당시의 남은 날짜이며 실제 예약접수 리드타임이 아니다.',formula:'stayDate - KST_date(observedAt)'},
    {label:'운영 검토 분류',componentIds:quantityIds,definition:'같은 날짜의 예약률 차이, 표본 확보, 검수 객실 기준, 판매 가능한 수량과 표시가격, 관측 순변화를 함께 검토한다. 기본 예약률 차이 10%p·남은 14일·표본 확보 80%는 후보 선별용 가정이며 검증된 할인 기준이나 효과 예측이 아니다. 기준·필터·보류 사유는 해당 행에 남긴다.'}
  ];
  const priceDefinitions=[
    {label:'쿠폰 검토 상품가격',componentIds:priceIds,definition:'선택 업체·관측 회차·숙박일에 저장된 개별 숙박상품의 양의 표시가격. 시나리오에서 상품을 선택해 사용하며 실제 결제액이나 적정가격으로 보지 않는다. 다른 업체 상품과 인원·혜택·박수·취소조건의 일치 여부는 미확인이다.'},
    {label:'쿠폰 손익 가정',componentIds:['operating-coupon-scenario'],definition:'할인율 기본 0%. 업체 전액 부담, 할인 후 금액에 같은 수수료율 적용, 1실 변동비 차감, 고정비·세금 제외. 기준 수량은 남은 재고 중 무할인으로 앞으로 팔릴 것이라 사용자가 가정한 수량이며 이미 예약된 객실이 아니다. 변동비·수수료·기준 수량·상품 객실한도가 비면 미확인으로 남긴다.',formula:'discountedPrice=round(price*(1-discountPercent/100)); baselineContributionPerRoom=price*(1-commissionPercent/100)-variableCost; couponContributionPerRoom=discountedPrice*(1-commissionPercent/100)-variableCost; breakEvenRooms=ceil(baselineRooms*baselineContributionPerRoom/couponContributionPerRoom), only when couponContributionPerRoom>0. User-entered product capacity limits feasibility; this is not a demand forecast.'}
  ];
  const queries={...snapshot.queries};
  queries.company_daily={...queries.company_daily,source:withDefinitions(queries.company_daily.source||{},quantityDefinitions,{title:'가격·쿠폰 운영 검토',detail:'선택 관측 회차·숙박기간·요일·표본을 그대로 적용하고 월명을 제외한 유효 표본과 날짜별로 비교한다. 원본 수량은 변경하지 않고 검토 후보·근거·남은 날짜·다음 행동을 계산한다. 과거 자료는 당시 검토안이며 가격·쿠폰 실행이나 정기수집으로 연결하지 않는다.'})};
  queries.product_observations={...queries.product_observations,source:withDefinitions(queries.product_observations.source||{},priceDefinitions,{title:'사용자 입력 쿠폰 시나리오',detail:'선택한 날짜·숙박상품의 저장 표시가격을 근거로 사용한다. 할인율·원가·수수료·무할인 판매 가정·상품별 객실 한도는 사용자 가정으로 분리하며, 필요한 판매수량을 비교한다. 실제 정산·가격 저장·쿠폰 발급은 하지 않는다.'})};
  return {...snapshot,buildStatus,queries};
}
if(require.main===module){
  const fs=require('node:fs'),path=require('node:path');
  const [input,output]=process.argv.slice(2);
  if(!input||!output||path.resolve(input)===path.resolve(output))throw Error('DISTINCT_INPUT_AND_NEW_OUTPUT_REQUIRED');
  const value=annotateActionProvenance(JSON.parse(fs.readFileSync(input,'utf8')));
  fs.writeFileSync(output,JSON.stringify(value),{flag:'wx'});
  console.log(JSON.stringify({output:path.resolve(output),version,rowsUnchanged:true}));
}
module.exports={annotateActionProvenance,version};
