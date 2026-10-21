"use strict";

// Bounded-input company member projection shared by saved-data readers.
const native = require("node:fs");
const fault = (code = "COMPANY_MASTER_INVALID") => Object.assign(new Error("Company master cannot be verified"), { code, statusCode: 503 });
const need = (condition, code) => { if (!condition) throw fault(code); };

function jsonStructureValidator() {
  const stack = []; let root = "value", quoted = false, escape = false, unicode = 0, scalar = "", first = true;
  const valid = value => need(value, "COMPANY_MASTER_INVALID");
  const expectsValue = () => stack.length ? ["value", "valueOrEnd"].includes(stack.at(-1).state) : root === "value";
  function complete() {
    valid(expectsValue());
    if (stack.length) stack.at(-1).state = "commaOrEnd"; else root = "end";
  }
  function scalarEnd() {
    if (!scalar) return;
    valid(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(scalar)); scalar = ""; complete();
  }
  function push(chunk) {
    for (let index = 0; index < chunk.length; index++) {
      const ch = chunk[index];
      if (first) { first = false; if (ch === "\uFEFF") continue; }
      if (quoted) {
        if (unicode) { valid(/[0-9a-f]/i.test(ch)); unicode--; }
        else if (escape) { valid('"\\/bfnrtu'.includes(ch)); escape = false; if (ch === "u") unicode = 4; }
        else if (ch === "\\") escape = true;
        else if (ch === '"') {
          quoted = false;
          const frame = stack.at(-1);
          if (frame?.kind === "object" && ["keyOrEnd", "key"].includes(frame.state)) frame.state = "colon";
          else complete();
        } else valid(ch.charCodeAt(0) >= 0x20);
        continue;
      }
      if (scalar) {
        if (!/[\x20\x09\x0a\x0d,}\]]/.test(ch)) { scalar += ch; valid(scalar.length <= 1024); continue; }
        scalarEnd();
      }
      if (/[\x20\x09\x0a\x0d]/.test(ch)) continue;
      const frame = stack.at(-1);
      if (ch === '"') { valid(expectsValue() || frame?.kind === "object" && ["keyOrEnd", "key"].includes(frame.state)); quoted = true; }
      else if (ch === "{" || ch === "[") { valid(expectsValue()); stack.push({ kind: ch === "{" ? "object" : "array", state: ch === "{" ? "keyOrEnd" : "valueOrEnd" }); }
      else if (ch === "}" || ch === "]") {
        valid(frame && frame.kind === (ch === "}" ? "object" : "array") && ["keyOrEnd", "valueOrEnd", "commaOrEnd"].includes(frame.state)); stack.pop(); complete();
      } else if (ch === ",") { valid(frame?.state === "commaOrEnd"); frame.state = frame.kind === "object" ? "key" : "value"; }
      else if (ch === ":") { valid(frame?.kind === "object" && frame.state === "colon"); frame.state = "value"; }
      else { valid(expectsValue() && /[-\dtnf]/.test(ch)); scalar = ch; }
    }
  }
  return { push, end() { scalarEnd(); valid(root === "end" && stack.length === 0 && !quoted && !escape && !unicode); } };
}

