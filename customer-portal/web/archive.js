(() => {
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const when=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'시각 확인 전';
  const period=value=>value?.start&&value?.end?`${value.start} ~ ${value.end}`:'기간 확인 전';
  const titles={'daily-review':'일별 검수 결과','published-report':'발행 리포트'};
  const status=value=>({reviewed:'자동 검수 통과',complete:'정상 자료',partial:'일부 자료 · 확인 필요'}[value]||'검수 상태 확인 필요');
  const PAGE_SIZE=100;
  let generation=0,listSequence=0,detailSequence=0,root=null,request=null,expired=null,enabled=false,writing=false,publishIntent=null,listOffset=0,listTotal=0;
  const node=selector=>root?.querySelector(selector);
  const visible=(token,element=root)=>token===generation&&root?.isConnected&&element?.isConnected;
  function panel(state={},selectedOwnId=null){
    const relations=(state.customer?.relations||[]).filter(row=>row.kind==='own'&&['active','pending'].includes(row.status));
    const companies=relations.map(row=>(state.companies||[]).find(company=>company.companyId===row.companyId)).filter(Boolean);
    const allCompanies=(state.customer?.relations||[]).filter(row=>['own','competitor'].includes(row.kind)&&['active','pending'].includes(row.status)).map(row=>(state.companies||[]).find(company=>company.companyId===row.companyId)).filter(Boolean);
    return `<section id="insight-archives" class="card"><div class="analysis-card-top"><h2>보관한 자료</h2><span class="status-pill">장기 보관</span></div><p class="muted">일별 검수 결과와 발행 당시의 주간·월간 리포트를 보존합니다. 선택 숙박기간의 보관된 검수 자료로 발행본을 만듭니다.</p>${allCompanies.length?`<details><summary>업체·월 검수 결과 보관</summary><p class="muted">데이터랩에 저장된 해당 업체·월 자료를 검사해 보관합니다.</p><form id="archive-review-form"><div class="form-grid"><label class="field"><span>업체 *</span><select name="companyId" required>${allCompanies.map(company=>`<option value="${esc(company.companyId)}">${esc(company.name)}</option>`).join('')}</select></label><label class="field"><span>숙박월 *</span><input type="month" name="month" min="2017-12" max="2099-12" value="${today().slice(0,7)}" required></label></div><button type="submit" class="button" disabled>검수 결과 보관</button></form></details>`:''}<form id="archive-publish-form"><div class="form-grid"><label class="field"><span>발행 종류</span><select name="reportType"><option value="weekly">주간</option><option value="monthly">월간</option></select></label><label class="field"><span>숙박 기준일 *</span><input type="date" name="anchorDate" value="${today()}" required></label>${companies.length?`<label class="field"><span>기준 내 매장</span><select name="ownId">${companies.map(company=>`<option value="${esc(company.companyId)}"${company.companyId===selectedOwnId?' selected':''}>${esc(company.name)}</option>`).join('')}</select></label>`:''}</div><button type="submit" class="button" disabled>발행본 보관</button></form><p id="archive-notice" class="muted" role="status" aria-live="polite"></p><label class="field"><span>자료 종류</span><select id="archive-kind"><option value="">전체</option><option value="daily-review">일별 검수 결과</option><option value="published-report">발행 리포트</option></select></label><div id="archive-list" aria-live="polite"><p class="empty-note">보관 목록을 연결하고 있습니다.</p></div><div id="archive-detail" aria-live="polite"></div></section>`;
  }
  function provenance(identity={},payload={}){
    const source=payload.provenance||identity;
    const links=Array.isArray(identity.sourceLinks)?identity.sourceLinks:Array.isArray(source)?source:[];
    const ids=Array.isArray(identity.companyIds)?identity.companyIds:identity.companyId?[identity.companyId]:source.companyId?[source.companyId]:[];
    const runs=Array.isArray(identity.runIds)?identity.runIds:Array.isArray(source.runIds)?source.runIds:[];
    const version=identity.calculationVersion||source.calculationVersion||payload.calculationVersion;
    const versions=Array.isArray(identity.calculationVersions)?identity.calculationVersions.join(', '):version;
    const sourceArchives=Array.isArray(identity.sourceArchives)?identity.sourceArchives:Array.isArray(payload.sourceArchives)?payload.sourceArchives:[];
    return `<details><summary>데이터랩 원본 연결</summary><p class="muted">업체 번호: ${esc(ids.length?ids.join(', '):'연결 확인 필요')}</p>${links.length?`<div class="collection-table-wrap"><table><caption>중앙 원본별 연결</caption><thead><tr><th>업체 번호</th><th>숙박월</th><th>수집 번호</th><th>중앙 계산 버전</th></tr></thead><tbody>${links.map(link=>`<tr><td>${esc(link.companyId||'연결 확인 필요')}</td><td>${esc(link.month||'기간 확인 필요')}</td><td>${esc(Array.isArray(link.runIds)&&link.runIds.length?link.runIds.join(', '):'연결 확인 필요')}</td><td>${esc(link.calculationVersion||'연결 확인 필요')}</td></tr>`).join('')}</tbody></table></div><p class="muted">발행 계산 버전: ${esc(versions||'해당 없음')}</p>`:`<p class="muted">수집 번호: ${esc(runs.length?runs.join(', '):'연결 확인 필요')}</p><p class="muted">계산 버전: ${esc(versions||'연결 확인 필요')}</p>`}${sourceArchives.length?`<p class="muted">검수 보관본: ${sourceArchives.map(value=>esc(value.id||'연결 확인 필요')).join(', ')}</p>`:''}</details>`;
  }
  function listView(records=[],{offset=0,total=records.length}={}){
    const content=records.length?`<div class="collection-table-wrap"><table><caption>일별 검수 결과·발행 리포트 보관 목록</caption><thead><tr><th>자료</th><th>숙박기간</th><th>상태</th><th>보관 시각</th><th>보기</th></tr></thead><tbody>${records.map(record=>`<tr><th>${esc(record.metadata?.title||titles[record.kind]||'보관 자료')}${record.metadata?.reportType?` · ${esc(record.metadata.reportType==='weekly'?'주간':record.metadata.reportType==='monthly'?'월간':'종류 확인 필요')}`:''}</th><td>${esc(period(record.period))}</td><td>${esc(status(record.metadata?.reviewStatus))}</td><td>${esc(when(record.createdAt))}</td><td><button type="button" class="button small" data-archive-open="${esc(record.id)}">보기</button>${provenance(record.identity)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty-note">아직 보관한 자료가 없습니다.</p>';
    return content+(total>PAGE_SIZE||offset>0?`<nav aria-label="보관 목록 페이지"><button type="button" class="button small" data-archive-page="${Math.max(0,offset-PAGE_SIZE)}"${offset===0?' disabled':''}>이전</button> <span class="muted">${number(offset+1)} ~ ${number(Math.min(offset+records.length,total))} / ${number(total)}건</span> <button type="button" class="button small" data-archive-page="${offset+PAGE_SIZE}"${offset+PAGE_SIZE>=total?' disabled':''}>다음</button></nav>`:'');
  }
  function dailyTable(rows=[]){
    return `<div class="collection-table-wrap"><table><caption>발행 당시 날짜별 예약·매출</caption><thead><tr><th>숙박일</th><th>공개 예약</th><th>방막기</th><th>예약 합계</th><th>추정매출</th><th>상태</th><th>수집 번호</th></tr></thead><tbody>${rows.map(row=>{
      const known=row.missing!==true&&row.inventoryConflict!==true&&row.review?.quantityReviewed!==false,priced=known&&row.review?.revenueReviewed!==false,publicCount=known?row.publicBookings:null,blockedCount=known?row.phoneBookings:null;
      const total=typeof publicCount==='number'&&typeof blockedCount==='number'?publicCount+blockedCount:null;
      const reason={SOURCE_LINK_MISSING:'원본 연결 미확인',QUANTITY_NOT_REVIEWABLE:'수량 검토 필요',REVENUE_NOT_REVIEWABLE:'금액 검토 필요',ARCHIVE_OBSERVATION_MISSING:'관측 자료 없음'}[row.review?.reason];
      const unresolved=reason||(!known?'미확인':!priced||row.partial||row.revenuePartial?'일부 확인 필요':'정상 관측');
      return `<tr><th>${esc(row.date)}</th><td class="public-value">${number(publicCount)}</td><td class="${typeof blockedCount==='number'&&blockedCount>0?'estimated-value':''}">${number(blockedCount)}</td><td>${number(total)}</td><td>${number(priced?row.estimatedRevenue:null)}${typeof row.estimatedRevenue==='number'&&priced?'원':''}</td><td>${esc(unresolved)}</td><td>${esc(row.sourceObservation?.runId||'연결 확인 필요')}</td></tr>`;
    }).join('')||'<tr><td colspan="7">보관된 날짜별 자료가 없습니다.</td></tr>'}</tbody></table></div>`;
  }
  function reviewedSummary(data={}){
    const days=Array.isArray(data.daily)?data.daily:[],review=data.review||{};
    const quantity=days.filter(row=>row.review?.quantityReviewed===true&&row.missing!==true&&row.inventoryConflict!==true),revenue=quantity.filter(row=>row.review?.revenueReviewed===true);
    const count=(key,rows)=>Number.isSafeInteger(review[key])&&review[key]===rows.length?review[key]:rows.length;
    const expectedDays=Number.isSafeInteger(data.period?.days)&&data.period.days>0?data.period.days:days.length;
    const observedDays=count('quantityReviewedDays',quantity),revenueObservedDays=count('revenueReviewedDays',revenue);
    const sum=(rows,key)=>rows.length&&rows.every(row=>typeof row[key]==='number'&&Number.isFinite(row[key]))?rows.reduce((total,row)=>total+row[key],0):null;
    const partial=expectedDays===0||observedDays!==expectedDays,revenuePartial=expectedDays===0||revenueObservedDays!==expectedDays;
    return {expectedDays,observedDays,revenueObservedDays,partial,revenuePartial,publicBookings:partial?null:sum(quantity,'publicBookings'),phoneBookings:partial?null:sum(quantity,'phoneBookings'),estimatedRevenue:revenuePartial?null:sum(revenue,'estimatedRevenue'),knownSold:sum(quantity,'sold'),knownEstimatedRevenue:sum(revenue,'estimatedRevenue')};
  }
  function companyView(company={}, {dailyReview=false,title}={}){
    const data=company.snapshot||company,summary=dailyReview?reviewedSummary(data):data.summary||{},review=data.review||company.review||{};
    return `<article><h4>${esc(company.name||title||company.companyId||data.companyId||'업체 자료')}</h4><p class="muted">${esc(status(review.status))} · 공개 예약 ${number(summary.publicBookings)}실 · 방막기 ${number(summary.phoneBookings)}실 · 추정매출 ${number(summary.estimatedRevenue)}${typeof summary.estimatedRevenue==='number'?'원':''}</p>${summary.partial||summary.revenuePartial?`<p class="muted">확인된 일부 자료: 예약 ${number(summary.knownSold)}실 · 매출 ${number(summary.knownEstimatedRevenue)}${typeof summary.knownEstimatedRevenue==='number'?'원':''} · ${dailyReview?'수량 ':''}확보 ${number(summary.observedDays)} / ${number(summary.expectedDays)}일${dailyReview?` · 금액 확보 ${number(summary.revenueObservedDays)} / ${number(summary.expectedDays)}일`:''}</p>`:''}${provenance({companyId:company.companyId||data.companyId},data)}${dailyTable(Array.isArray(data.daily)?data.daily:[])}</article>`;
  }
  function detailView(record){
    const data=record.payload||{},companies=Array.isArray(data.companies)?data.companies:[data];
    const quality=data.quality?.status||data.review?.status||record.metadata?.reviewStatus;
    const dailyReview=record.kind==='daily-review';
    return `<section class="analysis-notes"><h3>${esc(record.metadata?.title||titles[record.kind]||'보관 자료')}</h3><p class="muted">${esc(period(record.period||data.period))} · ${esc(status(quality))} · 보관 ${esc(when(record.createdAt))}</p><p class="muted">보관 당시의 고정 자료입니다. 이후 갱신된 현재 자료와 다를 수 있습니다.</p>${provenance(record.identity,data)}${companies.map(company=>companyView(company,{dailyReview,title:dailyReview?record.metadata?.title:undefined})).join('')}${Array.isArray(data.quality?.issues)&&data.quality.issues.length?`<details><summary>확인할 항목</summary><ul>${data.quality.issues.map(issue=>`<li>${esc(typeof issue==='string'?issue:issue.message||issue.code||'자료 확인 필요')}</li>`).join('')}</ul></details>`:''}</section>`;
  }
  function notice(message){const target=node('#archive-notice');if(target)target.textContent=message;}
  function buttons(){for(const id of ['#archive-publish-form','#archive-review-form']){const button=node(id)?.querySelector('button');if(button)button.disabled=!enabled||writing;}}
  function unauthorized(error,token){
    if(error?.status!==401||!visible(token))return false;
    const callback=expired;stop();if(callback)callback();return true;
  }
  async function loadList(){
    const token=generation,id=++listSequence,slot=node('#archive-list'),api=request,filter=node('#archive-kind')?.value||'',offset=listOffset;
    if(!slot||!api)return;
    const current=()=>visible(token,slot)&&id===listSequence;
    try{
      const params=[...(filter?['kind='+encodeURIComponent(filter)]:[]),...(offset?['limit='+PAGE_SIZE,'offset='+offset]:[])];
      const result=await api(`/archives${params.length?'?'+params.join('&'):''}`);
      if(!current())return;
      enabled=result.enabled===true&&result.status?.available!==false;
      buttons();
      if(!enabled){
        const code=/^ARCHIVE_[A-Z_]+$/.test(result.status?.lastError||'')?result.status.lastError:'';
        slot.innerHTML=result.enabled===true?`<p class="collection-warning">${code==='ARCHIVE_LOW_SPACE'?'장기 보관 디스크 여유 공간이 부족합니다.':'장기 보관 저장소를 사용할 수 없습니다. 서버의 디스크 연결 상태를 확인해 주세요.'}${code?' ('+esc(code)+')':''}</p>`:'<p class="empty-note">장기 보관 저장소 연결이 필요합니다.</p>';return;
      }
      const records=Array.isArray(result.records)?result.records:[];listTotal=Number.isSafeInteger(result.total)&&result.total>=0?result.total:offset+records.length;
      if(offset>=listTotal&&offset>0){listOffset=Math.max(0,Math.floor((listTotal-1)/PAGE_SIZE)*PAGE_SIZE);void loadList();return;}
      slot.innerHTML=listView(records,{offset,total:listTotal});
    }catch(error){if(!current()||unauthorized(error,token))return;slot.innerHTML=`<p class="collection-warning">${esc(error.message||'보관 목록을 확인하지 못했습니다.')}</p>`;}
  }
  async function openRecord(id){
    const token=generation,sequence=++detailSequence,slot=node('#archive-detail'),api=request;
    if(!slot||!api||!enabled)return;
    slot.innerHTML='<p class="empty-note" role="status">보관 자료를 불러오고 있습니다.</p>';
    const current=()=>visible(token,slot)&&sequence===detailSequence;
    try{const result=await api('/archives/'+encodeURIComponent(id));if(current())slot.innerHTML=detailView(result.record||{});}
    catch(error){if(!current()||unauthorized(error,token))return;slot.innerHTML=`<p class="collection-warning">${esc(error.message||'보관 자료를 확인하지 못했습니다.')}</p>`;}
  }
  async function publish(form){
    const token=generation,api=request;if(!enabled||writing||!visible(token,form))return;
    const values=Object.fromEntries(new FormData(form)),reportType=values.reportType,anchorDate=values.anchorDate;
    if(!['weekly','monthly'].includes(reportType)||!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate||'')){notice('발행 종류와 숙박 기준일을 확인해 주세요.');return;}
    const intent=JSON.stringify([reportType,anchorDate,values.ownId||'']);
    if(publishIntent?.intent!==intent){
      if(typeof globalThis.crypto?.randomUUID!=='function'){notice('보관 요청 번호를 만들지 못했습니다. 브라우저를 다시 열어 주세요.');return;}
      publishIntent={intent,key:globalThis.crypto.randomUUID()};
    }
    const payload={reportType,anchorDate,requestKey:publishIntent.key,...(values.ownId?{ownId:values.ownId}:{})};
    writing=true;buttons();notice('보관된 검수 자료로 발행본을 만들고 있습니다.');
    try{
      const result=await api('/archives/reports',payload);
      if(!visible(token,form))return;
      const record=result.record||{},partial=record.metadata?.reviewStatus==='partial'||record.payload?.quality?.status==='partial';
      if(publishIntent?.key===payload.requestKey)publishIntent=null;
      notice(partial?'일부 자료 발행본을 보관했습니다. 미확인 날짜와 사유를 확인해 주세요.':result.created===false?'이미 보관된 발행본을 표시합니다.':'발행본을 보관했습니다.');
      const detail=node('#archive-detail');if(record.payload){if(detail)detail.innerHTML=detailView(record);}else if(record.id)void openRecord(record.id);
      void loadList();
    }catch(error){if(!visible(token,form)||unauthorized(error,token))return;notice(error.status===504||error.status===503||error.status===502?'보관 완료 여부를 확인하지 못했습니다. 목록에서 확인한 뒤 다시 시도해 주세요.':error.message||'발행본 보관을 완료하지 못했습니다.');}
    finally{if(visible(token,form)){writing=false;buttons();}}
  }
  async function capture(form){
    const token=generation,api=request;if(!enabled||writing||!visible(token,form))return;
    const values=Object.fromEntries(new FormData(form)),companyId=values.companyId,month=values.month;
    if(typeof companyId!=='string'||!companyId||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month||'')){notice('업체와 숙박월을 확인해 주세요.');return;}
    writing=true;buttons();notice('저장된 업체·월 자료를 검사하고 있습니다.');
    try{
      const result=await api('/archives/reviews',{companyId,month});if(!visible(token,form))return;
      if(result.status!=='stored'||!result.record?.id){notice(result.status==='disabled'?'장기 보관 저장소 연결이 필요합니다.':'보관할 정상 검수 자료가 아직 준비되지 않았습니다. 업체 자료의 계산·검수 상태를 확인해 주세요.');return;}
      const record=result.record;
      notice(record.metadata?.reviewStatus==='partial'?'일부 검수 결과를 보관했습니다. 미확인 날짜와 사유를 확인해 주세요.':result.created===false?'이미 보관된 검수 결과를 표시합니다.':'검수 결과를 보관했습니다.');
      const detail=node('#archive-detail');if(record.payload){if(detail)detail.innerHTML=detailView(record);}else void openRecord(record.id);
      void loadList();
    }catch(error){if(!visible(token,form)||unauthorized(error,token))return;notice(error.message||'검수 결과 보관을 완료하지 못했습니다.');}
    finally{if(visible(token,form)){writing=false;buttons();}}
  }
  function stop(){generation++;listSequence++;detailSequence++;if(root?.isConnected)root.innerHTML='';root=null;request=null;expired=null;enabled=false;writing=false;publishIntent=null;listOffset=0;listTotal=0;}
  function mount(api,{onSessionExpired=null}={}){stop();root=document.querySelector('#insight-archives');request=api;expired=onSessionExpired;if(root)void loadList();}
  document.addEventListener('submit',event=>{if(!['archive-publish-form','archive-review-form'].includes(event.target.id))return;event.preventDefault();event.stopImmediatePropagation();if(event.target.id==='archive-publish-form')void publish(event.target);else void capture(event.target);});
  document.addEventListener('change',event=>{if(event.target.closest?.('#archive-publish-form'))publishIntent=null;if(event.target.id!=='archive-kind')return;event.stopImmediatePropagation();listOffset=0;detailSequence++;const detail=node('#archive-detail');if(detail)detail.innerHTML='';void loadList();});
  document.addEventListener('click',event=>{
    const page=event.target.closest?.('[data-archive-page]');
    if(page?.dataset?.archivePage!==undefined&&root?.contains(page)){
      event.preventDefault();event.stopImmediatePropagation();const offset=Number(page.dataset.archivePage);
      if(page.disabled||!enabled||!Number.isSafeInteger(offset)||offset<0||offset%PAGE_SIZE!==0||offset>=listTotal)return;
      listOffset=offset;detailSequence++;const detail=node('#archive-detail');if(detail)detail.innerHTML='';void loadList();return;
    }
    const button=event.target.closest?.('[data-archive-open]');if(!button||!root?.contains(button))return;event.preventDefault();event.stopImmediatePropagation();void openRecord(button.dataset.archiveOpen);
  });
  window.InsightArchives={panel,listView,detailView,mount,stop};
})();
