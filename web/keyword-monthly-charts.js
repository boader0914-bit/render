(function (root) {
  "use strict";

  // The official, unmodified Data chart component and its only import are served
  // from this application's origin. Chart reads never fetch collection data.
  const VERSION = "1.2.1";
  const BUILD_ID = "57515287d6adb6161c9f714f7d7d22497632ea800a917da78d081e531b34b352";
  const MODULE_PATH = "/vendor/data-charts-1.2.1/data-analytics-plugin/1.2.1/charts/element.js";
  const pending = new WeakMap();
  const waiting = new Set();
  let loadedModule = null;
  let removalObserver = null;

  function failure(code, message, aborted = false) {
    const error = new Error(message);
    error.code = code;
    if (aborted) error.name = "AbortError";
    return error;
  }

  function validate(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)
      || typeof config.id !== "string" || !config.id || config.id.length > 200
      || typeof config.title !== "string" || !config.title || config.title.length > 1000
      || !config.spec || typeof config.spec !== "object" || Array.isArray(config.spec)
      || !Array.isArray(config.rows) || config.rows.length > 2000
      || config.height != null && (!Number.isFinite(config.height) || config.height < 120 || config.height > 800)) {
      throw failure("KEYWORD_MONTHLY_CHART_CONFIG_INVALID", "월별 차트의 설정과 표시 범위를 확인해야 합니다.");
    }
    let serialized;
    try { serialized = JSON.stringify(config); }
    catch { throw failure("KEYWORD_MONTHLY_CHART_CONFIG_INVALID", "월별 차트 설정을 읽을 수 없습니다."); }
    if (new TextEncoder().encode(serialized).byteLength > 2 * 1024 * 1024) {
      throw failure("KEYWORD_MONTHLY_CHART_CONFIG_TOO_LARGE", "월별 차트의 표시 자료가 허용 범위를 넘었습니다.");
    }
  }

  function load() {
    if (!loadedModule) {
      let timer;
      loadedModule = Promise.race([
        import(MODULE_PATH),
        new Promise((_, reject) => {
          timer = root.setTimeout(() => reject(failure("KEYWORD_MONTHLY_CHART_LOAD_TIMEOUT", "월별 차트 모듈을 불러오는 시간이 초과됐습니다.")), 30000);
        })
      ]).then(component => {
        if (typeof component.mountChart !== "function") throw failure("KEYWORD_MONTHLY_CHART_MODULE_INVALID", "월별 차트 모듈의 버전을 확인해야 합니다.");
        return component;
      }).catch(() => {
        loadedModule = null;
        throw failure("KEYWORD_MONTHLY_CHART_LOAD_FAILED", "월별 차트 모듈을 불러오지 못했습니다. 저장 자료 표는 계속 확인할 수 있습니다.");
      }).finally(() => root.clearTimeout(timer));
    }
    return loadedModule;
  }

  function observeRemoval(doc) {
    if (removalObserver || typeof root.MutationObserver !== "function" || !doc.documentElement) return;
    removalObserver = new root.MutationObserver(() => {
      for (const item of waiting) {
        if (!item.container.isConnected || item.chart && !item.chart.isConnected) {
          item.abort("KEYWORD_MONTHLY_CHART_DISCONNECTED");
        }
      }
    });
    removalObserver.observe(doc.documentElement, { childList: true, subtree: true });
  }

  function mount(container, config) {
    return new Promise((resolve, reject) => {
      if (typeof root.HTMLElement !== "function" || !(container instanceof root.HTMLElement)) {
        reject(failure("KEYWORD_MONTHLY_CHART_CONTAINER_INVALID", "월별 차트를 표시할 영역을 확인해야 합니다."));
        return;
      }
      try { validate(config); }
      catch (error) { reject(error); return; }
      container.setAttribute("data-data-chart", "");
      pending.get(container)?.abort("KEYWORD_MONTHLY_CHART_SUPERSEDED");
      const item = { container, chart: null, abort: null };
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        item.chart?.removeEventListener("data-chart-ready", ready);
        item.chart?.removeEventListener("data-chart-error", failed);
        waiting.delete(item);
        if (pending.get(container) === item) pending.delete(container);
        if (!waiting.size) { removalObserver?.disconnect(); removalObserver = null; }
        if (error) reject(error);
        else resolve(item.chart);
      }
      function ready(event) { if (event.target === item.chart) finish(); }
      function failed(event) {
        if (event.target === item.chart) finish(failure("KEYWORD_MONTHLY_CHART_RENDER_FAILED", "월별 차트의 자료 또는 렌더링을 확인해야 합니다. 미확인 값을 0으로 표시하지 않습니다."));
      }
      item.abort = code => {
        finish(failure(code, "월별 차트의 이전 표시 요청이 종료됐습니다.", true));
        // The official disconnectedCallback disposes its own renderer/resources.
        if (item.chart?.parentNode === container) item.chart.remove();
      };
      pending.set(container, item);
      waiting.add(item);
      observeRemoval(container.ownerDocument);
      load().then(component => {
        if (settled) return;
        if (!container.isConnected) { item.abort("KEYWORD_MONTHLY_CHART_DISCONNECTED"); return; }
        try {
          item.chart = component.mountChart(container, config);
          item.chart.setAttribute("data-keyword-monthly-chart", VERSION);
          item.chart.addEventListener("data-chart-ready", ready);
          item.chart.addEventListener("data-chart-error", failed);
          // Resolve only on the official component's actual ready event. Its
          // render timeout pauses while hidden; removal cancels this waiter.
        } catch {
          finish(failure("KEYWORD_MONTHLY_CHART_RENDER_FAILED", "월별 차트를 표시하지 못했습니다. 저장 자료 표는 계속 확인할 수 있습니다."));
        }
      }, finish);
    });
  }

  const api = Object.freeze({ mount, version: VERSION, buildId: BUILD_ID, modulePath: MODULE_PATH, tagName: `viz-chart-${BUILD_ID}` });
  root.KeywordMonthlyCharts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
