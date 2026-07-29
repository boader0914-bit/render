"use strict";

const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PASSWORD_ITERATIONS = 210000;

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function opaqueId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
}

function hashPassword(password, salt = crypto.randomBytes(18).toString("base64url")) {
  const digest = crypto.pbkdf2Sync(String(password || ""), salt, PASSWORD_ITERATIONS, 32, "sha256").toString("base64url");
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt}$${digest}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 120000 || iterations > 1000000) return false;
  const expected = Buffer.from(parts[3], "base64url");
  const actual = crypto.pbkdf2Sync(String(password || ""), parts[2], iterations, expected.length, "sha256");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeKey(value, label) {
  const text = String(value || "");
  if (text.length < 32) throw new Error(`${label} must contain at least 32 characters`);
  return crypto.createHash("sha256").update(text).digest();
}

function parseSessionKeyRing(env = process.env) {
  const currentVersion = String(env.V2_AUTH_SESSION_KEY_VERSION || "v1").trim();
  const currentSecret = String(env.V2_AUTH_SESSION_HASH_KEY_CURRENT || "");
  if (!currentVersion || !currentSecret) {
    throw new Error("V2_AUTH_SESSION_KEY_VERSION and V2_AUTH_SESSION_HASH_KEY_CURRENT are required");
  }
  const keys = new Map([[currentVersion, normalizeKey(currentSecret, "V2_AUTH_SESSION_HASH_KEY_CURRENT")]]);
  if (String(env.V2_AUTH_SESSION_HASH_KEYS_PREVIOUS || "").trim()) {
    let previous;
    try {
      previous = JSON.parse(env.V2_AUTH_SESSION_HASH_KEYS_PREVIOUS);
    } catch {
      throw new Error("V2_AUTH_SESSION_HASH_KEYS_PREVIOUS must be a JSON object");
    }
    for (const [version, secret] of Object.entries(previous || {})) {
      if (!version || version === currentVersion) continue;
      keys.set(version, normalizeKey(secret, `previous session key ${version}`));
    }
  }
  return Object.freeze({ currentVersion, keys });
}

function keyedHash(value, key) {
  return crypto.createHmac("sha256", key).update(String(value || "")).digest("base64url");
}

function tokenHash(value, keyRing, version = keyRing.currentVersion) {
  const key = keyRing.keys.get(version);
  if (!key) return "";
  return keyedHash(value, key);
}

function tokenHashCandidates(value, keyRing) {
  return [...keyRing.keys.entries()].map(([version, key]) => ({ version, hash: keyedHash(value, key) }));
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text || "").toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, "0");
}

function totp(secret, nowMs = Date.now(), periodSeconds = 30) {
  return hotp(secret, Math.floor(nowMs / 1000 / periodSeconds));
}

function verifyTotp(secret, code, nowMs = Date.now(), window = 1) {
  return matchTotpStep(secret, code, nowMs, window) !== null;
}

function matchTotpStep(secret, code, nowMs = Date.now(), window = 1) {
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const counter = Math.floor(nowMs / 1000 / 30);
  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = counter + delta;
    if (timingSafeTextEqual(hotp(secret, candidate), normalized)) return candidate;
  }
  return null;
}

function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

function mfaEncryptionKey(env = process.env) {
  return normalizeKey(env.V2_AUTH_MFA_ENCRYPTION_KEY, "V2_AUTH_MFA_ENCRYPTION_KEY");
}

function encryptSecret(secret, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", mfaEncryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(String(secret || ""), "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: encrypted.toString("base64url")
  };
}

function decryptSecret(envelope, env = process.env) {
  if (!envelope || envelope.algorithm !== "aes-256-gcm") throw new Error("Unsupported MFA secret envelope");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    mfaEncryptionKey(env),
    Buffer.from(envelope.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(8).toString("hex").toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

function recoveryCodeHash(code, env = process.env) {
  return keyedHash(String(code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase(), mfaEncryptionKey(env));
}

module.exports = {
  decodeBase32,
  decryptSecret,
  encodeBase32,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hotp,
  matchTotpStep,
  opaqueId,
  parseSessionKeyRing,
  randomToken,
  recoveryCodeHash,
  timingSafeTextEqual,
  tokenHash,
  tokenHashCandidates,
  totp,
  verifyPassword,
  verifyTotp
};
