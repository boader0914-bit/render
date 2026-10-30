// Read-only operating hypotheses over the reviewed saved snapshot. No IO or execution.
import { aggregateRows, datesBetween, median } from './comparison-engine.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => finite(value) && value > 0;
const unique = values => [...new Set(values)];
const pct = value => finite(value) ? `${(value * 100).toFixed(1)}%` : '미확인';
const won = value => finite(value) ? `${Math.round(value).toLocaleString('ko-KR')}원` : '미확인';
const dayMs = 86400000;
const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];
const isKnown = row => row && finite(aggregateRows([row], 1).rate);
const validAvailable = row => whole(row?.available) && whole(row?.dayUseExcluded)
  && row.available + row.sold + row.dayUseExcluded === row.supply;
const matchFilter = (date, filter) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return filter === 'all' || filter === 'weekday' && day >= 1 && day <= 4
    || filter === 'friday' && day === 5 || filter === 'saturday' && day === 6 || filter === 'sunday' && day === 0;
};
const kstDate = timestamp => {
  const parsed = Date.parse(timestamp);
  return finite(parsed) ? new Date(parsed + 9 * 3600000).toISOString().slice(0, 10) : null;
};
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function indexedRows(rows) {
  const index = new Map();
  for (const row of rows) {
    const key = `${row.runId}|${row.companyId}|${row.date}`;
    if (!index.has(key)) index.set(key, row);
    else if (index.get(key) === null || stable(index.get(key)) !== stable(row)) index.set(key, null);
  }
  return index;
}

function optionsRules(options) {
  const rule = (name, fallback, max, min = 0) => finite(options[name]) && options[name] >= min && options[name] <= max ? options[name] : fallback;
  return {
    label: '검토용 가정', gapPp: rule('gapPp', 10, 100), couponLeadDays: rule('couponLeadDays', 14, 366),
    minimumPeerCoverage: rule('minimumPeerCoverage', 0.8, 1, 0.01),
    minimumPeerCompanies: Math.max(1, Math.floor(rule('minimumPeerCompanies', 3, 100, 1))),
    definition: '예약률 차이와 남은 기간으로 검토 순서를 정하는 운영 가설입니다. 검증된 최적 할인·수요 예측 기준이 아닙니다.'
  };
}

function changeFor(row, previous) {
  const comparable = Boolean(isKnown(row) && isKnown(previous) && row.supply === previous.supply
    && typeof row.capacityRevision === 'string' && row.capacityRevision.length && row.capacityRevision === previous.capacityRevision
    && typeof row.productSignature === 'string' && row.productSignature.length && row.productSignature === previous.productSignature);
  return {comparable, publicNetChange: comparable ? row.publicBookings - previous.publicBookings : null,
    inferredNetChange: comparable ? row.inferredBookings - previous.inferredBookings : null,
    reason: comparable ? '같은 상품구성·객실 기준의 공통 숙박일 순변화' : '이전 수량·상품구성·객실 기준의 공통 근거 미확인'};
}

