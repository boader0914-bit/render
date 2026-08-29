const { createMasterDbIncrementalProcessor } = require("./master_db_incremental.cjs");

const processor = createMasterDbIncrementalProcessor({
  rootDir: process.env.MASTER_DB_ROOT_DIR,
  dataDir: process.env.MASTER_DB_DATA_DIR,
  outputsDir: process.env.MASTER_DB_OUTPUTS_DIR,
  databasePath: process.env.MASTER_DB_PATH
});

let handled = false;

process.on("message", (message = {}) => {
  if (handled) return;
  handled = true;
  try {
    const result = processor.processEvent(message.event || {});
    if (typeof process.send === "function") process.send({ id: message.id, ok: true, result });
    process.exitCode = 0;
  } catch (error) {
    if (typeof process.send === "function") {
      process.send({
        id: message.id,
        ok: false,
        error: {
          code: error?.code || "master_db_incremental_failed",
          message: error?.message || String(error)
        }
      });
    }
    process.exitCode = 1;
  } finally {
    setImmediate(() => process.disconnect?.());
  }
});

setTimeout(() => {
  if (!handled) {
    process.exitCode = 1;
    process.disconnect?.();
  }
}, 30_000).unref();
