import { request as httpRequest } from "node:http";

const MAX_RESPONSE = 4 * 1024 * 1024;

export class DockerApiError extends Error {
  constructor(message, { statusCode = null, body = null } = {}) {
    super(message);
    this.name = "DockerApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

function encode(value) {
  return encodeURIComponent(value);
}

export class DockerApi {
  constructor({ socketPath = "/var/run/docker.sock", apiVersion = "v1.44", timeoutMs = 30000 } = {}) {
    this.socketPath = socketPath;
    this.apiVersion = apiVersion;
    this.timeoutMs = timeoutMs;
  }

  request(method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const headers = {};
      if (payload) {
        headers["content-type"] = "application/json";
        headers["content-length"] = payload.length;
      }
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/${this.apiVersion}${path}`,
        method,
        headers,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) {
            req.destroy(new Error("docker_api_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const message = parsed && typeof parsed === "object" && typeof parsed.message === "string"
              ? parsed.message : `docker_api_error_${res.statusCode}`;
            reject(new DockerApiError(message, { statusCode: res.statusCode, body: parsed }));
            return;
          }
          resolve(parsed);
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("docker_api_timeout")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  ping() { return this.request("GET", "/_ping"); }

  imageInspect(image) { return this.request("GET", `/images/${encode(image)}/json`); }

  networkCreate({ name, labels = {}, internal = false }) {
    return this.request("POST", "/networks/create", {
      Name: name,
      CheckDuplicate: true,
      Driver: "bridge",
      Internal: internal,
      Labels: labels,
    });
  }

  networkInspect(nameOrId) { return this.request("GET", `/networks/${encode(nameOrId)}`); }

  networkConnect(network, container, aliases = []) {
    return this.request("POST", `/networks/${encode(network)}/connect`, {
      Container: container,
      EndpointConfig: aliases.length ? { Aliases: aliases } : {},
    });
  }

  networkDisconnect(network, container) {
    return this.request("POST", `/networks/${encode(network)}/disconnect`, { Container: container, Force: false });
  }

  networkRemove(network) { return this.request("DELETE", `/networks/${encode(network)}`); }

  containerCreate({ name, platform, body }) {
    const query = new URLSearchParams({ name });
    if (platform) query.set("platform", platform);
    return this.request("POST", `/containers/create?${query}`, body);
  }

  containerStart(id) { return this.request("POST", `/containers/${encode(id)}/start`); }

  containerStop(id, timeoutSeconds = 10) {
    return this.request("POST", `/containers/${encode(id)}/stop?t=${encodeURIComponent(timeoutSeconds)}`);
  }

  containerRemove(id) { return this.request("DELETE", `/containers/${encode(id)}?force=1&v=1`); }

  containerInspect(id) { return this.request("GET", `/containers/${encode(id)}/json`); }

  listContainers({ all = true, label } = {}) {
    const query = new URLSearchParams({ all: all ? "1" : "0" });
    if (label) query.set("filters", JSON.stringify({ label: [label] }));
    return this.request("GET", `/containers/json?${query}`);
  }

  listNetworks({ label } = {}) {
    const query = new URLSearchParams();
    if (label) query.set("filters", JSON.stringify({ label: [label] }));
    const suffix = query.toString() ? `?${query}` : "";
    return this.request("GET", `/networks${suffix}`);
  }
}
