import { EnvironmentId } from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentPlacementBlockReason,
  automaticAttachmentPlacementBlockReason,
  type AttachmentDestination,
  type AttachmentRequirement,
} from "./attachments.js";

const destination: AttachmentDestination = {
  environmentId: EnvironmentId.make("destination"),
  canUpload: true,
  uploads: true,
  maxFileBytes: 50 * 1024 * 1024,
};
const attachment: AttachmentRequirement = {
  type: "file",
  name: "notes.txt",
  sizeBytes: 100,
  source: { kind: "local" },
};

describe("attachment placement", () => {
  it("allows Auto for an empty draft while every machine is offline", () => {
    expect(
      automaticAttachmentPlacementBlockReason([], [{ destination, connected: false }]),
    ).toBeNull();
  });
  it("reports the connected machine's attachment limit before offline candidates", () => {
    expect(
      automaticAttachmentPlacementBlockReason(
        [attachment],
        [
          { destination: { ...destination, uploads: null }, connected: false },
          { destination: { ...destination, maxFileBytes: 99 }, connected: true },
        ],
      ),
    ).toContain("'notes.txt' exceeds");
  });
  it("allows retained clipboard bytes while the destination reconnects", () => {
    expect(attachmentPlacementBlockReason(attachment, destination)).toBeNull();
  });
  it("allows a recoverable source upload on another machine", () => {
    expect(
      attachmentPlacementBlockReason(
        {
          ...attachment,
          source: {
            kind: "remote",
            environmentId: EnvironmentId.make("source"),
            readable: true,
          },
        },
        destination,
      ),
    ).toBeNull();
  });
  it("allows local images without a live destination connection", () => {
    expect(
      attachmentPlacementBlockReason({ ...attachment, type: "image" }, destination),
    ).toBeNull();
  });
  it("distinguishes unknown capability from a server that cannot accept files", () => {
    expect(attachmentPlacementBlockReason(attachment, { ...destination, uploads: null })).toContain(
      "Waiting for the server",
    );
    expect(
      attachmentPlacementBlockReason(attachment, { ...destination, uploads: false }),
    ).toContain("does not accept");
  });
  it.each([
    [{ ...attachment, source: { kind: "unresolved" } }, destination, "Restoring"],
    [{ ...attachment, source: { kind: "missing" } }, destination, "missing"],
    [
      {
        ...attachment,
        source: { kind: "remote", environmentId: EnvironmentId.make("source"), readable: false },
      },
      destination,
      "original machine",
    ],
    [attachment, { ...destination, canUpload: false }, "cannot send"],
    [attachment, { ...destination, uploads: false }, "does not accept"],
    [attachment, { ...destination, maxFileBytes: 99 }, "attachment limit"],
    [
      { ...attachment, sizeBytes: 51 * 1024 * 1024 },
      { ...destination, maxFileBytes: 100 * 1024 * 1024 },
      "attachment limit",
    ],
  ] satisfies Array<[AttachmentRequirement, AttachmentDestination, string]>)(
    "blocks unresolved, inaccessible or incompatible placement %#",
    (item, target, message) => {
      expect(attachmentPlacementBlockReason(item, target)).toContain(message);
    },
  );
});
