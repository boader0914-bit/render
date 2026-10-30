"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { fingerprint, multiset, counts, fingerprints, partialAccounting, verifyCompleteness, referenceEntries, expectedReferences, verifyDeclaredOptionsScope, verifyExtractionWitness, pureSnapshot, parseArgs, falsifiedSource, main } = require("./validate_keyword_monthly_complete_realcopy.cjs");
const NOW = "2026-10-30T00:00:00.000Z", KEYWORD = "가평글램핑", query = { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-22" };
const clone = value => JSON.parse(JSON.stringify(value));
function sourceFixture() {
  const source = { companies: [{ companyId: "a", primaryName: "공개 업체", capacity: 5, capacitySource: "db_correction" }], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], sourceDiagnostics: {}, warnings: [] };
  for (const [id, date, collectedAt, partial] of [["sep", "2026-09-20", "2026-09-20T01:00:00Z", false], ["oct", "2026-10-20", "2026-10-20T01:00:00Z", false], ["partial", "2026-10-21", "2026-10-21T01:00:00Z", true]]) {
    source.runs.push({ id, keyword: KEYWORD, collectedAt, collectionQuality: { status: partial ? "partial" : "complete" } });
    source.observations.push({ observationId: id, companyId: "a", runId: id, keyword: KEYWORD, productType: "lodging", stayDate: date, collectedAt, inventoryEvidenceVersion: 4,
      supply: 5, sold: 2, publicBookings: 2, phoneBookings: 0, publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200,
      explicitBlockedRevenue: 0, explicitBlockedBookings: 0, sharedDayUseExcluded: 0, phoneMissingPriceBookings: 0, partial, missing: false,
      dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } });
  }
  return source;
}
function completenessFixture(source) {
  const map = [{ sourceCompanyId: "legacy-a", canonicalCompanyId: "a" }], read = { sha256: "a".repeat(64), bytes: 123 }, inventory = { complete: true, arrays: {} };
  for (const key of ["observations", "rankObservations", "savedProductRecoveries"]) inventory.arrays[key] = { originalCount: source[key].length, publicCount: source[key].length, excludedRows: 0, multisetSha256: multiset(source[key]) };
  const manifest = { source: read, originalCounts: counts(source), publicCounts: counts(source), fullness: { fieldFilterOnly: true, excludedRows: 0, normalizedAdapterComplete: true, intermediateObservationsComplete: true },
    canonicalMap: { complete: true, scope: "normalized_input_accepted_companies", acceptedCanonicalRows: 1, rows: 1, uniqueSourceIds: 1, multisetSha256: multiset(map), inputCompanyIdsSha256: fingerprint(["a"]), unresolvedAcceptedCount: 0, ambiguousAcceptedCount: 0, rawRejectedIdentityCount: 8 },
    identityAccounting: { sourceExcludedIdentityCount: 8 } };
  return { map, read, inventory, manifest };
}
test("issued financial fingerprints include partial accounting and canonical-company values while excluding context metadata", () => {
  const snapshot = pureSnapshot(sourceFixture(), query, NOW), original = fingerprints(snapshot), changed = clone(snapshot);
  changed.context = { ignored: "not queried" }; changed.companies[0].primaryName = "다른 표시명"; changed.companies[0].regionLabel = "표시 메타";
  assert.deepEqual(fingerprints(changed), original);
  changed.companies[0].summary.lodging.knownPartialRevenue += 1;
  assert.notEqual(fingerprints(changed).companies, original.companies); assert.equal(fingerprints(changed).selectedDigest, original.selectedDigest);
  changed.sources.partialEvidence[0].knownPartialRevenue += 1; assert.notEqual(fingerprints(changed).partialEvidence, original.partialEvidence);
});
test("partial accounting independently counts included evidence and excludes superseded partial money", () => {
  const source = sourceFixture(), snapshot = pureSnapshot(source, query, NOW);
  assert.equal(snapshot.summary.lodging.knownPartialRevenue, 200); assert.equal(partialAccounting(snapshot).passed, true);
  const excluded = clone(snapshot.sources.partialEvidence[0]); excluded.companyId = "other"; excluded.includedInPartialSubtotal = false; excluded.knownPartialRevenue = 999999;
  snapshot.sources.partialEvidence.push(excluded); assert.equal(partialAccounting(snapshot).passed, true);
  snapshot.summary.lodging.knownPartialRevenue = null; assert.equal(partialAccounting(snapshot).passed, false);
});
test("completeness requires original counts, the entire nonconflicting canonical map and multiset inventory", () => {
  const source = sourceFixture(), proof = completenessFixture(source);
  assert.equal(verifyCompleteness(source, proof.read, proof.manifest, proof.map, proof.inventory).passed, true);
  const missing = clone(proof.manifest); missing.originalCounts.observations -= 1;
  assert.equal(verifyCompleteness(source, proof.read, missing, proof.map, proof.inventory).passed, false);
  assert.equal(verifyCompleteness(source, proof.read, proof.manifest, [...proof.map, { sourceCompanyId: "legacy-a", canonicalCompanyId: "wrong" }], proof.inventory).passed, false);
  const wrong = clone(proof.inventory); wrong.arrays.observations.multisetSha256 = "b".repeat(64);
  assert.equal(verifyCompleteness(source, proof.read, proof.manifest, proof.map, wrong).passed, false);
  assert.notEqual(multiset(source.observations), multiset([...source.observations, source.observations[0]]), "Duplicate multiplicity must be preserved");
});
test("a minimal old reference cannot masquerade as complete issued parity", () => {
  const snapshot = pureSnapshot(sourceFixture(), query, NOW), base = { keyword: KEYWORD, request: snapshot.request, reportId: "mr_00000000-0000-4000-8000-000000000000", snapshotHash: "a".repeat(64) };
  assert.throws(() => referenceEntries([{ ...base, summary: snapshot.summary }]), /FULL_ISSUED_FIELDS_REQUIRED/);
  assert.equal(referenceEntries([{ ...base, fingerprints: fingerprints(snapshot) }]).length, 1);
});
test("latest invalid falsification is later than every existing admissible key response and does not change valid money", () => {
  const source = sourceFixture(), original = pureSnapshot(source, query, NOW), before = fingerprints(original);
  source.observations.push({ ...source.observations[1], observationId: "already-invalid", collectedAt: "2026-10-20T02:00:00Z", missing: true });
  for (const kind of ["missing", "failed"]) {
    const injected = falsifiedSource(source, [{ query, snapshot: original }], kind, NOW, "2026-10-22T10:00:00Z");
    assert.equal(injected.additions.length, 1); assert.ok(Date.parse(injected.additions[0].invalidObservedAt) > Date.parse("2026-10-20T02:00:00Z"));
    assert.deepEqual(fingerprints(pureSnapshot(injected.source, query, NOW)), before);
  }
});
test("CLI requires explicit fixed clocks and new absolute-path inputs", () => {
  const path = require("node:path"), p = name => path.resolve(name), base = ["--source", p("source.json"), "--manifest", p("manifest.json"), "--reference", p("issued.json"), "--output", p("new-output"), "--now", NOW, "--data-through", "2026-10-22T10:00:00Z"];
  assert.equal(parseArgs(base).now, NOW); assert.throws(() => parseArgs(base.slice(0, -4)), /REQUIRED_ARGUMENTS/);
  assert.throws(() => parseArgs([...base, "--cutoffs", "2026-02-30"]), /CUTOFFS/); assert.throws(() => parseArgs([...base, "--output", p("again")]), /ARGUMENTS/);
});
test("independently declared issued scopes cannot disappear when a source omits an entire keyword", () => {
  const snapshot = pureSnapshot(sourceFixture(), query, NOW), reference = { keyword: KEYWORD, request: snapshot.request, reportId: "mr_00000000-0000-4000-8000-000000000000", snapshotHash: "a".repeat(64), fingerprints: fingerprints(snapshot) };
  const entries = referenceEntries([reference]); assert.equal(expectedReferences({ expectedIssuedScopes: [query] }, entries).length, 1);
  assert.throws(() => expectedReferences({}, entries), /INDEPENDENT_EXPECTED_SCOPES_REQUIRED/);
  assert.throws(() => expectedReferences({ expectedIssuedScopes: [query, { ...query, keyword: "경남글램핑" }] }, entries), /EXPECTED_ISSUED_SCOPE_MISSING/);
});
test("a reference digest must be bound to an independent extraction and frozen issued export witness", () => {
  const snapshot = pureSnapshot(sourceFixture(), query, NOW), entry = referenceEntries([{ keyword: KEYWORD, request: snapshot.request, reportId: "mr_00000000-0000-4000-8000-000000000000", snapshotHash: "a".repeat(64), fingerprints: fingerprints(snapshot) }])[0];
  assert.equal(verifyExtractionWitness({ basis: "frozen_copy_exact_old_adapter_and_issued_export" }, { sha256: "b".repeat(64) }, { sha256: "c".repeat(64) }, {}, [entry]).passed, false);
  const forged = clone(snapshot); forged.sources.partialEvidence.push({ ...forged.sources.observations[0], includedInPartialSubtotal: true });
  assert.equal(partialAccounting(forged).passed, false, "A normal selected key must not also enter the partial subtotal");
});
test("leftover rank months outside the frozen source scope cannot be advertised as accepted months", () => {
  const manifest = { sourceScope: { keywords: [KEYWORD], stayMonths: ["2026-09", "2026-10"] } };
  assert.equal(verifyDeclaredOptionsScope(manifest, { keywords: [{ keyword: KEYWORD, stayMonths: ["2026-09", "2026-10"] }] }).passed, true);
  assert.equal(verifyDeclaredOptionsScope(manifest, { keywords: [{ keyword: KEYWORD, stayMonths: ["2026-08", "2026-09", "2026-10"] }] }).passed, false);
  assert.equal(verifyDeclaredOptionsScope({}, { keywords: [{ keyword: KEYWORD, stayMonths: ["2026-09", "2026-10"] }] }).passed, false);
});
test("complete acceptance CLI exercises isolated projections and falsification without changing fixture inputs", async t => {
  const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "complete-copy-acceptance-fixture-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("complete-copy-acceptance-fixture-")); await fs.rm(root, { recursive: true, force: true }); });
  const source = sourceFixture(); source.runs.push({ id: "early", keyword: KEYWORD, collectedAt: "2026-10-19T01:00:00Z", collectionQuality: { status: "complete" } });
  source.observations.push({ ...source.observations[1], observationId: "early", runId: "early", collectedAt: "2026-10-19T01:00:00Z", sold: 1, publicBookings: 1, publicRevenue: 100, estimatedRevenue: 100 });
  const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const save = async (name, value) => { const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(path.join(root, name), bytes, { flag: "wx" }); return { file: name, fileSha256: sha(bytes), fileBytes: bytes.length, sha256: sha(bytes), bytes: bytes.length }; };
  const sourceFile = await save("source.json", source), snapshot = pureSnapshot(source, query, NOW), references = [{ keyword: KEYWORD, request: snapshot.request, reportId: "mr_00000000-0000-4000-8000-000000000000", snapshotHash: "a".repeat(64), fingerprints: fingerprints(snapshot) }];
  const referenceFile = await save("reference.json", references), proof = completenessFixture(source);
  const witnessFile = await save("witness.json", { basis: "frozen_copy_exact_old_adapter_and_issued_export", rawFullSourceSha256: "b".repeat(64), sourceManifestSha256: "c".repeat(64), adapterCodeSha256: "d".repeat(64),
    publicSourceSha256: sourceFile.sha256, referenceFileSha256: referenceFile.sha256, originalCounts: counts(source), publicCounts: counts(source), sourcePreserved: true, providerCalls: 0, kosisCopied: 0,
    issuedExports: [{ reportId: references[0].reportId, snapshotHash: references[0].snapshotHash, reportFileSha256: "e".repeat(64), fingerprintsSha256: fingerprint(references[0].fingerprints) }] });
  const manifest = { ...proof.manifest, source: { sha256: sourceFile.sha256, bytes: sourceFile.bytes }, canonicalMap: { ...proof.manifest.canonicalMap, entries: proof.map },
    intermediateManifest: proof.inventory, extractionWitness: witnessFile, expectedIssuedScopes: [query], sourceScope: { keywords: [KEYWORD], stayMonths: ["2026-09", "2026-10"] } };
  await save("manifest.json", manifest);
  const receipt = await main(["--source", path.join(root, "source.json"), "--manifest", path.join(root, "manifest.json"), "--reference", path.join(root, "reference.json"), "--output", path.join(root, "new-output"), "--now", NOW, "--data-through", "2026-10-22T10:00:00Z"]);
  assert.equal(receipt.status, "passed", JSON.stringify(receipt.checks.filter(row => !row.passed).map(row => row.name))); assert.equal(receipt.runtimeWriteAttempts, 0); assert.equal(receipt.network.attempts, 0);
  assert.equal(sha(await fs.readFile(path.join(root, "source.json"))), sourceFile.sha256); assert.equal(receipt.scopes.length, 1);
});
