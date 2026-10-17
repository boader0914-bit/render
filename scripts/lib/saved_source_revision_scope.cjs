"use strict";

const path = require("node:path");

// The monthly full inventory covers the industry's master, observation,
// reference, run/detail and special-day inputs. A capability is only shared
// for exactly the same roots and references, using the native filesystem.
// Different/custom readers must continue doing their own fresh inspection.
function savedIndustryRevisionScope({ dataDir, outputsDir, regionMasterFile, tourismRegionMapFile } = {}) {
  if (!dataDir || !outputsDir) return null;
  return JSON.stringify(["monthly-full-covers-industry-v1", ...[dataDir, outputsDir, regionMasterFile, tourismRegionMapFile]
    .map(value => value ? path.resolve(value) : null)]);
}

module.exports = { savedIndustryRevisionScope };
