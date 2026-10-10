import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "./runtime";
import { toast, useToastStore } from "./toast";
import { useNotificationScope } from "./useNotificationScope";
vi.mock("./webMode", async importOriginal => ({ ...await importOriginal<typeof import("./webMode")>(), isGatewayWeb: true }));
const original = useRuntimeStore.getState();
afterEach(() => { useRuntimeStore.setState(original, true); useToastStore.getState().reset(); });
describe("notification account lifecycle", () => {
  it("clears old UI and rejects late completions after identity changes", () => {
    useRuntimeStore.setState({ gatewayUser: { id: "one", username: "one", role: "user" } });
    const view = renderHook(() => useNotificationScope());
    act(() => toast.success("Old", { accountId: "one" }));
    act(() => useRuntimeStore.setState({ gatewayUser: { id: "two", username: "two", role: "user" } }));
    act(() => toast.success("Late", { accountId: "one" }));
    expect(useToastStore.getState().accountId).toBe("two"); expect(useToastStore.getState().toasts).toEqual([]); view.unmount();
  });
});
