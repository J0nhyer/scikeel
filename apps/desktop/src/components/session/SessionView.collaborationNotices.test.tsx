import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAt } from "@/test/render";
import { useRuntimeStore } from "@/lib/runtime";

// COPYCAT RULE: useRuntimeStore is module-global — restore the complete state
// this file found, so no other suite inherits a faked runtime kind or action.
const webMode = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/lib/webMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/webMode")>(),
  get isGatewayWeb() { return webMode.enabled; },
  get isPlatformWeb() { return webMode.enabled; },
}));

const collaboration = vi.hoisted(() => ({
  state: {
    version: 1,
    mode: "collaborative",
    revision: 3,
    execution: 2,
    phase: "idle",
    pending: null,
    decisions: [],
  } as Record<string, unknown>,
  error: null as string | null,
  saving: false,
  answer: vi.fn(),
  pause: vi.fn(),
  discard: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/collaboration", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/collaboration")>(),
  collaborationPollingEnabled: () => true,
  useCollaboration: () => collaboration,
}));

const INITIAL_RUNTIME = useRuntimeStore.getState();
afterEach(() => {
  webMode.enabled = false;
  useRuntimeStore.setState(INITIAL_RUNTIME, true);
  collaboration.state = {
    version: 1,
    mode: "collaborative",
    revision: 3,
    execution: 2,
    phase: "idle",
    pending: null,
    decisions: [],
  };
  vi.clearAllMocks();
});

function renderLive() {
  webMode.enabled = true;
  useRuntimeStore.setState({
    status: "ready",
    sessionListReady: true,
    webReadOnly: false,
    bootstrap: vi.fn(async () => {}),
    gatewayRuntime: "codex",
    providers: [],
    agents: [],
    error: null,
  });
  return renderAt("/live");
}

describe("confirmed research decisions", () => {
  it("stays out of the composer after a decision is stored", async () => {
    collaboration.state = {
      ...collaboration.state,
      decisions: [
        {
          id: "d1",
          execution: 1,
          kind: "plan",
          question: "Use all rows?",
          suggestedAnswer: "Yes",
          answer: "Yes",
        },
      ],
    };
    await act(async () => {
      renderLive();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.queryByText("Confirmed research decisions")).not.toBeInTheDocument();
    expect(screen.queryByText("Use all rows?")).not.toBeInTheDocument();
  });
});
