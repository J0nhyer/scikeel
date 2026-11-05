type PreparationState = {
  status: string;
  sessionListReady: boolean;
  gatewayCatalogState: string;
  defaultModel: string | null;
};
type PreparationSource = {
  getState: () => PreparationState;
  subscribe: (listener: (state: PreparationState) => void) => () => void;
};

/** Keep the existing login screen until the authenticated app can be used.
 * The server owns its markup; no credentials are stored or copied into the app. */
export function installLoginPreparation(source: PreparationSource): () => void {
  if (!document.documentElement.hasAttribute("data-scikeel-login-preparing")) return () => {};
  let finished = false;
  let unsubscribe = () => {};
  const finish = (event: "scikeel:login-ready" | "scikeel:login-error") => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    unsubscribe();
    document.dispatchEvent(new Event(event));
  };
  const timer = setTimeout(() => finish("scikeel:login-error"), 90_000);
  const update = (state: PreparationState) => {
    if (state.status === "error" || (state.status === "ready" && state.sessionListReady && state.gatewayCatalogState === "unavailable")) finish("scikeel:login-error");
    else if (state.status === "ready" && state.sessionListReady &&
      state.gatewayCatalogState === "ready" && state.defaultModel) finish("scikeel:login-ready");
  };
  unsubscribe = source.subscribe(update);
  update(source.getState());
  return () => { if (finished) return; clearTimeout(timer); unsubscribe(); finished = true; };
}
