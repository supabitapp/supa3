import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createRelayCompanionControl } from "./relayCompanion.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class ControlSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: ControlSocket[] = [];
  static created = deferred<ControlSocket>();
  readyState = 0;
  readonly sent: Array<{ id: string; action: string; address: string }> = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  constructor() {
    super();
    ControlSocket.instances.push(this);
    ControlSocket.created.resolve(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
    this.dispatchEvent(new Event("sent"));
  }
  nextRequest() {
    return new Promise<(typeof this.sent)[number]>((resolve) =>
      this.addEventListener("sent", () => resolve(this.sent.at(-1)!), { once: true }),
    );
  }
  reply(id: string, origin?: string) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, origin }) }));
  }
}

const controls: Array<ReturnType<typeof createRelayCompanionControl>> = [];
const identity = (index: number) => {
  const hex = index.toString(16).padStart(64, "0");
  return `https://${hex.slice(0, 32)}.${hex.slice(32)}.relay.supacode.invalid`;
};
async function connectedControl() {
  const control = createRelayCompanionControl();
  controls.push(control);
  const prepared = control.request("open", identity(1));
  const socket = await ControlSocket.created.promise;
  const opening = socket.nextRequest();
  socket.open();
  socket.reply((await opening).id, "http://127.0.0.1:40000");
  await prepared;
  return { control, socket };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", ControlSocket);
  vi.stubGlobal("location", { href: "http://127.0.0.1:5774/" });
  ControlSocket.instances = [];
  ControlSocket.created = deferred<ControlSocket>();
});
afterEach(() => {
  for (const control of controls.splice(0)) control.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps prepared environments connected when an unrelated request times out", async () => {
  const { control, socket } = await connectedControl();
  const stalled = socket.nextRequest();
  const timedOut = expect(control.request("open", identity(2))).rejects.toThrow("did not respond");
  await stalled;
  await vi.advanceTimersByTimeAsync(15_000);
  await timedOut;
  expect(socket.close).not.toHaveBeenCalled();
  const healthy = control.request("open", identity(1));
  expect(await healthy).toBe("http://127.0.0.1:40000");
  expect(ControlSocket.instances).toHaveLength(1);
});

it("reconciles a late first acquisition before reopening the same address", async () => {
  const { control, socket } = await connectedControl();
  const sent = socket.nextRequest();
  const timedOut = expect(control.request("open", identity(2))).rejects.toThrow("did not respond");
  const original = await sent;
  await vi.advanceTimersByTimeAsync(15_000);
  await timedOut;
  const cleanup = socket.nextRequest();
  socket.reply(original.id, "http://127.0.0.1:40001");
  const closing = await cleanup;
  expect(closing).toMatchObject({ action: "close", address: identity(2) });
  const reopened = socket.nextRequest();
  const retry = control.request("open", identity(2));
  expect(socket.sent.filter((request) => request.address === identity(2))).toHaveLength(2);
  socket.reply(closing.id);
  const opening = await reopened;
  expect(opening).toMatchObject({ action: "open", address: identity(2) });
  socket.reply(opening.id, "http://127.0.0.1:40002");
  expect(await retry).toBe("http://127.0.0.1:40002");
  expect(await control.request("open", identity(1))).toBe("http://127.0.0.1:40000");
  expect(socket.close).not.toHaveBeenCalled();
});

it("waits for a timed-out close before preparing its replacement", async () => {
  const { control, socket } = await connectedControl();
  const closing = socket.nextRequest();
  const timedOut = expect(control.request("close", identity(1))).rejects.toThrow("did not respond");
  const original = await closing;
  await vi.advanceTimersByTimeAsync(15_000);
  await timedOut;
  const opening = socket.nextRequest();
  const replacement = control.request("open", identity(1));
  expect(socket.sent).toHaveLength(2);
  socket.reply(original.id);
  socket.reply((await opening).id, "http://127.0.0.1:40003");
  expect(await replacement).toBe("http://127.0.0.1:40003");
  expect(socket.close).not.toHaveBeenCalled();
});

it("counts timed-out wire operations toward the limit while cached environments still work", async () => {
  const { control, socket } = await connectedControl();
  await vi.advanceTimersByTimeAsync(0);
  const requests = Array.from({ length: 64 }, (_, index) =>
    control.request("open", identity(index + 2)).catch((error: Error) => error),
  );
  await vi.advanceTimersByTimeAsync(15_000);
  expect(
    (await Promise.all(requests)).every(
      (error) => error instanceof Error && error.message.includes("did not respond"),
    ),
  ).toBe(true);
  await expect(control.request("open", identity(100))).rejects.toThrow(
    "Too many companion requests",
  );
  expect(await control.request("open", identity(1))).toBe("http://127.0.0.1:40000");
  expect(socket.close).not.toHaveBeenCalled();
  const cleanup = socket.nextRequest();
  socket.reply(socket.sent[1]!.id, "http://127.0.0.1:40001");
  socket.reply((await cleanup).id);
  await vi.advanceTimersByTimeAsync(0);
  const opening = socket.nextRequest();
  const fresh = control.request("open", identity(100));
  socket.reply((await opening).id, "http://127.0.0.1:40100");
  expect(await fresh).toBe("http://127.0.0.1:40100");
});

