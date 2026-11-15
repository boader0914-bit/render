"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {preparedPublicationCandidate}=require("./lib/keyword_monthly_publication_candidate.cjs");
const planned={sha256:"a".repeat(64),value:{scopes:[{},{}],partitions:[{}]}};
const candidate=()=>({schemaVersion:1,kind:"keyword_monthly_catalog_candidate",catalogSchemaVersion:2,generation:"b".repeat(32),catalogSha256:"c".repeat(64),scopePlanSha256:planned.sha256,calculationFingerprint:"d".repeat(64),catalogBytes:1234,scopeCount:2,partitionCount:1,preparedResultCount:2});
test("bind prepared promotion to its exact final catalog while retaining the independently checked scope plan",()=>{
  const result=preparedPublicationCandidate(candidate(),planned);assert.equal(result.expectedCatalogSha256,"c".repeat(64));assert.equal(result.sourceScopePlanSha256,planned.sha256);assert.equal(result.preparedResultCount,2);
});
test("wrong scope plan count schema fingerprint and missing candidate never create a promotion binding",()=>{
  for(const change of [{scopePlanSha256:"e".repeat(64)},{catalogSchemaVersion:1},{scopeCount:1},{partitionCount:2},{preparedResultCount:1},{calculationFingerprint:"invalid"},{catalogBytes:0},{generation:"../unsafe"}]){
    assert.throws(()=>preparedPublicationCandidate({...candidate(),...change},planned),e=>e.code==="KEYWORD_MONTHLY_PREPARED_CANDIDATE_INVALID");
  }
  assert.throws(()=>preparedPublicationCandidate(undefined,planned),e=>e.code==="KEYWORD_MONTHLY_PREPARED_CANDIDATE_INVALID");
});
