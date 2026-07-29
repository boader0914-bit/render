"use strict";

function createAuthEmailProvider(env = process.env) {
  const mode = String(env.V2_AUTH_EMAIL_PROVIDER || "mock").trim().toLowerCase();
  if (mode !== "mock") {
    if (!/^(1|true|yes|on)$/i.test(String(env.V2_AUTH_REAL_EMAIL_APPROVED || ""))) {
      throw new Error("Real auth email requires explicit V2_AUTH_REAL_EMAIL_APPROVED approval");
    }
    throw new Error("No real auth email provider is configured; mock is the only Stage 226 provider");
  }
  return Object.freeze({
    mode,
    record(store, message, now) {
      const row = {
        messageId: message.messageId,
        type: message.type,
        recipient: message.recipient,
        relatedId: message.relatedId || "",
        status: "mock_delivered",
        attempts: 1,
        createdAt: now,
        deliveredAt: now
      };
      store.emailOutbox.push(row);
      if (store.emailOutbox.length > 1000) {
        store.emailOutbox.splice(0, store.emailOutbox.length - 1000);
      }
      return row;
    }
  });
}

module.exports = { createAuthEmailProvider };
