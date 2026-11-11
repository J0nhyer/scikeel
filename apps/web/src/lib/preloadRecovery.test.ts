import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPreloadRecovery,
  PRELOAD_RECOVERY_KEY,
  PRELOAD_RECOVERY_WINDOW_MS,
} from "./preloadRecovery";

const uninstallers: Array<() => void> = [];

function install(options: Parameters<typeof installPreloadRecovery>[0]) {
  const uninstall = installPreloadRecovery(options);
  uninstallers.push(uninstall);
  return uninstall;
}

afterEach(() => {
  for (const uninstall of uninstallers.splice(0)) uninstall();
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function preloadError() {
  return new Event("vite:preloadError", { cancelable: true });
}

describe("installPreloadRecovery", () => {
  it("reloads once when a lazy chunk fails to load", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    install({ storage, now: () => 1_000, reload });

    const event = preloadError();
    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(storage.getItem(PRELOAD_RECOVERY_KEY)).toBe("1000");
  });

  it("does not reload again within the guard window, so the error surfaces", () => {
    let now = 1_000;
    const storage = memoryStorage();
    const reload = vi.fn();
    install({ storage, now: () => now, reload });

    window.dispatchEvent(preloadError());
    now += PRELOAD_RECOVERY_WINDOW_MS - 1;
    const repeated = preloadError();
    window.dispatchEvent(repeated);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(repeated.defaultPrevented).toBe(false);
  });

  it("reloads again after the guard window, so a later deploy still recovers", () => {
    let now = 1_000;
    const storage = memoryStorage();
    const reload = vi.fn();
    install({ storage, now: () => now, reload });

    window.dispatchEvent(preloadError());
    now += PRELOAD_RECOVERY_WINDOW_MS;
    window.dispatchEvent(preloadError());

    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.getItem(PRELOAD_RECOVERY_KEY)).toBe("11000");
  });

  it("still reloads when session storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };
    const reload = vi.fn();
    install({ storage, now: () => 1_000, reload });

    const event = preloadError();
    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});
