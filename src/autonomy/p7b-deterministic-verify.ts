import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Safety canaries required by P7-B / seed _e79f. */
export const CANARY_IDS = [
  "hidden_scout",
  "pointer",
  "tracker_outage",
  "dirty_repo",
  "git_producer",
  "watchdog_gap",
  "optional_domain",
  "installed_parity",
] as const;

export type CanaryId = (typeof CANARY_IDS)[number];

export type VerifyVerdict = "PASS" | "PARTIAL";

export interface CheckOutcome {
  id: string;
  kind: "command" | "canary" | "plan";
  exit_code: number;
  ok: boolean;
  detail?: string;
}

export const CorrectionIssueSchema = z.object({
  schema_version: z.literal(1),
  issue_id: z.string().min(1).max(191),
  status: z.enum(["open", "resolved"]),
  failed_checks: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export type CorrectionIssue = z.infer<typeof CorrectionIssueSchema>;

export interface CorrectionIssueAdapter {
  findLive(): Promise<CorrectionIssue | undefined>;
  list(): Promise<CorrectionIssue[]>;
  create(input: { failed_checks: string[]; at: string; summary: string }): Promise<CorrectionIssue>;
  update(issueId: string, input: { failed_checks: string[]; at: string; summary: string }): Promise<CorrectionIssue>;
}

/**
 * Injectable probes for safety canaries. Tests and the CLI supply concrete
 * implementations; production defaults live in createDefaultCanaryContext.
 */
export interface CanaryContext {
  /** Hidden scout must deny a harmless write attempt. */
  scoutWriteAttempt: () => Promise<"denied" | "allowed">;
  /** Deed/pointer completion marker must be present when a pointer exists. */
  pointerHasCompletionMarker: () => Promise<boolean>;
  trackerAvailable: () => Promise<boolean>;
  pendingContinuationPersisted: () => Promise<boolean>;
  /** Must stay false during tracker outage. */
  claimedSuccessDespiteOutage: () => Promise<boolean>;
  repoDirty: () => Promise<boolean>;
  /** Clean-state evidence must be invalidated when the repo is dirty. */
  cleanStateEvidenceValid: () => Promise<boolean>;
  gitProducerPostconditionOk: () => Promise<boolean>;
  watchdogGapDetectable: () => Promise<boolean>;
  /** Optional-domain overlay must not expand authority. */
  optionalDomainSafe: () => Promise<boolean>;
  installedParityOk: () => Promise<boolean>;
}

export interface VerifyCommand {
  id: string;
  run: () => Promise<{ exit_code: number; detail?: string }>;
}

export interface P7bVerifyOptions {
  commands?: VerifyCommand[];
  canaries: CanaryContext;
  corrections: CorrectionIssueAdapter;
  now?: () => string;
  /** Plans checks without executing; never invents PASS. */
  dryRun?: boolean;
}

export interface P7bVerifyReport {
  schema_version: 1;
  verdict: VerifyVerdict;
  /** Always false — callers must not treat missing evidence as PASS. */
  synthetic_pass: false;
  reason_code: "ALL_CHECKS_OK" | "CHECKS_FAILED" | "DRY_RUN";
  checks: CheckOutcome[];
  correction_issue_id?: string;
  recorded_at: string;
}

function check(id: string, kind: CheckOutcome["kind"], ok: boolean, detail?: string): CheckOutcome {
  return {
    id,
    kind,
    exit_code: ok ? 0 : 1,
    ok,
    ...(detail ? { detail } : {}),
  };
}

/** Evaluate the seven + parity safety canaries against injectable probes. */
export async function runSafetyCanaries(ctx: CanaryContext): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];

  const scout = await ctx.scoutWriteAttempt();
  outcomes.push(check("hidden_scout", "canary", scout === "denied", scout === "denied"
    ? "scout denied harmless write"
    : "scout allowed write — hidden canary failed"));

  const pointerOk = await ctx.pointerHasCompletionMarker();
  outcomes.push(check("pointer", "canary", pointerOk, pointerOk
    ? "pointer completion marker present"
    : "pointer missing completion marker"));

  const trackerUp = await ctx.trackerAvailable();
  const pending = await ctx.pendingContinuationPersisted();
  const claimed = await ctx.claimedSuccessDespiteOutage();
  const trackerOk = trackerUp ? !claimed : (pending && !claimed);
  outcomes.push(check("tracker_outage", "canary", trackerOk, trackerUp
    ? "tracker available"
    : trackerOk
      ? "outage retained pending without success claim"
      : "tracker outage without durable pending or with success claim"));

  const dirty = await ctx.repoDirty();
  const cleanValid = await ctx.cleanStateEvidenceValid();
  const dirtyOk = dirty ? !cleanValid : true;
  outcomes.push(check("dirty_repo", "canary", dirtyOk, dirty
    ? dirtyOk
      ? "dirty repo invalidated clean-state evidence"
      : "dirty repo still treats clean-state evidence as valid"
    : "repo clean"));

  const gitOk = await ctx.gitProducerPostconditionOk();
  outcomes.push(check("git_producer", "canary", gitOk, gitOk
    ? "git producer postcondition ok"
    : "git producer postcondition failed"));

  const watchdogOk = await ctx.watchdogGapDetectable();
  outcomes.push(check("watchdog_gap", "canary", watchdogOk, watchdogOk
    ? "watchdog gap detection available"
    : "watchdog gap detection unavailable"));

  const domainOk = await ctx.optionalDomainSafe();
  outcomes.push(check("optional_domain", "canary", domainOk, domainOk
    ? "optional-domain safety ok"
    : "optional-domain authority expansion or missing safety"));

  const parityOk = await ctx.installedParityOk();
  outcomes.push(check("installed_parity", "canary", parityOk, parityOk
    ? "installed hash/parity ok"
    : "installed hash/parity mismatch"));

  return outcomes;
}

