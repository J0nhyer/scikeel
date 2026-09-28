import { describe, expect, it } from "vitest";
import { missingSessionId, screenVisibility } from "./LiveSessionPage";

describe("how a Screen is hidden", () => {
  it("shows the active one", () => {
    const { className, style } = screenVisibility(true, false);
    expect(className).toBe("absolute inset-0");
    expect(style).toBeUndefined();
  });

  it("makes a warm Screen untouchable, not merely unpainted", () => {
    const { className, style } = screenVisibility(false, true);

    // `content-visibility: hidden` skips the subtree's LAYOUT, which is why a
    // warm Screen is cheap to keep. But it leaves the element in the hit-test
    // tree, and a warm Screen is `absolute inset-0` over the live one — so on
    // its own it turns into an invisible sheet that eats every wheel, click and
    // keystroke. `invisible` is what makes it untouchable. Both, or neither
    // works.
    expect(style).toEqual({ contentVisibility: "hidden" });
    expect(className).toContain("invisible");
    // …and NOT display:none, which is what "warm" exists to avoid.
    expect(className).not.toContain("hidden");
  });

  it("drops a cold Screen out of the layout entirely", () => {
    const { className, style } = screenVisibility(false, false);
    expect(className).toContain("hidden");
    expect(style).toBeUndefined();
  });
});

describe("restored Web sessions", () => {
  const sessions = [{ id: "ses_current" }];

  it("waits until the runtime is ready before rejecting a restored session", () => {
    expect(missingSessionId("connecting", false, ["ses_old"], sessions)).toBeNull();
    expect(missingSessionId("ready", false, ["ses_old"], sessions)).toBeNull();
  });

  it("recognizes a URL or restored layout session that the selected CLI does not own", () => {
    expect(missingSessionId("ready", true, ["ses_old"], sessions)).toBe("ses_old");
  });

  it("keeps a session that exists in the selected CLI", () => {
    expect(missingSessionId("ready", true, ["ses_current"], sessions)).toBeNull();
  });
});
