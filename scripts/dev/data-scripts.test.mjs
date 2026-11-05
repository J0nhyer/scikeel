import test from "node:test";
import assert from "node:assert/strict";
import { backupPlan } from "./data-backup.mjs";
import { usageReport } from "./data-usage.mjs";

test("builds a stopped-stack backup plan", () => {
  const plan = backupPlan({ dataDir: "/srv/scikeel/data", output: "/srv/backups/scikeel.tar.gz" });
  assert.deepEqual(plan.args, ["-czf", "/srv/backups/scikeel.tar.gz", "-C", "/srv", "scikeel/data"]);
});

test("parses usage", () => {
  assert.deepEqual(usageReport({ duOutput: "1.2G\t/srv/scikeel/data", dfOutput: "40G 10G 30G 25%" }), { data: "1.2G", filesystem: "40G 10G 30G 25%" });
});
