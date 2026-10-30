import React, { useMemo, useState } from 'react';
import { DataComponent, DataTable, SectionHeader } from '../../data-app-public.jsx';
import { computeOperatingActions, computeCouponScenario } from '../shared/operating-actions.mjs';
import { actionRows, selectedActionDay, scenarioNumber, scenarioProduct } from './action-ui-state.mjs';
import './operating-actions.css';

const finite = Number.isFinite;
const number = value => finite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : '미확인';
const percent = value => finite(value) ? `${(value * 100).toFixed(1)}%` : '미확인';
const won = value => finite(value) ? `${Math.round(value).toLocaleString('ko-KR')}원` : '미확인';
const rooms = value => finite(value) ? `${number(value)}실` : '미확인';
const signed = value => finite(value) ? `${value > 0 ? '+' : ''}${number(value)}` : '미확인';
const strings = values => (Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? value : value?.message || value?.label || value?.description || value?.reason).filter(Boolean);
const shortDate = value => value ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : '미확인';
function observedDay(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(date) : '';
}
function List({ values, ordered = false }) {
  const entries = strings(values);
  if (!entries.length) return null;
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag>{entries.map((entry, index) => <li key={index}>{entry}</li>)}</Tag>;
}

function CouponScenario({ day, productRows, selection }) {
  const products = (day.owner?.products || []).filter(product => finite(product.price) && product.price > 0);
  const [productId, setProductId] = useState('');
  const [discount, setDiscount] = useState('0');
  const [variableCost, setVariableCost] = useState('');
  const [commission, setCommission] = useState('');
  const [baseline, setBaseline] = useState('');
  const [capacity, setCapacity] = useState('');
  const product = scenarioProduct(products, productId);
  const assumptions = { price: product?.price ?? null, discountPercent: scenarioNumber(discount), variableCost: scenarioNumber(variableCost), commissionPercent: scenarioNumber(commission), baselineRooms: scenarioNumber(baseline), capacity: scenarioNumber(capacity) };
  const result = computeCouponScenario(assumptions);
  const reset = () => { setProductId(''); setDiscount('0'); setVariableCost(''); setCommission(''); setBaseline(''); setCapacity(''); };
  const chooseProduct = value => { setProductId(value); setDiscount('0'); setVariableCost(''); setCommission(''); setBaseline(''); setCapacity(''); };
  const sourceRows = productRows.filter(row => String(row.id) === String(product?.id));
  const modeledRow = { date: day.date, runId: selection.runId, previousRunId: selection.previousRunId, observationDate: observedDay(selection.observedAt), productId: product?.id ?? null, productName: product?.name ?? null, classification: 'user_assumption_scenario_not_recommendation', assumptions, result };
  const notice = result.status === 'invalid' ? '입력 조건을 확인하세요. 올바른 조건을 입력할 때까지 손익 판단을 보류합니다.' : result.status === 'unprofitable' ? '입력한 조건에서는 판매 1실의 비용 제외 금액을 지킬 수 없습니다. 쿠폰 적용을 보류하고 할인율과 비용을 다시 확인하세요.' : result.capacityFeasible === false ? '입력한 남은 판매한도로는 기존 비용 제외 금액을 유지할 수 없습니다. 할인 조건을 다시 검토하세요.' : result.capacityFeasible === true ? '입력한 수량 한도 안에서 계산상 가능하며, 실제 판매와 효과를 보장하지 않습니다.' : '판매한도와 비용을 확인하기 전에는 손익 판단을 보류합니다.';
  return <details className="koa-scenario">
    <summary>쿠폰 손익 가정해 보기 <b>+</b></summary>
    <DataComponent id="operating-coupon-scenario" queryId="product_observations" title={`${shortDate(day.date)} 쿠폰 손익 시나리오`} kind="table" displayRows={[modeledRow]} sourceRows={sourceRows}>
      {!product ? <p className="koa-muted">이 날짜에 저장된 양의 상품 가격이 없어 쿠폰 금액 계산을 보류합니다.</p> : <>
        <p className="koa-muted">할인율은 추천값이 아닌 입력 가정입니다. {day.date}의 저장 상품 가격 {won(product.price)}을 사용합니다.</p>
        <form className="koa-scenario-form" onSubmit={event => event.preventDefault()}>
          <label className="koa-field koa-product-field"><span>계산할 숙박상품</span><select aria-label="계산할 숙박상품" value={String(product.id)} onChange={event => chooseProduct(event.target.value)}>{products.map(item => <option key={item.id} value={String(item.id)}>{item.name} · {won(item.price)}</option>)}</select></label>
          <label className="koa-field"><span>할인율 가정 (%)</span><input aria-label="할인율 가정" type="number" min="0" max="100" step="1" value={discount} onChange={event => setDiscount(event.target.value)}/></label>
          <label className="koa-field"><span>1실 판매 시 변동비 (원)</span><input aria-label="1실 판매 시 변동비" type="number" min="0" step="1000" placeholder="직접 입력" value={variableCost} onChange={event => setVariableCost(event.target.value)}/></label>
          <label className="koa-field"><span>할인 후 매출 수수료 (%)</span><input aria-label="할인 후 매출 수수료" type="number" min="0" max="100" step="0.1" placeholder="직접 입력" value={commission} onChange={event => setCommission(event.target.value)}/></label>
          <label className="koa-field"><span>쿠폰 없이 앞으로 팔릴 수량 가정 (실)</span><input aria-label="쿠폰 없이 앞으로 팔릴 수량 가정" type="number" min="0" step="1" placeholder="선택 상품의 남은 재고 기준" value={baseline} onChange={event => setBaseline(event.target.value)}/></label>
          <label className="koa-field"><span>해당 상품의 남은 판매한도 (실)</span><input aria-label="해당 상품의 남은 판매한도" type="number" min="0" step="1" placeholder="직접 확인 후 입력" value={capacity} onChange={event => setCapacity(event.target.value)}/></label>
          <button className="koa-reset" type="button" onClick={reset}>가정 초기화</button>
        </form>
        <p className="koa-muted">기준 수량은 이미 예약된 수량이 아닙니다. 쿠폰 비용은 업체 전액 부담, 수수료는 할인 후 가격에 적용하며 고정비는 제외합니다.</p>
        <div className="koa-scenario-results" aria-live="polite" data-reviewed-rows>
          <div><span>할인 후 판매가격</span><strong>{won(result.discountedPrice)}</strong></div>
          <div><span>1실당 쿠폰 부담</span><strong>{won(result.discountPerRoom)}</strong></div>
          <div><span>1실당 원가·수수료 제외 금액</span><strong>{won(result.baselineContributionPerRoom)} → {won(result.couponContributionPerRoom)}</strong></div>
          <div><span>같은 금액을 남기는 데 필요한 판매수량</span><strong>{rooms(result.breakEvenRooms)}</strong><small>{finite(result.extraRooms) ? `기준보다 ${signed(result.extraRooms)}실` : '원가·수수료·기준 수량 입력 후 계산'}</small></div>
        </div>
        <p className={result.capacityFeasible === false || result.status === 'invalid' || result.status === 'unprofitable' ? 'koa-notice koa-attention' : 'koa-notice'} role="status">{notice}</p>
        <List values={result.reasons}/>
      </>}
    </DataComponent>
  </details>;
}

