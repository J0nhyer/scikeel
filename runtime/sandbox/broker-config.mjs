const HOST = /^[A-Za-z0-9.-]{1,253}$/;

function httpUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`invalid ${name}`); }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !url.hostname) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

export function brokerConfig(environment = process.env) {
  const host = environment.SCIKEEL_BROKER_HOST ?? "172.31.240.1";
  if (!HOST.test(host)) throw new Error("invalid broker host");
  const model = httpUrl(environment.SCIKEEL_BROKER_URL ?? `http://${host}:4792/v1`, "broker model URL");
  const packageBase = httpUrl(environment.SCIKEEL_BROKER_PACKAGE_URL ?? `http://${host}:4793`, "broker package URL");
  const egress = httpUrl(environment.SCIKEEL_BROKER_EGRESS_URL ?? `http://${host}:4794`, "broker egress URL");
  return Object.freeze({ host, model, packageBase, egress });
}
