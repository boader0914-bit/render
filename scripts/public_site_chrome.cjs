"use strict";

const POLICY_LINKS = [
  ["/terms", "이용약관"], ["/privacy", "개인정보처리방침"],
  ["/refund", "결제·해지 안내"], ["/business-info", "사업자정보"],
  ["/data-collection-notice", "수집 범위"], ["/data-quality-notice", "데이터의 한계"],
  ["/collection-failure-notice", "수집 실패 안내"], ["/report-disclaimer", "리포트 이용 안내"],
  ["/api-key-retention-policy", "자료 보관·보안"], ["/account-delete", "계정·데이터 삭제 요청"]
];

function publicHeader() {
  return `<a class="skip-link" href="#main">본문으로 건너뛰기</a>
  <header class="public-header">
    <a class="public-brand" href="/login" aria-label="STAYDATALAB 로그인"><span>STAYDATALAB</span><small>BY SABUN LABS</small></a>
    <nav aria-label="사분 서비스"><a href="https://www.sabun.co.kr/" target="_blank" rel="noopener">사분랩스 <span aria-hidden="true">↗</span></a><a href="https://ops.sabun.co.kr/" target="_blank" rel="noopener">오퍼레이션 <span aria-hidden="true">↗</span></a></nav>
  </header>`;
}

function publicFooter({ contactHtml = '<a href="mailto:info@sabun.co.kr">info@sabun.co.kr</a>', contactPhone = "070-4001-6668" } = {}) {
  // Contact values are supplied by the server after HTML escaping.
  return `<footer class="public-footer">
    <div class="footer-top"><span class="footer-brand">SABUN LABS <small>숙박업의 판단과 운영을 연결합니다.</small></span><span class="footer-contact">${contactHtml}<span>${contactPhone}</span></span></div>
    <nav class="policy-links" aria-label="정책 문서">${POLICY_LINKS.map(([href, label]) => `<a href="${href}">${label}</a>`).join("")}</nav>
    <p class="footer-copy">© SABUN · STAYDATALAB</p>
  </footer>`;
}

module.exports = { publicHeader, publicFooter, POLICY_LINKS };