// Parse and validate one companies-map member at a time. Callback results
// alone are retained; callers can consume without building any company map.
// Callbacks must derive read models only: the complete document is certified
// after the stream ends, never at an individual callback boundary.
async function readCompanyMasterProjection(file, {
  projectCompany = value => value, onCompany = null, checkpoint = async () => {},
  includeRootMetadata = false,
  stream = filename => native.createReadStream(filename, { encoding: "utf8", highWaterMark: 64 * 1024 })
} = {}) {
  if (projectCompany !== null && typeof projectCompany !== "function" || onCompany !== null && typeof onCompany !== "function"
    || typeof checkpoint !== "function" || typeof stream !== "function" || typeof includeRootMetadata !== "boolean") throw new TypeError("Company stream callbacks must be functions");
  const validator = jsonStructureValidator();
  const companies = Object.create(null);
  let depth = 0, quoted = false, escaped = false, token = "", stringDepth = 0;
  let rootKey = "", memberKey = "", rootWantsKey = false, companyWantsKey = false;
  let companiesDeclared = false;
  const seenCompanyKeys = new Set();
  let companiesSeen = false, inCompanies = false, companiesDone = false;
  let capturing = false, record = [], recordStart = -1, rootEnded = false;
  // Preserve unknown top-level fields for conservative revision hashing, while
  // replacing the complete companies body with an empty map before decoding.
  const rootParts = includeRootMetadata ? [] : null;
  let rootPartStart = 0;
  let input;
  try {
    input = stream(file);
    for await (let chunk of input) {
      await checkpoint();
      chunk = String(chunk);
      validator.push(chunk);
      recordStart = capturing ? 0 : -1;
      rootPartStart = inCompanies ? -1 : 0;
      for (let index = 0; index < chunk.length; index += 1) {
        const ch = chunk[index];
        if (quoted) {
          if (stringDepth <= 2 && !capturing) token += ch;
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') {
            quoted = false;
            if (stringDepth === 1 && rootWantsKey) {
              rootKey = JSON.parse(token); rootWantsKey = false;
              if (rootKey === "companies") { need(!companiesDeclared, "COMPANY_MASTER_INVALID"); companiesDeclared = true; }
            }
            else if (inCompanies && stringDepth === 2 && companyWantsKey) {
              memberKey = JSON.parse(token); companyWantsKey = false;
              need(!seenCompanyKeys.has(memberKey), "COMPANY_MASTER_INVALID"); seenCompanyKeys.add(memberKey);
            }
            token = "";
          }
          continue;
        }
        if (ch === '"') {
          need(!(inCompanies && depth === 2 && !companyWantsKey) && !(depth === 1 && rootKey === "companies" && !rootWantsKey), "COMPANY_MASTER_INVALID");
          quoted = true; stringDepth = depth; token = '"'; continue;
        }
        if (ch === "{" || ch === "[") {
          need(!rootEnded, "COMPANY_MASTER_INVALID");
          if (depth === 0) { need(ch === "{"); rootWantsKey = true; }
          else if (depth === 1 && rootKey === "companies") {
            need(ch === "{" && !companiesSeen, "COMPANY_MASTER_INVALID");
            if (rootParts) rootParts.push(chunk.slice(rootPartStart, index) + "{}");
            rootPartStart = -1;
            companiesSeen = true; inCompanies = true; companyWantsKey = true;
          } else if (inCompanies && depth === 2) {
            need(ch === "{" && memberKey, "COMPANY_MASTER_INVALID");
            capturing = true; recordStart = index; record = [];
          }
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          need(depth >= 0, "COMPANY_MASTER_INVALID");
          if (capturing && depth === 2) {
            record.push(chunk.slice(recordStart, index + 1));
            const value = JSON.parse(record.join(""));
            need(value && typeof value === "object" && !Array.isArray(value), "COMPANY_MASTER_INVALID");
            const key = memberKey;
            capturing = false; record = []; recordStart = -1; memberKey = "";
            if (onCompany) await onCompany(value, key);
            if (projectCompany) {
              const projected = await projectCompany(value, key);
              if (projected !== undefined) companies[key] = projected;
            }
            await checkpoint();
          } else if (inCompanies && depth === 1) { inCompanies = false; companiesDone = true; rootPartStart = index + 1; }
          else if (depth === 0) rootEnded = true;
        } else if (ch === ",") {
          if (depth === 1) { rootWantsKey = true; rootKey = ""; }
          else if (inCompanies && depth === 2) companyWantsKey = true;
        } else if ((rootEnded || inCompanies && depth === 2 && memberKey || depth === 1 && rootKey === "companies")
          && !/[\x20\x09\x0a\x0d:]/.test(ch)) throw fault("COMPANY_MASTER_INVALID");
      }
      if (capturing && recordStart >= 0) record.push(chunk.slice(recordStart));
      if (rootParts && rootPartStart >= 0) rootParts.push(chunk.slice(rootPartStart));
    }
  } catch (error) {
    if (error.code?.startsWith("COMPANY_MASTER_")) throw error;
    throw fault("COMPANY_MASTER_INVALID");
  } finally { input?.destroy?.(); }
  validator.end();
  need(rootEnded && depth === 0 && !quoted && !capturing && companiesSeen && companiesDone, "COMPANY_MASTER_INVALID");
  return { companies, ...(rootParts ? { metadata: JSON.parse(rootParts.join("").replace(/^\uFEFF/, "")) } : {}) };
}

module.exports = { readCompanyMasterProjection };
