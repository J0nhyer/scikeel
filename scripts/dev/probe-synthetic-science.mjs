export async function probeSyntheticScience({ client, imageDigest, fetchImpl = fetch } = {}) {
  if (!client || !/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? "")) throw new Error("invalid synthetic science configuration");
  const instances = [];
  const evidence = [];
  try {
    for (const suffix of ["a", "b"]) {
      const instanceId = `sandbox-test-${suffix}`;
      const registered = await client.register({ instanceId, userId: instanceId });
      instances.push({ instanceId, generation: registered.generation });
      const started = await client.start({ instanceId, generation: registered.generation, imageDigest });
      const response = await fetchImpl(`${started.runnerEndpoint}/test/science`, { method: "POST", signal: AbortSignal.timeout(45000) });
      if (response.status !== 200) throw new Error("synthetic scientific probe rejected");
      const science = await response.json();
      if (!["imports", "figure", "noPrivateVenv", "baselineWriteRejected", "secureOpenSupported", "hostControlHidden"].every((key) => science[key] === true))
        throw new Error("incomplete scientific evidence");
      const inspected = await client.inspect({ instanceId });
      if (inspected.status !== "ready" || inspected.imageDigest !== imageDigest || inspected.generation !== registered.generation ||
          inspected.quota?.enforced !== true || inspected.limits?.owned !== true)
        throw new Error("unverified scientific sandbox limits");
      evidence.push({ instanceId, generation: registered.generation, imageDigest, science, limits: inspected.limits, quota: inspected.quota });
      // Keep this host's memory budget: run each tenant serially using the same shared image.
      await client.stop({ instanceId, generation: registered.generation, reason: "synthetic-science-complete" });
      instances.pop();
    }
    return { synthetic: true, tenants: evidence, sharedImage: imageDigest };
  } finally {
    const failures = [];
    for (const owned of instances) {
      try { await client.stop({ ...owned, reason: "synthetic-science-cleanup" }); } catch { failures.push(owned.instanceId); }
    }
    if (failures.length) throw new Error("synthetic science cleanup unverified");
  }
}