function dayAction(day, rules) {
  const reasons = [], reasonCodes = [], steps = [];
  let action = 'hold', actionLabel = '판단 보류';
  const add = (code, text) => { reasonCodes.push(code); reasons.push(text); };
  if (day.leadDays === null) add('observation_date_unknown', '관측 기준일을 확인하지 못했습니다.');
  if (day.leadDays !== null && day.leadDays < 0) add('stay_before_observation', '관측 당시 이미 지난 숙박일입니다. 가격·쿠폰 적용 대상으로 삼지 않습니다.');
  if (!finite(day.owner.rate)) add('owner_quantity_unknown', '내 매장 수량 응답이 미확인 또는 충돌 상태입니다. 정상 0실과 구별합니다.');
  if (!day.owner.capacityReviewed) add('owner_capacity_unreviewed', '내 매장의 객실 기준이 아직 검수되지 않았습니다.');
  if (day.owner.capacityReviewed && day.owner.capacityMatches === false) add('owner_capacity_mismatch', '숙박일의 공급수량이 검수된 객실 기준과 다릅니다. 기준을 확인하기 전에는 운영 판단을 보류합니다.');
  if (!finite(day.peers.rate) || day.peers.validCompanies < rules.minimumPeerCompanies || day.peers.coverage < rules.minimumPeerCoverage)
    add('peer_coverage_low', `월명 제외 표본은 ${day.peers.validCompanies}/${day.peers.expectedCompanies}곳 확보로 검토용 표본 조건을 충족하지 못했습니다.`);
  const held = reasonCodes.length > 0;
  if (!held) {
    const behind = day.gapPp <= -rules.gapPp;
    if (!validAvailable(day.rawOwner)) {
      action = 'sales_conditions_review'; actionLabel = '판매 조건 점검';
      add('available_unknown', '예약률은 계산 가능하지만 판매 가능한 남은 재고를 확인하지 못했습니다. 쿠폰 수량을 정하지 않습니다.');
    } else if (day.owner.available === 0) {
      action = 'maintain_price'; actionLabel = '가격 유지 검토';
      add('no_available_inventory', '남은 판매 가능 재고가 없어 신규 쿠폰 대상에서 제외합니다.');
    } else if (behind && day.change.comparable && day.change.publicNetChange > 0) {
      action = 'sales_conditions_review'; actionLabel = '판매 조건 점검';
      add('public_bookings_growing', `공개예약이 두 관측 사이 ${day.change.publicNetChange}실 순증했습니다. 이미 움직이는 구간이므로 추가 할인보다 현재 상품·가격 조건의 유지를 먼저 검토합니다.`);
      steps.push('해당 날짜·상품의 현재 조건을 우선 유지하고, 다음 관측에서도 같은 상품·객실 기준으로 공개예약 순변화를 비교합니다.',
        '예약률 차이가 남는다면 실제 남은 재고와 판매 조건을 점검합니다. 순증만으로 가격·쿠폰 효과를 확정하지 않습니다.');
    } else if (behind && positive(day.owner.price) && positive(day.peers.price) && day.owner.price < day.peers.price) {
      action = 'sales_conditions_review'; actionLabel = '판매 조건 점검';
      add('visible_price_already_lower', '숙박상품 표시가격 중앙값이 월명 제외 표본보다 낮습니다. 추가 할인보다 인원·혜택·상품 구성과 노출 조건을 먼저 점검합니다.');
      steps.push('조건이 같은 상품인지 먼저 대조하고, 포함 혜택·사진·예약 가능 조건을 점검합니다.',
        '표시가격 중앙값의 차이를 적정가격으로 해석하지 않고, 추가 할인 검토는 실제 판매 조건을 확인한 뒤 별도로 합니다.');
    } else if (behind && day.leadDays <= rules.couponLeadDays && positive(day.owner.price) && positive(day.peers.price)) {
      action = 'limited_coupon_review'; actionLabel = '한정 쿠폰 검토';
      add('nearby_rate_gap', `관측 당시 ${day.leadDays}일 남은 숙박일의 예약률이 월명 제외 표본보다 ${Math.abs(day.gapPp).toFixed(1)}%p 낮습니다.`);
      add('conditional_only', '한정 쿠폰을 검토할 후보입니다. 가격 차이가 할인 필요성이나 최적 할인율을 증명하지는 않습니다.');
      steps.push('인원·박수·포함 혜택·취소조건이 같은 상품끼리 대조하고, 실제 판매 가능한 남은 객실을 확인합니다.',
        '이 숙박일·상품만 적용할 쿠폰 수량과 유효기간을 정합니다. 전체 날짜의 기본가격은 일괄 인하하지 않습니다.',
        '최소 받을 금액, 추가 판매 1실당 변동비, 수수료, 기존 쿠폰과의 중복 여부를 확인한 뒤 손익 시나리오를 비교합니다.');
    } else if (behind) {
      action = 'sales_conditions_review'; actionLabel = '판매 조건 점검';
      add(day.leadDays > rules.couponLeadDays ? 'outside_coupon_horizon' : 'price_unknown',
        day.leadDays > rules.couponLeadDays ? `관측 당시 ${day.leadDays}일 남은 구간으로 즉시 할인보다 상품 구성과 노출 조건을 먼저 점검합니다.` : '비교 가능한 양의 숙박상품 표시가격을 확인하지 못해 할인 조건을 정하지 않습니다.');
      steps.push('해당 숙박일의 판매중지·최소 숙박일·예약 가능 조건과 상품 구성을 확인합니다.',
        '혜택과 가격을 함께 대조하고, 기본가격을 바로 내리기보다 적용할 상품·날짜를 좁힙니다.');
    } else {
      action = 'maintain_price'; actionLabel = '가격 유지 검토';
      add('no_large_negative_gap', '검토용 가정에서 큰 예약률 열위가 확인되지 않아 일괄 할인은 우선 보류합니다. 가격 인상 근거를 뜻하지 않습니다.');
      steps.push('현재 가격과 상품 조건을 우선 유지하고, 남은 재고와 다음 관측의 같은 숙박일 변화를 비교합니다.',
        '재방문 쿠폰은 과거 구매·동의 고객과 실제 원가 조건이 있을 때 별도 대상을 정합니다. 현재 자료만으로 발송 대상을 정하지 않습니다.');
    }
    if (day.owner.inferredBookings > day.owner.publicBookings) {
      add('inferred_majority', '타채널 추정예약 비중이 높습니다. 실수요 강세나 가격 인상 근거로 해석하지 않습니다.');
      steps.push('공개예약과 타채널 추정을 나눠 보고, 내 매장의 실제 남은 판매 가능 재고를 기준으로 수량을 정합니다.');
    }
    if (day.change.comparable && day.change.publicNetChange < 0) add('negative_observed_change', '공개예약 순변화가 음수입니다. 취소·재예약·재고 변경이 섞일 수 있어 취소 건수로 확정하지 않습니다.');
  }
  if (held) steps.push('미확인 수량과 객실 기준의 저장 근거를 먼저 확인합니다. 확보되지 않은 날짜는 0실로 채우지 않습니다.');
  if (day.peers.unreviewedCompanies) add('peer_capacity_unreviewed', `월명 제외 유효 표본 중 ${day.peers.unreviewedCompanies}곳의 객실 기준은 최대관측 추정으로 참고용입니다.`);
  return {action, actionLabel, status: action === 'hold' ? 'hold' : 'conditional', reasons, reasonCodes, steps};
}

