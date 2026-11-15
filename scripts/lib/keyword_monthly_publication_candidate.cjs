"use strict";
const SHA=/^[a-f0-9]{64}$/,GEN=/^[a-f0-9]{32}$/;
// The scope/index plan is checked independently of the final v2 catalog, whose
// final-result descriptors are known only after offline result preparation.
// Bind the last-safe promotion intent to that exact final catalog, not to a
// guessed schema1 hash. Prior immutable intents remain readable as before.
function preparedPublicationCandidate(candidate,planned){
  const invalid=()=>{throw Object.assign(new Error("KEYWORD_MONTHLY_PREPARED_CANDIDATE_INVALID"),{code:"KEYWORD_MONTHLY_PREPARED_CANDIDATE_INVALID"});};
  if(!candidate||candidate.schemaVersion!==1||candidate.kind!=="keyword_monthly_catalog_candidate"
    ||candidate.catalogSchemaVersion!==2||!GEN.test(candidate.generation||"")||!SHA.test(candidate.catalogSha256||"")
    ||candidate.scopePlanSha256!==planned?.sha256||!SHA.test(candidate.calculationFingerprint||"")
    ||!Number.isSafeInteger(candidate.catalogBytes)||candidate.catalogBytes<1||candidate.catalogBytes>4*1024*1024
    ||candidate.scopeCount!==planned?.value?.scopes?.length||candidate.partitionCount!==planned?.value?.partitions?.length
    ||!Number.isSafeInteger(candidate.preparedResultCount)||candidate.preparedResultCount<candidate.scopeCount
    ||candidate.preparedResultCount>16384)invalid();
  return {expectedCatalogSha256:candidate.catalogSha256,sourceScopePlanSha256:planned.sha256,
    preparedResultCount:candidate.preparedResultCount,preparedCalculationFingerprint:candidate.calculationFingerprint};
}
module.exports={preparedPublicationCandidate};
