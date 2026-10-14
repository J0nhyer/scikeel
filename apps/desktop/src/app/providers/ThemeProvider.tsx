import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useUiStore } from "@/lib/store";
import { resolveAppearance } from "@/lib/appearance";
import { isMacUA, isTauri, setWindowTheme } from "@/lib/tauri";

/** Applies the current theme to the document root. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => resolveAppearance(s.theme, s.systemDark));
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    void setWindowTheme(theme === "dark");
  }, [theme]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => useUiStore.getState().setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  // The macOS desktop window has a vibrancy material behind the webview
  // (tauri.macos.conf.json); flag the root so CSS can let the sidebar show it.
  useEffect(() => {
    if (isTauri && isMacUA()) document.documentElement.dataset.vibrancy = "1";
  }, []);
  return <>{children}</>;
}
