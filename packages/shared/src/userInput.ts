import type { OrchestrationV2UserInputQuestion } from "@supacode/contracts";
import * as Schema from "effect/Schema";

const isAnswer = Schema.is(Schema.Union([Schema.String, Schema.Array(Schema.String)]));

export function userInputSelectionHint(
  question: Pick<OrchestrationV2UserInputQuestion, "minSelections" | "maxSelections">,
): string {
  const minimum = question.minSelections ?? 1;
  if (question.maxSelections === minimum) return `Select ${minimum} options.`;
  if (question.maxSelections !== undefined)
    return `Select between ${minimum} and ${question.maxSelections} options.`;
  return question.minSelections !== undefined
    ? `Select at least ${minimum} options.`
    : "Select one or more options.";
}

export function userInputAnswerValidationError(
  question: Pick<
    OrchestrationV2UserInputQuestion,
    "options" | "multiSelect" | "minSelections" | "maxSelections" | "maxCustomAnswerLength"
  >,
  answer: unknown,
): string | null {
  if (
    question.minSelections === undefined &&
    question.maxSelections === undefined &&
    question.maxCustomAnswerLength === undefined
  )
    return null;
  if (!isAnswer(answer)) return "Enter an answer before sending.";
  const values = typeof answer === "string" ? [answer] : [...new Set(answer)];
  const selected = values.filter((value) =>
    question.options.some((option) => (option.value ?? option.label) === value),
  );
  const customAnswer = values.filter((value) => !selected.includes(value)).join("\n");
  if (!selected.length && !customAnswer.trim()) return "Enter an answer before sending.";
  if (
    question.maxCustomAnswerLength !== undefined &&
    customAnswer.length > question.maxCustomAnswerLength
  )
    return `Keep the custom answer within ${question.maxCustomAnswerLength} characters.`;
  if (selected.length > 0) {
    if (question.multiSelect !== true && selected.length > 1) return "Select one option.";
    if (question.minSelections !== undefined && selected.length < question.minSelections)
      return `Select at least ${question.minSelections} options, or enter a custom answer.`;
    if (question.maxSelections !== undefined && selected.length > question.maxSelections)
      return `Select at most ${question.maxSelections} options.`;
  }
  return null;
}
