import { describe, expect, it } from "vite-plus/test";

import { userInputAnswerValidationError } from "./userInput.ts";

const question = {
  options: ["One", "Two", "Three", "Four"].map((label) => ({ label, description: label })),
  multiSelect: true,
  minSelections: 2,
  maxSelections: 3,
  maxCustomAnswerLength: 500,
};

describe("userInputAnswerValidationError", () => {
  it("accepts bounded selections and custom answers independently", () => {
    expect(userInputAnswerValidationError(question, ["One", "Two"])).toBeNull();
    expect(userInputAnswerValidationError(question, "x".repeat(500))).toBeNull();
    expect(userInputAnswerValidationError(question, ["One", "Two", "A note"])).toBeNull();
  });

  it("rejects answers that the native provider would refuse", () => {
    expect(userInputAnswerValidationError(question, "x".repeat(501))).toContain("500 characters");
    expect(userInputAnswerValidationError(question, ["One"])).toContain("at least 2");
    expect(userInputAnswerValidationError(question, ["One", "Two", "Three", "Four"])).toContain(
      "at most 3",
    );
    expect(userInputAnswerValidationError(question, ["One", "One"])).toContain("at least 2");
    expect(userInputAnswerValidationError(question, undefined)).toContain("Enter an answer");
    expect(userInputAnswerValidationError(question, [])).toContain("Enter an answer");
    expect(userInputAnswerValidationError(question, ["One", "Two", "x".repeat(501)])).toContain(
      "500 characters",
    );
  });

  it("preserves native option values and enforces single selection", () => {
    const single = {
      options: [
        { value: " first\t", label: "First", description: "First" },
        { value: "second", label: "Second", description: "Second" },
      ],
      multiSelect: false,
      maxSelections: 1,
      maxCustomAnswerLength: 4,
    };
    expect(userInputAnswerValidationError(single, " first\t")).toBeNull();
    expect(userInputAnswerValidationError(single, [" first\t", "second"])).toBe(
      "Select one option.",
    );
  });

  it("leaves questions without advertised constraints unchanged", () => {
    expect(
      userInputAnswerValidationError({ options: [], multiSelect: false }, "x".repeat(501)),
    ).toBeNull();
  });
});
