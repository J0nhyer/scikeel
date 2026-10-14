export type GatewayAccountIdentity = { id: string; username: string; role: "admin" | "user" };
type AccountOptions = {
  fetchImpl: typeof fetch;
  publish: (user: GatewayAccountIdentity) => void;
  suspend: () => void;
  clear: () => void;
  navigate: () => void;
  onIdentityState?: (state:'ready'|'unavailable') => void;
};

/** Authentication owns account reads; workspace reconnects never invalidate them. */
export function createGatewayAccountLifecycle(options: AccountOptions) {
  let authenticationEpoch = 0;
  let suspended = false;
  let disposed = false;
  let accountController: AbortController | null = null;
  let logoutController: AbortController | null = null;
  let pendingAccount: Promise<void> | null = null;
  let pendingLogout: Promise<void> | null = null;

  async function request(path: string, init: RequestInit, controller: AbortController): Promise<unknown> {
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new Error("Account request timed out")), 15_000);
    let abort!: () => void;
    try {
      return await Promise.race([
        (async () => {
          const response = await options.fetchImpl(path, { ...init, credentials: "same-origin", signal });
          if (!response.ok) throw new Error(`Account request failed (HTTP ${response.status})`);
          return response.json() as Promise<unknown>;
        })(),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason ?? new Error("Account request cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  function suspend() {
    if (suspended) return;
    suspended = true;
    ++authenticationEpoch;
    accountController?.abort();
    options.suspend();
  }

  function load(): Promise<void> {
    if (suspended || disposed) return Promise.resolve();
    if (pendingAccount) return pendingAccount;
    const epoch = authenticationEpoch;
    const controller = new AbortController();
    accountController = controller;
    const run = (async () => {
      try {
        const body = await request("/api/me", {}, controller);
        if (suspended || disposed || epoch !== authenticationEpoch || controller.signal.aborted) return;
        if (typeof body !== "object" || body === null || !("user" in body)) throw new Error('Invalid identity');
        const user = body.user;
        if (typeof user !== "object" || user === null || !("id" in user) || !("username" in user) || !("role" in user) ||
          typeof user.id !== "string" || !user.id || typeof user.username !== "string" || !user.username ||
          (user.role !== "admin" && user.role !== "user")) throw new Error('Invalid identity');
        options.publish({ id: user.id, username: user.username, role: user.role });
        options.onIdentityState?.('ready');
      } catch {
        if(!disposed&&!suspended&&epoch===authenticationEpoch)options.onIdentityState?.('unavailable');
        // Account availability cannot gate access to the independent logout route.
      }
    })();
    pendingAccount = run;
    void run.finally(() => {
      if (pendingAccount === run) pendingAccount = null;
      if (accountController === controller) accountController = null;
    });
    return run;
  }

  function signOut(): Promise<void> {
    if (disposed) return Promise.reject(new Error("Account lifecycle disposed"));
    if (pendingLogout) return pendingLogout;
    suspend();
    const controller = new AbortController();
    logoutController = controller;
    const run = (async () => {
      const body = await request("/auth/logout", { method: "POST", headers: { accept: "application/json" } }, controller);
      if (disposed || controller.signal.aborted) throw new Error("Logout cancelled");
      if (typeof body !== "object" || body === null || !("ok" in body) || body.ok !== true) throw new Error("Invalid logout response");
      options.clear();
      options.navigate();
    })();
    pendingLogout = run;
    const clearPending = () => {
      if (pendingLogout === run) pendingLogout = null;
      if (logoutController === controller) logoutController = null;
    };
    void run.then(clearPending, clearPending);
    return run;
  }

  return {
    load, suspend, signOut,
    get suspended() { return suspended; },
    dispose() {
      disposed = suspended = true;
      ++authenticationEpoch;
      accountController?.abort();
      logoutController?.abort();
    },
  };
}
