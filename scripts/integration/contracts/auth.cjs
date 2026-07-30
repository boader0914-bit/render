"use strict";

const AUTH_SCHEMA_VERSION = 1;

const AUTH_ROLES = Object.freeze({
  admin: "admin",
  business: "b2b"
});

const ACCOUNT_STATUSES = Object.freeze({
  active: "active",
  disabled: "disabled",
  mfaPending: "mfa_pending"
});

const PLAN_ENTITLEMENTS = Object.freeze({
  free: Object.freeze({
    plan: "free",
    dailySearchLimit: 2,
    searchUnlimited: false,
    searchWindowDays: 7,
    monthlyExportLimit: 0,
    concurrentExportLimit: 0,
    expandedSearchAllowed: false
  }),
  basic: Object.freeze({
    plan: "basic",
    dailySearchLimit: 20,
    searchUnlimited: false,
    searchWindowDays: 14,
    monthlyExportLimit: 5,
    concurrentExportLimit: 1,
    expandedSearchAllowed: true
  }),
  pro: Object.freeze({
    plan: "pro",
    dailySearchLimit: 100,
    searchUnlimited: false,
    searchWindowDays: 30,
    monthlyExportLimit: 30,
    concurrentExportLimit: 2,
    expandedSearchAllowed: true
  })
});

const ADMIN_ENTITLEMENTS = Object.freeze({
  ...PLAN_ENTITLEMENTS.pro,
  dailySearchLimit: 0,
  searchUnlimited: true
});

function cleanText(value, max = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeLoginId(value) {
  return cleanText(value, 120).toLowerCase();
}

function normalizeEmail(value) {
  return cleanText(value, 254).toLowerCase();
}

function normalizeRole(value) {
  return value === AUTH_ROLES.admin ? AUTH_ROLES.admin : AUTH_ROLES.business;
}

function normalizePlan(value) {
  return Object.prototype.hasOwnProperty.call(PLAN_ENTITLEMENTS, value) ? value : "free";
}

function entitlementsForPlan(value) {
  return { ...PLAN_ENTITLEMENTS[normalizePlan(value)] };
}

function entitlementsForRole(role, plan) {
  return normalizeRole(role) === AUTH_ROLES.admin
    ? { ...ADMIN_ENTITLEMENTS }
    : entitlementsForPlan(plan);
}

function assertPassword(password) {
  const value = String(password || "");
  if (value.length < 8 || value.length > 120) {
    const error = new Error("비밀번호는 8자 이상 120자 이하로 입력하세요.");
    error.statusCode = 400;
    throw error;
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value) || !(/[A-Z]/.test(value) || /[^A-Za-z0-9]/.test(value))) {
    const error = new Error("비밀번호는 영문과 숫자를 포함하고, 대문자 또는 특수문자를 포함해야 합니다.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function assertLoginId(value) {
  const loginId = normalizeLoginId(value);
  if (!/^[a-z0-9._@-]{4,120}$/i.test(loginId)) {
    const error = new Error("아이디는 영문, 숫자, 이메일 형식으로 4자 이상 입력하세요.");
    error.statusCode = 400;
    throw error;
  }
  return loginId;
}

function assertEmail(value) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("이메일을 올바르게 입력하세요.");
    error.statusCode = 400;
    throw error;
  }
  return email;
}

function publicAccount(account = {}) {
  return {
    accountId: account.accountId || "",
    username: account.username || "",
    email: account.email || "",
    displayName: account.displayName || "",
    role: normalizeRole(account.role),
    status: account.status || ACCOUNT_STATUSES.active,
    authVersion: Math.max(1, Number(account.authVersion) || 1),
    createdAt: account.createdAt || "",
    updatedAt: account.updatedAt || ""
  };
}

function publicSession(session = null, account = null, memberships = []) {
  if (!session || !account) {
    return {
      authenticated: false,
      username: "",
      role: "",
      roleLabel: "",
      memberId: "",
      accountType: "",
      profile: null,
      expiresAt: ""
    };
  }
  const role = normalizeRole(account.role);
  const primaryMembership = memberships[0] || {};
  const entitlements = entitlementsForRole(role, primaryMembership.plan || "free");
  return {
    authenticated: true,
    username: account.username || account.email || "",
    role,
    roleLabel: role === AUTH_ROLES.admin ? "마스터" : "B2B",
    memberId: account.accountId || "",
    accountId: account.accountId || "",
    accountType: role === AUTH_ROLES.admin ? "master" : "member",
    profile: {
      displayName: account.displayName || "",
      email: account.email || "",
      companyName: primaryMembership.companyName || ""
    },
    companyId: primaryMembership.companyId || "",
    companyIds: memberships.map((membership) => membership.companyId).filter(Boolean),
    plan: entitlements.plan,
    entitlements,
    mfaVerified: Boolean(session.mfaVerifiedAt),
    reauthenticatedAt: session.reauthenticatedAt || "",
    sessionCreatedAt: session.createdAt || "",
    expiresAt: session.expiresAt || ""
  };
}

module.exports = {
  ACCOUNT_STATUSES,
  ADMIN_ENTITLEMENTS,
  AUTH_ROLES,
  AUTH_SCHEMA_VERSION,
  PLAN_ENTITLEMENTS,
  assertEmail,
  assertLoginId,
  assertPassword,
  cleanText,
  entitlementsForPlan,
  entitlementsForRole,
  normalizeEmail,
  normalizeLoginId,
  normalizePlan,
  normalizeRole,
  publicAccount,
  publicSession
};
