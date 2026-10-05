export const unwrapPreviewAutomationResult = <A>(result: A): A => {
  if (
    typeof result === "object" &&
    result !== null &&
    "_tag" in result &&
    result._tag === "PreviewAutomationPausedError"
  ) {
    // contextBridge preserves plain rejection data, but strips custom Error fields.
    throw {
      ...result,
      message:
        "Browser automation and capture are paused for private input. Only the user can resume access in the browser.",
    };
  }
  return result;
};
