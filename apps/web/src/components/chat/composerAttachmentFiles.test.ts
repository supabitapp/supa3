import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@supacode/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isVideoAttachment, videoMimeType } from "../../types";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  composerOtherFilesForPresentation,
  composerImagesForAttachmentTray,
  fileAttachmentStagingLimit,
  inferImageMimeTypeFromName,
  isPreviewableComposerVideo,
  normalizeComposerImageFileMimeType,
  shouldHandleComposerAttachmentPaste,
  prepareComposerAttachmentFiles,
} from "./composerAttachmentFiles";

describe("composer attachment files", () => {
  it.each(["session-only", "restore-failed", "missing"] as const)(
    "exposes an annotation screenshot requiring %s attention",
    (byteState) => {
      const image: ComposerImageAttachment = {
        type: "image",
        id: "screenshot",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 1,
        file: null,
        previewUrl: "",
        byteState,
      };
      expect(composerImagesForAttachmentTray([image], [{ id: image.id }], {})).toEqual([image]);
      expect(
        composerImagesForAttachmentTray(
          [{ ...image, byteState: "cached", file: new File(["x"], image.name) }],
          [{ id: image.id }],
          {},
        ),
      ).toEqual([]);
    },
  );
  it("admits unavailable-image replacements at capacity before compression", () => {
    const image = new File(["new bytes"], "missing.png", { type: "image/png" });
    const unavailable: ComposerImageAttachment = {
      type: "image",
      id: "missing",
      name: image.name,
      mimeType: image.type,
      sizeBytes: 999,
      file: null,
      previewUrl: "",
      byteState: "missing",
    };
    const accepted = prepareComposerAttachmentFiles({
      files: [image, new File(["x"], "new.png", { type: "image/png" }), image],
      attachments: [unavailable],
      reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      fileStagingLimit: 50 * 1024 * 1024,
    });
    expect(accepted.images).toEqual([image]);
    expect(accepted.files).toEqual([]);
    expect(accepted.error).toContain(`${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files`);
  });

  it.each([
    {
      name: "photo.HEIC",
      type: "image/heic",
      retainedName: "photo.jpg",
      retainedType: "image/jpeg",
    },
    {
      name: "large.png",
      type: "image/png",
      retainedName: "large.webp",
      retainedType: "image/webp",
    },
  ])(
    "allows $name to reach conversion before final replacement admission",
    ({ name, type, retainedName, retainedType }) => {
      const picked = new File(["source bytes"], name, { type });
      const unavailable: ComposerImageAttachment = {
        type: "image",
        id: "missing",
        name: retainedName,
        mimeType: retainedType,
        sizeBytes: 3,
        file: null,
        previewUrl: "",
        byteState: "missing",
      };
      const accepted = prepareComposerAttachmentFiles({
        files: [picked],
        attachments: [unavailable],
        reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        fileStagingLimit: null,
      });
      expect(accepted.images).toEqual([picked]);
      expect(accepted.error).toBeNull();
      expect(
        prepareComposerAttachmentFiles({
          files: [picked],
          attachments: [unavailable],
          reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1,
          pendingImageCount: 1,
          fileStagingLimit: null,
        }).images,
      ).toEqual([]);
    },
  );

  it("reserves a replacement once while allowing another pick into the last free slot", () => {
    const image = new File(["bytes"], "missing.png", { type: "image/png" });
    const unavailable: ComposerImageAttachment = {
      type: "image",
      id: "missing",
      name: image.name,
      mimeType: image.type,
      sizeBytes: image.size,
      file: null,
      previewUrl: "",
      byteState: "restore-failed",
    };
    const unique = new File(["x"], "new.png", { type: "image/png" });
    const accepted = prepareComposerAttachmentFiles({
      files: [image, unique],
      attachments: [unavailable],
      reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
      fileStagingLimit: null,
    });
    expect(accepted.images).toEqual([image, unique]);
    expect(accepted.error).toBeNull();
  });

  it("admits a file with unreadable cached bytes under a fresh identity at capacity", () => {
    const file = new File(["bytes"], "report.txt", { type: "text/plain" });
    const unavailable: ComposerFileAttachment = {
      type: "file",
      id: "failed",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file: null,
      byteState: "restore-failed",
    };
    const accepted = prepareComposerAttachmentFiles({
      files: [file],
      attachments: [unavailable],
      reservedCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
      fileStagingLimit: 50 * 1024 * 1024,
    });
    expect(accepted.files).toHaveLength(1);
    expect(accepted.files[0]?.id).not.toBe(unavailable.id);
    expect(accepted.files[0]?.file).toBe(file);
    expect(accepted.error).toBeNull();
  });

  it("keeps inline non-media files out of the legacy attachment row", () => {
    const environmentId = EnvironmentId.make("env-1");
    const files = [
      {
        type: "file" as const,
        id: "inline-file",
        name: "inline.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        file: new File(["inline"], "inline.txt", { type: "text/plain" }),
      },
      {
        type: "file" as const,
        id: "legacy-file",
        name: "legacy.zip",
        mimeType: "application/zip",
        sizeBytes: 24,
        file: new File(["legacy"], "legacy.zip", { type: "application/zip" }),
      },
    ];

    expect(
      composerOtherFilesForPresentation(files, environmentId, new Set(["inline-file"])),
    ).toEqual([files[1]]);
  });

  it("keeps supported images and HEIC photos on the image path", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.png", type: "image/png" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "photo.heic", type: "" })).toBe("image");
  });

  it("rejects unsupported image types instead of attaching them as generic files", () => {
    expect(classifyComposerAttachmentFile({ name: "diagram.svg", type: "image/svg+xml" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "photo.tiff", type: "image/tiff" })).toBe(
      "unsupported-image",
    );
    expect(classifyComposerAttachmentFile({ name: "report.pdf", type: "application/pdf" })).toBe(
      "file",
    );
  });

  it("preserves text paste when an application adds a synthetic generic file", () => {
    const file = new File(["clipboard"], "clipboard.rtf", { type: "application/rtf" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file],
        plainText: "Copied text",
      }),
    ).toBe(false);
  });

  it("claims unsupported image pastes so the composer can report them", () => {
    const images = [
      new File(["svg"], "diagram.svg", { type: "image/svg+xml" }),
      new File(["tiff"], "photo.tiff", { type: "image/tiff" }),
    ];

    for (const image of images) {
      expect(
        shouldHandleComposerAttachmentPaste({
          files: [image],
          plainText: "Image caption",
        }),
      ).toBe(true);
    }
  });

  it("claims generic file-only pastes so the composer can report validation errors", () => {
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });

    expect(shouldHandleComposerAttachmentPaste({ files: [file], plainText: "" })).toBe(true);
  });

  it("routes empty and oversized generic files to composer feedback", () => {
    const empty = new File([], "empty.txt", { type: "text/plain" });
    const oversized = new File([new Uint8Array(1024)], "large.zip", {
      type: "application/zip",
    });

    expect(shouldHandleComposerAttachmentPaste({ files: [empty], plainText: "" })).toBe(true);
    expect(shouldHandleComposerAttachmentPaste({ files: [oversized], plainText: "" })).toBe(true);
  });

  it("ignores an empty clipboard", () => {
    expect(shouldHandleComposerAttachmentPaste({ files: [], plainText: "" })).toBe(false);
  });

  it("falls back to the extension when an image arrives without a MIME type", () => {
    expect(classifyComposerAttachmentFile({ name: "photo.jpg", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "shot.PNG", type: "" })).toBe("image");
    expect(classifyComposerAttachmentFile({ name: "archive.zip", type: "" })).toBe("file");
    expect(classifyComposerAttachmentFile({ name: "no-extension", type: "" })).toBe("file");
    expect(inferImageMimeTypeFromName("photo.jpg")).toBe("image/jpeg");
    expect(inferImageMimeTypeFromName("archive.zip")).toBeNull();
  });

  it("infers supported image types from octet-stream files", () => {
    const jpeg = new File(["jpeg"], "photo.jpg", { type: "application/octet-stream" });
    const png = new File(["png"], "shot.PNG", { type: "application/octet-stream" });

    expect(classifyComposerAttachmentFile(jpeg)).toBe("image");
    expect(classifyComposerAttachmentFile(png)).toBe("image");
    expect(normalizeComposerImageFileMimeType(jpeg).type).toBe("image/jpeg");
    expect(normalizeComposerImageFileMimeType(png).type).toBe("image/png");
  });

  it("does not infer images for unknown extensions or specific conflicting MIME types", () => {
    const binary = new File(["binary"], "archive.bin", { type: "application/octet-stream" });
    const unknownDocument = new File(["pdf"], "report.pdf", {
      type: "application/octet-stream",
    });
    const document = new File(["pdf"], "photo.jpg", { type: "application/pdf" });
    const explicitImage = new File(["png"], "photo.jpg", { type: "image/png" });

    expect(classifyComposerAttachmentFile(binary)).toBe("file");
    expect(classifyComposerAttachmentFile(unknownDocument)).toBe("file");
    expect(classifyComposerAttachmentFile(document)).toBe("file");
    expect(classifyComposerAttachmentFile(explicitImage)).toBe("image");
    expect(normalizeComposerImageFileMimeType(binary)).toBe(binary);
    expect(normalizeComposerImageFileMimeType(document)).toBe(document);
    expect(normalizeComposerImageFileMimeType(explicitImage)).toBe(explicitImage);
  });

  it("uses the hard local limit while server config is unknown", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  });

  it("rejects local staging when known config has no file support", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: null,
      }),
    ).toBeNull();
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: 50 * 1024 * 1024,
      }),
    ).toBeNull();
  });

  it("uses the confirmed server limit without exceeding the hard cap", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: 1024 * 1024,
      }),
    ).toBe(1024 * 1024);
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: true,
        maxFileAttachmentBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  });

  it("keeps draft-persisted file uploads when the upload capability flips off", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image-1",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl: "blob:photo",
      file: new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }),
    };
    const uploadingFile: ComposerFileAttachment = {
      type: "file",
      id: "file-uploading",
      name: "fresh.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File([new Uint8Array([1, 2, 3])], "fresh.pdf", { type: "application/pdf" }),
    };
    const hydratedFile: ComposerFileAttachment = {
      type: "file",
      id: "file-hydrated",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "pending-report-pdf",
      uploadEnvironmentId: environmentId,
    };
    const uploadedLocalFile: ComposerFileAttachment = {
      ...uploadingFile,
      id: "file-uploaded-local",
      uploadedAttachmentId: "pending-fresh-pdf",
      uploadEnvironmentId: environmentId,
    };

    const released = attachmentsToReleaseOnUploadCapabilityLoss([
      image,
      uploadingFile,
      hydratedFile,
      uploadedLocalFile,
    ]);

    expect(released.map((attachment) => attachment.id)).toEqual(["image-1", "file-uploading"]);
  });

  it("keeps restored videos on the preview path in their upload environment", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const video: ComposerFileAttachment = {
      type: "file",
      id: "video-1",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 3,
      file: null,
      uploadedAttachmentId: "uploaded-video-1",
      uploadEnvironmentId: environmentId,
    };

    expect(isPreviewableComposerVideo(video, environmentId)).toBe(true);
    expect(isPreviewableComposerVideo(video, EnvironmentId.make("environment-2"))).toBe(false);
  });

  it("recognizes common video extensions when the browser omits the MIME type", () => {
    const formats = [
      ["clip.mp4", "video/mp4"],
      ["clip.mov", "video/quicktime"],
      ["clip.webm", "video/webm"],
      ["clip.m4v", "video/mp4"],
      ["clip.mkv", "video/x-matroska"],
      ["clip.avi", "video/x-msvideo"],
      ["clip.ogv", "video/ogg"],
    ] as const;

    for (const [name, expectedMimeType] of formats) {
      expect(
        isVideoAttachment({
          type: "file",
          id: name,
          name,
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        }),
      ).toBe(true);
      expect(videoMimeType({ name, mimeType: "application/octet-stream" })).toBe(expectedMimeType);
    }
  });

  it("claims image pastes even when clipboard text is present", () => {
    const image = new File(["image"], "photo.heic", { type: "image/heic" });

    expect(
      shouldHandleComposerAttachmentPaste({
        files: [image],
        plainText: "Image caption",
      }),
    ).toBe(true);
  });
});
