const crypto = require("node:crypto");

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|cookie|authorization|sessionId|sessionHash|userAgentHash|ipHash|apiKey|clientSecret|recipient|email|phone|mobile)/i;
const SENSITIVE_VALUE_PATTERN = /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]+|pbkdf2_sha256\$\d+\$)/i;

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortObject(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function contractDigest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function contractShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      item: value.length ? contractShape(value[0]) : "unknown"
    };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, contractShape(value[key])])
    );
  }
  return typeof value;
}

function sensitivePaths(value, path = "$") {
  const findings = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...sensitivePaths(item, `${path}[${index}]`)));
    return findings;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && SENSITIVE_VALUE_PATTERN.test(value)) findings.push(path);
    return findings;
  }
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_KEY_PATTERN.test(key)) findings.push(childPath);
    else findings.push(...sensitivePaths(item, childPath));
  }
  return findings;
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") {
    return typeof value === "string" && SENSITIVE_VALUE_PATTERN.test(value) ? "[REDACTED]" : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitive(item)
  ]));
}

module.exports = {
  SENSITIVE_KEY_PATTERN,
  contractDigest,
  contractShape,
  redactSensitive,
  sensitivePaths,
  sortObject,
  stableJson
};
