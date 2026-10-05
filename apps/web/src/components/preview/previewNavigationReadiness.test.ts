import { EnvironmentId, ThreadId } from "@supacode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readThreadPreviewState: vi.fn(),
}));

vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: vi.fn(),
  readThreadPreviewState: mocks.readThreadPreviewState,
  reconcilePreviewServerSessions: vi.fn(),
  updatePreviewServerSnapshot: vi.fn(),
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    automation: {
      evaluate: vi.fn(),
      status: vi.fn(),
    },
  },
}));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import {
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationPausedHostError,
} from "./previewAutomationErrors";
import { previewBridge } from "./previewBridge";
import { waitForNavigationReadiness } from "./previewNavigationReadiness";

describe("waitForNavigationReadiness", () => {
  it.each(["load", "domContentLoaded", "none"] as const)(
    "rejects private input pause while waiting for %s readiness",
    async (readiness) => {
      vi.clearAllMocks();
      const threadRef = {
        environmentId: EnvironmentId.make("environment-2"),
        threadId: ThreadId.make("thread-1"),
      };
      const tabId = "tab_1";
      mocks.readThreadPreviewState.mockReturnValue({
        serverEpoch: "epoch-1",
        sessions: { [tabId]: { tabId } },
      });
      vi.mocked(previewBridge!.automation.status).mockResolvedValue({
        available: true,
        visible: true,
        tabId,
        automationPaused: true,
        loading: false,
        url: null,
        title: null,
      });
      await expect(
        waitForNavigationReadiness(
          threadRef,
          "request-paused",
          tabId,
          previewRuntimeTabId(threadRef, "epoch-1", tabId),
          "navigate",
          readiness,
          100,
        ),
      ).rejects.toBeInstanceOf(PreviewAutomationPausedHostError);
      expect(previewBridge!.automation.evaluate).not.toHaveBeenCalled();
    },
  );

  it("rejects a replaced runtime target even when readiness polling is disabled", async () => {
    const threadRef = {
      environmentId: EnvironmentId.make("environment-2"),
      threadId: ThreadId.make("thread-1"),
    };
    const tabId = "tab_1";
    const staleRuntimeTabId = previewRuntimeTabId(threadRef, "epoch-1", tabId);
    mocks.readThreadPreviewState.mockReturnValue({
      serverEpoch: "epoch-2",
      sessions: {
        [tabId]: { tabId },
      },
    });

    await expect(
      waitForNavigationReadiness(
        threadRef,
        "request-1",
        tabId,
        staleRuntimeTabId,
        "navigate",
        "none",
        100,
      ),
    ).rejects.toBeInstanceOf(PreviewAutomationTargetUnavailableError);
  });
});