it("never reconciles an old socket's reply through a replacement control connection", async () => {
  const { control, socket } = await connectedControl();
  const original = socket.nextRequest();
  const failed = expect(control.request("open", identity(2))).rejects.toThrow("disconnected");
  const oldRequest = await original;
  socket.close();
  await failed;
  ControlSocket.created = deferred<ControlSocket>();
  const retried = control.request("open", identity(2));
  const replacement = await ControlSocket.created.promise;
  const opening = replacement.nextRequest();
  replacement.open();
  const fresh = await opening;
  socket.reply(oldRequest.id, "http://127.0.0.1:40001");
  replacement.reply(fresh.id, "http://127.0.0.1:40004");
  expect(await retried).toBe("http://127.0.0.1:40004");
  expect(replacement.sent).toEqual([fresh]);
});

it("retains an owned close when timed-out jobs fill admission", async () => {
  const { control, socket } = await connectedControl();
  const openingSibling = socket.nextRequest();
  const sibling = control.request("open", identity(2));
  socket.reply((await openingSibling).id, "http://127.0.0.1:40002");
  await sibling;
  await vi.advanceTimersByTimeAsync(0);
  const stalled = Array.from({ length: 64 }, (_, index) =>
    control.request("open", identity(index + 10)).catch((error: Error) => error),
  );
  await vi.advanceTimersByTimeAsync(0);
  const released = control.request("close", identity(1)).catch((error: Error) => error);
  const duplicate = control.request("close", identity(1)).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  await Promise.all(stalled);
  expect(await released).toMatchObject({ message: expect.stringContaining("did not respond") });
  expect(await duplicate).toMatchObject({ message: expect.stringContaining("did not respond") });
  await expect(control.request("open", identity(1))).rejects.toThrow("Too many companion requests");
  expect(await control.request("open", identity(2))).toBe("http://127.0.0.1:40002");
  const cleanup = socket.nextRequest();
  socket.reply(socket.sent[2]!.id, "http://127.0.0.1:40010");
  const recovered = await cleanup;
  const closing = socket.nextRequest();
  socket.reply(recovered.id);
  const ownedClose = await closing;
  expect(ownedClose).toMatchObject({ action: "close", address: identity(1) });
  expect(
    socket.sent.filter((request) => request.action === "close" && request.address === identity(1)),
  ).toHaveLength(1);
  socket.reply(ownedClose.id);
  await vi.advanceTimersByTimeAsync(0);
  const reopened = socket.nextRequest();
  const retry = control.request("open", identity(1));
  socket.reply((await reopened).id, "http://127.0.0.1:40100");
  expect(await retry).toBe("http://127.0.0.1:40100");
  expect(await control.request("open", identity(2))).toBe("http://127.0.0.1:40002");
  expect(socket.close).not.toHaveBeenCalled();
});

it.each(["disconnect", "dispose"])("abandons a deferred close on %s", async (ending) => {
  const { control, socket } = await connectedControl();
  await vi.advanceTimersByTimeAsync(0);
  const stalled = Array.from({ length: 64 }, (_, index) =>
    control.request("open", identity(index + 10)).catch((error: Error) => error),
  );
  const released = control.request("close", identity(1)).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(0);
  if (ending === "dispose") control.close();
  else socket.close();
  await Promise.all(stalled);
  if (ending === "dispose")
    expect(await released).toMatchObject({ message: expect.stringContaining("closed") });
  else expect(await released).toBeUndefined();
  expect(ControlSocket.instances).toHaveLength(1);
  expect(socket.sent.filter((request) => request.action === "close")).toEqual([]);
});

it("keeps a close after an intervening reopen separate from the previous close", async () => {
  const { control, socket } = await connectedControl();
  const initial = socket.nextRequest();
  const released = control.request("close", identity(1));
  socket.reply((await initial).id);
  await released;
  const opening = socket.nextRequest();
  const reopened = control.request("open", identity(1));
  const removedAgain = control.request("close", identity(1));
  const request = await opening;
  const closing = socket.nextRequest();
  socket.reply(request.id, "http://127.0.0.1:40100");
  await reopened;
  const secondClose = await closing;
  expect(secondClose).toMatchObject({ action: "close", address: identity(1) });
  socket.reply(secondClose.id);
  await removedAgain;
});

it("keeps close, reopen, and close ordered after the first close times out", async () => {
  const { control, socket } = await connectedControl();
  const initial = socket.nextRequest();
  const timedOut = expect(control.request("close", identity(1))).rejects.toThrow("did not respond");
  const firstClose = await initial;
  await vi.advanceTimersByTimeAsync(15_000);
  await timedOut;
  const opening = socket.nextRequest();
  const reopened = control.request("open", identity(1));
  const removedAgain = control.request("close", identity(1));
  socket.reply(firstClose.id);
  const request = await opening;
  const closing = socket.nextRequest();
  socket.reply(request.id, "http://127.0.0.1:40100");
  await reopened;
  const finalClose = await closing;
  socket.reply(finalClose.id);
  await removedAgain;
  expect(socket.sent.slice(1).map(({ action }) => action)).toEqual(["close", "open", "close"]);
});

it("orders open, close, and reopen while the control socket is connecting", async () => {
  const control = createRelayCompanionControl();
  controls.push(control);
  const first = control.request("open", identity(1));
  const close = control.request("close", identity(1));
  const reopened = control.request("open", identity(1));
  const socket = await ControlSocket.created.promise;
  const opening = socket.nextRequest();
  socket.open();
  const initial = await opening;
  const closing = socket.nextRequest();
  socket.reply(initial.id, "http://127.0.0.1:40000");
  expect(await first).toBe("http://127.0.0.1:40000");
  const closed = await closing;
  const retry = socket.nextRequest();
  socket.reply(closed.id);
  await close;
  socket.reply((await retry).id, "http://127.0.0.1:40100");
  expect(await reopened).toBe("http://127.0.0.1:40100");
  expect(socket.sent.map(({ action }) => action)).toEqual(["open", "close", "open"]);
});
