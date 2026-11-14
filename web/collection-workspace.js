(function () {
  "use strict";
  // Navigation changes only focus, scroll and existing disclosures.
  // Forms and application selection stay mounted in their current state.
  const root = document.getElementById("collectorControlsCard");
  const nav = document.getElementById("collectionWorkspaceNav");
  if (!root || !nav) return;
  nav.addEventListener("click", event => {
    const button = event.target.closest("[data-collection-workspace-target]");
    if (!button || !nav.contains(button)) return;
    const target = document.getElementById(button.dataset.collectionWorkspaceTarget);
    if (!target || !root.contains(target)) return;
    if (target.id === "collectorHistoryTitle") {
      const toggle = document.getElementById("collectorHistoryToggle");
      if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
    }
    if (target.id === "collectorRegularHeading") {
      const panel = document.getElementById("collectionRotationPanel");
      if (panel && root.contains(panel)) panel.open = true;
    }
    if (target.id === "collectorExecutionHeading") {
      for (const card of root.querySelectorAll(".collector-worker-card")) {
        if (!card.hidden) card.open = true;
      }
    }
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });
})();
