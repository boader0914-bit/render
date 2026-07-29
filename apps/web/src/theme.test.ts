import { describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, nextTheme, normalizeTheme } from "./theme";

describe("Stage 225 theme contract", () => {
  it("defaults the first visit and invalid values to light", () => {
    expect(normalizeTheme(undefined)).toBe("light");
    expect(normalizeTheme("system")).toBe("light");
  });

  it("persists only the V2 theme key and toggles both ways", () => {
    expect(THEME_STORAGE_KEY).toBe("lodging-v2-theme");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });
});
