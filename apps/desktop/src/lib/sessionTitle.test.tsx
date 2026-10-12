import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@ai4s/sdk";
import { useSessionTitles } from "./sessionTitle";
vi.mock("./webMode", () => ({ isGatewayWeb: true }));
const pending = (deadline: number): SessionMeta => ({ id: "pending", title: "New session", titlePresentation: { status: "pending", fallback: "Study spike sorting", pendingUntil: deadline } });
afterEach(() => vi.useRealTimers());

describe("Web session title display", () => {
  it("expires to an excerpt and reads once without blocking task execution", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const refresh = vi.fn(async () => {});
    const session = pending(2000);
    const { result } = renderHook(() => useSessionTitles([session], refresh));
    expect(result.current(session)).toBe("Generating title…");
    await act(() => vi.advanceTimersByTimeAsync(1001));
    expect(result.current(session)).toBe("Study spike sorting");
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows successful/manual titles immediately and never resets the pending clock", () => {
    const { result, rerender } = renderHook(({ session }) => useSessionTitles([session]), { initialProps: { session: pending(Date.now() + 1000) } });
    const titled = { ...pending(1000), title: "Spike sorting comparison", titlePresentation: undefined };
    rerender({ session: titled });
    expect(result.current(titled)).toBe("Spike sorting comparison");
    const manual = { ...titled, title: "New session", metadata: { scikeelSessionTitle: { source: "manual" } } };
    rerender({ session: manual });
    expect(result.current(manual)).toBe("New session");
  });

  it("shows readable labels for interrupted or empty sessions after reopening", () => {
    const session = { ...pending(0), titlePresentation: { status: "fallback" as const } };
    const { result } = renderHook(() => useSessionTitles([session]));
    expect(result.current(session)).toBe("New conversation");
    expect(result.current({ ...session, titlePresentation: { status: "fallback", fallback: "Analyze measurements.csv" } })).toBe("Analyze measurements.csv");
  });
});
