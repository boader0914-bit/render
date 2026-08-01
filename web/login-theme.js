(() => {
  const storageKey = "lodging-theme";
  const media = matchMedia("(prefers-color-scheme: dark)");
  let stored = "";
  try {
    stored = localStorage.getItem(storageKey) || "";
  } catch {
    stored = "";
  }
  let followsSystem = stored !== "dark" && stored !== "light";
  const preferred = media.matches ? "dark" : "light";
  const root = document.documentElement;

  root.dataset.theme = followsSystem ? preferred : stored;

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("themeToggle");
    const meta = document.getElementById("themeColor");

    const render = () => {
      const dark = root.dataset.theme === "dark";
      const nextLabel = dark ? "라이트 모드" : "다크 모드";
      const currentLabel = dark ? "다크 모드" : "라이트 모드";
      if (button) {
        button.innerHTML = `<span class="theme-toggle-icon" aria-hidden="true">${dark ? "☀" : "◐"}</span><span class="theme-toggle-label">${nextLabel}</span>`;
        button.setAttribute("aria-pressed", String(dark));
        button.setAttribute("aria-label", `${nextLabel}로 전환 · 현재 ${currentLabel}`);
        button.setAttribute("title", `${nextLabel}로 전환`);
      }
      if (meta) meta.setAttribute("content", dark ? "#070b12" : "#f3f6fa");
    };

    if (button) {
      button.addEventListener("click", () => {
        root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
        followsSystem = false;
        try {
          localStorage.setItem(storageKey, root.dataset.theme);
        } catch {
          // The selected theme still applies for this page when storage is unavailable.
        }
        render();
      });
    }
    media.addEventListener?.("change", (event) => {
      if (!followsSystem) return;
      root.dataset.theme = event.matches ? "dark" : "light";
      render();
    });

    document.querySelectorAll("form[data-public-submit]").forEach((form) => {
      form.addEventListener("submit", (event) => {
        if (event.defaultPrevented || !form.checkValidity()) return;
        const submitButton = event.submitter || form.querySelector('button[type="submit"]');
        if (!submitButton || submitButton.disabled) return;
        submitButton.disabled = true;
        submitButton.setAttribute("aria-busy", "true");
        submitButton.textContent = submitButton.dataset.submittingLabel || "처리 중";
      });
    });
    render();
  });
})();
