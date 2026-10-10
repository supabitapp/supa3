import {
  FeedbackStartError,
  type FeedbackStartInput,
  type FeedbackStartResult,
} from "@supacode/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@supacode/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BOOT_SERVICE_LOG_FILE } from "../service/bootService.ts";
import { buildTriageContext, buildTriageSeedPrompt } from "./triagePrompt.ts";

const isFeedbackStartError = Schema.is(FeedbackStartError);

export class FeedbackService extends Context.Service<
  FeedbackService,
  {
    readonly start: (
      input: FeedbackStartInput,
      clientProperties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<FeedbackStartResult, FeedbackStartError>;
  }
>()("supacode/feedback/FeedbackService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const launchLock = yield* Semaphore.make(1);

  const start = Effect.fn("FeedbackService.start")(function* (
    input: FeedbackStartInput,
    clientProperties: Readonly<Record<string, unknown>> = {},
  ) {
    const serverSettings = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new FeedbackStartError({ stage: "read-settings", cause })),
    );
    const availableProviders = (yield* providers.getProviders).filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.availability !== "unavailable" &&
        provider.status !== "error" &&
        provider.status !== "disabled" &&
        provider.auth.status !== "unauthenticated",
    );
    const preferred = input.modelSelection ?? serverSettings.defaultModelSelection;
    const preferredProvider = availableProviders.find(
      (provider) => provider.instanceId === preferred?.instanceId,
    );
    const provider =
      preferredProvider ?? availableProviders.find((entry) => entry.models.length > 0);
    const defaultModel =
      provider?.models.find((model) => model.isDefault) ??
      provider?.models.find((model) => !model.isLegacy) ??
      provider?.models[0];
    const modelSelection =
      preferredProvider && preferred
        ? preferred
        : provider && defaultModel
          ? { instanceId: provider.instanceId, model: defaultModel.slug }
          : null;
    if (modelSelection === null) {
      return yield* new FeedbackStartError({
        stage: "choose-provider",
        cause: new Error("No available provider model."),
      });
    }

    const { projectId } = yield* managedFolders.ensureScratchProject.pipe(
      Effect.mapError((cause) => new FeedbackStartError({ stage: "launch-thread", cause })),
    );
    const creationSource = clientProperties.surface === "mobile" ? "mobile" : "web";
    const directory = yield* Effect.gen(function* () {
      const receipt = yield* receipts.getByCommandId(input.commandId);
      if (Option.isSome(receipt)) {
        if (
          receipt.value.status !== "accepted" ||
          receipt.value.commandType !== "thread.create" ||
          receipt.value.threadId !== input.threadId
        ) {
          return yield* new FeedbackStartError({
            stage: "launch-thread",
            cause: new Error("This feedback request cannot be replayed."),
          });
        }
        const thread = yield* threads.getThreadShell(input.threadId);
        if (thread?.projectId !== projectId || thread.worktreePath === null) {
          return yield* new FeedbackStartError({
            stage: "launch-thread",
            cause: new Error("The feedback thread has no workspace folder."),
          });
        }
        return thread.worktreePath;
      }
      const folder = yield* managedFolders.folderForThread({
        projectId,
        threadId: input.threadId,
        text: "Supacode feedback",
      });
      if (Option.isNone(folder)) {
        return yield* new FeedbackStartError({
          stage: "launch-thread",
          cause: new Error("The feedback project has no scratch folder."),
        });
      }
      return folder.value;
    }).pipe(
      Effect.mapError((cause) =>
        isFeedbackStartError(cause)
          ? cause
          : new FeedbackStartError({ stage: "launch-thread", cause }),
      ),
    );
    const instructions = yield* Effect.gen(function* () {
      const contextPath = path.join(directory, "feedback-context.md");
      const promptPath = path.join(directory, "feedback-guide.md");
      const version = packageJson.version;
      const context = buildTriageContext({
        generatedAt: DateTime.formatIso(yield* DateTime.now),
        version,
        releaseTag: `v${version}`,
        os: `${yield* HostProcessPlatform} ${yield* HostProcessArchitecture}`,
        nodeVersion: process.version,
        launchedAs: "Send feedback",
        server: `running (${config.mode})`,
        paths: {
          ...config,
          serviceLogPath: path.join(config.logsDir, BOOT_SERVICE_LOG_FILE),
          desktopBackendLogGlob: path.join(config.logsDir, "server-child*.log*"),
          sourceCacheDir: path.join(config.baseDir, "source"),
        },
      });
      yield* fs.makeDirectory(directory, { recursive: true });
      const clientContext = Object.entries(clientProperties)
        .map(([key, value]) => `- ${key}: ${String(value)}`)
        .join("\n");
      yield* fs.writeFileString(contextPath, `${context}\n## Client\n\n${clientContext}\n`);
      const prompt = buildTriageSeedPrompt(contextPath, "Send feedback");
      yield* fs.writeFileString(promptPath, prompt);
      return prompt;
    }).pipe(
      Effect.mapError((cause) => new FeedbackStartError({ stage: "prepare-context", cause })),
    );
    const result = yield* launches
      .launch({
        commandId: input.commandId,
        threadId: input.threadId,
        projectId,
        title: "Supacode feedback",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "existing_worktree", worktreePath: directory },
        initialMessage: {
          text: "I'd like to send feedback about Supacode. Start by asking me what happened.",
          attachments: [],
          context: { version: 1, records: [], instructions },
        },
        createdBy: "user",
        creationSource,
      })
      .pipe(Effect.mapError((cause) => new FeedbackStartError({ stage: "launch-thread", cause })));
    return { threadId: result.threadId };
  }, launchLock.withPermit);

  return FeedbackService.of({ start });
});

export const layer = Layer.effect(FeedbackService, make);
