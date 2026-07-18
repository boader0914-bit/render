const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function base32Encode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of buffer) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let accumulator = 0;
  const output = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) continue;
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totpCounterBuffer(counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  return buffer;
}

function generateTotp(secret, options = {}) {
  const period = Math.max(10, Number(options.period || 30));
  const digits = Math.max(6, Math.min(8, Number(options.digits || 6)));
  const timestamp = Number(options.timestamp ?? Date.now());
  const counter = Math.floor(timestamp / 1000 / period);
  const digest = crypto
    .createHmac(String(options.algorithm || "sha1").toLowerCase(), base32Decode(secret))
    .update(totpCounterBuffer(counter))
    .digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits);
  return String(binary).padStart(digits, "0");
}

function safeEqualText(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function verifyTotp(secret, code, options = {}) {
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6,8}$/.test(normalized)) return false;
  const period = Math.max(10, Number(options.period || 30));
  const timestamp = Number(options.timestamp ?? Date.now());
  const window = Math.max(0, Math.min(3, Number(options.window ?? 1)));
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = generateTotp(secret, { ...options, period, timestamp: timestamp + offset * period * 1000 });
    if (safeEqualText(candidate, normalized)) return true;
  }
  return false;
}

function generateMfaSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(Math.max(16, byteLength)));
}

function encryptionKey(value) {
  const source = String(value || "");
  if (source.length < 24) throw new Error("AUTH_MFA_ENCRYPTION_KEY must contain at least 24 characters.");
  return crypto.createHash("sha256").update(source).digest();
}

function encryptMfaSecret(secret, keyMaterial, options = {}) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(keyMaterial), iv);
  const ciphertext = Buffer.concat([cipher.update(String(secret), "utf8"), cipher.final()]);
  return {
    version: 1,
    keyVersion: String(options.keyVersion || "").trim(),
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptMfaSecret(payload = {}, keyMaterial) {
  if (payload.algorithm !== "aes-256-gcm" || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw new Error("Stored MFA secret is not decryptable.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(keyMaterial), Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function normalizeRecoveryCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(value) {
  return crypto.createHash("sha256").update(`mfa-recovery:${normalizeRecoveryCode(value)}`).digest("hex");
}

function generateRecoveryCodes(count = 10) {
  return Array.from({ length: Math.max(4, Math.min(20, Number(count || 10))) }, () => {
    let value = "";
    for (let index = 0; index < 12; index += 1) {
      value += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
  });
}

function buildOtpAuthUri({ issuer, accountName, secret }) {
  const safeIssuer = String(issuer || "Lodging Data Lab").trim() || "Lodging Data Lab";
  const label = `${safeIssuer}:${String(accountName || "admin").trim() || "admin"}`;
  const params = new URLSearchParams({
    secret: String(secret || ""),
    issuer: safeIssuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

module.exports = {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCodes,
  generateTotp,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp
};
