import { expect, it } from "vite-plus/test";
import { unwrapPreviewAutomationResult } from "./AutomationResult.ts";
it("preserves the paused reason through Promise rejection and structured cloning", async () => {
  const reason = await Promise.resolve({
    _tag: "PreviewAutomationPausedError",
    tabId: "private-tab",
  })
    .then(unwrapPreviewAutomationResult)
    .catch((value: unknown) => structuredClone(value));
  expect(reason).not.toBeInstanceOf(Error);
  expect(reason).toMatchObject({
    _tag: "PreviewAutomationPausedError",
    tabId: "private-tab",
    message: expect.stringContaining("Only the user"),
  });
});
