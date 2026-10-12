import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile(`${process.env.OSD_STATE_DIR}/runtime/xdg-config/opencode/opencode.json`, "utf8"));
const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: config.model })); });
await new Promise((done) => server.listen(Number(process.env.FIXTURE_PORT), "127.0.0.1", done));
process.once("SIGTERM", () => server.close(() => process.exit(0)));
