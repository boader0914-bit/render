const CURRENT_KEY_ID_ENV = "V4_FIXTURE_JOB_KEY_ID_CURRENT";
const CURRENT_SECRET_ENV = "V4_FIXTURE_JOB_HMAC_KEY_CURRENT";
const PREVIOUS_KEY_ID_ENV = "V4_FIXTURE_JOB_KEY_ID_PREVIOUS";
const PREVIOUS_SECRET_ENV = "V4_FIXTURE_JOB_HMAC_KEY_PREVIOUS";
const LEGACY_KEY_ID_ENV = "V4_FIXTURE_JOB_KEY_ID";
const LEGACY_SECRET_ENV = "V4_FIXTURE_JOB_HMAC_KEY";

class SigningKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SigningKeyError";
    this.code = code;
    this.stage = "signature";
    this.retryable = false;
  }
}

function normalizedPair(keyIdValue, secretValue, label, required) {
  const keyId = String(keyIdValue || "").trim();
  const secret = String(secretValue || "");
  if (!keyId && !secret && !required) return null;
  if (!keyId || !secret) {
    throw new SigningKeyError("FIXTURE_SIGNING_CONFIG_INCOMPLETE", `${label} signing key ID and secret must be configured together.`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(keyId)) {
    throw new SigningKeyError("FIXTURE_SIGNING_KEY_ID_INVALID", `${label} signing key ID is invalid.`);
  }
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new SigningKeyError("FIXTURE_SIGNING_KEY_INVALID", `${label} signing secret must contain at least 32 bytes.`);
  }
  return Object.freeze({ keyId, secret });
}

function loadSigningKeyring(env = process.env, options = {}) {
  const allowLegacy = options.allowLegacy === true;
  const hasCurrentNames = env[CURRENT_KEY_ID_ENV] !== undefined || env[CURRENT_SECRET_ENV] !== undefined;
  const current = normalizedPair(
    hasCurrentNames ? env[CURRENT_KEY_ID_ENV] : (allowLegacy ? env[LEGACY_KEY_ID_ENV] : ""),
    hasCurrentNames ? env[CURRENT_SECRET_ENV] : (allowLegacy ? env[LEGACY_SECRET_ENV] : ""),
    "Current",
    true
  );
  const previous = normalizedPair(env[PREVIOUS_KEY_ID_ENV], env[PREVIOUS_SECRET_ENV], "Previous", false);
  if (previous && previous.keyId === current.keyId) {
    throw new SigningKeyError("FIXTURE_SIGNING_KEY_ID_CONFLICT", "Current and previous signing key IDs must differ.");
  }
  const byId = new Map([[current.keyId, current.secret]]);
  if (previous) byId.set(previous.keyId, previous.secret);
  return Object.freeze({
    current,
    previous,
    resolveKey: (keyId) => byId.get(String(keyId)) || null,
    acceptedKeyIds: Object.freeze(previous ? [current.keyId, previous.keyId] : [current.keyId])
  });
}

module.exports = {
  CURRENT_KEY_ID_ENV,
  CURRENT_SECRET_ENV,
  LEGACY_KEY_ID_ENV,
  LEGACY_SECRET_ENV,
  PREVIOUS_KEY_ID_ENV,
  PREVIOUS_SECRET_ENV,
  SigningKeyError,
  loadSigningKeyring
};
