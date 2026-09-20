"use strict";

const { publicHeader, publicFooter } = require("./public_site_chrome.cjs");

function createPublicPages(context) {
  const { escapeHtml: e, contactHtml, contactEmail, contactPhone, operatorName, policyVersion, signupEnabled, signupClosedMessage, loginFailureLimit, lockMinutes, sessionHours } = context;
  const footer = () => publicFooter({ contactHtml, contactPhone: e(contactPhone) });
  const head = (title) => `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#f7f6f0"><title>${e(title)} · STAYDATALAB</title><link rel="stylesheet" href="/public-site.css?v=20260920">`;

  function legalPage(title, eyebrow, sections, options = {}) {
    const rows = sections.map((section, index) => `<section id="section-${index + 1}"><h2>${e(section.title)}</h2>${section.body}</section>`).join("");
    const index = sections.map((section, i) => `<a href="#section-${i + 1}">${e(section.title)}</a>`).join("");
    return `<!doctype html><html lang="ko"><head>${head(title)}</head><body>
      ${publicHeader()}
      <main id="main" class="document-layout">
        <header class="document-heading"><p class="eyebrow">STAYDATALAB · ${e(eyebrow)}</p><h1>${e(title)}</h1><p class="meta">최종 수정 ${e(policyVersion.replace(/-/g, "."))} · 운영자 ${e(operatorName)}</p></header>
        <nav class="document-index" aria-label="문서 목차">${index}</nav>
        <div class="document-body">${rows}</div>
        <div class="document-actions"><a href="${e(options.backHref || "/login")}">${e(options.backLabel || "로그인으로 돌아가기")}</a>${options.historyHref ? `<a href="${e(options.historyHref)}">이전 안내 보기 (2026.07.08)</a>` : ""}</div>
      </main>${footer()}
    </body></html>`;
  }

  function loginPage(message = "") {
    const signupEntry = signupEnabled
      ? '<p>처음 이용하시나요?</p><a class="link" href="/signup">회원가입</a>'
      : `<p>${e(signupClosedMessage)}</p><a href="mailto:${e(contactEmail)}">이용 문의</a>`;
    return `<!doctype html><html lang="ko"><head>${head("로그인")}
      <meta name="application-name" content="STAYDATALAB"><meta name="apple-mobile-web-app-title" content="STAYDATALAB"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/icon-192.png">
    </head><body>${publicHeader()}
      <main id="main" class="login-layout">
        <section class="login-brand-panel" aria-labelledby="login-title">
          <p class="brand-kicker">STAY INSIGHT, BETTER DECISIONS</p>
          <h1 id="login-title">데이터로 운영의<br>기준을 만듭니다.</h1>
          <p class="brand-note">지역의 수요와 경쟁 숙소의 흐름을 살펴봅니다.<br>관측한 자료를 모아, 숙소의 다음 판단을 준비합니다.</p>
          <div class="brand-capabilities" aria-label="데이터랩의 분석 범위"><span><b>01</b> 지역과 수요</span><span><b>02</b> 숙소와 상품</span><span><b>03</b> 관측과 비교</span></div>
          <p class="brand-bottom">FROM OBSERVATION TO OPERATION · SABUN LABS</p>
        </section>
        <section class="login-form-panel" aria-labelledby="login-form-title">
          <div class="form-head"><p class="eyebrow">ACCOUNT ACCESS</p><h2 id="login-form-title">로그인</h2><p>이용 중인 계정으로 시작하세요.</p></div>
          <form class="login-form" method="post" action="/login">
            <label>아이디<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
            <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
            <button type="submit">로그인</button>
            <div class="error" role="alert">${e(message)}</div>
            <p class="security-note">${loginFailureLimit}회 연속 실패 시 ${lockMinutes}분간 로그인이 제한됩니다.<br>로그인은 최대 ${sessionHours}시간 유지되며 만료 시 다시 로그인해야 합니다.</p>
          </form>
          <div class="signup-entry">${signupEntry}</div>
        </section>
      </main>${footer()}
    </body></html>`;
  }

  function forbiddenPage(message = "") {
    return `<!doctype html><html lang="ko"><head>${head("접근 권한 안내")}</head><body>${publicHeader()}<main id="main" class="document-layout simple-layout"><p class="eyebrow">ACCOUNT ACCESS</p><h1>접근 권한을 확인해 주세요.</h1><p>${e(message || "이 계정으로 이용할 수 없는 화면입니다.")}</p><a href="/">서비스 화면으로 돌아가기</a></main>${footer()}</body></html>`;
  }

  return { legalPage, loginPage, forbiddenPage, footer };
}

module.exports = { createPublicPages };
