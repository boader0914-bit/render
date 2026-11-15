"use strict";
// The child still runs the normal calculator. In parent mode the calculator is
// deliberately unavailable: publishing/readback must only handle stored bytes.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const analysis=require("./lib/keyword_monthly_analysis.cjs"),originalFactory=analysis.createKeywordMonthlyAnalysis;
let parentMode=false,analyses=0;
analysis.createKeywordMonthlyAnalysis=options=>{const service=originalFactory(options);return{...service,analyze:async query=>{analyses++;if(parentMode)throw Object.assign(new Error("parent financial graph forbidden"),{code:"PARENT_FINANCIAL_GRAPH_FORBIDDEN"});return service.analyze(query);}};};
delete require.cache[require.resolve("./lib/keyword_monthly_bundle.cjs")];
const B=require("./lib/keyword_monthly_bundle.cjs"),NOW="2026-11-15T00:00:00.000Z",keyword="synthetic-prevalidation",hash=b=>crypto.createHash("sha256").update(b).digest("hex");
async function fixture(t,options={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),"keyword-prevalidation-"));t.after(async()=>{parentMode=false;assert.equal(path.dirname(root),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const source={companies:[{companyId:"cmp_1",primaryName:"Synthetic public company",capacity:5}],runs:[],observations:[],rankObservations:[],savedProductRecoveries:[],warnings:[],sourceDiagnostics:{}};
  for(const month of ["2026-10","2026-11"]){const runId="run_"+month,collectedAt=month+"-14T00:00:00.000Z";source.runs.push({id:runId,keyword,collectedAt,collectionQuality:{status:"complete"}});source.observations.push({companyId:"cmp_1",runId,keyword,productType:"lodging",stayDate:month+"-20",collectedAt,inventoryEvidenceVersion:4,supply:5,sold:2,publicBookings:2,phoneBookings:0,publicRevenue:200,phoneRevenue:0,estimatedRevenue:200});}
  const now=options.now||NOW,directory=path.join(root,"partition"),outputDir=path.join(root,"bundle");await analysis.buildKeywordMonthlyProjection({source,sourceFingerprint:hash(JSON.stringify(source)),outputDir:directory,materializedAt:NOW,dataThrough:options.dataThrough||NOW,sourceProvenance:options.sourceProvenance,now:()=>now,compression:"gzip"});
  const inputs=[{directory,exposeScopes:[{keyword,month:"2026-10"},{keyword,month:"2026-11"}]}],maxTotalBytes=128*1024*1024,preparation=await B.prepareKeywordMonthlyBundle({inputs,now,maxTotalBytes,
    ...(options.prepareResults?{prepareResults:true,preparedOutputDir:path.join(root,"prepared-results")}:{} )});
  return{root,directory,outputDir,inputs,preparation,maxTotalBytes,publish:extra=>B.publishPrevalidatedKeywordMonthlyBundle({inputs,outputDir,now,maxTotalBytes,preparation,...extra})};}
test("attested metadata publish and exact byte readback create no parent financial graphs",async t=>{const f=await fixture(t),before=analyses;assert.ok(f.preparation.parts[0].validation.length===2);parentMode=true;
  const receipt=await f.publish(),loaded=await B.loadBundle(f.outputDir),verified=await B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes});
  assert.equal(analyses,before);assert.equal(receipt.publicationProjectionAnalyses,0);assert.equal(verified.readbackProjectionAnalyses,0);assert.equal(Object.hasOwn(receipt,"parentProjectionAnalyses"),false);assert.equal(verified.scopeCount,2);assert.equal(verified.verificationBasis,"attested_semantic_validation_and_exact_published_bytes");
  parentMode=false;for(const validated of f.preparation.parts[0].validation){const actual=await B.createKeywordMonthlyBundleAnalysis({projectionDir:f.outputDir,now:()=>NOW}).analyze(validated.query);assert.equal(actual.snapshot.sources.digest,validated.selectedDigest);assert.equal(actual.provenance.inputSha256,validated.inputSha256);assert.equal(actual.snapshot.summary.lodging.sold,2);}
});
test("the generic publisher still requires semantic validation",async t=>{const f=await fixture(t),before=analyses;parentMode=true;await assert.rejects(B.publishKeywordMonthlyBundle({inputs:f.inputs,outputDir:f.outputDir,now:NOW,maxTotalBytes:f.maxTotalBytes}),{code:"PARENT_FINANCIAL_GRAPH_FORBIDDEN"});assert.equal(analyses,before+1);await assert.rejects(fs.access(f.outputDir));});
for(const mutation of ["missing","clock","fingerprint","scope","cutoff","rowCount","fileDigest","indexPath","extraField"]){test(`prevalidation ${mutation} cannot create a live pointer`,async t=>{const f=await fixture(t),p=JSON.parse(JSON.stringify(f.preparation));
  if(mutation==="clock")p.fixedValidationClock="2026-11-14T00:00:00.000Z";if(mutation==="fingerprint")p.inputsFingerprint="0".repeat(64);if(mutation==="scope")p.parts[0].exposed[0].keyword="wrong";if(mutation==="cutoff")p.parts[0].validation[0].query.cutoffDate="2026-10-13";if(mutation==="rowCount")p.parts[0].validation.pop();if(mutation==="fileDigest")p.parts[0].files[0].sha256="0".repeat(64);if(mutation==="indexPath")p.parts[0].index.file=path.join(f.root,"other.json");if(mutation==="extraField")p.parts[0].trusted=true;
  parentMode=true;await assert.rejects(f.publish({preparation:mutation==="missing"?undefined:p}),/PREVALIDATION_INVALID/);await assert.rejects(fs.access(path.join(f.outputDir,"current.json")));});}
