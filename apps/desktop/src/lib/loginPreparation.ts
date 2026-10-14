import { isWorkspaceReport, type WorkspaceReport } from "@ai4s/sdk";

type PreparationState = {
  status: string;
  sessionListReady: boolean;
  gatewayCatalogState: string;
  defaultModel: string | null;
  gatewayWorkspaceReport?: WorkspaceReport | null;
};
type PreparationSource = {
  getState: () => PreparationState;
  subscribe: (listener: (state: PreparationState) => void) => () => void;
};

/** Keep the existing login screen until the authenticated app can be used.
 * The server owns its markup; no credentials are stored or copied into the app. */
export function installLoginPreparation(source: PreparationSource, signOut?: () => Promise<void>): () => void {
  if (!document.documentElement.hasAttribute("data-scikeel-login-preparing")) return () => {};
  let finished = false;
  let disposed = false;
  let signingOut = false;
  let failureShown = false;
  let unsubscribe = () => {};
  const finish = (event: "scikeel:login-ready" | "scikeel:login-error" | "scikeel:login-recovery") => {
    if (finished) return;
    clearTimeout(timer);
    if (event === "scikeel:login-error") {
      if (!failureShown) document.dispatchEvent(new Event(event));
      failureShown = true;
      return;
    }
    finished = true;
    unsubscribe();
    document.removeEventListener("scikeel:sign-out", logout);
    document.dispatchEvent(new Event(event));
  };
  const timer = setTimeout(() => finish("scikeel:login-error"), 90_000);
  const update = (state: PreparationState) => {
    if (finished || signingOut) return;
    if (state.status === "error" && isWorkspaceReport(state.gatewayWorkspaceReport)) finish("scikeel:login-recovery");
    else if (state.status === "error" || (state.status === "ready" && state.sessionListReady && state.gatewayCatalogState === "unavailable")) finish("scikeel:login-error");
    else if (state.status === "ready" && state.sessionListReady &&
      (state.gatewayCatalogState === "ready" || state.gatewayCatalogState === "limited") && state.defaultModel) finish("scikeel:login-ready");
  };
  const logout = () => {
    if (!signOut || signingOut || disposed) return;
    signingOut = true;
    finished = true;
    clearTimeout(timer);
    unsubscribe();
    void (async () => {
      try { await signOut(); }
      catch { if (!disposed) document.dispatchEvent(new Event("scikeel:sign-out-failed")); }
      finally { signingOut = false; }
    })();
  };
  document.addEventListener("scikeel:sign-out", logout);
  unsubscribe = source.subscribe(update);
  update(source.getState());
  return () => {
    disposed = true;
    document.removeEventListener("scikeel:sign-out", logout);
    clearTimeout(timer);
    if (!finished) unsubscribe();
    finished = true;
  };
}
