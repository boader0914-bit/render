'use strict';

// This module contains invented fixtures only. It never reads the operational DB.
const COMPANIES = [
  { id: 'demo-yunseul', name: '윤슬숲 스테이', regionCode: '48860', address: '경상남도 산청군 · 예시 주소', category: '글램핑', rooms: 16, metrics: { publicBookings: 182, inferredBookings: 64, supply: 480, estimatedRevenue: 44280000, coverage: 0.94 } },
  { id: 'demo-dalbit', name: '달빛마루 글램핑', regionCode: '48860', address: '경상남도 산청군 · 예시 주소', category: '글램핑', rooms: 18, metrics: { publicBookings: 204, inferredBookings: 71, supply: 540, estimatedRevenue: 52250000, coverage: 0.91 } },
  { id: 'demo-onyu', name: '온유들 스테이', regionCode: '48870', address: '경상남도 함양군 · 예시 주소', category: '글램핑', rooms: 12, metrics: { publicBookings: 131, inferredBookings: 40, supply: 360, estimatedRevenue: 29070000, coverage: 0.89 } },
  { id: 'demo-baram', name: '바람결 포레스트', regionCode: '41820', address: '경기도 가평군 · 예시 주소', category: '풀빌라', rooms: 10, metrics: { publicBookings: 119, inferredBookings: 28, supply: 300, estimatedRevenue: 41160000, coverage: 0.96 } },
  { id: 'demo-haedeun', name: '해든물 글램핑', regionCode: '41650', address: '경기도 포천시 · 예시 주소', category: '글램핑', rooms: 20, metrics: { publicBookings: 218, inferredBookings: 86, supply: 600, estimatedRevenue: 57760000, coverage: 0.9 } },
  { id: 'demo-solbyeol', name: '솔별정원 스테이', regionCode: '48720', address: '경상남도 의령군 · 예시 주소', category: '펜션', rooms: 8, metrics: { publicBookings: 88, inferredBookings: 27, supply: 240, estimatedRevenue: 18400000, coverage: 0.85 } },
];
const REGIONS = [
  { code: '48860', name: '경남 산청군', metrics: { visitors: 342000, searchIndex: 68, population: 33000 } },
  { code: '48870', name: '경남 함양군', metrics: { visitors: 284000, searchIndex: 57, population: 36000 } },
  { code: '41820', name: '경기 가평군', metrics: { visitors: 782000, searchIndex: 86, population: 63000 } },
  { code: '41650', name: '경기 포천시', metrics: { visitors: 651000, searchIndex: 79, population: 143000 } },
  { code: '48720', name: '경남 의령군', metrics: { visitors: 184000, searchIndex: 43, population: 25000 } },
];
const clone = (value) => structuredClone(value);

