const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value, fallback) => typeof value === "string" && value.length > 0 && value.length <= 512 ? value : fallback;
const unavailable = () => Object.assign(new Error("OpenCode model catalog unavailable"), { statusCode: 503 });

/** Read the current tenant runtime, then expose only model metadata allowed by
 * its managed broker profile. Never return raw runtime/provider configuration. */
export async function readManagedModelCatalog({ config, access, context, fetchImpl = fetch }) {
  try {
    const read = async (path) => {
      const url = new URL(path, access.url);
      url.searchParams.set("directory", context.workspaceDir);
      const response = await fetchImpl(url.toString(), {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${access.token}`).toString("base64")}` },
        redirect: "error", signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw unavailable();
      return response.json();
    };
    const [catalog, current] = await Promise.all([read("/config/providers"), read("/global/config")]);
    if (!record(catalog) || !Array.isArray(catalog.providers) || !record(current)) throw unavailable();
    const providers = [];
    for (const provider of catalog.providers) {
      if (!record(provider) || typeof provider.id !== "string" || !record(provider.models)) throw unavailable();
      // brokerProfile currently enables only the default provider. Other
      // configured brokers and native CLI catalogs are not this runtime's models.
      if (provider.id !== config.defaultProvider || !Object.hasOwn(config.providers, provider.id)) continue;
      const allowed = new Set(config.providers[provider.id].enabledModels);
      const models = Object.fromEntries(Object.entries(provider.models).flatMap(([id, model]) => {
        if (!allowed.has(id) || !record(model)) return [];
        const safe = { id, providerID: provider.id, name: label(config.providers[provider.id].modelNames?.[id], label(model.name, id)) };
        if (record(model.variants)) safe.variants = Object.fromEntries(Object.keys(model.variants)
          .filter((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name) &&
            (!config.providers[provider.id].modelVariants?.[id] || config.providers[provider.id].modelVariants[id].includes(name))).map((name) => [name, {}]));
        if (record(model.limit) && Number.isSafeInteger(model.limit.context) && model.limit.context > 0)
          safe.limit = { context: model.limit.context };
        return [[id, safe]];
      }));
      if (Object.keys(models).length) providers.push({ id: provider.id, name: label(config.providers[provider.id].name, label(provider.name, provider.id)), models });
    }
    const keys = new Set(providers.flatMap((provider) => Object.keys(provider.models).map((id) => `${provider.id}/${id}`)));
    const model = typeof current.model === "string" && keys.has(current.model) ? current.model : null;
    return { model, providers, connected: providers.map((provider) => provider.id), defaults: Object.fromEntries(providers.map((provider) => [
      provider.id, model?.startsWith(`${provider.id}/`) ? model.slice(provider.id.length + 1) : Object.keys(provider.models)[0],
    ])) };
  } catch {
    // Failure must clear the Web catalog, never manufacture a static fallback.
    throw unavailable();
  }
}
