import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  PREVIEW_AUTOMATION_PRE_PRIVATE_INPUT_OPERATIONS,
  PREVIEW_AUTOMATION_OPERATIONS,
  previewAutomationHostOperations,
} from "./previewAutomation.ts";
const decodeLegacyHost = Schema.decodeUnknownSync(
  Schema.Struct({
    supportedOperations: Schema.Array(
      Schema.Literals(PREVIEW_AUTOMATION_PRE_PRIVATE_INPUT_OPERATIONS),
    ),
  }),
);
describe("private input host negotiation", () => {
  it("keeps newer desktops attachable to older servers without enabling private input", () => {
    expect(
      decodeLegacyHost({ supportedOperations: previewAutomationHostOperations(false, false) })
        .supportedOperations,
    ).toEqual(PREVIEW_AUTOMATION_PRE_PRIVATE_INPUT_OPERATIONS);
  });
  it("advertises atomic close when server support is explicit", () => {
    expect(previewAutomationHostOperations(true, false)).toEqual(PREVIEW_AUTOMATION_OPERATIONS);
    expect(() =>
      decodeLegacyHost({ supportedOperations: previewAutomationHostOperations(true, false) }),
    ).toThrow();
  });
  it("does not silently downgrade a protected tab when support disappears", () => {
    expect(previewAutomationHostOperations(false, true)).toContain("close");
  });
});