class PreviewError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'PreviewError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreviewError('validation', `${name} 형식이 올바르지 않습니다.`);
}
function fields(value, allowed, name) {
  object(value, name);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new PreviewError('validation', `${name}에 지원하지 않는 항목이 있습니다.`, 400, { fields: unknown });
}
function idList(value, name, allowed) {
  if (!Array.isArray(value) || value.length > 1000 || value.some((id) => typeof id !== 'string' || !allowed.has(id))) {
    throw new PreviewError('validation', `${name}에서 선택할 수 없는 대상이 있습니다.`);
  }
  if (new Set(value).size !== value.length) throw new PreviewError('validation', `${name}에 중복된 대상이 있습니다.`);
  return [...value];
}
function limit(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) throw new PreviewError('validation', `${name}는 0부터 1000까지의 정수여야 합니다.`);
  return value;
}
function makeInitial(profile) {
  const planning = profile === 'planning';
  const reportSnapshot = (type) => ({
    companyId: planning ? null : 'demo-yunseul',
    companyName: planning ? null : '윤슬숲 스테이',
    name: planning ? '매장 준비 중 · 관심 지역' : '윤슬숲 스테이',
    businessStage: planning ? 'planning' : 'owned',
    regionCodes: planning ? ['41820'] : ['48860', '41820'],
    competitorIds: planning ? ['demo-baram', 'demo-haedeun'] : ['demo-dalbit', 'demo-onyu'],
    metrics: type === 'monthly'
      ? (planning ? { publicBookings: 310, inferredBookings: 92, supply: 930, estimatedRevenue: 78230000, coverage: 0.91 } : { publicBookings: 174, inferredBookings: 61, supply: 496, estimatedRevenue: 42300000, coverage: 0.93 })
      : (planning ? { publicBookings: 80, inferredBookings: 28, supply: 210, estimatedRevenue: 21780000, coverage: 0.93 } : { publicBookings: 45, inferredBookings: 17, supply: 112, estimatedRevenue: 11160000, coverage: 0.95 }),
    metricScope: planning ? '발행 당시 비교업체 2곳의 예시 합계' : '발행 당시 내 매장의 예시 합계',
    source: '가상 예시 데이터',
  });
  return {
    mode: 'preview', profile, revision: 1,
    customer: { id: planning ? 'demo-member-planning' : 'demo-member-owner', name: planning ? '창업 준비 고객' : '윤슬숲 운영 고객', businessStage: planning ? 'planning' : 'owned', ownedCompanyId: planning ? null : 'demo-yunseul', projectName: planning ? '나의 스테이 준비' : '윤슬숲 스테이' },
    limits: { competitorLimit: 3, interestRegionLimit: 1 },
    companies: clone(COMPANIES), regions: clone(REGIONS),
    companySettings: {}, correctionRequests: [],
    competitorIds: planning ? ['demo-baram', 'demo-haedeun'] : ['demo-dalbit', 'demo-onyu'],
    interestRegionCodes: ['41820'],
    reports: [
      { id: `${profile}-monthly-202608-v1`, title: planning ? '8월 관심 지역 월간 리포트' : '8월 내 매장 월간 리포트', type: 'monthly', period: '2026-08', status: 'published', version: 1, summary: '예시 발행본 · 공개 관측과 방막기 추정을 구분한 월간 흐름입니다.', snapshot: reportSnapshot('monthly') },
      { id: `${profile}-weekly-20260921-v1`, title: '9월 4주 주간 리포트', type: 'weekly', period: '2026-09-21 ~ 2026-09-27', status: 'published', version: 1, summary: '예시 발행본 · 같은 숙박일의 예약 변화와 관심 지역 동향을 비교합니다.', snapshot: reportSnapshot('weekly') },
    ],
    archived: { competitorIds: [], interestRegionCodes: [] },
    audit: [{ id: `${profile}-initial`, at: '2026-09-28T00:00:00.000Z', action: 'initial', message: '가상 고객과 예시 자료를 준비했습니다.' }],
  };
}
function archiveChange(state, key, next) {
  const previous = state[key];
  state.archived[key] = [...new Set([...state.archived[key], ...previous.filter((id) => !next.includes(id))])].filter((id) => !next.includes(id));
  state[key] = [...next];
}

const EDIT_FIELDS = ['name', 'address', 'category', 'rooms', 'dayUse', 'facilities'];
function editText(value, label, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new PreviewError('validation', `${label} 입력을 확인해 주세요. 최대 ${max}자입니다.`);
  return value.trim();
}
function editableCompany(state, id) {
  const registered = state.customer.ownedCompanyId === id || state.competitorIds.includes(id);
  const company = state.companies.find((item) => item.id === id);
  if (!registered || !company) throw new PreviewError('not_found', '등록된 매장에서만 정보를 수정할 수 있습니다.', 404);
  return company;
}
function companyValues(company) {
  return Object.fromEntries(EDIT_FIELDS.map((key) => [key, company[key] ?? (key === 'dayUse' ? 'unknown' : '')]));
}

