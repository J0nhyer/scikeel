import { useSyncExternalStore } from "react";

// A viewport is "mobile" at or below this width (phones / narrow LAN-web
// windows). The fixed sidebar is unusable there, so mobile turns it into an
// overlay drawer.
const MOBILE_MAX_PX = 768;

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function widthSnapshot(): number {
  // No window (SSR / node tests): never mobile, as before.
  return typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
}

/** True on phone-width viewports. SSR/test-safe (returns false). */
export function useIsMobile(): boolean {
  const cssWidth = useSyncExternalStore(
    subscribe,
    widthSnapshot,
    () => Number.POSITIVE_INFINITY,
  );
  return cssWidth <= MOBILE_MAX_PX;
}
