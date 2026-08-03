import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditCaveman,
  auditMattPocockSkills,
  auditPonytail,
  auditRalphLoop,
  resolvePonytailRoot,
} from "../src/cli/install-kit.js";

test("resolvePonytailRoot finds Cursor plugin cache install", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ycm-ponytail-"));
  try {
    const root = path.join(
      home,
      ".cursor",
      "plugins",
      "cache",
      "ponytail",
      "ponytail",
      "abc123",
    );
    await fs.mkdir(path.join(root, "skills", "ponytail"), { recursive: true });
    await fs.writeFile(
      path.join(root, "skills", "ponytail", "SKILL.md"),
      "# ponytail\n",
    );
    assert.equal(await resolvePonytailRoot(home), root);
    const audit = await auditPonytail(home);
    assert.equal(audit.status, "ok");
    assert.equal(audit.path, root);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("auditPonytail reports missing when Cursor home exists without plugin", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ycm-ponytail-missing-"));
  try {
    await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
    const audit = await auditPonytail(home);
    assert.equal(audit.status, "missing");
    assert.match(audit.path, /ponytail/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("auditPonytail accepts Cursor rules fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ycm-ponytail-rule-"));
  try {
    const rule = path.join(home, ".cursor", "rules", "ponytail.mdc");
    await fs.mkdir(path.dirname(rule), { recursive: true });
    await fs.writeFile(rule, "---\ndescription: ponytail\n---\n");
    assert.equal(await resolvePonytailRoot(home), rule);
    assert.equal((await auditPonytail(home)).status, "ok");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("doctor vendor audits cover all four recommended plugins on this machine", async () => {
  const home = os.homedir();
  const audits = {
    mattpocock: await auditMattPocockSkills(home),
    ralph: await auditRalphLoop(home),
    caveman: await auditCaveman(home),
    ponytail: await auditPonytail(home),
  };
  for (const [name, item] of Object.entries(audits)) {
    assert.ok(
      ["ok", "missing", "n/a"].includes(item.status),
      `${name} status=${item.status}`,
    );
    assert.ok(item.path.length > 0, `${name} path`);
  }
});
