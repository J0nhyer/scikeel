export const APPEARANCE_CHOICES = ["light", "dark", "system", "cdut"] as const;
export type AppearanceChoice = (typeof APPEARANCE_CHOICES)[number];
export type Theme = AppearanceChoice | "warm";
export type ResolvedTheme = Exclude<Theme, "system">;

export function normalizeAppearance(value: string | null): Theme | null {
  return value === "light" || value === "dark" || value === "system" ||
    value === "cdut" || value === "warm" ? value : null;
}
export function resolveAppearance(theme: Theme, systemDark: boolean): ResolvedTheme {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}
export function readAppearance(read: (key: string) => string | null): Theme {
  try {
    const current = normalizeAppearance(read("ai4s.theme.v2"));
    if (current) return current;
    const legacy = read("ai4s.theme");
    if (legacy === "light") return "warm";
    if (legacy === "dark") return "dark";
  } catch { /* An unavailable browser preference must not prevent rendering. */ }
  return "system";
}
export function readUiPreference(key: string): string | null {
  try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); }
  catch { return null; }
}
export function writeUiPreference(key: string, value: string): void {
  try { if (typeof window !== "undefined") window.localStorage.setItem(key, value); }
  catch { /* Keep the in-memory preference usable when storage is blocked. */ }
}
export function systemPrefersDark(): boolean {
  try { return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches); }
  catch { return false; }
}
