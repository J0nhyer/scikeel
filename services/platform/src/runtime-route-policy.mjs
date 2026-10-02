const ID = "([A-Za-z0-9_-]{1,128})";
const table = [];
function route(method, path, operation, { ids = [], fields = [], query = [], approval = null } = {}) {
  table.push({ method, pattern: new RegExp(`^${path}$`), operation, ids, fields,
    query: ["directory", ...query], approval });
}
route("GET", "/session", "sessionList", { query: ["limit", "cursor", "search", "roots", "start"] });
route("GET", "/experimental/session", "sessionList", { query: ["limit", "cursor", "search", "roots", "start"] });
route("POST", "/session", "sessionCreate", { fields: ["title", "parentID", "directory", "permission"] });
route("GET", "/session/status", "sessionStatus");
route("GET", `/session/${ID}`, "sessionRead", { ids: ["sessionId"] });
route("PATCH", `/session/${ID}`, "sessionPatch", { ids: ["sessionId"], fields: ["title", "time", "metadata"] });
route("DELETE", `/session/${ID}`, "sessionDelete", { ids: ["sessionId"], approval: "deletion" });
for (const child of ["message", "children", "todo", "diff"])
  route("GET", `/session/${ID}/${child}`, `session${child[0].toUpperCase()}${child.slice(1)}`,
    { ids: ["sessionId"], query: ["limit", "messageID"] });
const post = {
  fork: ["messageID"], prompt_async: ["messageID", "model", "agent", "variant", "parts", "system", "tools", "noReply"],
  message: ["messageID", "model", "agent", "variant", "parts", "system", "tools", "noReply"],
  abort: [], summarize: ["providerID", "modelID", "auto"], revert: ["messageID", "partID"],
  unrevert: [], shell: ["command", "agent", "model"], command: ["command", "arguments", "agent", "model", "variant"],
};
for (const [name, fields] of Object.entries(post))
  route("POST", `/session/${ID}/${name}`, `session${name[0].toUpperCase()}${name.slice(1)}`,
    { ids: ["sessionId"], fields, approval: ["shell", "command"].includes(name) ? "command" : null });
route("PATCH", `/session/${ID}/message/${ID}/part/${ID}`, "sessionTextPart", {
  ids: ["sessionId", "messageId", "partId"],
  fields: ["id", "sessionID", "messageID", "type", "text", "synthetic", "metadata"],
});
route("POST", "/experimental/control-plane/move-session", "sessionMove", {
  fields: ["sessionID", "destination", "moveChanges"], approval: "metadata",
});
for (const name of ["event", "agent", "command", "skill"])
  route("GET", `/${name}`, name, { query: name === "event" ? ["auth_token"] : [] });
for (const name of ["permission", "question"]) {
  route("GET", `/${name}`, `${name}List`);
  route("POST", `/${name}/${ID}/reply`, `${name}Reply`, {
    ids: ["requestId"], fields: name === "permission" ? ["reply", "message"] : ["answers"],
    approval: "reply",
  });
}
route("POST", `/question/${ID}/reject`, "questionReject", { ids: ["requestId"] });
route("GET", "/config/providers", "modelCatalog");
route("GET", "/provider", "providerCatalog");
// Config is returned by the platform's sanitized handler; never proxy raw config.
route("GET", "/global/config", "modelConfig");

export function classifyRuntimeRoute(method, path) {
  if (typeof path !== "string" || path.includes("%") || path.includes("\\") || path.includes("\0")) return null;
  for (const entry of table) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(path);
    if (match) {
      const { pattern: _pattern, ...description } = entry;
      return { ...description, path, identifiers: Object.fromEntries(entry.ids.map((name, i) => [name, match[i + 1]])) };
    }
  }
  return null;
}
function invalid(message = "invalid runtime input") {
  throw Object.assign(new Error(message), { statusCode: 400 });
}
export function validateRuntimeInput(route, { query = new URLSearchParams(), body = {}, headers = {} } = {}) {
  for (const key of query.keys())
    if (!route.query.includes(key) || query.getAll(key).length !== 1) invalid();
  for (const key of Object.keys(headers))
    if (/directory|workspace|^x-opencode-/i.test(key)) invalid("unsupported runtime header");
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  for (const key of Object.keys(body)) if (!route.fields.includes(key)) invalid();
  if (body.destination !== undefined && (!body.destination || typeof body.destination !== "object" ||
      Object.keys(body.destination).join(",") !== "directory")) invalid();
  const directories = [query.get("directory") ?? undefined, body.directory, body.destination?.directory].filter((value) => value !== undefined);
  if (directories.some((value) => typeof value !== "string") || new Set(directories).size > 1) invalid();
  const inspect = (value, depth = 0) => {
    if (depth > 32) invalid();
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/directory|workspace|source_path|^userId$|^instanceId$/i.test(key)) invalid();
      inspect(item, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(body)) if (key !== "directory" && key !== "destination") inspect(value);
  if (body.parts !== undefined) {
    if (!Array.isArray(body.parts) || body.parts.length > 256) invalid();
    for (const part of body.parts) {
      if (!part || typeof part !== "object") invalid();
      if (part.type === "file") {
        // Existing inline images are allowed; remote/file URLs never confer file authority.
        if (typeof part.url !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(part.url)) invalid();
      } else if (part.type === "text") {
        if (typeof part.text !== "string") invalid();
      } else if (part.type !== "agent") invalid();
    }
  }
  if (route.operation === "sessionTextPart" &&
      (body.id !== route.identifiers.partId || body.sessionID !== route.identifiers.sessionId ||
       body.messageID !== route.identifiers.messageId || body.type !== "text" || typeof body.text !== "string")) invalid();
  if (body.moveChanges !== undefined && body.moveChanges !== false) invalid();
  // Never let a session-creation body override manual permission defaults.
  if (body.permission !== undefined || body.tools !== undefined) invalid();
  return { directory: directories[0], body };
}

export function scrubRuntimeSecrets(value, depth = 0) {
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map((item) => scrubRuntimeSecrets(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|credential|headers|env)$/i.test(key))
    .map(([key, item]) => [key, scrubRuntimeSecrets(item, depth + 1)]));
}

const gatewayReads = new Map([
  ["/v1/health", { operation: "health", query: [] }],
  ["/v1/whoami", { operation: "identity", query: [] }],
  ["/v1/fs/list", { operation: "fileList", query: ["path", "dir", "root"] }],
  ["/v1/fs/read", { operation: "fileRead", query: ["path", "dir", "root", "ticket", "download"] }],
  ["/v1/fs/ticket", { operation: "fileTicket", query: ["path", "dir", "root"] }],
  ["/v1/projects", { operation: "projectsList", query: [] }],
  ["/v1/runs", { operation: "runsList", query: [] }],
  ["/v1/runs/query", { operation: "runsQuery", query: ["q"] }],
  ["/v1/runs/log", { operation: "runsLog", query: ["hash"] }],
]);
export function classifyGatewayRoute(method, path) {
  const entry = method === "GET" && gatewayReads.get(path);
  return entry ? { ...entry, path } : null;
}