export function OperatingActions({ snapshot, model, sourceRows, productRows }) {
  const [gapPp, setGapPp] = useState(10);
  const [leadDays, setLeadDays] = useState(14);
  const [filter, setFilter] = useState('all');
  const [selectedDate, setSelectedDate] = useState(null);
  const plan = useMemo(() => computeOperatingActions(snapshot, model, { gapPp, couponLeadDays: leadDays }), [snapshot, model, gapPp, leadDays]);
  const rows = actionRows(plan.days, filter);
  const selected = selectedActionDay(rows, selectedDate);
  const selection = plan.selection || model.selection;
  const observation = observedDay(selection.observedAt);
  const selectedSources = selected ? sourceRows.filter(row => row.date === selected.date) : [];
  const selectedProducts = selected ? productRows.filter(row => row.runId === selection.runId && row.companyId === (model.owner.companyId || model.owner.id) && row.date === selected.date) : [];
  const viewRows = rows.map(day => ({ date: day.date, weekday: day.weekday, leadDays: day.leadDays, action: day.action, actionLabel: day.actionLabel, ownerRate: day.owner?.rate, peerRate: day.peers?.rate, gapPp: day.gapPp, ownerPrice: day.owner?.price, available: day.owner?.available, change: day.change?.publicNetChange, peers: day.peers?.validCompanies, expectedPeers: day.peers?.expectedCompanies, runId:selection.runId, previousRunId:selection.previousRunId, ruleGapPp:gapPp, ruleLeadDays:leadDays, ruleClassification:'검토용 가정' }));
  const displayedDates = new Set(rows.map(day => day.date));
  const displayedSources = sourceRows.filter(row => displayedDates.has(row.date));
  return <section className="koa-section" aria-label="가격·쿠폰 운영 제안">
    <SectionHeader id="operating-actions-heading" title={`${shortDate(observation)} 관측 당시 운영 검토`}/>
    <div className="koa-intro"><p>같은 숙박일의 <strong>월명 제외 표본</strong>과 비교해 먼저 볼 날짜를 정리했습니다. 과거 자료의 검토안이며 현재 가격이나 쿠폰에 자동 적용하지 않습니다.</p><span className="koa-tag">검토용 가정 · 실행 전 확인</span></div>
    <DataComponent id="operating-direction-summary" queryId="company_daily" title="선택 기간의 운영 검토 방향" kind="narrative" displayRows={[{...plan.summary,runId:selection.runId,previousRunId:selection.previousRunId,rules:plan.rules}]} sourceRows={sourceRows}>
      <div className="koa-summary" data-reviewed-rows>
        <span><b>{number(plan.summary?.couponReviewDays)}</b>일 한정 쿠폰 검토</span><span><b>{number(plan.summary?.conditionReviewDays)}</b>일 판매 조건 점검</span><span><b>{number(plan.summary?.maintainPriceDays)}</b>일 가격 유지 검토</span><span><b>{number(plan.summary?.holdDays)}</b>일 판단 보류</span>
      </div>
      <p className="koa-priority-note" data-reviewed-rows>{plan.cards?.[0]?.finding || '자료를 확인한 뒤 검토할 날짜를 정합니다.'}</p>
    </DataComponent>
    <DataComponent id="operating-priority-dates" queryId="company_daily" title="먼저 검토할 숙박일" kind="table" displayRows={viewRows} sourceRows={displayedSources}>
      <details className="koa-rules"><summary>날짜 선별 기준 <b>+</b></summary><div className="koa-rules-body">
        <label className="koa-field"><span>예약률이 표본보다 낮은 차이</span><select aria-label="쿠폰 검토 예약률 차이 가정" value={gapPp} onChange={event => setGapPp(Number(event.target.value))}>{[5,10,15].map(value => <option key={value} value={value}>{value}%p 이상</option>)}</select></label>
        <label className="koa-field"><span>관측일부터 숙박일까지</span><select aria-label="쿠폰 검토 남은 기간 가정" value={leadDays} onChange={event => setLeadDays(Number(event.target.value))}>{[7,14,21].map(value => <option key={value} value={value}>{value}일 이내</option>)}</select></label>
        <p>위 수치는 검토용 가정이며 검증된 최적 할인 기준이 아닙니다. 표본은 같은 날짜의 유효 업체 {number(plan.rules.minimumPeerCompanies)}곳 이상·확보율 {number(plan.rules.minimumPeerCoverage * 100)}% 이상에서 비교하며 객실 검수 전 업체도 포함됩니다. 남은 일수는 실제 예약 리드타임이 아닙니다.</p>
      </div></details>
      <label className="koa-filter"><span>표시할 검토 방향</span><select aria-label="표시할 운영 검토 방향" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">전체 숙박일</option><option value="limited_coupon_review">한정쿠폰 검토</option><option value="sales_conditions_review">판매조건 점검</option><option value="maintain_price">가격 유지 검토</option><option value="hold">판단 보류</option></select></label>
      {rows.length ? <DataTable rows={viewRows} columns={[
        {field:'date',label:'숙박일',renderCell:(value,row)=>`${shortDate(value)} (${row.weekday})`},
        {field:'leadDays',label:'관측일 기준',renderCell:value=>finite(value)?value<0?'이미 지난 숙박일':`${value}일 남음`:'미확인'},
        {field:'actionLabel',label:'검토 방향',renderCell:(value,row)=><span className={`koa-direction koa-${row.action}`}>{value}</span>},
        {field:'ownerRate',label:'월명 예약률',renderCell:percent},
        {field:'peerRate',label:'월명 제외 표본',renderCell:percent},
        {field:'gapPp',label:'차이',renderCell:value=>finite(value)?`${signed(value)}%p`:'미확인'},
        {field:'change',label:'공개예약 순변화',renderCell:value=>finite(value)?`${signed(value)}실`:'미확인'}
      ]} rowKey="date" searchable={false} selectedRowKey={selected?.date} onRowSelect={row=>setSelectedDate(row.date)} rowActionLabel={row=>`${row.date} 운영 검토 근거 보기`} label="숙박일별 운영 검토 우선순위"/> : <p className="koa-empty" role="status">선택한 방향에 해당하는 날짜가 없습니다. 다른 방향을 선택하면 저장 근거를 확인할 수 있습니다.</p>}
    </DataComponent>
    {selected && <div className="koa-detail-grid">
      <DataComponent id="operating-selected-date" queryId="company_daily" title={`${shortDate(selected.date)} (${selected.weekday}) · ${selected.actionLabel}`} kind="narrative" displayRows={[selected]} sourceRows={selectedSources}>
        <div className="koa-detail" data-reviewed-rows><div className="koa-detail-numbers"><span>월명 <strong>{percent(selected.owner?.rate)}</strong></span><span>월명 제외 표본 <strong>{percent(selected.peers?.rate)}</strong></span><span>차이 <strong>{finite(selected.gapPp)?`${signed(selected.gapPp)}%p`:'미확인'}</strong></span></div>
          <p className="koa-composition">공개예약 {rooms(selected.owner?.publicBookings)} + 타채널 추정 {rooms(selected.owner?.inferredBookings)} / 공급 {rooms(selected.owner?.supply)} · 공개 잔여 {rooms(selected.owner?.available)}</p>
          <List values={selected.reasons}/>
          <h3>다음 행동</h3><List values={selected.steps} ordered/>
          <details className="koa-evidence"><summary>수량·가격 판단 근거 <b>+</b></summary><List values={selected.evidence}/><p>월명 표시가격 중앙값 {won(selected.owner?.price)} · 표본 {won(selected.peers?.price)}. 상품 조건이 일치하는 적정가격 비교는 아닙니다.</p><p>유효 표본 {number(selected.peers?.validCompanies)}/{number(selected.peers?.expectedCompanies)}곳 · 객실 기준 검수 전 {number(selected.peers?.unreviewedCompanies)}곳. 타채널 추정은 실제 수요 확정값과 구별합니다.</p></details>
        </div>
      </DataComponent>
      <DataComponent id="operating-selected-products" queryId="product_observations" title={`${shortDate(selected.date)} 월명 숙박상품 가격`} kind="table" displayRows={selected.owner?.products || []} sourceRows={selectedProducts}>
        {(selected.owner?.products || []).length ? <DataTable rows={selected.owner.products} columns={[{field:'name',label:'상품명'},{field:'price',label:'표시가격',renderCell:won}]} rowKey="id" searchable={false} label="선택 숙박일의 월명 상품별 표시가격"/> : <p className="koa-muted">해당 날짜의 상품별 판매가격을 확인하지 못했습니다.</p>}
        <div className="koa-checklist"><h3>실행 전 정할 조건</h3><ul><li>선택한 숙박일·상품에만 적용하고 사용 가능한 수량과 최소 판매가격을 먼저 정합니다.</li><li>기존 할인과 중복되지 않게 하고, 예약 마감 전 종료 시각을 정합니다.</li><li>실제 예약이 목표 수량에 도달하거나 판매한도·비용 제외 금액을 지키지 못하면 중단합니다.</li><li>적용 전후의 같은 숙박일 공개예약 순변화, 실제 쿠폰 사용 수량·비용과 취소를 함께 확인합니다.</li></ul><p>저장된 과거 날짜에 대한 검토 조건이며 실제 발급·소급 적용은 하지 않습니다. 공휴일 자료가 없어 월~목을 비연휴 평일로 확정하지 않습니다.</p></div>
      </DataComponent>
    </div>}
    {selected && <CouponScenario key={`${selection.runId}:${selection.previousRunId}:${selection.cohort}:${selection.start}:${selection.end}:${selection.dayFilter}:${selected.date}`} day={selected} productRows={selectedProducts} selection={selection}/>}
    <details className="koa-limits"><summary>운영 제안의 범위 <b>+</b></summary><List values={plan.limits}/><p>가격 유지 검토는 인상 권고가 아니며, 한정쿠폰 검토도 가격 인하가 필요하다는 확정 판단이 아닙니다.</p></details>
  </section>;
}
