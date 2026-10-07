// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthSessionState, type EnvironmentId, type ServerInstallation } from "@supacode/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  continueThreadsAfterServerUpdate: false,
  session: null as AsyncResult.AsyncResult<AuthSessionState, Error> | null,
  sessionAtom: Symbol("session"),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: (options: { onCopy: (context: { command: string }) => void }) => ({
    copyToClipboard: (command: string, context: { command: string }) => {
      testState.clipboard(command);
      options.onCopy(context);
    },
  }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => selector({ continueThreadsAfterServerUpdate: testState.continueThreadsAfterServerUpdate }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.session }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => testState.session },
}));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => testState.sessionAtom },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import {
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
} from "~/confirmDialog";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetConfirmDialogForTests();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  resetConfirmDialogForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mountAction(props: ComponentProps<typeof ServerUpdateAction>) {
  root = createRoot(container);
  act(() => root!.render(<ServerUpdateAction {...props} />));
  return container.querySelector("button")!;
}

async function press(button: HTMLButtonElement, at: number) {
  const event = new MouseEvent("click", { bubbles: true });
  Object.defineProperty(event, "timeStamp", { value: at + 1 });
  await act(async () => {
    button.dispatchEvent(event);
  });
}

function renderAction() {
  return mountAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.31",
  });
}

function click(button: HTMLButtonElement) {
  act(() => button.click());
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "supacode_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    testState.clipboard.mockReset();
    testState.continueThreadsAfterServerUpdate = false;
    testState.session = AsyncResult.success(currentSession);
  });

  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      testState.session = AsyncResult.success(
        decodeSessionState({
          ...currentSession,
          scopes,
          auth: {
            ...legacyAuth,
            ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
          },
        }),
      );
      testState.updateServer.mockResolvedValue(
        AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
      );

      click(renderAction());
      await flushPromises();

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("keeps a known grant usable while the session refreshes", async () => {
    testState.session = AsyncResult.waiting(AsyncResult.success(currentSession));
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    click(renderAction());
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledOnce();
  });

  it("does not dispatch an update after maintenance access is removed", async () => {
    const action = renderAction();
    testState.session = AsyncResult.success({ ...currentSession, scopes: [] });
    click(action);
    await flushPromises();
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it.each([
    [
      { kind: "npm-global", prefix: "/opt/node" },
      "npm install --global --prefix '/opt/node' supacode@0.0.45",
      "Update command copied",
      "then restart supacode",
    ],
    [
      { kind: "npx" },
      "npx supacode@0.0.45",
      "Relaunch command copied",
      "This does not update an installed supacode command.",
    ],
    [
      undefined,
      "npx supacode@0.0.45",
      "Relaunch command copied",
      "This does not update an installed supacode command.",
    ],
  ] satisfies ReadonlyArray<readonly [ServerInstallation | undefined, string, string, string]>)(
    "copies an honest manual command for %j without invoking remote update",
    (installation, command, title, guidance) => {
      const action = mountAction({
        environmentId: "env-test" as EnvironmentId,
        serverLabel: "Test server",
        selfUpdate: null,
        installation,
        targetVersion: "0.0.45",
      });
      click(action);
      expect(testState.clipboard).toHaveBeenCalledWith(command);
      expect(testState.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title,
          description: expect.stringContaining(guidance),
        }),
      );
      expect(testState.updateServer).not.toHaveBeenCalled();
    },
  );

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    click(renderAction());
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on supacode@0.0.31.",
    });
  });

  it("reports one result when the update action is double-clicked", async () => {
    let finishUpdate: (() => void) | undefined;
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () =>
            resolve(
              AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
            );
        }),
    );

    const action = renderAction();
    click(action);
    click(action);

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    click(renderAction());
    await flushPromises();

    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("keeps the manual instruction for desktop servers without remote update support", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateAction
        environmentId={"env-test" as EnvironmentId}
        serverLabel="Test server"
        selfUpdate="desktop-managed"
        targetVersion="0.0.31"
      />,
    );

    expect(markup).toContain("Update the desktop app on that machine to update this server.");
    expect(markup).not.toContain("<button");
  });

  it.each(["button", "icon"] as const)(
    "confirms remote desktop updates in the same %s before updating",
    async (appearance) => {
      registerConfirmDialogHost();
      testState.updateServer.mockResolvedValue(
        AsyncResult.success({ targetVersion: "0.0.34", method: "desktop-app" as const }),
      );

      const button = mountAction({
        environmentId: "env-test" as EnvironmentId,
        serverLabel: "Test server",
        selfUpdate: "desktop-managed",
        desktopAppUpdate: true,
        targetVersion: "0.0.31",
        appearance,
      });
      await press(button, 0);
      expect(testState.updateServer).not.toHaveBeenCalled();
      expect(readConfirmDialogState()).toEqual({ status: "idle" });
      expect(container.querySelector("button")).toBe(button);
      expect(
        appearance === "icon" ? button.getAttribute("aria-label") : button.textContent,
      ).toContain("Confirm update");
      await press(button, 200);
      expect(testState.updateServer).not.toHaveBeenCalled();
      await press(button, 500);

      expect(testState.updateServer).toHaveBeenCalledWith({
        environmentId: "env-test",
        input: { targetVersion: "0.0.31" },
      });
      expect(testState.toast).toHaveBeenCalledWith({
        type: "success",
        title: "Test server updated",
        description: "Desktop app relaunched on 0.0.34.",
      });
    },
  );

  it("cancels an armed desktop update on Escape", async () => {
    const button = mountAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: "0.0.31",
    });
    await press(button, 0);
    act(() => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await press(button, 500);
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("rechecks maintenance access when an armed desktop update is confirmed", async () => {
    const button = mountAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: "0.0.31",
    });
    await press(button, 0);
    testState.session = AsyncResult.success({ ...currentSession, scopes: [] });
    await press(button, 500);
    expect(testState.updateServer).not.toHaveBeenCalled();
  });

  it("leaves thread continuation off by default", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    const action = mountAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      threadContinuation: true,
      targetVersion: "0.0.31",
    });

    click(action);
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
  });

  it("applies the saved thread continuation preference automatically", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    testState.continueThreadsAfterServerUpdate = true;
    const action = mountAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "boot-service",
      threadContinuation: true,
      targetVersion: "0.0.31",
    });

    click(action);
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31", continueRunningThreads: true },
    });
  });
});

