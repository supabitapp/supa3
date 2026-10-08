import { CommandId, ServerSettingsError } from "@supacode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class QuestionAutoDismissService extends Context.Service<
  QuestionAutoDismissService,
  {
    readonly sweep: Effect.Effect<
      void,
      ServerSettingsError | ProjectionStore.ProjectionStoreV2Error
    >;
  }
>()("supacode/orchestration-v2/QuestionAutoDismissService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  const sweep = Effect.gen(function* () {
    if (!(yield* settings.getSettings).autoDismissQuestions) return;
    const now = yield* DateTime.now;
    const requests = yield* projections.getQuestionAutoDismissCandidates(
      DateTime.subtract(now, { minutes: 2 }),
    );

    for (const request of requests) {
      const { threadId, requestId, responseMode } = request;
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`question-auto-dismiss:${requestId}`),
          threadId,
          requestId,
          decision: "cancel",
          ...(responseMode === "live" ? { answers: {} } : {}),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Question automatic dismissal failed", {
              threadId,
              requestId,
              cause,
            }),
          ),
        );
    }
  });

  return QuestionAutoDismissService.of({ sweep });
});

export const layer = Layer.effect(QuestionAutoDismissService, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const questions = yield* QuestionAutoDismissService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("question-auto-dismiss", questions.sweep);
  }),
);
