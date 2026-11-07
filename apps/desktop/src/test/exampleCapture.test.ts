import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OpenCodeClient } from "@ai4s/sdk";
import { describe, expect, it } from "vitest";
import { historyToThread } from "@/lib/runtime";
import { redactExampleText, trimBlocks } from "@/lib/examples/capture";

const session = process.env.EXAMPLE_CAPTURE_SESSION;
const id = process.env.EXAMPLE_CAPTURE_ID;
const baseUrl = process.env.EXAMPLE_CAPTURE_BASE_URL;
const cookie = process.env.EXAMPLE_CAPTURE_COOKIE;

const capture = session && id && baseUrl ? it : it.skip;

describe("example capture", () => {
  capture("writes a trimmed, redacted fixture", async () => {
    const client = new OpenCodeClient({
      baseUrl,
      fetchImpl: (input, init) => {
        // jsdom's AbortSignal is not the Node fetch implementation's class.
        const rest: RequestInit = { ...(init ?? {}) };
        delete rest.signal;
        const headers = new Headers(rest.headers);
        if (cookie) headers.set("Cookie", `osd_session=${cookie}`);
        return fetch(input, { ...rest, headers });
      },
    });
    const generation = Number(process.env.EXAMPLE_CAPTURE_GENERATION ?? 55);
    if (Number.isSafeInteger(generation) && generation > 0) client.setGatewayGeneration(generation);
    client.setGatewayAssistantRevision(1);

    const messages = await client.getMessages(session!);
    const blocks = trimBlocks(historyToThread(messages, undefined, true).blocks);
    const redacted = JSON.parse(redactExampleText(JSON.stringify(blocks))) as unknown[];
    const target = resolve(process.cwd(), "src/lib/examples/captured", `${id}.json`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(redacted, null, 2) + "\n");
    expect(redacted.length).toBeGreaterThan(0);
  });
});
