export const PRELOAD_RECOVERY_KEY = "scikeel:preload-reload-at";
export const PRELOAD_RECOVERY_WINDOW_MS = 10_000;

interface PreloadRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PreloadRecoveryOptions {
  storage?: PreloadRecoveryStorage;
  now?: () => number;
  reload?: () => void;
}

// A redeploy replaces every hashed chunk. An already-open tab keeps running
// the previous entry bundle, so its not-yet-loaded routes request chunk names
// that no longer exist and Vite reports `vite:preloadError`. Reloading once
// fetches the new index.html and chunk graph; the timestamp guard stops a
// reload loop when the server really is serving a broken bundle.
export function installPreloadRecovery(options: PreloadRecoveryOptions = {}): () => void {
  const storage = options.storage ?? browserSessionStorage();
  const now = options.now ?? Date.now;
  const reload = options.reload ?? (() => window.location.reload());

  const handler = (event: Event) => {
    const at = now();
    const last = lastReloadAt(storage);
    if (last !== null && at - last < PRELOAD_RECOVERY_WINDOW_MS) return;
    event.preventDefault();
    recordReloadAt(storage, at);
    reload();
  };

  window.addEventListener("vite:preloadError", handler);
  return () => window.removeEventListener("vite:preloadError", handler);
}

function browserSessionStorage(): PreloadRecoveryStorage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function lastReloadAt(storage: PreloadRecoveryStorage | undefined): number | null {
  try {
    const value = storage?.getItem(PRELOAD_RECOVERY_KEY);
    if (value === null || value === undefined) return null;
    const at = Number(value);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function recordReloadAt(storage: PreloadRecoveryStorage | undefined, at: number): void {
  try {
    storage?.setItem(PRELOAD_RECOVERY_KEY, String(at));
  } catch {
    // Storage can be unavailable; the reload itself is still the right action.
  }
}
