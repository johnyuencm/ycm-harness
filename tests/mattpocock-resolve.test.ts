import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditMattPocockSkills,
  resolveMattPocockSkillsRoot,
} from "../src/cli/install-kit.js";
import os from "node:os";

test("resolveMattPocockSkillsRoot finds installed mattpocock-skills when present", async () => {
  const home = os.homedir();
  const root = await resolveMattPocockSkillsRoot(home);
  const audit = await auditMattPocockSkills(home);
  // On this developer machine the plugin is expected; elsewhere n/a|missing is fine.
  if (root) {
    assert.equal(audit.status, "ok");
    assert.ok(root.includes("mattpocock") || root.includes("skills"));
  } else {
    assert.ok(["missing", "n/a"].includes(audit.status));
  }
});
