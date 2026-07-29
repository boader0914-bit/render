(() => {
  let saved = "";
  try {
    saved = localStorage.getItem("lodging-v2-theme") || "";
  } catch {
    saved = "";
  }
  document.documentElement.dataset.theme = saved === "dark" ? "dark" : "light";
})();