function aggregateDays(days, peerExpected) {
  const valid = days.filter(day => finite(day.owner.rate) && finite(day.peers.rate));
  const ownerSupply = valid.reduce((sum, day) => sum + day.owner.supply, 0);
  const peerSupply = valid.reduce((sum, day) => sum + day.peers.supply, 0);
  const ownerSold = valid.reduce((sum, day) => sum + day.owner.sold, 0);
  const peerSold = valid.reduce((sum, day) => sum + day.peers.sold, 0);
  return {matchedDays: valid.length, expectedDays: days.length, ownerRate: ownerSupply ? ownerSold / ownerSupply : null,
    peerRate: peerSupply ? peerSold / peerSupply : null, ownerSupply: ownerSupply || null, peerSupply: peerSupply || null,
    peerExpectedCompanies: peerExpected, peerLabel: '월명 제외 표본',
    couponReviewDays: days.filter(day => day.action === 'limited_coupon_review').length,
    maintainPriceDays: days.filter(day => day.action === 'maintain_price').length,
    conditionReviewDays: days.filter(day => day.action === 'sales_conditions_review').length,
    holdDays: days.filter(day => day.action === 'hold').length};
}

/** Selects hypotheses using the model's exact run, period, weekday and cohort. Does not mutate evidence. */
export function computeOperatingActions(snapshot, model, options = {}) {
  const rules = optionsRules(options);
  if (!model?.selection || !snapshot) return {version:'saved-operating-actions-v1',selection:null,rules,summary:aggregateDays([], 0),days:[],weekdayGroups:[],cards:[],limits:[]};
  const selection = {...model.selection, asOfDate: kstDate(model.selection.observedAt)};
  const ownerCompany = snapshot.companies.find(company => String(company.placeId) === String(snapshot.meta.ownerPlaceId));
  if (!ownerCompany || (model.owner?.id || model.owner?.companyId) !== ownerCompany.id) throw Error('ACTION_OWNER_MISMATCH');
  const run = snapshot.runs.find(item => item.id === selection.runId);
  const memberRun = selection.cohort === 'run' ? run : snapshot.runs.at(-1);
  const peerIds = unique(memberRun?.members || []).filter(id => id !== ownerCompany.id);
  const companyMap = new Map(snapshot.companies.map(company => [company.id, company]));
  const rows = indexedRows(snapshot.daily || []);
  const get = (runId, companyId, date) => rows.get(`${runId}|${companyId}|${date}`);
  const previousIsEarlier = selection.previousRunId && Date.parse(selection.previousObservedAt) < Date.parse(selection.observedAt);
  const days = datesBetween(selection.start, selection.end).filter(date => matchFilter(date, selection.dayFilter || 'all')).map(date => {
    const row = get(selection.runId, ownerCompany.id, date);
    const previous = previousIsEarlier ? get(selection.previousRunId, ownerCompany.id, date) : undefined;
    const peerRows = peerIds.map(id => get(selection.runId, id, date)).filter(item => isKnown(item)
      && !(companyMap.get(item.companyId)?.capacity?.reviewed === true && companyMap.get(item.companyId)?.capacity?.rooms !== item.supply));
    const own = aggregateRows(row ? [row] : [], 1), peers = aggregateRows(peerRows, peerIds.length);
    const products = (row?.productPrices || []).filter(product => positive(product.price)).map(product => ({...product}));
    const day = {date, weekday: weekdayNames[new Date(`${date}T00:00:00Z`).getUTCDay()],
      leadDays: selection.asOfDate ? (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${selection.asOfDate}T00:00:00Z`)) / dayMs : null,
      owner:{rate:own.rate,publicBookings:own.publicBookings,inferredBookings:own.inferredBookings,sold:own.sold,supply:own.supply,
        available:isKnown(row) && validAvailable(row) ? row.available : null,price:own.medianProductPrice,products,
        capacityReviewed:ownerCompany.capacity?.reviewed === true,capacityRooms:ownerCompany.capacity?.rooms ?? null,
        capacityMatches:row && whole(ownerCompany.capacity?.rooms) ? row.supply === ownerCompany.capacity.rooms : null,
        dayUseExcluded:isKnown(row) && whole(row?.dayUseExcluded) ? row.dayUseExcluded : null},
      peers:{rate:peers.rate,price:peers.medianProductPrice,supply:peers.supply,sold:peers.sold,companyCount:peerIds.length,
        validCompanies:peerRows.length,expectedCompanies:peerIds.length,coverage:peerIds.length ? peerRows.length / peerIds.length : 0,
        unreviewedCompanies:peerRows.filter(item => companyMap.get(item.companyId)?.capacity?.reviewed !== true).length},
      gapPp:finite(own.rate) && finite(peers.rate) ? (own.rate - peers.rate) * 100 : null,
      priceGapPercent:positive(own.medianProductPrice) && positive(peers.medianProductPrice) ? (own.medianProductPrice / peers.medianProductPrice - 1) * 100 : null,
      change:changeFor(row, previous), sourceRefs:unique([...(row?.sourceRefs || []),...peerRows.flatMap(item => item.sourceRefs || []),...(previous?.sourceRefs || [])]), rawOwner:row};
    Object.assign(day, dayAction(day, rules));
    day.evidence = [`숙박일 ${date} · 관측 기준 ${selection.asOfDate || '미확인'} · 남은 기간 ${day.leadDays ?? '미확인'}일`,
      `월명 ${pct(own.rate)} · 공개 ${own.publicBookings ?? '미확인'}실 + 타채널 추정 ${own.inferredBookings ?? '미확인'}실 · 남은 재고 ${day.owner.available ?? '미확인'}실`,
      `월명 제외 표본 ${pct(peers.rate)} · ${peerRows.length}/${peerIds.length}곳 · 공급 ${peers.supply ?? '미확인'}실`,
      `숙박상품 표시가격 중앙값 월명 ${won(own.medianProductPrice)} · 월명 제외 표본 ${won(peers.medianProductPrice)}`];
    delete day.rawOwner;
    return day;
  });
  const summary = aggregateDays(days, peerIds.length);
  const weekdayGroups = weekdayNames.map(weekday => ({weekday, ...aggregateDays(days.filter(day => day.weekday === weekday), peerIds.length)}));
  const priority = {limited_coupon_review:0,sales_conditions_review:1,maintain_price:2,hold:3};
  const ordered = [...days].sort((a,b) => priority[a.action] - priority[b.action] || (a.leadDays ?? Infinity) - (b.leadDays ?? Infinity) || a.date.localeCompare(b.date));
  const couponDays = ordered.filter(day => day.action === 'limited_coupon_review');
  const first = ordered.find(day => day.action !== 'hold');
  const limits = [
    '저장된 과거 관측일 당시의 검토입니다. 오늘의 가격·재고에 대한 실행 지시가 아닙니다.',
    '상단 상위 20개 표본 지표는 월명을 포함하며, 행동 검토용 비교에서는 월명을 제외합니다.',
    '경남 키워드의 시설·규모가 다른 표본을 포함하므로 동급 직접 경쟁업체나 적정가격으로 단정하지 않습니다.',
    '남은 기간은 숙박일과 관측 기준일의 날짜 차이이며 실제 예약 리드타임이 아닙니다.',
    '공휴일 달력·예약접수 시각·쿠폰 사용·실결제 자료가 없어 연휴 여부, 최적 할인율, 쿠폰 효과와 매출 증가를 예측하지 않습니다.'
  ];
  const cards = [
    {id:'operating-targets',title:'먼저 볼 숙박일',status:first?'conditional':'hold',
      finding:first ? `${first.date} (${first.weekday}) · ${first.actionLabel} · 월명 ${pct(first.owner.rate)} / 월명 제외 표본 ${pct(first.peers.rate)}` : '같은 숙박일의 유효 수량 근거가 부족해 운영 판단을 보류합니다.',
      action:first ? first.steps[0] : '미확인 날짜의 원본 수량과 객실 기준을 먼저 확인하세요.',targetDates:first?[first.date]:[],
      evidence:first?first.evidence:[],limits:[rules.definition,limits[0],limits[2]]},
    {id:'operating-coupon',title:'가격·쿠폰 운영 범위',status:couponDays.length?'conditional':first?'conditional':'hold',
      finding:couponDays.length ? `한정 쿠폰 검토 ${couponDays.length}일 · ${couponDays.slice(0,3).map(day=>day.date).join(', ')}` : '지금의 검토용 가정에 맞는 한정 쿠폰 대상이 없습니다.',
      action:couponDays.length ? '선택한 숙박일·상품의 남은 재고에 한해 수량·유효기간을 제한하고, 상품 조건과 최소 받을 금액을 확인한 뒤 가정별 손익을 비교하세요.' : '가격을 일괄 조정하지 말고 판매 조건과 다음 관측의 같은 숙박일 변화를 먼저 확인하세요.',
      targetDates:couponDays.map(day=>day.date),evidence:[`검토용 가정: 예약률 차이 ${rules.gapPp}%p 이상 · 관측 당시 ${rules.couponLeadDays}일 이내`,
        `판매 조건 점검 ${summary.conditionReviewDays}일 · 가격 유지 검토 ${summary.maintainPriceDays}일 · 판단 보류 ${summary.holdDays}일`],
      limits:['기본 할인율은 0%입니다. 입력한 할인율은 가정이며 권장·최적 할인율이 아닙니다.','재방문 쿠폰의 발송 대상은 과거 구매·동의 자료가 있어야 정할 수 있습니다. 현재 자료에는 발송 기능이 없습니다.']},
    {id:'operating-next-observation',title:'실행 후 다음 확인',status:first?'conditional':'hold',
      finding:`같은 상품·숙박일·객실 기준으로 다시 비교 · 현재 공통 근거 ${days.filter(day=>day.change.comparable).length}일`,
      action:'다음 저장 관측에서 공개예약 순변화와 타채널 추정을 분리하고, 실제 쿠폰 사용·수령액·변동비 기록이 있을 때 비용과 판매 변화를 나란히 검토하세요.',
      targetDates:couponDays.map(day=>day.date),evidence:[`현재 ${selection.runId}`,`이전 ${selection.previousRunId || '없음'}`],
      limits:['다음 수집을 예약하거나 시작하지 않습니다.','두 관측의 순변화는 신규예약 건수나 쿠폰의 인과 효과가 아닙니다.']}
  ];
  return {version:'saved-operating-actions-v1',selection,rules,summary,days,weekdayGroups,cards,
    scenarioDefaults:{discountPercent:0,variableCost:null,commissionPercent:null,baselineRooms:null,capacity:null},limits};
}

/** Arithmetic-only scenario. Inputs describe future sales from remaining inventory, not existing bookings. */
export function computeCouponScenario(input = {}) {
  const price = input.price, discountPercent = input.discountPercent === undefined ? 0 : input.discountPercent;
  const {variableCost,commissionPercent,baselineRooms,capacity} = input;
  const result = {status:'incomplete',price:positive(price)?price:null,discountPercent,discountedPrice:null,discountPerRoom:null,
    baselineContributionPerRoom:null,couponContributionPerRoom:null,baselineContribution:null,breakEvenRooms:null,extraRooms:null,capacityFeasible:null,
    reasons:[],assumptions:[
      '한 숙박일·한 상품의 남은 재고 중 앞으로 판매할 수량을 가정합니다. 기존 예약에는 할인을 소급하지 않습니다.',
      '쿠폰 비용은 업체가 전액 부담하고 수수료는 할인 후 판매금액에 적용합니다.',
      '원가는 추가 판매 1실당 변동비이며 고정비·세금·추가 매출·쿠폰 중복은 별도로 포함하지 않습니다.',
      '필요 판매수는 무할인 가정의 공헌이익을 유지하기 위한 수량이며 판매 가능성이나 매출 증가 예측이 아닙니다.'
    ]};
  if (!positive(price) || !finite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    result.status='invalid';result.reasons.push('양의 판매가격과 0~100% 할인율을 입력하세요.');return result;
  }
  result.discountedPrice=Math.round(price*(1-discountPercent/100));
  result.discountPerRoom=price-result.discountedPrice;
  if (![result.discountedPrice,result.discountPerRoom].every(Number.isSafeInteger)) {
    result.status='invalid';result.discountedPrice=null;result.discountPerRoom=null;result.reasons.push('원 단위로 안전하게 계산 가능한 판매가격을 입력하세요.');return result;
  }
  if (variableCost === null || variableCost === undefined || variableCost === '' || commissionPercent === null || commissionPercent === undefined || commissionPercent === ''
    || baselineRooms === null || baselineRooms === undefined || baselineRooms === '' || capacity === null || capacity === undefined || capacity === '') {
    result.reasons.push('변동비·수수료·무할인 판매 가정 수량·남은 판매한도를 직접 입력해야 손익을 계산합니다.');return result;
  }
  if (!finite(variableCost) || variableCost < 0 || !finite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100
    || !whole(baselineRooms) || !whole(capacity) || baselineRooms > capacity) {
    result.status='invalid';result.reasons.push('원가와 수수료 범위, 정수 수량을 확인하세요. 무할인 판매 가정은 남은 판매한도를 넘을 수 없습니다.');return result;
  }
  result.baselineContributionPerRoom=price*(1-commissionPercent/100)-variableCost;
  result.couponContributionPerRoom=result.discountedPrice*(1-commissionPercent/100)-variableCost;
  result.baselineContribution=result.baselineContributionPerRoom*baselineRooms;
  if (![result.baselineContributionPerRoom,result.couponContributionPerRoom,result.baselineContribution].every(value=>finite(value)&&Math.abs(value)<=Number.MAX_SAFE_INTEGER)) {
    result.status='invalid';result.baselineContributionPerRoom=null;result.couponContributionPerRoom=null;result.baselineContribution=null;
    result.reasons.push('안전한 금액 범위를 넘었습니다. 금액과 수량을 확인하세요.');return result;
  }
  if (result.baselineContributionPerRoom <= 0 || result.couponContributionPerRoom <= 0) {
    result.status='unprofitable';result.reasons.push('1실당 공헌이익이 0원 이하인 가정입니다. 판매 수량 증가로 보전할 수량을 제시하지 않습니다.');return result;
  }
  const exact=result.baselineContribution/result.couponContributionPerRoom;
  if (!finite(exact) || exact > Number.MAX_SAFE_INTEGER) {
    result.status='invalid';result.reasons.push('필요 판매수의 안전한 계산 범위를 넘었습니다. 금액과 수량을 확인하세요.');return result;
  }
  result.breakEvenRooms=Math.max(0,Math.ceil(exact-Number.EPSILON*Math.max(1,Math.abs(exact))*4));
  result.extraRooms=result.breakEvenRooms-baselineRooms;
  result.capacityFeasible=result.breakEvenRooms<=capacity;
  result.status=result.capacityFeasible?'calculated':'capacity_exceeded';
  result.reasons.push(result.capacityFeasible?'입력한 남은 판매한도 안의 산술 조건입니다. 실제 판매 가능성은 예측하지 않습니다.':'기준 공헌이익 유지에 필요한 판매수가 입력한 남은 판매한도를 넘습니다.');
  return result;
}
