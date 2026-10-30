import React, { useMemo, useState } from "react";
import { DataComponent, DataTable, EvidenceChart, SectionHeader, SortableItem, SortableRegion, useDataApp } from "../../data-app-public.jsx";
import { computeComparison } from "../shared/comparison-engine.mjs";

const number=value=>Number.isFinite(value)?value.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
const percent=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'미확인';
const money=value=>Number.isFinite(value)?`${Math.round(value).toLocaleString('ko-KR')}원`:'미확인';
const rooms=value=>Number.isFinite(value)?`${number(value)}실`:'미확인';
const quantityLabel=value=>({valid:'정상',legacy_unverified:'구형 응답 미확인',conflict:'수량 충돌',missing:'미수집',unavailable:'미확인'})[value]||'미확인';
const signed=value=>Number.isFinite(value)?`${value>0?'+':''}${number(value)}`:'비교 보류';
const shortDate=value=>value?`${Number(value.slice(5,7))}/${Number(value.slice(8,10))}`:'미확인';
const dayNames={all:'전체 요일',weekday:'월~목',friday:'금요일',saturday:'토요일',sunday:'일요일'};
const presets={common:['2026-09-22','2026-10-20'],september:['2026-09-01','2026-09-30'],october:['2026-10-01','2026-10-31'],all:['2026-09-20','2026-10-22']};
const statusLabel=value=>({ready:'비교 가능',reference:'참고',reference_only:'참고',hold:'판단 보류',held:'판단 보류',review:'검토',partial:'일부 자료',unavailable:'미확인'})[value]||'검토';
const matchesDay=(date,filter)=>{const day=new Date(date+'T00:00:00Z').getUTCDay();return filter==='all'||filter==='weekday'&&day>=1&&day<=4||filter==='friday'&&day===5||filter==='saturday'&&day===6||filter==='sunday'&&day===0;};
const safeReasons=values=>[...new Set((Array.isArray(values)?values:[]).map(item=>typeof item==='string'?item:item?.message||item?.reason||item?.code).filter(Boolean))];
function Control({label,value,onChange,children}){return <label className="kc-control"><span>{label}</span><select value={value} onChange={event=>onChange(event.target.value)}>{children}</select></label>;}
function Stat({id,title,value,detail,rows,sourceRows}){return <SortableItem id={id} label={title} kind="metric"><DataComponent id={id} queryId="company_daily" title={title} kind="metric" variant="card" displayRows={rows} sourceRows={sourceRows}><div className="kc-stat"><strong>{value}</strong><span>{detail}</span></div></DataComponent></SortableItem>;}
function readPayload(queries){const row=queries.comparison_payload?.rows?.[0];if(!row?.payload)return null;try{return typeof row.payload==='string'?JSON.parse(row.payload):row.payload;}catch{return null;}}

