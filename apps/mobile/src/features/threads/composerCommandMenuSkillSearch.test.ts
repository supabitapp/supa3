import { describe, expect, it } from "vite-plus/test";

import { matchesCommandMenuSkillQuery } from "./composerCommandMenuSkillSearch";

const browserSkill = {
  name: "browser",
  path: "/skills/browser/SKILL.md",
  enabled: true,
  shortDescription: "Open and control the in-app browser",
};

describe("matchesCommandMenuSkillQuery", () => {
  it("matches the rendered skill prefix", () => {
    expect(matchesCommandMenuSkillQuery(browserSkill, "skill")).toBe(true);
    expect(matchesCommandMenuSkillQuery(browserSkill, "skill:brow")).toBe(true);
  });
});
