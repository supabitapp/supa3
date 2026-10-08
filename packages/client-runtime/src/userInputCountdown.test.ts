import { describe, expect, it } from "vite-plus/test";
import { userInputCountdown } from "./userInputCountdown.ts";

const now = Date.parse("2026-10-08T12:00:00.000Z");
const deadline = new Date(now + 120_000).toISOString();

describe("question countdown", () => {
  it("counts down in whole seconds and warns for the final twenty", () => {
    expect(userInputCountdown(deadline, now)?.text).toBe("Closes in 2:00");
    expect(userInputCountdown(deadline, now + 60_001)?.text).toBe("Closes in 1:00");
    expect(userInputCountdown(deadline, now + 99_000)?.state).toBe("counting");
    expect(userInputCountdown(deadline, now + 100_000)?.state).toBe("warning");
    expect(userInputCountdown(deadline, now + 119_999)?.text).toBe("Closes in 0:01");
  });
  it("waits for the server at zero and distinguishes a kept-open question", () => {
    expect(userInputCountdown(deadline, now + 120_000)?.text).toBe("Closing…");
    expect(userInputCountdown(deadline, now + 130_000)?.state).toBe("closing");
    expect(userInputCountdown(null, now)?.text).toBe("Kept open");
    expect(userInputCountdown(undefined, now)).toBeNull();
    expect(userInputCountdown("invalid", now)).toBeNull();
  });
});
