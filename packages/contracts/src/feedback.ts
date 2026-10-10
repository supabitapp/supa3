import * as Schema from "effect/Schema";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const FeedbackStartInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  modelSelection: Schema.optional(ModelSelection),
});
export type FeedbackStartInput = typeof FeedbackStartInput.Type;

export const FeedbackStartResult = Schema.Struct({ threadId: ThreadId });
export type FeedbackStartResult = typeof FeedbackStartResult.Type;

export class FeedbackStartError extends Schema.TaggedError<FeedbackStartError>()(
  "FeedbackStartError",
  {
    stage: Schema.Literals([
      "read-settings",
      "choose-provider",
      "prepare-context",
      "launch-thread",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "read-settings":
        return "Could not read your provider settings. Try again.";
      case "choose-provider":
        return "Connect a provider in Settings to send feedback.";
      case "prepare-context":
        return "Could not prepare the feedback guide. Try again.";
      case "launch-thread":
        return "Could not start the feedback thread. Try again.";
    }
  }
}