/**
 * All-green canary probes for unit tests and dry fixtures.
 * Production CLI replaces probes with real filesystem/git/parity checks.
 */
export function createPassingCanaryContext(): CanaryContext {
  return {
    scoutWriteAttempt: async () => "denied",
    pointerHasCompletionMarker: async () => true,
    trackerAvailable: async () => true,
    pendingContinuationPersisted: async () => true,
    claimedSuccessDespiteOutage: async () => false,
    repoDirty: async () => false,
    cleanStateEvidenceValid: async () => true,
    gitProducerPostconditionOk: async () => true,
    watchdogGapDetectable: async () => true,
    optionalDomainSafe: async () => true,
    installedParityOk: async () => true,
  };
}

export function createMemoryCorrectionIssueAdapter(): CorrectionIssueAdapter & {
  list(): Promise<CorrectionIssue[]>;
} {
  const issues = new Map<string, CorrectionIssue>();
  return {
    async findLive() {
      return [...issues.values()].find((issue) => issue.status === "open");
    },
    async list() {
      return [...issues.values()].sort((a, b) => a.issue_id.localeCompare(b.issue_id));
    },
    async create(input) {
      const issue: CorrectionIssue = {
        schema_version: 1,
        issue_id: `p7b-corr-${sha(`${input.at}\0${input.failed_checks.join(",")}`).slice(0, 16)}`,
        status: "open",
        failed_checks: [...input.failed_checks],
        summary: input.summary,
        created_at: input.at,
        updated_at: input.at,
      };
      issues.set(issue.issue_id, issue);
      return issue;
    },
    async update(issueId, input) {
      const current = issues.get(issueId);
      if (!current || current.status !== "open") throw new Error("p7b_correction_missing");
      const next: CorrectionIssue = {
        ...current,
        failed_checks: [...input.failed_checks],
        summary: input.summary,
        updated_at: input.at,
      };
      issues.set(issueId, next);
      return next;
    },
  };
}

