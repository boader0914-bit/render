const CACHE_PREFIXES = ["lodging-datalab-pwa-", "glamping-datalab-v2-ui-v3-"];

export function registerPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, { once: true });
}

export async function purgeV2UiCaches(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: "PURGE_V2_UI_CACHES" });
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))).map((key) => caches.delete(key)));
}
