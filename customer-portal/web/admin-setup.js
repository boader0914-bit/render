(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status = {pending:'비밀번호 설정 대기',active:'사용 중',disabled:'중지됨'};
  async function request(payload) {
    const r = await fetch('/api/admin/insight-admin-accounts', { method:payload?'POST':'GET',headers:{'Content-Type':'application/json',Accept:'application/json'},...(payload?{body:JSON.stringify(payload)}:{}) });
    const d = await r.json(); if(!r.ok)throw Error(d.error?.message || '데이터랩 관리자 로그인이 필요합니다.'); return d;
  }
  function render(d) {
    document.querySelector('#accounts').innerHTML = `<section class="card"><h2>계정 현황</h2>${d.accounts.length?d.accounts.map(a=>`<div class="customer-row"><strong>${esc(a.username)}</strong><span class="status">${status[a.status] || esc(a.status)}</span>${a.status==='active'?`<button data-disable="${esc(a.adminId)}">이 관리자 사용 중지</button>`:''}</div>`).join(''):'<p>준비된 관리자 계정이 없습니다.</p>'}</section>`;
    const pending=d.accounts.filter(a=>a.status==='pending');document.querySelector('#activation').hidden=!pending.length;
    document.querySelector('[name=adminId]').innerHTML=pending.map(a=>`<option value="${esc(a.adminId)}">${esc(a.username)}</option>`).join('');
  }
  const feedback=document.querySelector('#feedback');
  document.addEventListener('submit',async e=>{
    e.preventDefault();const f=e.target,b=f.querySelector('button');b.disabled=true;feedback.textContent='';
    const p=Object.fromEntries(new FormData(f));p.action=f.id==='reserve'?'reserve':'activate';
    try {render(await request(p));f.querySelectorAll('input[type=password]').forEach(x=>x.value='');feedback.textContent=p.action==='activate'?'관리자 계정이 활성화되었습니다. 인사이트 /admin에서 로그인하세요.':'계정을 준비했습니다. 운영 비밀번호를 직접 설정해 주세요.';}catch(err){feedback.textContent=err.message;}finally{b.disabled=false;}
  });
  document.addEventListener('click',async e=>{const b=e.target.closest('[data-disable]');if(!b)return;b.disabled=true;try{render(await request({action:'disable',adminId:b.dataset.disable}));feedback.textContent='관리자 사용을 중지하고 기존 로그인 세션을 종료했습니다.';}catch(err){feedback.textContent=err.message;b.disabled=false;}});
  request().then(render).catch(e=>feedback.textContent=e.message);
})();
