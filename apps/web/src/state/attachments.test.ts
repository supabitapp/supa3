import { EnvironmentId } from "@supacode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  download: vi.fn(),
  scope: vi.fn(),
  connection: vi.fn(),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("@supacode/client-runtime/state/attachments", async (original) => ({
  ...(await original<typeof import("@supacode/client-runtime/state/attachments")>()),
  createAttachmentEnvironmentAtoms: () => ({}),
}));
vi.mock("@supacode/client-runtime/state/runtime", () => ({
  executeAtomQuery: mocks.query,
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("./assets", () => ({ assetEnvironment: { createUrl: (input: unknown) => input } }));
vi.mock("./session", () => ({
  readEnvironmentScope: mocks.scope,
  readPreparedConnection: mocks.connection,
}));
vi.mock("../lib/downloadAttachmentBytes", async (original) => ({
  ...(await original<typeof import("../lib/downloadAttachmentBytes")>()),
  downloadAttachmentBytes: mocks.download,
}));

import { AttachmentSourceMissingError } from "../lib/downloadAttachmentBytes";
import { recoverAttachmentSource } from "./attachments";

const input = {
  environmentId: EnvironmentId.make("original"),
  attachmentId: "source-file",
  type: "file" as const,
  name: "clipboard.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
};
const file = new File(["abc"], input.name, { type: input.mimeType });

beforeEach(() => {
  mocks.query
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/signed/source-file" } });
  mocks.download.mockReset().mockResolvedValue(file);
  mocks.scope.mockReset().mockReturnValue(true);
  mocks.connection.mockReset().mockReturnValue({ httpBaseUrl: "https://original.example/" });
});

describe("attachment source recovery", () => {
  it("mints a fresh source URL and downloads within the generic file limit", async () => {
    expect(await recoverAttachmentSource({ ...input, signal: new AbortController().signal })).toBe(
      file,
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ environmentId: input.environmentId }),
      expect.objectContaining({ refresh: true }),
    );
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://original.example/signed/source-file",
        sizeBytes: 3,
        maxBytes: 50 * 1024 * 1024,
      }),
    );
  });
  it("refuses an original-machine read without its grant", async () => {
    mocks.scope.mockReturnValue(false);
    await expect(
      recoverAttachmentSource({ ...input, signal: new AbortController().signal }),
    ).rejects.toThrow("cannot read");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("distinguishes a confirmed expired source from reconnect failures", async () => {
    mocks.query.mockResolvedValue({
      _tag: "Failure",
      error: { _tag: "AssetAttachmentNotFoundError" },
    });
    await expect(
      recoverAttachmentSource({ ...input, signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(AttachmentSourceMissingError);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("discards a download when the source connection changes", async () => {
    mocks.connection
      .mockReturnValueOnce({ httpBaseUrl: "https://original.example/" })
      .mockReturnValue({ httpBaseUrl: "https://replacement.example/" });
    await expect(
      recoverAttachmentSource({ ...input, signal: new AbortController().signal }),
    ).rejects.toThrow("connection changed");
  });
  it("discards completed bytes after the owning operation is cancelled", async () => {
    const controller = new AbortController();
    mocks.download.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(file);
    });
    await expect(
      recoverAttachmentSource({ ...input, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
