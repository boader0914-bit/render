import type { NavigationItem, ProductRole } from "@glamping-datalab-v2/ui";

export interface AppRoute extends NavigationItem {
  role: ProductRole;
  eyebrow: string;
  title: string;
  description: string;
}

export const ROUTE_REGISTRY = Object.freeze([
  { id: "business-onboarding", role: "business", marker: "01", label: "시작 안내", path: "/app/onboarding", eyebrow: "Business start", title: "시작 안내", description: "새 통합 store가 비어 있는 상태에서 수집 준비와 다음 단계를 확인합니다." },
  { id: "business-activity", role: "business", marker: "02", label: "검색·관심", path: "/app/activity", eyebrow: "Search & interest", title: "검색·관심", description: "신규 수집이 승인되면 검색 이력과 관심 업체가 이곳에 표시됩니다." },
  { id: "business-report", role: "business", marker: "03", label: "리포트", path: "/app/report", eyebrow: "Business report", title: "리포트", description: "기존 데이터를 옮기지 않고 새 관측으로 생성한 사업자 리포트를 제공합니다." },
  { id: "business-location", role: "business", marker: "04", label: "입지카드", path: "/app/location", eyebrow: "Location card", title: "입지카드", description: "신규 표본이 기준을 충족하기 전에는 데이터 부족 상태를 유지합니다." },
  { id: "business-map", role: "business", marker: "05", label: "지역 지도", path: "/app/map", eyebrow: "Regional map", title: "지역 지도", description: "승인된 정적 경계와 새로 수집한 공개 지표만 표시합니다." },
  { id: "business-ranking", role: "business", marker: "06", label: "업체 순위", path: "/app/ranking", eyebrow: "Ranking", title: "업체 순위", description: "V2 계산 규칙을 따르는 순위가 준비되면 표시됩니다." },
  { id: "business-strategy", role: "business", marker: "07", label: "전략 추천", path: "/app/strategy", eyebrow: "Strategy", title: "전략 추천", description: "근거와 신뢰도를 갖춘 추천만 단계적으로 공개합니다." },
  { id: "business-execution", role: "business", marker: "08", label: "실행계획", path: "/app/execution", eyebrow: "Execution", title: "실행계획", description: "승인된 전략을 체크리스트와 측정 가능한 실행 항목으로 전환합니다." },
  { id: "business-retrospective", role: "business", marker: "09", label: "월간 회고", path: "/app/retrospective", eyebrow: "Monthly review", title: "월간 회고", description: "반복 관측이 쌓이면 월간 결과와 다음 행동을 함께 검토합니다." },
  { id: "admin-overview", role: "admin", marker: "01", label: "운영 홈", path: "/admin/overview", eyebrow: "Admin overview", title: "운영 홈", description: "빈 통합 store와 신규 수집 준비 상태를 안전하게 확인합니다." },
  { id: "admin-companies", role: "admin", marker: "02", label: "업체 DB", path: "/admin/companies", eyebrow: "Company database", title: "업체 DB", description: "신규 수집으로 식별된 업체와 검토 상태를 관리합니다." },
  { id: "admin-collection", role: "admin", marker: "03", label: "수집", path: "/admin/collection", eyebrow: "Collection", title: "수집", description: "provider 승인과 예산 gate를 통과한 신규 수집만 실행합니다." },
  { id: "admin-location", role: "admin", marker: "04", label: "입지카드", path: "/admin/location", eyebrow: "Location card", title: "입지카드", description: "표본과 freshness 기준을 충족한 입지카드를 검토합니다." },
  { id: "admin-map", role: "admin", marker: "05", label: "전국 지도", path: "/admin/map", eyebrow: "National map", title: "전국 지도", description: "허용된 정적 경계 자산과 신규 수집 지표를 결합합니다." },
  { id: "admin-ranking", role: "admin", marker: "06", label: "업체 순위", path: "/admin/ranking", eyebrow: "Company ranking", title: "업체 순위", description: "V2 계산 계약과 공개 범위를 확인합니다." },
  { id: "admin-reliability", role: "admin", marker: "07", label: "데이터 신뢰도", path: "/admin/reliability", eyebrow: "Reliability", title: "데이터 신뢰도", description: "coverage, 결측, freshness와 provider 품질을 검토합니다." },
  { id: "admin-import", role: "admin", marker: "08", label: "데이터 가져오기", path: "/admin/import", eyebrow: "Safe import", title: "데이터 가져오기", description: "기존 V2·Cluster 데이터가 아닌 승인된 신규 입력만 받습니다." },
  { id: "admin-backup", role: "admin", marker: "09", label: "백업·복구", path: "/admin/backup", eyebrow: "Backup & restore", title: "백업·복구", description: "통합 store의 복구 가능성과 감사 증적을 관리합니다." },
  { id: "admin-operations-quality", role: "admin", marker: "10", label: "운영 품질", path: "/admin/operations-quality", eyebrow: "Operations quality", title: "운영 품질", description: "API p95, worker 처리량과 오류 예산을 확인합니다." },
  { id: "admin-access", role: "admin", marker: "11", label: "계정·요금제", path: "/admin/access", eyebrow: "Access & plans", title: "계정·요금제", description: "역할과 entitlement 구조는 다음 보안 단계에서 연결됩니다." },
  { id: "admin-stage-review", role: "admin", marker: "12", label: "단계 검토", path: "/admin/stage-review", eyebrow: "Stage review", title: "단계 검토", description: "각 단계 release gate와 승인 증적을 검토합니다." },
  { id: "admin-settings", role: "admin", marker: "13", label: "설정", path: "/admin/settings", eyebrow: "Settings", title: "설정", description: "V2 우선 정책과 안전한 feature flag 상태를 관리합니다." }
] as const satisfies readonly AppRoute[]);

export const AUTH_ROUTES = Object.freeze(["/login", "/signup", "/activate", "/reset-password"] as const);
export const COMPATIBILITY_ROUTES = Object.freeze({
  "/b2b": "/app/onboarding",
  "/admin": "/admin/overview",
  "/view": "role-home"
} as const);

export function navigationForRole(role: ProductRole): readonly AppRoute[] {
  return ROUTE_REGISTRY.filter((route) => route.role === role);
}

export function homeForRole(role: ProductRole): string {
  return role === "admin" ? "/admin/overview" : "/app/onboarding";
}

export function routeForPath(pathname: string, role?: ProductRole): AppRoute {
  const direct = ROUTE_REGISTRY.find((route) => route.path === pathname);
  if (direct) return direct;
  const compatibility = COMPATIBILITY_ROUTES[pathname as keyof typeof COMPATIBILITY_ROUTES];
  const target = compatibility === "role-home" ? homeForRole(role || "business") : compatibility;
  return ROUTE_REGISTRY.find((route) => route.path === target) || ROUTE_REGISTRY[0];
}