function createPreviewStore({ now = () => new Date().toISOString() } = {}) {
  const states = new Map(['owner', 'planning'].map((profile) => [profile, makeInitial(profile)]));
  const companyIds = new Set(COMPANIES.map((company) => company.id));
  const regionCodes = new Set(REGIONS.map((region) => region.code));
  function requireProfile(profile) {
    if (!states.has(profile)) throw new PreviewError('validation', 'owner 또는 planning 예시 고객을 선택해 주세요.');
    return states.get(profile);
  }
  function read(profile = 'owner') { return clone(requireProfile(profile)); }
  function act(request) {
    fields(request, ['profile', 'revision', 'action', 'payload'], '요청');
    const current = requireProfile(request.profile);
    if (!Number.isSafeInteger(request.revision) || request.revision < 1) throw new PreviewError('validation', '현재 revision이 필요합니다.');
    if (request.revision !== current.revision) throw new PreviewError('stale_revision', '다른 화면에서 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요.', 409, { revision: current.revision });
    if (typeof request.action !== 'string') throw new PreviewError('validation', '변경할 작업을 선택해 주세요.');
    const payload = request.payload;
    object(payload, '설정');
    let next = clone(current);
    let message;
    switch (request.action) {
      case 'edit-company': {
        fields(payload, ['companyId', 'nickname', 'note', 'proposed', 'reason'], '매장 정보 수정');
        const company = editableCompany(next, payload.companyId);
        const nickname = editText(payload.nickname, '별칭', 80);
        const note = editText(payload.note, '메모', 1000);
        const reason = editText(payload.reason, '수정 근거', 1000);
        fields(payload.proposed, EDIT_FIELDS, '수정 요청 항목');
        if (EDIT_FIELDS.some((key) => !Object.hasOwn(payload.proposed, key))) throw new PreviewError('validation', '수정할 매장 정보를 모두 확인해 주세요.');
        const proposed = {
          name: editText(payload.proposed.name, '매장명', 120, true),
          address: editText(payload.proposed.address, '주소', 300, true),
          category: editText(payload.proposed.category, '업종', 60, true),
          rooms: payload.proposed.rooms,
          dayUse: payload.proposed.dayUse,
          facilities: editText(payload.proposed.facilities, '시설·편의정보', 1000),
        };
        if (!Number.isSafeInteger(proposed.rooms) || proposed.rooms < 1) throw new PreviewError('validation', '객실 수는 1 이상의 정수로 입력해 주세요.');
        if (!['unknown', 'none', 'separate', 'shared'].includes(proposed.dayUse)) throw new PreviewError('validation', '데이유즈 운영 방식을 확인해 주세요.');
        const base = companyValues(company);
        const changes = Object.fromEntries(EDIT_FIELDS.filter((key) => proposed[key] !== base[key]).map((key) => [key, proposed[key]]));
        const pending = next.correctionRequests.findLast((item) => item.companyId === company.id && item.status === 'pending');
        if (Object.keys(changes).length && !reason) throw new PreviewError('validation', '수집 정보의 수정 요청에는 확인 근거를 입력해 주세요.');
        if (Object.keys(changes).length && (!pending || JSON.stringify(pending.proposed) !== JSON.stringify(changes) || pending.reason !== reason)) {
          if (pending) { pending.status = 'superseded'; pending.closedAt = now(); }
          next.correctionRequests.push({
            id: `${request.profile}-correction-${current.revision + 1}`, companyId: company.id,
            status: 'pending', submittedAt: now(), submittedBy: next.customer.id,
            relationship: next.customer.ownedCompanyId === company.id ? 'own' : 'competitor',
            baseValues: base, proposed: changes, reason,
          });
        } else if (!Object.keys(changes).length && pending) {
          // Explicitly returning every field to the current baseline withdraws the request.
          pending.status = 'withdrawn'; pending.closedAt = now();
        }
        next.companySettings[company.id] = { nickname, note, updatedAt: now() };
        message = Object.keys(changes).length ? '개인 설정을 저장하고 매장 정보 수정 요청을 검수 대기에 두었습니다.' : '개인 설정을 저장했습니다. 분석 기준은 그대로 유지됩니다.';
        break;
      }
      case 'withdraw-company-correction': {
        fields(payload, ['requestId'], '수정 요청 철회');
        const item = next.correctionRequests.find((entry) => entry.id === payload.requestId && entry.status === 'pending');
        if (!item) throw new PreviewError('not_found', '대기 중인 수정 요청을 찾을 수 없습니다.', 404);
        // This profile owns the request even after its comparison relationship is archived.
        item.status = 'withdrawn'; item.closedAt = now();
        message = '수정 요청을 철회했습니다. 기존 기준과 변경 이력은 유지됩니다.';
        break;
      }
      case 'set-profile': {
        fields(payload, ['businessStage', 'ownedCompanyId', 'projectName'], '매장 설정');
        if (!['owned', 'planning'].includes(payload.businessStage)) throw new PreviewError('validation', '내 매장 등록 또는 준비 중을 선택해 주세요.');
        const ownedCompanyId = payload.businessStage === 'owned' ? payload.ownedCompanyId : null;
        if (payload.businessStage === 'owned' && !companyIds.has(ownedCompanyId)) throw new PreviewError('validation', '등록할 매장을 선택해 주세요.');
        if (payload.businessStage === 'planning' && payload.ownedCompanyId != null) throw new PreviewError('validation', '준비 중에는 등록 매장을 연결할 수 없습니다.');
        let projectName = current.customer.projectName;
        if ('projectName' in payload) {
          if (typeof payload.projectName !== 'string' || payload.projectName.trim().length < 1 || payload.projectName.trim().length > 80) throw new PreviewError('validation', '매장 또는 준비 프로젝트 이름은 1~80자로 입력해 주세요.');
          projectName = payload.projectName.trim();
        }
        next.customer = { ...next.customer, businessStage: payload.businessStage, ownedCompanyId, projectName };
        if (ownedCompanyId) {
          const baseRegion = COMPANIES.find((company) => company.id === ownedCompanyId).regionCode;
          archiveChange(next, 'competitorIds', next.competitorIds.filter((id) => id !== ownedCompanyId));
          archiveChange(next, 'interestRegionCodes', next.interestRegionCodes.filter((code) => code !== baseRegion));
        }
        message = payload.businessStage === 'owned' ? '내 매장을 연결했습니다. 소재 지역은 기본 제공됩니다.' : '매장 준비 중으로 변경했습니다. 기존 리포트는 보관됩니다.';
        break;
      }
      case 'set-targets': {
        fields(payload, ['competitorIds', 'interestRegionCodes'], '관심 대상');
        const competitors = idList(payload.competitorIds, '경쟁업체', companyIds);
        const regions = idList(payload.interestRegionCodes, '관심지역', regionCodes);
        if (competitors.length > next.limits.competitorLimit || regions.length > next.limits.interestRegionLimit) {
          throw new PreviewError('limit_exceeded', '관리자가 설정한 등록 가능 수량을 초과했습니다.', 400, clone(next.limits));
        }
        const owned = COMPANIES.find((company) => company.id === next.customer.ownedCompanyId);
        if (owned && competitors.includes(owned.id)) throw new PreviewError('validation', '내 매장을 경쟁업체에 중복 등록할 수 없습니다.');
        if (owned && regions.includes(owned.regionCode)) throw new PreviewError('validation', '내 매장 소재 지역은 기본 제공되므로 관심지역에 추가하지 않습니다.');
        archiveChange(next, 'competitorIds', competitors);
        archiveChange(next, 'interestRegionCodes', regions);
        message = '관심 대상을 변경했습니다. 제외한 대상의 등록 이력과 기존 리포트는 보관됩니다.';
        break;
      }
      case 'set-limits': {
        fields(payload, ['competitorLimit', 'interestRegionLimit', 'keepCompetitorIds', 'keepInterestRegionCodes'], '관리자 한도 설정');
        const limits = { competitorLimit: limit(payload.competitorLimit, '경쟁업체 한도'), interestRegionLimit: limit(payload.interestRegionLimit, '관심지역 한도') };
        const keepCompetitors = 'keepCompetitorIds' in payload ? idList(payload.keepCompetitorIds, '유지할 경쟁업체', new Set(next.competitorIds)) : null;
        const keepRegions = 'keepInterestRegionCodes' in payload ? idList(payload.keepInterestRegionCodes, '유지할 관심지역', new Set(next.interestRegionCodes)) : null;
        if ((next.competitorIds.length > limits.competitorLimit && keepCompetitors === null) || (next.interestRegionCodes.length > limits.interestRegionLimit && keepRegions === null)) {
          throw new PreviewError('requires_selection', '한도를 줄이려면 유지할 대상을 선택해 주세요. 기존 자료는 삭제되지 않습니다.', 409, { limits, competitorIds: [...next.competitorIds], interestRegionCodes: [...next.interestRegionCodes] });
        }
        if ((keepCompetitors && keepCompetitors.length > limits.competitorLimit) || (keepRegions && keepRegions.length > limits.interestRegionLimit)) throw new PreviewError('validation', '유지할 대상 수가 새 한도를 초과합니다.');
        if (keepCompetitors !== null) archiveChange(next, 'competitorIds', keepCompetitors);
        if (keepRegions !== null) archiveChange(next, 'interestRegionCodes', keepRegions);
        next.limits = limits;
        message = '예시 고객의 이용 한도를 변경했습니다. 비활성 대상의 자료와 발행본은 보관됩니다.';
        break;
      }
      case 'reset':
        fields(payload, [], '초기화 설정');
        next = makeInitial(request.profile);
        message = '현재 예시 고객의 미리보기를 초기화했습니다.';
        break;
      default:
        throw new PreviewError('validation', '지원하지 않는 미리보기 작업입니다.');
    }
    next.revision = current.revision + 1;
    next.audit.push({ id: `${request.profile}-${next.revision}`, at: now(), action: request.action, message, changes: clone(payload),
      ...(request.action === 'edit-company' ? { previousPersonalSettings: clone(current.companySettings[payload.companyId] || null) } : {}) });
    states.set(request.profile, next);
    return clone(next);
  }
  return { read, act };
}

module.exports = { createPreviewStore, PreviewError };