test("changed stored projection is caught by bytes before parent publication",async t=>{const f=await fixture(t),file=path.join(f.directory,"projections",f.preparation.parts[0].files[0].name);await fs.appendFile(file," ");parentMode=true;await assert.rejects(f.publish(),/INPUT_PROJECTION_MISMATCH/);await assert.rejects(fs.access(f.outputDir));});
test("hardlinked input remains unsafe in metadata-only parent mode",async t=>{const f=await fixture(t),file=path.join(f.directory,"projections",f.preparation.parts[0].files[0].name);await fs.link(file,path.join(f.root,"hardlink"));parentMode=true;await assert.rejects(f.publish(),/UNSAFE_PATH/);await assert.rejects(fs.access(f.outputDir));});
test("readback checks every exact published file and cannot substitute a descriptor",async t=>{const f=await fixture(t);parentMode=true;await f.publish();const loaded=await B.loadBundle(f.outputDir),query={projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes};
  const corrupt=JSON.parse(JSON.stringify(f.preparation));corrupt.parts[0].validation[0].selectedDigest="0".repeat(64);await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle({...query,preparation:corrupt}),/READBACK_FAILED/);
  const file=path.join(loaded.generationDir,"partitions",loaded.catalog.partitions[0].key,"projections",f.preparation.parts[0].files[0].name);await fs.appendFile(file," ");await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle(query),/INPUT_PROJECTION_MISMATCH/);
});
test("published cardinality and wanted-scope identity must match the child exactly",async t=>{const f=await fixture(t);parentMode=true;await f.publish();const loaded=await B.loadBundle(f.outputDir),q={projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation};
  await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle({...q,wantedScopes:[{keyword,month:"2026-12"}]}),/READBACK_FAILED/);await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle({...q,wantedScopes:[f.inputs[0].exposeScopes[0],f.inputs[0].exposeScopes[0]]}),/READBACK_FAILED/);
  const file=path.join(loaded.generationDir,"publication-receipt.json"),receipt=JSON.parse(await fs.readFile(file));receipt.scopeCount++;await fs.writeFile(file,JSON.stringify(receipt));await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle({...q,wantedScopes:f.inputs[0].exposeScopes}),/READBACK_FAILED/);
});
test("unannounced output files are not accepted as the exact published manifest",async t=>{const f=await fixture(t);parentMode=true;await f.publish();const loaded=await B.loadBundle(f.outputDir),directory=path.join(loaded.generationDir,"partitions",loaded.catalog.partitions[0].key,"projections");await fs.writeFile(path.join(directory,"unannounced.json"),"{}");await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes}),/READBACK_FAILED/);});
test("repeated index subsets retain one physical partition with both exact validations",async t=>{const f=await fixture(t),inputs=f.inputs[0].exposeScopes.map(scope=>({directory:f.directory,exposeScopes:[scope]})),preparation=await B.prepareKeywordMonthlyBundle({inputs,now:NOW,maxTotalBytes:f.maxTotalBytes});parentMode=true;const receipt=await f.publish({inputs,preparation}),loaded=await B.loadBundle(f.outputDir);assert.equal(receipt.partitionCount,1);assert.equal(receipt.scopeCount,2);const verified=await B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation,wantedScopes:f.inputs[0].exposeScopes});assert.equal(verified.scopes.length,2);});
test("fresh options retain an attested stale analysis when cutoff exceeds data through",async t=>{const f=await fixture(t,{dataThrough:"2026-11-14T00:00:00.000Z",sourceProvenance:{normalizationCutoffs:{"2026-10":"2026-10-31","2026-11":"2026-11-15"}}});assert.equal((await originalFactory({projectionDir:f.directory,now:()=>NOW}).options()).status,"available");assert.equal(f.preparation.parts[0].validation[1].status,"stale");parentMode=true;await f.publish();const loaded=await B.loadBundle(f.outputDir),v=await B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes});assert.equal(v.scopes[1].status,"stale");});
test("equivalent ISO offset clocks preserve canonical publication and readback identity",async t=>{const f=await fixture(t,{now:"2026-11-15T09:00:00+09:00"});assert.equal(f.preparation.fixedValidationClock,NOW);parentMode=true;await f.publish();const loaded=await B.loadBundle(f.outputDir);assert.equal(loaded.catalog.createdAt,NOW);await B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes});});
test("scope object key order cannot change the canonical public query result identity",async t=>{const f=await fixture(t),inputs=[{directory:f.directory,exposeScopes:[{month:"2026-11",keyword}]}],preparation=await B.prepareKeywordMonthlyBundle({inputs,now:NOW,maxTotalBytes:f.maxTotalBytes});parentMode=true;await f.publish({inputs,preparation});const loaded=await B.loadBundle(f.outputDir),verified=await B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation,wantedScopes:[{month:"2026-11",keyword}]});parentMode=false;const actual=await B.createKeywordMonthlyBundleAnalysis({projectionDir:f.outputDir,now:()=>NOW}).analyze({month:"2026-11",keyword,cutoffDate:verified.scopes[0].cutoffDate});assert.equal(verified.scopes[0].resultId,actual.resultId);});
test("phase diagnostics retain child semantic checkpoints without parent financial phases or private labels",async t=>{const f=await fixture(t),diagnostics=require("./lib/analytical_phase_runtime.cjs").getAnalyticalPhaseDiagnostics(),originalInfo=console.info;
  console.info=()=>{};
  try {
    const preparation=await diagnostics.run("fixture_child_semantic_validation",()=>B.prepareKeywordMonthlyBundle({inputs:f.inputs,now:NOW,maxTotalBytes:f.maxTotalBytes}));
    parentMode=true;const countBeforeParent=analyses;
    await diagnostics.run("fixture_parent_publication",()=>f.publish({preparation}));
    const loaded=await B.loadBundle(f.outputDir);
    await diagnostics.run("fixture_parent_readback",()=>B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation,wantedScopes:f.inputs[0].exposeScopes}));
    assert.equal(analyses,countBeforeParent);
    const records=diagnostics.status().records.filter(r=>["fixture_child_semantic_validation","fixture_parent_publication","fixture_parent_readback"].includes(r.kind));
    assert.equal(records.length,3);assert.ok(records.every(r=>r.status==="completed"));
    const child=records.find(r=>r.kind==="fixture_child_semantic_validation");assert.ok(child.phases.some(p=>p.phase==="keyword_projection_read"));assert.ok(child.phases.some(p=>p.phase==="keyword_snapshot_current"));
    for(const record of records.filter(r=>r.kind!=="fixture_child_semantic_validation")){assert.ok(record.phases.some(p=>p.phase==="keyword_index_read"));assert.ok(!record.phases.some(p=>["keyword_projection_read","keyword_source_validate","keyword_snapshot_current","keyword_snapshot_previous","keyword_compare"].includes(p.phase)));}
    const serialized=JSON.stringify(records);for(const privateLabel of [keyword,"Synthetic public company",f.root])assert.ok(!serialized.includes(privateLabel));
  } finally {console.info=originalInfo;parentMode=false;}
});
test("v2 child prepares each final response once and parent publishes, reads and verifies without financial graphs",async t=>{
  const beforeChild=analyses,f=await fixture(t,{prepareResults:true});assert.equal(analyses-beforeChild,2);assert.equal(f.preparation.schemaVersion,2);
  assert.equal(f.preparation.preparedResults.descriptors.length,2);const expected=[];
  for(const row of f.preparation.parts[0].validation)expected.push(await originalFactory({projectionDir:f.directory,now:()=>NOW}).analyze(row.query));
  const beforeParent=analyses;parentMode=true;let candidate;
  const receipt=await f.publish({beforePromote:value=>{candidate=value;}}),loaded=await B.loadBundle(f.outputDir);
  assert.equal(loaded.catalog.schemaVersion,2);assert.equal(candidate.catalogSchemaVersion,2);assert.equal(candidate.preparedResultCount,2);
  assert.equal(receipt.publicationProjectionAnalyses,0);assert.equal(receipt.preparedResultCount,2);
  const verify=()=>B.verifyPrevalidatedKeywordMonthlyBundle({projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes});
  const proof=await verify();assert.equal(proof.readbackProjectionAnalyses,0);
  const semantic=r=>({status:r.status,request:r.request,snapshot:r.snapshot,activity:r.activity,latestAttempt:r.latestAttempt,lastSuccessfulAttempt:r.lastSuccessfulAttempt,diagnostics:r.diagnostics});
  for(let index=0;index<expected.length;index++){
    const actual=await B.createKeywordMonthlyBundleAnalysis({projectionDir:f.outputDir,now:()=>NOW}).readPrepared(expected[index].request);
    assert.equal(actual.preparedResult.status,"ready");assert.deepEqual(semantic(actual),semantic(expected[index]));
  }
  await fs.rename(f.preparation.preparedResults.directory,path.join(f.root,"retained-child-evidence"));
  await verify();assert.equal(analyses,beforeParent,"restart readback must use published files after disposable child cleanup");
});
for(const mutation of ["missingFile","changedFile","hardlink","extraFile","fingerprint","sourceProjection","sourcePartition","duplicateQuery","missingQuery","extraDescriptorField"]){
  test(`v2 ${mutation} cannot promote a child result or allocate a parent graph`,async t=>{
    const f=await fixture(t,{prepareResults:true}),p=JSON.parse(JSON.stringify(f.preparation)),saved=p.preparedResults,descriptor=saved.descriptors[0];
    const file=path.join(saved.directory,descriptor.sha256+".json"+(descriptor.encoding==="gzip"?".gz":""));
    if(mutation==="missingFile")await fs.rename(file,path.join(f.root,"withheld-result"));
    if(mutation==="changedFile")await fs.appendFile(file," ");
    if(mutation==="hardlink")await fs.link(file,path.join(f.root,"result-hardlink"));
    if(mutation==="extraFile")await fs.writeFile(path.join(saved.directory,"unknown.json"),"{}");
    if(mutation==="fingerprint")saved.calculationFingerprint="0".repeat(64);
    if(mutation==="sourceProjection")descriptor.sourceProjectionSha256="0".repeat(64);
    if(mutation==="sourcePartition")descriptor.partition="0".repeat(64);
    if(mutation==="duplicateQuery")saved.descriptors.push({...descriptor});
    if(mutation==="missingQuery")saved.descriptors.pop();
    if(mutation==="extraDescriptorField")descriptor.trusted=true;
    const before=analyses;parentMode=true;await assert.rejects(f.publish({preparation:p}));assert.equal(analyses,before);
    await assert.rejects(fs.access(path.join(f.outputDir,"current.json")));
  });
}
test("v2 copied artifact tampering at the final barrier preserves the last good pointer",async t=>{
  const f=await fixture(t),prior=await f.publish(),beforePointer=await fs.readFile(path.join(f.outputDir,"current.json"));
  const preparation=await B.prepareKeywordMonthlyBundle({inputs:f.inputs,now:NOW,maxTotalBytes:f.maxTotalBytes,prepareResults:true,preparedOutputDir:path.join(f.root,"new-results")});
  const before=analyses;parentMode=true;
  await assert.rejects(f.publish({preparation,expectedCurrentSha256:prior.pointerSha256,beforePromote:async candidate=>{
    const descriptor=preparation.preparedResults.descriptors[0];await fs.appendFile(path.join(f.outputDir,"generations",candidate.generation,"results",descriptor.sha256+".json"+(descriptor.encoding==="gzip"?".gz":""))," ");
  }}),/RESULT_CHANGED_BEFORE_PROMOTION/);assert.equal(analyses,before);assert.deepEqual(await fs.readFile(path.join(f.outputDir,"current.json")),beforePointer);
});
test("v2 exact readback rejects an unknown final result and a rehashed substituted descriptor",async t=>{
  const f=await fixture(t,{prepareResults:true});parentMode=true;await f.publish();const loaded=await B.loadBundle(f.outputDir),query={projectionDir:f.outputDir,expectedCatalogSha256:loaded.catalogRead.sha256,preparation:f.preparation,wantedScopes:f.inputs[0].exposeScopes};
  const corrupt=JSON.parse(JSON.stringify(f.preparation));corrupt.preparedResults.descriptors[0].sourceDigest="0".repeat(64);
  await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle({...query,preparation:corrupt}),/READBACK_FAILED/);
  await fs.writeFile(path.join(loaded.generationDir,"results","unknown.json"),"{}");await assert.rejects(B.verifyPrevalidatedKeywordMonthlyBundle(query),/READBACK_FAILED/);
});
test("v2 preparation respects its byte budget and never overwrites an existing result directory",async t=>{
  const f=await fixture(t),directory=path.join(f.root,"small-results");
  await assert.rejects(B.prepareKeywordMonthlyBundle({inputs:f.inputs,now:NOW,maxTotalBytes:1,prepareResults:true,preparedOutputDir:directory}),/TOTAL_BOUND/);
  assert.deepEqual(await fs.readdir(directory),[]);
  const marker=path.join(directory,"kept.txt");await fs.writeFile(marker,"existing evidence");
  await assert.rejects(B.prepareKeywordMonthlyBundle({inputs:f.inputs,now:NOW,maxTotalBytes:f.maxTotalBytes,prepareResults:true,preparedOutputDir:directory}),{code:"EEXIST"});
  assert.equal(await fs.readFile(marker,"utf8"),"existing evidence");await assert.rejects(fs.access(f.outputDir));
});
