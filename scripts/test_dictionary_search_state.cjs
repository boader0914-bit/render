"use strict";

const assert = require("node:assert/strict");
const { fixture, POCHEON, SANCHEONG } = require("./test_region_analysis_navigation.cjs");

(async () => {
  for (const query of ["", "산청"]) {
    const f = fixture({ keyword: null });
    f.api.setAnalysisRegion(SANCHEONG);
    f.els.dictionarySearchInput.value = query;
    await f.api.loadRun("run-pocheon");
    assert.equal(f.els.dictionarySearchInput.value, query, "Collection loading preserves unfinished region search text");
    assert.equal(f.api.selectedAnalysisRegion().regionKey, SANCHEONG, "Explicit region remains the common selection");
    assert.equal(f.state.selectedLocationCard.regionKey, SANCHEONG);
    assert.equal(f.state.activeRunId, "run-pocheon");
    assert.equal(f.state.data.run.keyword, "포천글램핑", "Collection views receive the newly loaded run");
    assert.equal(f.els.runSelect.value, "run-pocheon");
  }
  const automatic = fixture({ keyword: null });
  await automatic.api.loadRun("run-pocheon");
  assert.equal(automatic.api.selectedAnalysisRegion().regionKey, POCHEON, "One exact collection region initializes the selection");
  assert.equal(automatic.state.analysisRegionSelection.explicit, false);
  await automatic.api.loadRun("run-sancheong");
  assert.equal(automatic.api.selectedAnalysisRegion().regionKey, SANCHEONG, "An inferred choice may follow a subsequent collection");
  console.log("Dictionary search state: explicit selection/query preservation and exact collection initialization passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