export function DashboardContent(){
  const {queries}=useDataApp();
  const snapshot=useMemo(()=>readPayload(queries),[queries]);
  const [runId,setRunId]=useState('gyeongnam_glamping_20260922_140041');
  const [previousRunId,setPreviousRunId]=useState('gyeongnam_glamping_20260921_140004');
  const [period,setPeriod]=useState('common');
  const [start,setStart]=useState('2026-09-22');
  const [end,setEnd]=useState('2026-10-20');
  const [dayFilter,setDayFilter]=useState('all');
  const [cohort,setCohort]=useState('latest');
  const [selectedCompany,setSelectedCompany]=useState(null);
  const validRange=start&&end&&start<=end;
  const model=useMemo(()=>{if(!snapshot)return null;try{if(!validRange)throw Error('INVALID_DATE_RANGE');return computeComparison(snapshot,{runId,previousRunId,start,end,cohort,dayFilter});}catch{return {owner:{expectedDays:0,coveredDays:0},benchmark:{expectedDays:0,coveredDays:0},companies:[],cards:[],daily:[],error:'선택한 숙박기간과 요일에 해당하는 자료가 없습니다. 비교 조건을 확인하세요.'};}},[snapshot,validRange,runId,previousRunId,start,end,cohort,dayFilter]);
  const choosePeriod=value=>{setPeriod(value);if(presets[value]){setStart(presets[value][0]);setEnd(presets[value][1]);}};
  const commitDate=(setter,currentValue,event)=>{const value=event.currentTarget.value;if(value===currentValue)return;setPeriod('custom');setter(value);};
  const chooseRun=value=>{setRunId(value);const current=snapshot?.runs.find(run=>run.id===value);const previous=snapshot?.runs.filter(run=>Date.parse(run.observedAt)<Date.parse(current?.observedAt)).at(-1);setPreviousRunId(previous?.id||'');};
  if(!snapshot||!model)return <article className="keyword-comparison"><p role="status">{!validRange?'숙박 시작일과 종료일을 확인하세요.':'저장된 비교 자료를 준비하고 있습니다.'}</p></article>;
  const owner=model.error?snapshot.companies.find(company=>company.placeId===snapshot.meta.ownerPlaceId)||{}:model.owner||{}, benchmark=model.benchmark||{}, companies=model.companies||[];
  const ownerId=owner.companyId||owner.id;
  const selected=companies.find(item=>item.companyId===selectedCompany)||owner;
  const selectedId=selected.companyId||selected.id;
  const currentMembers=new Set(companies.map(company=>company.companyId||company.id));
  const sourceRows=(queries.company_daily?.rows||[]).filter(row=>[runId,model.selection?.previousRunId].includes(row.runId)&&row.date>=start&&row.date<=end&&currentMembers.has(row.companyId)&&matchesDay(row.date,dayFilter));
  const currentRows=sourceRows.filter(row=>row.runId===runId);
  const rankRows=companies.map(company=>({company:company.placeId===snapshot.meta.ownerPlaceId?`● ${company.name}`:company.name,publicRate:company.supply>0?company.publicBookings/company.supply:null,inferredRate:company.supply>0?company.inferredBookings/company.supply:null,rate:company.rate,rank:company.rank,coveredDays:company.coveredDays,supply:company.supply,publicBookings:company.publicBookings,inferredBookings:company.inferredBookings,companyId:company.companyId}));
  const dailyRows=(model.daily||[]).map(row=>({date:row.date,ownerRate:row.owner?.rate??null,benchmarkRate:row.benchmark?.rate??null}));
  const tableRows=companies.map(company=>({companyId:company.companyId,name:company.name,rank:company.rank,capacity:company.capacity?.rooms??null,capacityReviewed:company.capacity?.reviewed===true,rate:company.rate,publicBookings:company.publicBookings,inferredBookings:company.inferredBookings,coverage:`${company.coveredDays}/${company.expectedDays}일`,price:company.medianProductPrice,priceCoverage:company.priceCoverage,change:company.change?.publicNetChange??null,comparisonDays:company.change?.comparableDays??0,status:!company.capacity?.reviewed?'객실 기준 검토':company.coveredDays===company.expectedDays?'확보':'일부 자료'}));
  const changeRows=companies.map(company=>({name:company.name,publicNetChange:company.change?.publicNetChange??null,inferredNetChange:company.change?.inferredNetChange??null,comparableDays:company.change?.comparableDays??0,reason:company.change?.reason||'',companyId:company.companyId}));
  const productSource=(queries.product_observations?.rows||[]).filter(row=>row.runId===runId&&row.companyId===selectedId&&row.date>=start&&row.date<=end);
  const selectedDaily=(selected.daily||currentRows.filter(row=>row.companyId===selectedId)).map(row=>({date:row.date,supply:row.supply,publicBookings:row.publicBookings,inferredBookings:row.inferredBookings,rate:row.rate,price:row.medianProductPrice,status:quantityLabel(row.quantityStatus)}));
  const gap=Number.isFinite(owner.rate)&&Number.isFinite(benchmark.rate)?(owner.rate-benchmark.rate)*100:null;
  const hasRate=rankRows.some(row=>Number.isFinite(row.rate));
  const hasDailyRate=dailyRows.some(row=>Number.isFinite(row.ownerRate)||Number.isFinite(row.benchmarkRate));
  const previousRuns=snapshot.runs.filter(run=>Date.parse(run.observedAt)<Date.parse(snapshot.runs.find(item=>item.id===runId)?.observedAt));
  return <article className="keyword-comparison">
    <div className="kc-context"><span>2026년 9월 저장 관측</span><span>숙박 {shortDate(start)}~{shortDate(end)}</span><span>월명 {rooms(owner.capacity?.rooms)} · {owner.capacity?.reviewed?'검수 기준':'추정 기준'}</span><span>보존 DB 검수값 소급 적용</span><span>실시간 연결 없음</span></div>
    <div className="kc-controls" aria-label="비교 조건">
      <Control label="관측 회차" value={runId} onChange={chooseRun}>{snapshot.runs.map(run=><option key={run.id} value={run.id}>{shortDate(run.observedAt?.slice(0,10)||run.start)} 관측</option>)}</Control>
      <Control label="이전 관측" value={previousRunId} onChange={setPreviousRunId}><option value="">이전 관측 없음</option>{previousRuns.map(run=><option key={run.id} value={run.id}>{shortDate(run.observedAt?.slice(0,10)||run.start)} 관측</option>)}</Control>
      <Control label="숙박기간" value={period} onChange={choosePeriod}><option value="common">공통 29일</option><option value="september">9월 전체</option><option value="october">10월 전체</option><option value="all">저장 전체 구간</option><option value="custom">직접 선택</option></Control>
      <label className="kc-control"><span>숙박 시작일</span><input aria-label="숙박 시작일" type="date" value={start} onInput={event=>commitDate(setStart,start,event)} onChange={event=>commitDate(setStart,start,event)} onBlur={event=>commitDate(setStart,start,event)}/></label>
      <label className="kc-control"><span>숙박 종료일</span><input aria-label="숙박 종료일" type="date" value={end} onInput={event=>commitDate(setEnd,end,event)} onChange={event=>commitDate(setEnd,end,event)} onBlur={event=>commitDate(setEnd,end,event)}/></label>
      <Control label="요일" value={dayFilter} onChange={setDayFilter}>{Object.entries(dayNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</Control>
      <Control label="업체 표본" value={cohort} onChange={setCohort}><option value="latest">9/22의 20곳 고정</option><option value="run">선택 회차 상위 20곳</option></Control>
    </div>
    {model.error&&<p className="kc-warning" role="status">{model.error}</p>}
    {!model.error&&<>
    {previousRunId&&!model.selection?.previousRunId&&<p className="kc-warning">이전 관측은 선택한 관측 회차보다 앞선 회차로 선택하세요. 예약 변화 비교를 보류합니다.</p>}
    <p className="kc-scope">표본 예약률은 유효 공급수량으로 가중 계산하며 월명을 포함합니다. 9월·10월 전체 선택 시 관측되지 않은 날짜는 공백으로 남습니다.</p>
    <p className="kc-scope">표본 수량 확보 {number(benchmark.coveredDays)}/{number(benchmark.expectedDays)}업체·일 · 객실 기준 검토 필요 {number(model.quality?.unreviewedCompanies)}곳</p>
    <SortableRegion id="keyword-comparison:headlines" variant="freeform" authoredRevision={1} className="kc-headlines">
      <Stat id="owner-reservation-rate" title="월명 추정 예약률" value={percent(owner.rate)} detail={`공개 ${number(owner.publicBookings)}실 + 타채널 ${number(owner.inferredBookings)}실 · ${owner.coveredDays}/${owner.expectedDays}일`} rows={[owner]} sourceRows={currentRows.filter(row=>row.companyId===ownerId)}/>
      <Stat id="benchmark-reservation-rate" title="상위 20개 표본 예약률" value={percent(benchmark.rate)} detail={`월명 − 표본: ${Number.isFinite(gap)?`${gap>0?'+':''}${gap.toFixed(1)}%p`:'차이 미확인'} · 공급 가중`} rows={[benchmark]} sourceRows={currentRows}/>
      <Stat id="owner-visible-price" title="월명 숙박상품 표시가격 중앙값" value={money(owner.medianProductPrice)} detail={`표본 ${money(benchmark.medianProductPrice)} · 상품 조건 미확인, 참고`} rows={[owner,benchmark]} sourceRows={currentRows}/>
      <Stat id="owner-reservation-change" title="월명 공개예약 순변화" value={`${signed(owner.change?.publicNetChange)}${Number.isFinite(owner.change?.publicNetChange)?'실':''}`} detail={`같은 상품·숙박일 ${number(owner.change?.comparableDays)}일 비교 · 신규예약 건수 아님`} rows={[owner.change||{}]} sourceRows={sourceRows.filter(row=>row.companyId===ownerId)}/>
    </SortableRegion>
    <SectionHeader id="comparison-review-heading" title="먼저 검토할 판단"/>
    <div className="kc-judgments">{(model.cards||[]).map((card,index)=><DataComponent key={card.id||index} id={`saved-judgment-${index}`} queryId="company_daily" title={card.title} kind="narrative" variant="card" displayRows={[{...card,start,end,runId,previousRunId}]} sourceRows={sourceRows}><div className="kc-judgment"><span className={`kc-pill ${card.status==='hold'?'kc-hold':''}`}>{statusLabel(card.status)}</span><p className="kc-finding">{card.finding}</p><p className="kc-next">{card.action}</p><details><summary>근거와 적용 범위 <b>+</b></summary><ul>{safeReasons(card.evidence).map((text,i)=><li key={i}>{text}</li>)}</ul><ul className="kc-muted">{safeReasons(card.limits).map((text,i)=><li key={i}>{text}</li>)}</ul></details></div></DataComponent>)}</div>
    <div className="kc-chart-grid">
      {hasRate?<EvidenceChart id="top20-reservation-composition" queryId="company_daily" title="업체별 추정 예약률" rows={rankRows} sourceRows={currentRows} spec={{type:'horizontalStackedBar',x:'company',y:'publicRate',fields:['publicRate','inferredRate'],colors:{publicRate:'var(--chart-1)',inferredRate:'var(--chart-2)'},legend:{labels:{publicRate:'공개예약',inferredRate:'타채널 추정'}},showXAxisLabel:false,showYAxisLabel:false,startAtZero:true,showValues:true,valueDecimals:1}} height={640}><p className="kc-caption">● 월명글램핑 · 순위 순서 · 공개예약은 녹색, 타채널 추정예약은 보라색입니다. 미확인은 0으로 바꾸지 않습니다.</p></EvidenceChart>:<DataComponent id="top20-reservation-composition" queryId="company_daily" title="업체별 추정 예약률" kind="chart" displayRows={rankRows} sourceRows={currentRows}><div className="kc-empty"><strong>수량 응답 근거 미확인</strong><p>선택한 범위에 유효한 수량 근거가 없습니다. 예약률 0%와 구별하며, 확인 가능한 가격은 별도로 표시합니다.</p></div></DataComponent>}
      <div className="kc-right-charts">
        {hasDailyRate?<EvidenceChart id="daily-reservation-comparison" queryId="company_daily" title="숙박일별 예약률 흐름" rows={dailyRows} sourceRows={currentRows} spec={{type:'line',x:'date',y:'ownerRate',fields:['ownerRate','benchmarkRate'],colors:{ownerRate:'var(--chart-1)',benchmarkRate:'var(--chart-8)'},legend:{labels:{ownerRate:'월명',benchmarkRate:'상위 20개 표본'}},stackable:false,showXAxisLabel:false,showYAxisLabel:false,valueDecimals:1}} height={270}><p className="kc-caption">선택한 관측 회차에서 바라본 숙박일별 예약률입니다. 예약 접수일 흐름과 구별합니다.</p></EvidenceChart>:<DataComponent id="daily-reservation-comparison" queryId="company_daily" title="숙박일별 예약률 흐름" kind="chart" displayRows={dailyRows} sourceRows={currentRows}><div className="kc-empty"><strong>예약률 흐름 미확인</strong><p>미확인 날짜를 0% 선으로 연결하지 않습니다.</p></div></DataComponent>}
        <DataComponent id="observed-change-comparison" queryId="company_daily" title="공개예약 순변화 비교" kind="table" displayRows={changeRows} sourceRows={sourceRows}><DataTable rows={changeRows} columns={[{field:'name',label:'업체'},{field:'publicNetChange',label:'공개 순변화',renderCell:value=>`${signed(value)}${Number.isFinite(value)?'실':''}`},{field:'comparableDays',label:'공통일',renderCell:value=>`${number(value)}일`}]} rowKey="companyId" label="이전 관측과 같은 상품 숙박일의 공개예약 순변화"/><p className="kc-caption">감소는 취소·재예약·재고변경 등을 포함할 수 있습니다. 구형 응답 미확인·기준 변경은 비교를 보류합니다.</p></DataComponent>
      </div>
    </div>
    <SectionHeader id="company-detail-heading" title="업체별 가격·확보율과 근거"/>
    <DataComponent id="company-comparison-table" queryId="company_daily" title="상위 20개 업체 비교" kind="table" displayRows={tableRows} sourceRows={currentRows}>
      <DataTable rows={tableRows} columns={[
        {field:'name',label:'업체'},
        {field:'rank',label:'순위'},
        {field:'capacity',label:'객실 기준',renderCell:(value,row)=><span className={row.capacityReviewed?'kc-reviewed':'kc-unreviewed'}>{rooms(value)}<small>{row.capacityReviewed?'검수값':'최대관측 · 검수 전'}</small></span>},
        {field:'rate',label:'추정 예약률',renderCell:percent},
        {field:'price',label:'표시가격 중앙값',renderCell:money},
        {field:'coverage',label:'수량 확보'},
        {field:'priceCoverage',label:'가격 확보율',renderCell:percent},
        {field:'status',label:'상태'}
      ]} rowKey="companyId" selectedRowKey={selectedId} onRowSelect={row=>setSelectedCompany(row.companyId)} rowActionLabel={row=>`${row.name} 날짜별 근거 보기`} label="업체 검색과 상세 근거 선택"/>
      <p className="kc-caption">표시가격 중앙값은 관측된 숙박상품×날짜의 양의 판매가격 기준입니다. 객실 규모·상품 구성·혜택 차이가 있어 적정가격이나 실제 객단가로 해석하지 않습니다.</p>
    </DataComponent>
    <DataComponent id="selected-company-daily-evidence" queryId="company_daily" title={`${selected.name||'선택 업체'} · 날짜별 근거`} kind="table" displayRows={selectedDaily} sourceRows={currentRows.filter(row=>row.companyId===selectedId)}>
      <div className="kc-detail-meta"><span>객실 기준 {rooms(selected.capacity?.rooms)}</span><span>{selected.capacity?.reviewed?'DB·사용자 검수':'최대관측 추정 · 검토 필요'}</span><span>공유 데이유즈 제외 {rooms(selected.dayUseExcluded)}</span></div>
      {safeReasons(selected.reasons).length>0&&<p className="kc-warning">{safeReasons(selected.reasons).join(' · ')}</p>}
      <details className="kc-daily-disclosure"><summary>날짜별 자료 펼치기 <b>+</b></summary><DataTable rows={selectedDaily} columns={[
        {field:'date',label:'숙박일'},
        {field:'supply',label:'공급',renderCell:rooms},
        {field:'publicBookings',label:'공개예약',renderCell:rooms},
        {field:'inferredBookings',label:'타채널 추정',renderCell:rooms},
        {field:'rate',label:'예약률',renderCell:percent},
        {field:'price',label:'표시가격 중앙값',renderCell:money},
        {field:'status',label:'수량 상태'}
      ]} searchable={false} rowKey="date" label={`${selected.name} 숙박일별 관측 자료`}/></details>
      <p className="kc-caption">{productSource.length?`선택 범위의 상품 관측 근거 ${number(productSource.length)}행.`:'상품의 상세 조건은 저장 근거에서 확인합니다.'} 원본 수집번호·계산 기준은 각 카드의 자료 출처에서 확인할 수 있습니다.</p>
    </DataComponent>
    <p className="kc-bottom-note">보존 자료를 이용한 검토 화면입니다. 실제 예약접수일·쿠폰 사용·실결제 자료는 연결하지 않았으며, 정기수집·가격 변경·쿠폰 발급 기능은 없습니다.</p>
    </>}
  </article>;
}
