(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const field = (label, name, type, extra = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${extra}></label>`;
  const support = c => c.supportEmail ? `<a href="mailto:${esc(c.supportEmail)}">이용·계정 문의</a>` : '';
  const links = c => `<a href="/terms" target="_blank" rel="noopener">이용약관</a><a href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>${support(c)}`;
  function screen({ signup, config: c }) {
    const login = `${field('아이디','username','text','required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="80"')}${field('비밀번호','password','password','required autocomplete="current-password" maxlength="120"')}`;
    const registration = `<fieldset class="auth-section"><legend><span>01</span> 로그인 정보</legend>
      <div class="username-field">${field('아이디','username','text','required autocomplete="username" autocapitalize="none" spellcheck="false" minlength="4" maxlength="80" pattern="[a-zA-Z0-9._@\\-]{4,80}" aria-describedby="username-help username-status"')}${c.usernameCheckEnabled ? '<button class="button" type="button" data-action="check-username">중복 확인</button>':''}</div>
      <p class="field-hint" id="username-help">영문·숫자 또는 이메일 형식, 4~80자</p><p id="username-status" class="field-status" role="status"></p>
      <div class="form-grid">${field('비밀번호','password','password','required autocomplete="new-password" minlength="8" maxlength="120" aria-describedby="password-help"')}${field('비밀번호 확인','passwordConfirm','password','required autocomplete="new-password" minlength="8" maxlength="120"')}</div>
      <p class="field-hint" id="password-help">8자 이상, 영문·숫자와 대문자 또는 특수문자를 포함해 주세요.</p></fieldset>
      <fieldset class="auth-section"><legend><span>02</span> 연락처와 사업 정보</legend><div class="form-grid">${field('연락처','phone','tel','required autocomplete="tel" maxlength="30" placeholder="010-0000-0000"')}${field('이메일','email','email','required autocomplete="email" maxlength="120"')}</div><p class="field-hint">이용 안내와 요청 처리에 사용합니다.</p>
      <fieldset class="business-choices"><legend>어떤 상황에서 시작하시나요?</legend><div class="choice-grid"><label class="business-choice"><input type="radio" name="businessStatus" value="owned" required><span><strong>내 매장 운영 중</strong><small>가입 후 내 매장을 검색해 등록합니다.</small></span></label><label class="business-choice"><input type="radio" name="businessStatus" value="planning" required><span><strong>매장 준비 중</strong><small>관심지역과 경쟁업체부터 살펴봅니다.</small></span></label></div></fieldset>
      ${field('매장·프로젝트 이름 (선택)','projectName','text','maxlength="100" autocomplete="organization" placeholder="가입 후에도 수정할 수 있습니다."')}</fieldset>
      <fieldset class="auth-section consent-section"><legend><span>03</span> 필수 안내 확인</legend><div class="consent-summary"><strong>회원가입을 위한 개인정보 수집·이용</strong><p>아이디·비밀번호·연락처·이메일·사업 상태·동의 기록을 계정 관리와 요청 대응에 사용합니다. 서비스 이용 및 탈퇴·삭제 요청 처리에 필요한 동안 보관합니다. 동의를 거부할 수 있으나 가입은 제한됩니다.</p></div>
      <label class="check-field"><input name="agreeTerms" type="checkbox" required><span>[필수] <a href="${esc(c.termsUrl || '/terms')}" target="_blank" rel="noopener">이용약관</a>에 동의합니다.</span></label>
      <label class="check-field"><input name="agreePrivacy" type="checkbox" required><span>[필수] <a href="${esc(c.privacyUrl || '/privacy')}" target="_blank" rel="noopener">개인정보 수집·이용 안내</a>에 동의합니다.</span></label>
      <label class="check-field"><input name="confirmAge" type="checkbox" required><span>[필수] 만 14세 이상입니다.</span></label></fieldset>`;
    return `<div class="auth-layout ${signup?'signup-layout':''}"><div class="auth-intro"><span class="eyebrow">YOUR STAY, IN PERSPECTIVE</span><h1>운영의 흐름을 읽는<br>나만의 분석 공간</h1><p>내 매장부터 경쟁업체, 관심지역까지.<br>사분 인사이트에서 함께 관리하세요.</p><ul class="auth-benefits"><li><span>01</span> 내 매장 운영 중 · 매장 준비 중</li><li><span>02</span> 경쟁업체 기본 3곳 · 관심지역 1곳</li><li><span>03</span> 데이터랩과 연결된 매장 정보 관리</li></ul><p class="auth-footnote">제공 범위는 관리자 설정에 따라 달라질 수 있습니다.<br>리포트는 발행·배정 후 제공됩니다.</p></div>
      <section class="card auth-card"><span class="eyebrow">${signup?'CREATE YOUR ACCOUNT':'WELCOME BACK'}</span><h2>${signup?'회원가입':'로그인'}</h2><p class="muted">${signup?'계정을 만들고 내 상황에 맞게 시작하세요.':'가입한 이용자 계정으로 로그인하세요.'}</p>
      ${signup&&!c.signupEnabled?`<div class="empty-note" role="status">${esc(c.signupMessage || '현재 신규 가입을 준비하고 있습니다.')}<p>${support(c)}</p></div>`:`<form id="auth-form">${signup?registration:login}<p class="form-error" role="alert" tabindex="-1"></p><button class="button primary" type="submit">${signup?'동의하고 회원가입':'로그인'}</button></form>`}
      <div class="auth-switch">${signup?'이미 계정이 있으신가요?':'처음 이용하시나요?'} <a class="text-link" href="#${signup?'login':'signup'}">${signup?'로그인':'회원가입'}</a></div>${!signup?`<p class="auth-recovery">아이디·비밀번호 확인이 필요하신가요? ${support(c)}</p>`:''}<nav class="auth-policy-links" aria-label="이용 안내">${links(c)}</nav></section></div>`;
  }
  function policy(doc, config, signedIn) {
    return `<article class="card policy-card"><a class="text-link" href="/#${signedIn?'home':'signup'}">← ${signedIn?'내 공간':'회원가입'}으로</a><span class="eyebrow">SABUN INSIGHT</span><h1>${esc(doc.title)}</h1><p class="muted">적용 버전 ${esc(doc.version)}</p>${doc.sections.map(s=>`<section><h2>${esc(s.heading)}</h2>${s.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}</section>`).join('')}<nav class="auth-policy-links" aria-label="이용 안내">${links(config)}</nav></article>`;
  }
  function welcome(c) {
    const owned=c.businessStatus==='owned';
    return `<section class="card welcome-card"><span class="status-pill">회원가입 완료</span><h1>${esc(c.username)}님, 반갑습니다.</h1><p>이제 분석할 대상을 등록해 주세요. 정보는 나중에 변경할 수 있습니다.</p><div class="welcome-steps"><article><span>01</span><h2>${owned?'내 매장 등록':'관심지역 등록'}</h2><p>${owned?'업체명이나 주소로 검색해 내 매장 연결을 신청하세요. 관리자가 확인한 후 연결됩니다.':'준비 중인 지역을 먼저 등록하고 사업 구상을 시작하세요.'}</p><a href="#${owned?'property':'regions'}" class="button primary">${owned?'내 매장 찾기':'관심지역 선택'}</a></article><article><span>02</span><h2>경쟁업체 등록</h2><p>비교할 업체를 최대 ${esc(c.entitlements.competitorLimit)}곳까지 등록할 수 있습니다.</p><a href="#competitors" class="button">경쟁업체 찾기</a></article></div><a href="#home" class="text-link">나중에 등록하고 홈으로 이동</a></section>`;
  }
  const api={screen,policy,welcome};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else window.InsightAuth=api;
})();