describe("ServerUpdatesAction", () => {
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: true,
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: false,
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];
  const success = AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const });

  async function mount(batch = targets) {
    await act(async () => {
      root = createRoot(container);
      root.render(<ServerUpdatesAction targets={batch} />);
    });
    return container.querySelector("button")!;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    testState.session = AsyncResult.success(currentSession);
    resetConfirmDialogForTests();
  });

  it("updates both supported machines with their own continuation preference and skips the manual machine", async () => {
    testState.updateServer.mockResolvedValue(success);
    const button = await mount();
    await act(async () => {
      button.click();
    });

    expect(testState.updateServer.mock.calls.map(([target]) => target)).toEqual([
      {
        environmentId: "batch-a",
        input: { targetVersion: "0.0.31", continueRunningThreads: true },
      },
      { environmentId: "batch-b", input: { targetVersion: "0.0.31" } },
    ]);
    expect(testState.toast.mock.calls.map(([toast]) => toast.title)).toEqual([
      "Laptop updated",
      "Office updated",
    ]);
  });

  it("names a failed machine while letting the other machine complete", async () => {
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success);
    const button = await mount();
    await act(async () => {
      button.click();
    });

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button.disabled).toBe(false);
  });

  it("starts each machine once when double-clicked and disables the action until both finish", async () => {
    const completions: Array<() => void> = [];
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve(success));
        }),
    );
    const button = await mount();
    await act(async () => {
      button.click();
      button.click();
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(true);
    await act(async () => {
      completions[0]!();
    });
    expect(button.disabled).toBe(true);
    await act(async () => {
      completions[1]!();
    });
    expect(button.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledTimes(2);
  });

  it("confirms a batch containing desktop machines in place before updating any machine", async () => {
    registerConfirmDialogHost();
    testState.updateServer.mockResolvedValue(success);
    const batch = targets.map((target, index) =>
      index === 0
        ? { ...target, selfUpdate: "desktop-managed" as const, desktopAppUpdate: true }
        : target,
    );
    root = createRoot(container);
    act(() => root!.render(<ServerUpdatesAction targets={batch} />));
    const button = container.querySelector("button")!;
    await press(button, 0);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    expect(testState.updateServer).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await press(button, 500);
    expect(testState.updateServer).not.toHaveBeenCalled();
    await press(button, 1000);
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button.disabled).toBe(false);
  });
});

describe("ServerUpdateProgress", () => {
  it("shows one calm status row for the restart wait", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Restarting…");
    // The wait state is monochrome and calm: no versions, no step rail, no
    // success/warning colors, one duty-cycled pulse on the dot.
    expect(markup).not.toContain("0.0.30");
    expect(markup).not.toContain("Resum");
    expect(markup).not.toContain("text-success");
    expect(markup).not.toContain("text-primary");
    expect(markup).toContain("animate-status-pulse");
    expect(markup).not.toContain("animate-spin");
  });

  it("folds the sub-second installing handoff into the download phase", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Downloading…");
    expect(markup).not.toContain("Install");
  });

  it("keeps the failure visible with its retryable error", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
    expect(markup).not.toContain("animate-status-pulse");
  });
});
