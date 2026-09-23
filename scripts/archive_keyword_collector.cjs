"use strict";

// Explicit 0923 entry; the archive 4e4e190 lineage runs through the maintained
// common engine so quantity, evidence and provider-block fixes remain shared.
if (process.env.COLLECTOR_WORKER_KEY !== "scheduled"
  || !["manual", "scheduled"].includes(process.env.COLLECTOR_TRIGGER)) {
  throw new Error("COLLECTOR_ROLE_MISMATCH");
}
process.env.COLLECTOR_ENGINE = "archive-keyword-adapted-v2";
process.env.SCHEDULED_COLLECTION = process.env.COLLECTOR_TRIGGER === "scheduled" ? "1" : "0";
require("./gyeongnam_glamping_crawl.cjs");
