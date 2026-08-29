const { createMasterDbIncrementalProcessor } = require("./master_db_incremental.cjs");
const { normalizeWriteMode, renderShadowStorageValidation } = require("./master_db_dual_write.cjs");

function assertWorkerStorageReady() {
  if (normalizeWriteMode(process.env.MASTER_DB_WRITE_MODE) !== "shadow") {
    const error = new Error("Master DB worker는 shadow 쓰기 모드에서만 실행할 수 있습니다.");
    error.code = "master_db_worker_write_mode_disabled";
    throw error;
  }
  const validation = renderShadowStorageValidation({
    dataDir: process.env.MASTER_DB_DATA_DIR,
    databasePath: process.env.MASTER_DB_PATH
  });
  if (!validation.ok) {
    const error = new Error(validation.message || "Shadow Master DB 저장소 검증에 실패했습니다.");
    error.code = validation.code || "master_db_worker_storage_unavailable";
    throw error;
  }
}

let processor = null;

function getProcessor() {
  if (processor) return processor;
  assertWorkerStorageReady();
  processor = createMasterDbIncrementalProcessor({
    rootDir: process.env.MASTER_DB_ROOT_DIR,
    dataDir: process.env.MASTER_DB_DATA_DIR,
    outputsDir: process.env.MASTER_DB_OUTPUTS_DIR,
    databasePath: process.env.MASTER_DB_PATH
  });
  return processor;
}

let handled = false;

process.on("message", (message = {}) => {
  if (handled) return;
  handled = true;
  try {
    const result = getProcessor().processEvent(message.event || {});
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

module.exports = { assertWorkerStorageReady, getProcessor };
