import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  updateUsage: vi.fn(async (_ids: ReadonlySet<string>) => {}),
  save: vi.fn(async () => "cached" as const),
}));
vi.mock("./draftAttachmentByteStorage", () => ({
  createDraftAttachmentByteStorage: () => ({ updateUsage: mocks.updateUsage, save: mocks.save }),
}));
import { draftAttachmentBytes } from "./draftAttachmentBytes";

beforeEach(() => {
  mocks.updateUsage.mockClear();
  mocks.save.mockReset().mockResolvedValue("cached");
});

it("coalesces a burst of holds without dropping attachments still in use", async () => {
  const releaseFirst = draftAttachmentBytes.hold(["first"]);
  const releaseSecond = draftAttachmentBytes.hold(["second"]);
  releaseFirst();
  await Promise.resolve();
  expect(mocks.updateUsage).toHaveBeenCalledTimes(1);
  expect(mocks.updateUsage.mock.calls[0]?.[0]).toEqual(new Set(["second"]));
  releaseSecond();
  await Promise.resolve();
  expect(mocks.updateUsage).toHaveBeenCalledTimes(2);
  expect(mocks.updateUsage.mock.calls[1]?.[0]).toEqual(new Set());
});

it("pins saved bytes in the atomic save transaction without a separate hold write", async () => {
  const file = new File(["clipboard"], "notes.txt", { type: "text/plain" });
  await draftAttachmentBytes.save("file", file);
  expect(mocks.save).toHaveBeenCalledWith("file", file, new Set(["file"]));
  expect(mocks.updateUsage).toHaveBeenCalledTimes(1);
  expect(mocks.updateUsage.mock.calls[0]?.[0]).toEqual(new Set());
});
