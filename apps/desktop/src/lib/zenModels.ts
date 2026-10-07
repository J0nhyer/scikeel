// Which OpenCode Zen models are still real.
//
// Zen is the built-in free provider, and its model list reaches the picker from
// the models.dev catalog by way of the runtime's /config/providers. That catalog
// is a superset of what the gateway serves: measured 2026-08-15, 29 of its 91
// zen entries — including 19 of the 25 `*-free` ones — are retired and answer
// `401 {"type":"ModelError","message":"Model <id> is not supported"}` on the
// first turn. The user could only discover that by sending a turn and reading a
// provider error, having already picked the model and typed a prompt.
//
// GET https://opencode.ai/zen/v1/models is the gateway's own serving list, and
// is a strict subset of the catalog (nothing it lists is missing from
// models.dev), so it can only ever remove entries — never invent one. Models it
// omits are marked unavailable and the pickers stop offering them.
//
// Fail-open is the rule throughout: an unreachable endpoint, an empty list, or a
// platform with no way to ask (plain browser dev) all mean "unknown", and every
// model stays selectable. Hiding models because the network blinked would be a
// far worse failure than showing one that turns out to be retired.

import type { OpenCodeClient, OpenCodeCatalogReadOptions, ProviderInfo } from "@ai4s/sdk";
import { isTauri, zenServedModelIds } from "./tauri";
import { isGatewayWeb, gatewayGet } from "./webMode";

/** Provider id of OpenCode Zen — its models.dev key, and what the runtime reports. */
export const ZEN_PROVIDER_ID = "opencode";

/** Successful public availability is stable for ten minutes; failures retry sooner. */
const TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = "scikeel.zen.models.v1";
const FAILURE_TTL_MS = 30_000;

let cached: { at: number; served: Set<string> | null } | null = null;
let inFlight: Promise<Set<string> | null> | null = null;

/** Test seam: drop the cache so a case starts from a known state. */
export function resetZenModelCache(): void {
  cached = null;
  inFlight = null;
}

function readPublicCache(): Set<string> | null {
  if (!isGatewayWeb) return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? "null");
    const age = Date.now() - value?.fetchedAt;
    if (value?.version !== 1 || !Number.isFinite(value.fetchedAt) || age < 0 || age >= TTL_MS ||
      !Array.isArray(value.models) || !validIds(value.models)) return null;
    return new Set(value.models);
  } catch { return null; }
}

function validIds(ids: unknown[]): ids is string[] {
  return ids.length > 0 && ids.length <= 4096 && ids.every(id =>
    typeof id === "string" && id.length > 0 && id.length <= 160 && [...id].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127));
}

async function fetchServed(): Promise<Set<string> | null> {
  try {
    let ids: string[] = [];
    if (isTauri) {
      ids = await zenServedModelIds();
    } else if (isGatewayWeb) {
      const signal = AbortSignal.timeout(3000);
      const body = await new Promise<{ models?: string[] } | null>((resolve, reject) => {
        const abort = () => reject(new Error("Model availability check timed out"));
        signal.addEventListener("abort", abort, { once: true });
        void gatewayGet<{ models?: string[] }>("/v1/zen-models", { signal })
          .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
      ids = body?.models ?? [];
    } else {
      // Plain browser (`pnpm dev`): the fetch would be blocked by CORS, and the
      // Rust side is not there to do it for us.
      return null;
    }
    // An empty list is indistinguishable from a broken answer, and acting on it
    // would empty the picker — treat it as unknown.
    return Array.isArray(ids) && validIds(ids) ? new Set(ids) : null;
  } catch {
    return null;
  }
}

/** Model ids Zen serves, or null when we could not find out. Cached; concurrent
 *  callers share one request. */
export async function zenServedModels(): Promise<Set<string> | null> {
  if (cached && Date.now() - cached.at < (cached.served ? TTL_MS : FAILURE_TTL_MS)) return cached.served;
  const saved = readPublicCache();
  if (saved) return saved;
  inFlight ??= fetchServed().then((served) => {
    cached = { at: Date.now(), served };
    if (isGatewayWeb && served) {
      try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, fetchedAt: cached.at, models: [...served] })); }
      catch { /* Public cache is optional. */ }
    }
    inFlight = null;
    return served;
  });
  return inFlight;
}

/**
 * Mark every Zen model the gateway no longer serves. Pure; other providers and
 * every model when `served` is null are returned untouched (`available` stays
 * undefined, which reads as available).
 */
export function markZenAvailability(
  providers: ProviderInfo[],
  served: Set<string> | null,
): ProviderInfo[] {
  if (!served) return providers;
  const zen = providers.find((provider) => provider.id === ZEN_PROVIDER_ID);
  // An answer that recognises none of the models the runtime reports is not a
  // retirement list, it is a wrong one — a changed response shape, a captive
  // portal, some future rename. Believing it would empty the picker, so treat
  // it the same as no answer at all.
  if (!zen || !zen.models.some((model) => served.has(model.id))) return providers;
  return providers.map((provider) =>
    provider.id !== ZEN_PROVIDER_ID
      ? provider
      : {
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            available: served.has(model.id),
          })),
        },
  );
}

/**
 * Web publishes native models immediately and enriches availability in the
 * background. Desktop retains its awaited lookup. Neither can add model IDs.
 */
export async function listProvidersWithAvailability(
  client: Pick<OpenCodeClient, "listProviders">,
  onAvailability?: (providers: ProviderInfo[]) => void,
  readOptions?: OpenCodeCatalogReadOptions,
): Promise<ProviderInfo[]> {
  if (isGatewayWeb) {
    const providers = await client.listProviders(readOptions);
    if (!providers.some(provider => provider.id === ZEN_PROVIDER_ID)) return providers;
    const saved = readPublicCache() ?? (cached && Date.now() - cached.at < TTL_MS ? cached.served : null);
    if (saved) return markZenAvailability(providers, saved);
    void zenServedModels().then(served => {
      const marked = markZenAvailability(providers, served);
      if (marked !== providers) onAvailability?.(marked);
    }).catch(() => {});
    return providers;
  }
  const [providers, served] = await Promise.all([client.listProviders(), zenServedModels()]);
  return markZenAvailability(providers, served);
}
