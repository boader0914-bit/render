import type { ThemeMode } from "@glamping-datalab-v2/ui";

export const THEME_STORAGE_KEY = "lodging-v2-theme";

export function normalizeTheme(value: unknown): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function nextTheme(theme: ThemeMode): ThemeMode {
  return theme === "light" ? "dark" : "light";
}

export function currentTheme(): ThemeMode {
  return normalizeTheme(document.documentElement.dataset.theme);
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* A blocked store must not prevent theme application. */ }
}
