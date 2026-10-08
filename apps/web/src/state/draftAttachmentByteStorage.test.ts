import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vite-plus/test";

import { createDraftAttachmentByteStorage } from "./draftAttachmentByteStorage";

const DAY = 24 * 60 * 60_000;

function fixture(budgetBytes = 512 * 1024 * 1024) {
  const factory = new IDBFactory();
  let time = 1;
  const create = (actor: string) =>
    createDraftAttachmentByteStorage({
      actor,
      factory: () => factory,
      now: () => time,
      budgetBytes,
    });
  return {
    first: create("first"),
    second: create("second"),
    advance: () => {
      time += DAY;
    },
  };
}

function file(name = "clipboard.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png", lastModified: 10 });
}

describe("draft attachment byte storage", () => {
  it("reconstructs immutable bytes and File metadata in another client", async () => {
    const { first, second } = fixture();
    expect(await first.save("image", file(), new Set())).toBe("cached");
    const restored = await second.load("image", new Set());
    expect(restored?.name).toBe("clipboard.png");
    expect(restored?.type).toBe("image/png");
    expect(restored?.lastModified).toBe(10);
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("never overwrites an immutable cache key held by another tab", async () => {
    const { first, second } = fixture();
    await first.save("original", file(), new Set());
    const changed = new File([new Uint8Array([4, 5, 6])], "clipboard.png", { type: "image/png" });
    await second.save("original", changed, new Set());
    expect(new Uint8Array(await (await first.load("original", new Set()))!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(
      second.save(
        "original",
        new File(["compressed"], "clipboard.png", { type: "image/png" }),
        new Set(),
      ),
    ).rejects.toThrow();
    expect((await first.load("original", new Set()))?.size).toBe(3);
  });

  it("retains saved draft references regardless of age", async () => {
    const { first, advance } = fixture();
    await first.save("draft", file(), new Set());
    await first.releaseUsage();
    advance();
    advance();
    expect(await first.collect(() => new Set(["draft"]))).toBe(0);
    expect(await first.load("draft", new Set())).not.toBeNull();
  });

  it("collects only after the unreferenced grace period", async () => {
    const { first, advance } = fixture();
    await first.save("removed", file(), new Set());
    await first.releaseUsage();
    expect(await first.collect(() => new Set())).toBe(0);
    advance();
    expect(await first.collect(() => new Set())).toBe(3);
    expect(await first.load("removed", new Set())).toBeNull();
  });

  it("a second tab's undo or preview hold prevents collection", async () => {
    const { first, second, advance } = fixture();
    await first.save("undo", file(), new Set());
    await first.releaseUsage();
    await first.collect(() => new Set());
    await second.load("undo", new Set());
    advance();
    expect(await first.collect(() => new Set())).toBe(0);
    await second.releaseUsage();
    await first.collect(() => new Set());
    advance();
    expect(await first.collect(() => new Set())).toBe(3);
  });

  it("retains bytes while reference ownership is unknown", async () => {
    const { first, advance } = fixture();
    await first.save("migration", file(), new Set());
    await first.releaseUsage();
    await first.collect(() => new Set());
    advance();
    expect(await first.collect(() => null)).toBe(0);
    expect(await first.load("migration", new Set())).not.toBeNull();
  });

  it("a live-use transaction wins against a concurrent collection", async () => {
    const { first, second, advance } = fixture();
    await first.save("race", file(), new Set());
    await first.releaseUsage();
    await first.collect(() => new Set());
    advance();
    await second.load("not-present", new Set());
    const restored = second.load("race", new Set());
    const collected = first.collect(() => new Set());
    expect(await restored).not.toBeNull();
    expect(await collected).toBe(0);
  });

  it("refuses admission at budget without evicting another draft", async () => {
    const { first } = fixture(3);
    expect(await first.save("one", file(), new Set())).toBe("cached");
    expect(await first.save("two", file(), new Set())).toBe("budget");
    expect(await first.load("one", new Set())).not.toBeNull();
    expect(await first.load("two", new Set())).toBeNull();
  });

  it("reports unavailable storage without claiming persistence", async () => {
    const storage = createDraftAttachmentByteStorage({
      actor: "unavailable",
      factory: () => undefined,
    });
    await expect(storage.save("image", file(), new Set())).rejects.toThrow("unavailable");
  });
});
