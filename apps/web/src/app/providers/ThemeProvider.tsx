import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { useUiStore } from "@/lib/store";
import { resolveAppearance } from "@/lib/appearance";

/** Applies the current theme to the document root. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useUiStore((s) => resolveAppearance(s.theme, s.systemDark));
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => useUiStore.getState().setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return <>{children}</>;
}
