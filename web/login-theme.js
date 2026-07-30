(() => {
  const storageKey = "lodging-theme";
  const stored = localStorage.getItem(storageKey);
  const preferred = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const root = document.documentElement;

  root.dataset.theme = stored === "dark" || stored === "light" ? stored : preferred;

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("themeToggle");
    const meta = document.getElementById("themeColor");
    if (!button || !meta) return;

    const render = () => {
      const dark = root.dataset.theme === "dark";
      button.textContent = dark ? "☀ 라이트 모드" : "◐ 다크 모드";
      button.setAttribute("aria-pressed", String(dark));
      meta.setAttribute("content", dark ? "#070b12" : "#f3f6fa");
    };

    button.addEventListener("click", () => {
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
      localStorage.setItem(storageKey, root.dataset.theme);
      render();
    });
    render();
  });
})();
