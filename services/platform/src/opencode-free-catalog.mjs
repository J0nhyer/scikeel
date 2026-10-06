const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validName = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

/** Match the desktop: use original models.dev metadata and remove models that
 * Zen no longer serves. Only explicitly free models enter the managed broker. */
export async function resolveOpenCodeFreeCatalog(config, { fetchImpl = fetch } = {}) {
  const provider = config.providers.opencode;
  if (config.defaultProvider !== "opencode" || provider?.catalog !== "opencode-free" || provider.baseUrl !== "https://opencode.ai/zen/v1") return config;
  try {
    const read = async (url, maximum) => {
      const response = await fetchImpl(url, { headers: { "user-agent": "opencode/1.18.32" }, redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok || !response.body) throw new Error("catalog unavailable");
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximum) throw new Error("catalog exceeds limit");
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    };
    const [metadata, serving] = await Promise.all([
      read("https://models.dev/api.json", 16 * 1024 ** 2), read("https://opencode.ai/zen/v1/models", 256 * 1024),
    ]);
    if (!record(metadata?.opencode?.models) || !Array.isArray(serving?.data)) throw new Error("invalid catalog");
    const served = new Set(serving.data.filter(record).map((model) => model.id));
    const models = Object.entries(metadata.opencode.models).filter(([id, model]) =>
      typeof id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(id) && record(model) && validName(model.name) &&
      model.cost?.input === 0 && model.cost?.output === 0 && served.has(id));
    if (!models.length || models.length > 200 || !models.some(([id]) => id === config.defaultModel)) throw new Error("incomplete catalog");
    return { ...config, providers: { ...config.providers, opencode: { ...provider,
      name: validName(metadata.opencode.name) ? metadata.opencode.name : "OpenCode Zen",
      enabledModels: models.map(([id]) => id), modelNames: Object.fromEntries(models.map(([id, model]) => [id, model.name])),
    } } };
  } catch {
    // A temporary discovery failure keeps the last administrator-owned catalog.
    return config;
  }
}
