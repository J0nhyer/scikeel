import test from "node:test";
import assert from "node:assert/strict";
import { brokerConfig } from "../../../runtime/sandbox/broker-config.mjs";

test("defaults to the legacy broker", () => {
  assert.deepEqual(brokerConfig({}), { host: "172.31.240.1", model: "http://172.31.240.1:4792/v1", packageBase: "http://172.31.240.1:4793", egress: "http://172.31.240.1:4794" });
});

test("uses the docker broker host", () => {
  assert.deepEqual(brokerConfig({ SCIKEEL_BROKER_HOST: "broker" }), { host: "broker", model: "http://broker:4792/v1", packageBase: "http://broker:4793", egress: "http://broker:4794" });
});
