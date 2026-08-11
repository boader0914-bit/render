const { createCanaryTransport } = require("../v4_canary_transport.cjs");

function exercisePinnedLookup(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, records) => {
      if (error) reject(error);
      else resolve(records);
    });
  });
}

function createOfflineCanaryTransport(env = process.env) {
  return createCanaryTransport({
    env,
    lookupFn: async () => [{ address: "8.8.8.8", family: 4 }],
    requestImpl: async ({ target, lookup }) => {
      await exercisePinnedLookup(lookup, target.hostname);
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          lastBuildDate: "Tue, 11 Aug 2026 00:00:00 +0900",
          total: 1,
          start: 1,
          display: 1,
          items: [{ title: "Offline canary fixture" }]
        }), "utf8")
      };
    }
  });
}

module.exports = { createOfflineCanaryTransport };
