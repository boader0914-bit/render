const { flagEnabled } = require("./integration_feature_flags.cjs");

const UI_V3_FEATURE_FLAG = Object.freeze({
  envKey: "V2_UI_V3_ENABLED",
  owner: "Frontend Engineer",
  approver: "Product Owner",
  dependsOn: Object.freeze(["Stage 224 blocker=0", "apps/web production build"]),
  defaultValue: false,
  targetRoles: Object.freeze(["admin", "b2b"]),
  rolloutOrder: Object.freeze(["local QA", "internal admin", "internal business", "limited pilot"]),
  observe: Object.freeze(["legacy response parity", "UI error rate", "session failure rate", "asset load p95"]),
  rollback: "Set V2_UI_V3_ENABLED=false and purge glamping-datalab-v2-ui-v3-* caches."
});

function readUiV3FeatureFlag(env = process.env) {
  return flagEnabled(env[UI_V3_FEATURE_FLAG.envKey]);
}

module.exports = { UI_V3_FEATURE_FLAG, readUiV3FeatureFlag };