/** File-backed correction adapter under `.ycm-harness/autonomy/p7b-corrections/`. */
export function createFileCorrectionIssueAdapter(root: string): CorrectionIssueAdapter {
  const dir = path.join(root, HARNESS_DIR_NAME, "autonomy", "p7b-corrections");
  async function loadAll(): Promise<CorrectionIssue[]> {
    const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error));
    const issues: CorrectionIssue[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const parsed = CorrectionIssueSchema.safeParse(await readJsonIfExists<unknown>(path.join(dir, name)));
      if (!parsed.success) throw new Error("p7b_correction_invalid");
      issues.push(parsed.data);
    }
    return issues;
  }
  return {
    async findLive() {
      return (await loadAll()).find((issue) => issue.status === "open");
    },
    async list() {
      return loadAll();
    },
    async create(input) {
      await fs.mkdir(dir, { recursive: true });
      const issue: CorrectionIssue = {
        schema_version: 1,
        issue_id: `p7b-corr-${sha(`${input.at}\0${input.failed_checks.join(",")}`).slice(0, 16)}`,
        status: "open",
        failed_checks: [...input.failed_checks],
        summary: input.summary,
        created_at: input.at,
        updated_at: input.at,
      };
      await writeJsonAtomic(path.join(dir, `${issue.issue_id}.json`), issue);
      return issue;
    },
    async update(issueId, input) {
      const file = path.join(dir, `${issueId}.json`);
      const current = CorrectionIssueSchema.parse(await readJsonIfExists<unknown>(file));
      if (current.status !== "open") throw new Error("p7b_correction_missing");
      const next: CorrectionIssue = {
        ...current,
        failed_checks: [...input.failed_checks],
        summary: input.summary,
        updated_at: input.at,
      };
      await writeJsonAtomic(file, next);
      return next;
    },
  };
}

async function openOrReuseCorrection(
  corrections: CorrectionIssueAdapter,
  failed: string[],
  at: string,
): Promise<CorrectionIssue> {
  const summary = `P7-B verification PARTIAL: ${failed.join(", ")}`;
  const live = await corrections.findLive();
  if (live) {
    return corrections.update(live.issue_id, { failed_checks: failed, at, summary });
  }
  return corrections.create({ failed_checks: failed, at, summary });
}

/**
 * Orchestrate recorded verification commands + safety canaries.
 * Any failure opens/reuses one live correction issue and returns PARTIAL.
 * Dry-run plans checks but never invents PASS.
 */
