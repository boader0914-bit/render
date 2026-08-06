"use strict";

const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "preloaded child fixture" });

process.on("beforeExit", () => {
  if (guard.blockedAttempts() > 0) process.exitCode = 97;
});
