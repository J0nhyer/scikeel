import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCollaboration, defaultCollaboration, prepareCollaborationSend } from "./collaboration";
vi.mock("./webMode", () => ({ isGatewayWeb: true, gatewayOrigin: () => "" }));
afterEach(() => vi.restoreAllMocks());
describe("conversation collaboration", () => {
  it("restores a pending decision without starting work and does not lose it after an answer failure", async () => {
    const state = {
      ...defaultCollaboration,
      phase: "waiting_input",
      revision: 2,
      pending: {
        id: "d",
        execution: 1,
        kind: "plan",
        question: "Plan?",
        suggestedAnswer: "Continue",
      },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify(
            body.action === "answer"
              ? { error: "stale answer" }
              : { state, available: true },
          ),
          { status: body.action === "answer" ? 409 : 200 },
        );
      });
    const { result, unmount } = renderHook(() =>
      useCollaboration("ses_test", true),
    );
    await waitFor(() => expect(result.current.state.pending?.id).toBe("d"));
    await act(() => result.current.answer("Continue"));
    expect(result.current.state.pending?.id).toBe("d");
    expect(result.current.error).toBe("stale answer");
    expect(
      fetchMock.mock.calls.every(([url]) => !String(url).includes("prompt")),
    ).toBe(true);
    unmount();
    expect(fetchMock.mock.calls.some(([, init]) => init?.keepalive)).toBe(true);
  });
});

it("a slow answer response from a previous conversation cannot overwrite the newly opened one", async () => {
  let resolveAnswer!: (response: Response) => void;
  const old = {
    ...defaultCollaboration,
    revision: 2,
    execution: 1,
    phase: "waiting_input",
    pending: {
      id: "old",
      execution: 1,
      kind: "plan",
      question: "Old plan?",
      suggestedAnswer: "Continue",
    },
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const action = init?.body ? JSON.parse(String(init.body)).action : null;
    if (action === "answer")
      return new Promise<Response>((resolve) => (resolveAnswer = resolve));
    return new Response(
      JSON.stringify({
        available: true,
        state: String(url).endsWith("/old") ? old : defaultCollaboration,
      }),
    );
  });
  const { result, rerender, unmount } = renderHook(
    ({ sid }) => useCollaboration(sid, true),
    { initialProps: { sid: "old" } },
  );
  await waitFor(() => expect(result.current.state.pending?.id).toBe("old"));
  let saving!: Promise<boolean>;
  act(() => {
    saving = result.current.answer("Continue");
  });
  rerender({ sid: "new" });
  await waitFor(() => expect(result.current.state.pending).toBe(null));
  await act(async () => {
    resolveAnswer(
      new Response(
        JSON.stringify({
          available: true,
          state: { ...old, pending: null, revision: 3 },
        }),
      ),
    );
    await saving;
  });
  expect(result.current.state.revision).toBe(0);
  expect(result.current.state.decisions).toEqual([]);
  unmount();
});


it("selects a draft mode without a network call or starting work", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const { result, unmount } = renderHook(() => useCollaboration(null, true));
  await act(async () => { expect(await result.current.setMode("delegated")).toBe(true); });
  expect(result.current.state.mode).toBe("delegated");
  expect(result.current.state.execution).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
  unmount();
});

it("persists the selected draft mode before its first prompt and heartbeat", async () => {
  const requests: Record<string, unknown>[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push(body);
    return new Response(JSON.stringify({ available: true, state: { ...defaultCollaboration,
      mode: requests.some(item => item.action === "mode") ? "delegated" : "collaborative",
      revision: requests.some(item => item.action === "mode") ? 1 : 0 } }));
  });
  expect(await prepareCollaborationSend("created", "delegated")).toBe(1);
  expect(requests.map(item => item.action ?? "read")).toEqual(["read", "mode", "heartbeat"]);
  expect(requests[1]).toEqual({ action: "mode", mode: "delegated", revision: 0 });
  expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("prompt"))).toBe(true);
});

it("a failed first-send mode save prevents the execution heartbeat", async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push(body.action ?? "read");
    return new Response(JSON.stringify(body.action === "mode" ? { error: "Mode changed" } : { available: true, state: defaultCollaboration }), { status: body.action === "mode" ? 409 : 200 });
  });
  await expect(prepareCollaborationSend("created", "delegated")).rejects.toThrow("Mode changed");
  expect(requests).toEqual(["read", "mode"]);
});

it("an existing conversation send preserves Guided without resaving its mode", async () => {
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push(body.action ?? "read");
    return new Response(JSON.stringify({ available: true, state: { ...defaultCollaboration, mode: "delegated", revision: 4 } }));
  });
  expect(await prepareCollaborationSend("existing")).toBe(4);
  expect(requests).toEqual(["read", "heartbeat"]);
});

it("defaults new Web drafts to Full autonomy", () => {
  expect(defaultCollaboration.mode).toBe("autonomous");
});
