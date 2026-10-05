import { DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER } from "@supacode/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  compositor: vi.fn(),
  stopScreencast: vi.fn(async () => undefined),
  save: vi.fn(async () => ({
    id: "recording",
    tabId: "same-tab",
    path: "/tmp/recording.webm",
    mimeType: "video/webm",
    sizeBytes: 0,
    createdAt: "2026-10-05T00:00:00.000Z",
  })),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    onStateChange: vi.fn(),
    recording: {
      onInput: vi.fn(() => () => undefined),
      startScreencast: async (tabId: string) =>
        Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER)(tabId),
      stopScreencast: mocks.stopScreencast,
      save: mocks.save,
    },
  },
}));
vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: async () => undefined,
  getClientSettings: () => ({
    browserRecordingFrameRate: 30,
    browserRecordingShowMousePresses: true,
    browserRecordingShowKeyPresses: true,
  }),
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("./recordingCompositor", () => ({ createRecordingCompositor: mocks.compositor }));

import {
  discardBrowserRecordingForPrivateInput,
  readActiveBrowserRecordingTabIds,
  startBrowserRecording,
  stopBrowserRecording,
} from "./browserRecording";

class TestRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  state: RecordingState = "inactive";
  mimeType = "video/webm";
  constructor(_stream: MediaStream) {
    super();
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("old startup cleanup cannot stop a fresh recording after private pause and resume", async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("MediaRecorder", TestRecorder);
  const oldStreamStop = vi.fn();
  const freshStreamStop = vi.fn();
  const oldStream = {
    getTracks: () => [{ stop: oldStreamStop }],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
  const freshStream = {
    getTracks: () => [{ stop: freshStreamStop }],
    getVideoTracks: () => [],
  } as unknown as MediaStream;
  const getDisplayMedia = vi
    .fn()
    .mockResolvedValueOnce(oldStream)
    .mockResolvedValueOnce(freshStream);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  let markCompositorStarted: (() => void) | undefined;
  const compositorStarted = new Promise<void>((resolve) => {
    markCompositorStarted = resolve;
  });
  let finishOldCompositor: (() => void) | undefined;
  const oldCompositorReady = new Promise<void>((resolve) => {
    finishOldCompositor = resolve;
  });
  const oldDispose = vi.fn();
  mocks.compositor
    .mockImplementationOnce(async () => {
      markCompositorStarted?.();
      await oldCompositorReady;
      return { stream: oldStream, dispose: oldDispose };
    })
    .mockResolvedValueOnce(null);
  const oldStart = startBrowserRecording("same-tab");
  const oldFailure = expect(oldStart).rejects.toMatchObject({
    _tag: "BrowserRecordingOperationError",
  });
  await compositorStarted;
  discardBrowserRecordingForPrivateInput("same-tab");
  expect(oldStreamStop).toHaveBeenCalled();
  await startBrowserRecording("same-tab");
  finishOldCompositor?.();
  await oldFailure;
  expect(oldDispose).toHaveBeenCalled();
  expect(mocks.stopScreencast).not.toHaveBeenCalled();
  expect(freshStreamStop).not.toHaveBeenCalled();
  expect(readActiveBrowserRecordingTabIds().has("same-tab")).toBe(true);
  await stopBrowserRecording("same-tab");
  expect(mocks.stopScreencast).toHaveBeenCalledOnce();
  expect(freshStreamStop).toHaveBeenCalled();
});

it("does not save a discarded recording when byte materialization finishes after resume", async () => {
  vi.clearAllMocks();
  mocks.compositor.mockResolvedValue(null);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("MediaRecorder", TestRecorder);
  const stream = { getTracks: () => [{ stop: vi.fn() }], getVideoTracks: () => [] };
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia: async () => stream } });
  let bufferStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    bufferStarted = resolve;
  });
  let finishBuffer: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    finishBuffer = resolve;
  });
  vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementationOnce(async () => {
    bufferStarted?.();
    await ready;
    return new ArrayBuffer(0);
  });
  await startBrowserRecording("buffered-tab");
  const stopping = stopBrowserRecording("buffered-tab");
  await started;
  discardBrowserRecordingForPrivateInput("buffered-tab");
  finishBuffer?.();
  expect(await stopping).toBeNull();
  expect(mocks.save).not.toHaveBeenCalled();
});