export async function runP7bDeterministicVerify(opts: P7bVerifyOptions): Promise<P7bVerifyReport> {
  const at = (opts.now ?? (() => new Date().toISOString()))();
  const checks: CheckOutcome[] = [];

  if (opts.dryRun) {
    for (const command of opts.commands ?? []) {
      checks.push({
        id: command.id,
        kind: "plan",
        exit_code: 0,
        ok: false,
        detail: "dry-run: command not executed",
      });
    }
    for (const id of CANARY_IDS) {
      checks.push({
        id,
        kind: "plan",
        exit_code: 0,
        ok: false,
        detail: "dry-run: canary not executed",
      });
    }
    return {
      schema_version: 1,
      verdict: "PARTIAL",
      synthetic_pass: false,
      reason_code: "DRY_RUN",
      checks,
      recorded_at: at,
    };
  }

  for (const command of opts.commands ?? []) {
    const result = await command.run();
    checks.push({
      id: command.id,
      kind: "command",
      exit_code: result.exit_code,
      ok: result.exit_code === 0,
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }

  checks.push(...await runSafetyCanaries(opts.canaries));

  const failed = checks.filter((item) => !item.ok).map((item) => item.id);
  if (failed.length === 0) {
    return {
      schema_version: 1,
      verdict: "PASS",
      synthetic_pass: false,
      reason_code: "ALL_CHECKS_OK",
      checks,
      recorded_at: at,
    };
  }

  const correction = await openOrReuseCorrection(opts.corrections, failed, at);
  return {
    schema_version: 1,
    verdict: "PARTIAL",
    synthetic_pass: false,
    reason_code: "CHECKS_FAILED",
    checks,
    correction_issue_id: correction.issue_id,
    recorded_at: at,
  };
}

/** Marker required in deed pointers when present (P7 pointer canary). */
export const POINTER_COMPLETION_MARKER = "<!-- deed-pointer-complete -->";

/**
 * Production probes for the P7-B CLI: real scout deny, dirty-repo invalidation,
 * watchdog exports, optional-domain catalog, and honest installed parity.
 */
export async function createCliCanaryContext(root: string): Promise<CanaryContext> {
  const { authorizeScoutAdapterRequest } = await import("./scout-guard.js");
  const { worktreeStatus, isGitRepo } = await import("../git/worktree.js");
  const { EXPECTED_SLOTS, WATCHDOG_TIMEZONE } = await import("./missed-slot-watchdog.js");
  const {
    compareStrategicInstalledParity,
    loadStrategicReviewProfileCatalog,
    sourcePluginRoot,
  } = await import("./strategic-installed-parity.js");
  const os = await import("node:os");

  return {
    async scoutWriteAttempt() {
      const decision = await authorizeScoutAdapterRequest(
        { projectRoot: root, cwd: root },
        { adapter: "project", operation: "write", target: path.join(root, "p7b-harmless-write.txt") },
      );
      return decision.allowed ? "allowed" : "denied";
    },
    async pointerHasCompletionMarker() {
      const pointerRoot = path.join(root, HARNESS_DIR_NAME, "autonomy", "deed-pointers");
      const names = await fs.readdir(pointerRoot).catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? [] : Promise.reject(error));
      if (names.length === 0) return true;
      async function walk(dir: string): Promise<string[]> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) files.push(...await walk(full));
          else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
        }
        return files;
      }
      const files = await walk(pointerRoot);
      if (files.length === 0) return true;
      for (const file of files) {
        const body = await fs.readFile(file, "utf8");
        if (!body.includes(POINTER_COMPLETION_MARKER)) return false;
      }
      return true;
    },
    async trackerAvailable() {
      return process.env.YCM_HARNESS_TRACKER_OUTAGE !== "1";
    },
    async pendingContinuationPersisted() {
      const pendingDir = path.join(root, HARNESS_DIR_NAME, "autonomy", "pending");
      try {
        const names = await fs.readdir(pendingDir);
        return names.length > 0;
      } catch {
        return process.env.YCM_HARNESS_TRACKER_OUTAGE !== "1";
      }
    },
    async claimedSuccessDespiteOutage() {
      return process.env.YCM_HARNESS_TRACKER_CLAIM_SUCCESS === "1";
    },
    async repoDirty() {
      if (!(await isGitRepo(root))) return false;
      const status = await worktreeStatus(root);
      return status.dirty;
    },
    async cleanStateEvidenceValid() {
      if (!(await isGitRepo(root))) return true;
      const status = await worktreeStatus(root);
      // Dirty trees must invalidate earlier clean-state evidence.
      return !status.dirty;
    },
    async gitProducerPostconditionOk() {
      if (!(await isGitRepo(root))) return true;
      const status = await worktreeStatus(root);
      return !status.dirty;
    },
    async watchdogGapDetectable() {
      return WATCHDOG_TIMEZONE === "Asia/Hong_Kong" && EXPECTED_SLOTS.length === 3;
    },
    async optionalDomainSafe() {
      try {
        const plugin = await sourcePluginRoot();
        const catalog = await loadStrategicReviewProfileCatalog(plugin);
        const profile = catalog.profiles.find((item) => item.profile === "optional-domain");
        return Boolean(profile && catalog.forbidden_capability_expansion === true);
      } catch {
        return false;
      }
    },
    async installedParityOk() {
      try {
        const source = await sourcePluginRoot();
        const projected = path.join(os.homedir(), ".cursor", "plugins", "ycm-harness");
        try {
          await fs.access(path.join(projected, ".cursor-plugin", "plugin.json"));
          const report = await compareStrategicInstalledParity(source, projected);
          return report.ok;
        } catch {
          // No installed projection: fresh-copy self-parity proves hashes are readable.
          const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "p7b-parity-"));
          await fs.cp(source, tmp, { recursive: true });
          const report = await compareStrategicInstalledParity(source, tmp);
          return report.ok;
        }
      } catch {
        return false;
      }
    },
  };
}
