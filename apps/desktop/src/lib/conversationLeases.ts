import { useEffect, useState } from "react";
import { collaborationRequest } from "./collaboration";
import { useRuntimeStore } from "./runtime";
import { isGatewayWeb, isPlatformWeb } from "./webMode";

const HEARTBEAT_MS = 10_000;

interface Lease {
  running: boolean;
  pending: Promise<void> | null;
}

/** Keep running OpenCode turns leased independently of mounted session panes.
 * Subscribe synchronously: a send updates runningSessions before the user can
 * switch panes, so the background heartbeat is dispatched before pane cleanup.
 * On navigation/unmount, let the server's 45s TTL bridge reloads and eventually
 * pause work when the browser is gone. Heartbeats never start/resume a turn.
 */
export function useConversationLeases(): void {
  // getRandomValues also works on HTTP. The distinct 43-character identifier
  // fits the lease identifier limit and cannot collide with researchPageId.
  const [pageId] = useState(() => `background-${Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("")}`);

  useEffect(() => {
    if (!isGatewayWeb || !isPlatformWeb) return;
    const leases = new Map<string, Lease>();
    let hidden = false;
    let disposed = false;
    let timer: number | undefined;

    const stopTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const release = (sessionId: string, lease: Lease) => {
      if (hidden || disposed || lease.running || lease.pending) return;
      leases.delete(sessionId);
      void collaborationRequest(sessionId, { action: "release", pageId }, true).catch(() => {});
    };
    const heartbeat = (sessionId: string, lease: Lease) => {
      if (hidden || disposed || !lease.running || lease.pending) return;
      // Keep even the initial acquisition alive across a fast navigation.
      // At most one heartbeat per session is in flight; retry on the next tick.
      lease.pending = collaborationRequest(sessionId, { action: "heartbeat", pageId }, true)
        .then(() => {}, () => {})
        .then(() => {
          lease.pending = null;
          // An ended turn must release AFTER an in-flight heartbeat, otherwise
          // a late heartbeat could recreate the lease after its release.
          release(sessionId, lease);
        });
    };
    const startTimer = () => {
      if (timer !== undefined || hidden || disposed) return;
      if (![...leases.values()].some((lease) => lease.running)) return;
      timer = window.setInterval(() => {
        for (const [sessionId, lease] of leases) heartbeat(sessionId, lease);
      }, HEARTBEAT_MS);
    };
    const reconcile = () => {
      if (hidden || disposed) return;
      const state = useRuntimeStore.getState();
      const running: Record<string, true> = state.gatewayRuntime === "opencode" ? state.runningSessions : {};
      // A reload starts with an empty store. Retain the last active IDs solely
      // to prioritize directory discovery; server status remains authoritative.
      if (Object.keys(running).length) {
        try { sessionStorage.setItem("scikeel.running-sessions", JSON.stringify(Object.keys(running).slice(0, 200))); }
        catch { /* Browsers may deny storage; heartbeats still work. */ }
      }
      for (const [sessionId, lease] of leases) {
        lease.running = running[sessionId] === true;
        if (!lease.running) release(sessionId, lease);
      }
      for (const sessionId of Object.keys(running)) {
        if (running[sessionId] !== true) continue;
        const existing = leases.get(sessionId);
        if (existing) existing.running = true;
        else {
          const lease: Lease = { running: true, pending: null };
          leases.set(sessionId, lease);
          heartbeat(sessionId, lease);
        }
      }
      if (Object.keys(running).length === 0) stopTimer();
      else startTimer();
    };
    const onPageHide = () => {
      hidden = true;
      stopTimer();
      // Do not release: the server expires this page's leases within 45s.
    };
    const onPageShow = () => {
      hidden = false;
      reconcile();
      // BFCache restores the same app instance; renew surviving runs promptly.
      for (const [sessionId, lease] of leases) heartbeat(sessionId, lease);
    };

    const unsubscribe = useRuntimeStore.subscribe(reconcile);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    reconcile();
    return () => {
      disposed = true;
      unsubscribe();
      stopTimer();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      // App teardown (including StrictMode effect replay) is not turn completion.
      // Leave running leases bounded by TTL instead of pausing the last owner.
    };
  }, [pageId]);
}
