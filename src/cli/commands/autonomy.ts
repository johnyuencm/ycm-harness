import type { Command } from "commander";
import { promises as fs } from "node:fs";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { buildFollowUpRequest, handlePostToolUse, parseExplicitFollowUps } from "../../autonomy/deeds.js";
import { buildStopHookOutput, dispatchStopHook, validateStopPayload } from "../../hooks/stop.js";
import { fulfillScoutObligation } from "../../autonomy/scout-brief.js";
import { SCOUT_GUARD_ASSURANCE } from "../../autonomy/scout-guard.js";
import { apply, type StrategicActionRequest } from "../../autonomy/strategic-action.js";
import { promote, type KnowledgePromotionRequest } from "../../autonomy/knowledge-promotion.js";
import { review, type StrategicReviewRequest } from "../../autonomy/strategic-review.js";
import {
  handoffPm,
  preparePm,
  reviewPm,
  statusPm,
  type HandoffPmInput,
  type PreparePmInput,
  type ReviewPmInput,
  type StatusPmInput,
} from "../../autonomy/pm.js";
import { readProjectedPmSchedulerOrigin } from "../../autonomy/pm-scheduler-origin.js";
import {
  coordinationStatus,
  ensureContinuation,
  retryContinuations,
  type CanonicalContinuationRequest,
} from "../../autonomy/coordination.js";
import {
  createFileGapIssueAdapter,
  createFileReceiptStore,
  createStaticRuntimeProbe,
  disableWatchdog,
  enableWatchdog,
  tickMissedSlotWatchdog,
  watchdogStatus,
  writeSlotReceipt,
} from "../../autonomy/missed-slot-watchdog.js";
import {
  captureRollbackBaseline,
  disableRollbackSurface,
  reEnableRollbackSurface,
  rollbackStatus,
  ROLLBACK_SURFACES,
  type RollbackSurface,
} from "../../autonomy/enforcement-rollback.js";
import {
  gradeNaturalCycle,
  installHkNaturalSchedules,
  labelManualCanaryRun,
  monitorHkNaturalReceipts,
  runNaturalSlot,
  scheduleStatus,
  writeSignedHkSchedulerOrigin,
} from "../../autonomy/hk-natural-schedules.js";

interface BindOptions {
  owner: string;
  repo: string;
  project: string;
  parentIssue: string;
  statusField?: string;
  goal?: string;
}

interface RequestOptions {
  file?: string;
  goal?: string;
  metadataPolicy: "none" | "optional" | "required";
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > 64 * 1024) {
        process.stdin.pause();
        reject(new Error("request_too_large"));
        return;
      }
      raw += chunk;
    });
    process.stdin.once("end", () => resolve(raw));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
}

async function readJson(file?: string): Promise<unknown> {
  const raw = file ? await fs.readFile(file, "utf8") : await readStdin();
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("request_too_large");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

export function registerAutonomy(program: Command, ctx: CliContext, out: CliOutput): void {
  program.enablePositionalOptions();
  const autonomy = program
    .command("autonomy")
    .description("Verified autonomous coordination state")
    .passThroughOptions();

  const scout = autonomy.command("scout").description("Bounded startup orientation");
  scout
    .command("status")
    .description("Show the startup scout structural guard assurance boundary")
    .action(() => {
      out.json({
        guard: "structural",
        complete_confinement: false,
        residual_risks: ["native", "MCP", "OS", "reparse TOCTOU"],
        assurance: SCOUT_GUARD_ASSURANCE,
      });
    });
  scout
    .command("fulfill")
    .description("Fulfil one opaque scout obligation with the deterministic direct collector")
    .requiredOption("--obligation <key>", "Opaque key from the current SessionStart context")
    .action(async (opts: { obligation: string }) => {
      out.json(await fulfillScoutObligation(ctx.cwd, opts.obligation));
    });
  const pm = autonomy.command("pm").description("Durable PM execution receipts");
  pm
    .command("prepare")
    .description("Select at most one safe live candidate and persist its complete brief before annotation")
    .option("--file <path>", "Read bounded prepare JSON from a file instead of stdin")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .action(async (opts: { file?: string; goal?: string }) => {
      const raw = await readJson(opts.file);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
      const request = raw as Omit<PreparePmInput, "cwd">;
      out.json(await preparePm({ ...request, cwd: ctx.cwd, goal: opts.goal ?? request.goal }));
    });
  pm
    .command("handoff")
    .description("Authenticate one bounded worker claim and persist its safe artifact handoff")
    .option("--file <path>", "Read bounded handoff JSON from a file instead of stdin")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .action(async (opts: { file?: string; goal?: string }) => {
      const raw = await readJson(opts.file);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
      const request = raw as Omit<HandoffPmInput, "cwd">;
      out.json(await handoffPm({ ...request, cwd: ctx.cwd, goal: opts.goal ?? request.goal }));
    });
  pm
    .command("review")
    .description("Independently authenticate one PM handoff and durably dispose every finding")
    .option("--file <path>", "Read bounded review JSON from a file instead of stdin")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .action(async (opts: { file?: string; goal?: string }) => {
      const raw = await readJson(opts.file);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
      const request = raw as Omit<ReviewPmInput, "cwd">;
      out.json(await reviewPm({ ...request, cwd: ctx.cwd, goal: opts.goal ?? request.goal }));
    });
  pm
    .command("status")
    .description("Authenticate and report one PM receipt chain without repairing provider or scheduler state")
    .option("--file <path>", "Read bounded status JSON from a file instead of stdin")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .option("--record-gap", "Idempotently persist the one local missing-natural-evidence receipt")
    .action(async (opts: { file?: string; goal?: string; recordGap?: boolean }) => {
      const raw = await readJson(opts.file);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
      const request = raw as Omit<StatusPmInput, "cwd" | "record_gap">;
      out.json(await statusPm(
        { ...request, cwd: ctx.cwd, goal: opts.goal ?? request.goal, record_gap: Boolean(opts.recordGap) },
        { readTrustedSchedulerArtifact: readProjectedPmSchedulerOrigin },
      ));
    });
  const strategicReview = autonomy.command("review").description("Universal installation-owned strategic review");
  for (const operation of ["evaluate", "status", "replay"] as const) {
    strategicReview
      .command(operation)
      .description(`${operation} one bounded strategic review`)
      .option("--file <path>", `Read bounded ${operation} JSON from a file instead of stdin`)
      .action(async (opts: { file?: string }) => {
        const raw = await readJson(opts.file);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
        const request = raw as Omit<StrategicReviewRequest, "cwd" | "operation">;
        out.json(await review({ ...request, cwd: ctx.cwd, operation }));
      });
  }
  const knowledgePromotion = autonomy.command("promotion").description("Ticket-first verified knowledge promotion");
  for (const operation of ["promote", "status", "replay", "rollback"] as const) {
    knowledgePromotion
      .command(operation)
      .description(`${operation} one verified knowledge promotion`)
      .option("--file <path>", `Read bounded ${operation} JSON from a file instead of stdin`)
      .action(async (opts: { file?: string }) => {
        const raw = await readJson(opts.file);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
        const request = raw as Omit<KnowledgePromotionRequest, "cwd" | "operation">;
        out.json(await promote({ ...request, cwd: ctx.cwd, operation }));
      });
  }
  const strategicAction = autonomy.command("action").description("Bounded authenticated strategic action");
  for (const operation of ["apply", "status", "replay"] as const) {
    strategicAction
      .command(operation)
      .description(`${operation} one authenticated strategic action`)
      .option("--file <path>", `Read bounded ${operation} JSON from a file instead of stdin`)
      .action(async (opts: { file?: string }) => {
        const raw = await readJson(opts.file);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_json");
        const request = raw as Omit<StrategicActionRequest, "cwd" | "operation">;
        out.json(await apply({ ...request, cwd: ctx.cwd, operation }));
      });
  }
  autonomy
    .command("bind")
    .description("Describe a GitHub Issues destination for an active goal")
    .requiredOption("--owner <owner>", "GitHub owner or organization")
    .requiredOption("--repo <repo>", "GitHub repository name")
    .requiredOption("--project <number>", "GitHub Project number")
    .requiredOption("--parent-issue <number>", "GitHub parent issue number")
    .option("--status-field <name>", "GitHub Project status field", "Status")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .action(async (opts: BindOptions) => {
      const projectNumber = Number(opts.project);
      const parentIssueNumber = Number(opts.parentIssue);
      if (!Number.isInteger(projectNumber) || projectNumber < 1) throw new Error("--project must be a positive integer");
      if (!Number.isInteger(parentIssueNumber) || parentIssueNumber < 1) throw new Error("--parent-issue must be a positive integer");
      out.json({
        kind: "github",
        owner: opts.owner,
        repo: opts.repo,
        project_number: projectNumber,
        parent_issue_number: parentIssueNumber,
        status_field: opts.statusField ?? "Status",
        ...(opts.goal ? { goal_id: opts.goal } : {}),
      });
    });

  autonomy
    .command("ensure")
    .description("Ensure one durable continuation from a UTF-8 JSON request")
    .option("--file <path>", "Read JSON from a file instead of stdin")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .option("--metadata-policy <policy>", "none, optional, or required", "optional")
    .addHelpText("after", "\nRequired JSON fields: title, source_class, source, problem, impact_scope, owner_control, acceptance[], verification[], dependencies[], safety_blockers[], cost_class, evidence_horizon, rollback, status=\"todo\", priority=\"medium\".")
    .action(async (opts: RequestOptions) => {
      const result = await ensureContinuation({
        cwd: ctx.cwd,
        goal: opts.goal,
        metadataPolicy: opts.metadataPolicy,
        request: await readJson(opts.file) as CanonicalContinuationRequest,
      });
      out.json(result ?? {});
    });

  autonomy
    .command("retry")
    .description("Retry sorted pending continuations")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .option("--metadata-policy <policy>", "none, optional, or required", "optional")
    .option("--limit <count>", "Maximum retry count", (value) => Number(value), 12)
    .action(async (opts: RequestOptions & { limit: number }) => {
      out.json(await retryContinuations({
        cwd: ctx.cwd,
        goal: opts.goal,
        metadataPolicy: opts.metadataPolicy,
        limit: opts.limit,
      }));
    });

  autonomy
    .command("status")
    .description("Live-verify binding and show bounded local pending metadata")
    .option("--goal <id>", "Require this active ycm-harness goal")
    .option("--limit <count>", "Maximum pending summaries", (value) => Number(value), 12)
    .action(async (opts: { goal?: string; limit: number }) => {
      out.json(await coordinationStatus(ctx.cwd, opts.goal, opts.limit) ?? {});
    });

  const schedule = autonomy.command("schedule").description(
    "Install and monitor Asia/Hong_Kong natural schedule projections (09:00/17:00/23:00)",
  );
  schedule
    .command("install")
    .description("Idempotently install HK natural schedule projections and signed origin material")
    .option("--apply-schtasks", "Attempt live Windows Task Scheduler registration (default: projection only)", false)
    .action(async (opts: { applySchtasks: boolean }) => {
      out.json(await installHkNaturalSchedules(ctx.cwd, { apply_schtasks: opts.applySchtasks }));
    });
  schedule
    .command("status")
    .description("Show installed HK natural schedule projection status")
    .action(async () => {
      out.json(await scheduleStatus(ctx.cwd));
    });
  schedule
    .command("monitor")
    .description("Report honest hit/miss for expected HK slots without fabricating PASS")
    .requiredOption("--local-date <yyyy-mm-dd>", "Local Asia/Hong_Kong date to inspect")
    .action(async (opts: { localDate: string }) => {
      out.json(await monitorHkNaturalReceipts(ctx.cwd, { local_date: opts.localDate }));
    });
  schedule
    .command("run-slot")
    .description("Run one local_no_delivery natural slot workflow (PM/review/nightly) and write receipts")
    .requiredOption("--slot <hh:mm>", "Expected slot 09:00, 17:00, or 23:00")
    .option("--local-date <yyyy-mm-dd>", "Local Asia/Hong_Kong date (default: today in HK)")
    .option("--natural", "Require natural_scheduler labeling (mandatory for this runner)", true)
    .action(async (opts: { slot: string; localDate?: string; natural: boolean }) => {
      if (!["09:00", "17:00", "23:00"].includes(opts.slot)) {
        throw new Error("--slot must be 09:00, 17:00, or 23:00");
      }
      out.json(await runNaturalSlot(ctx.cwd, {
        slot: opts.slot as "09:00" | "17:00" | "23:00",
        local_date: opts.localDate,
        natural: opts.natural !== false,
      }));
    });
  schedule
    .command("grade-cycle")
    .description("Grade one HK local_date natural cycle (PASS only with PM+review+nightly+scout/pointer+watchdog)")
    .requiredOption("--local-date <yyyy-mm-dd>", "Local Asia/Hong_Kong date to grade")
    .action(async (opts: { localDate: string }) => {
      out.json(await gradeNaturalCycle(ctx.cwd, { local_date: opts.localDate }));
    });
  schedule
    .command("origin-write")
    .description("Write one signed scheduler-origin record for natural gate proof")
    .requiredOption("--local-date <yyyy-mm-dd>", "Local Asia/Hong_Kong date bound into the record")
    .option("--record-id <id>", "Optional record id (default hk-natural-<date>)")
    .option("--artifact-file <path>", "JSON artifact file; defaults to natural local_no_delivery stub")
    .action(async (opts: { localDate: string; recordId?: string; artifactFile?: string }) => {
      const artifact = opts.artifactFile
        ? JSON.parse(await fs.readFile(opts.artifactFile, "utf8"))
        : {
            evidence_class: "natural_scheduler",
            delivery: "local_no_delivery",
            trigger: "scheduled",
            manual_trigger: false,
            slots: ["09:00", "17:00", "23:00"],
          };
      out.json(await writeSignedHkSchedulerOrigin(ctx.cwd, {
        local_date: opts.localDate,
        record_id: opts.recordId,
        artifact,
      }));
    });
  const receipt = schedule.command("receipt").description("Watchdog slot-receipt writer for natural/manual runs");
  receipt
    .command("record")
    .description("Persist one slot receipt observable by missed-slot-watchdog")
    .requiredOption("--slot <hh:mm>", "Expected slot 09:00, 17:00, or 23:00")
    .requiredOption("--local-date <yyyy-mm-dd>", "Local Asia/Hong_Kong date")
    .option("--receipt-id <id>", "Receipt id (default derived from date+slot)")
    .option("--status <ok|failed>", "Receipt status", "ok")
    .option("--natural", "Label as natural_scheduler evidence", false)
    .option("--manual", "Label as non-natural manual/local canary", false)
    .action(async (opts: {
      slot: string;
      localDate: string;
      receiptId?: string;
      status: string;
      natural: boolean;
      manual: boolean;
    }) => {
      if (!["09:00", "17:00", "23:00"].includes(opts.slot)) {
        throw new Error("--slot must be 09:00, 17:00, or 23:00");
      }
      if (opts.status !== "ok" && opts.status !== "failed") {
        throw new Error("--status must be ok or failed");
      }
      if (opts.natural && opts.manual) {
        throw new Error("--natural and --manual are mutually exclusive");
      }
      const base = {
        schema_version: 1 as const,
        slot: opts.slot as "09:00" | "17:00" | "23:00",
        local_date: opts.localDate,
        receipt_id: opts.receiptId ?? `rcpt-${opts.localDate}-${opts.slot.replace(":", "")}`,
        observed_at: new Date().toISOString(),
        status: opts.status as "ok" | "failed",
      };
      const labeled = opts.manual || !opts.natural
        ? labelManualCanaryRun(base)
        : { ...base, evidence_class: "natural_scheduler" as const, natural: true };
      out.json(await writeSlotReceipt(ctx.cwd, labeled));
    });

  const watchdog = autonomy.command("watchdog").description(
    "Script-only missed-slot watchdog for Asia/Hong_Kong 09:00/17:00/23:00 receipts",
  );
  watchdog
    .command("tick")
    .description("Compare due scheduled receipts and idempotently open/update/resolve one live gap issue")
    .option("--app-available <bool>", "Runtime probe: desktop app available", "true")
    .option("--scheduler-reachable <bool>", "Runtime probe: scheduler reachable", "true")
    .action(async (opts: { appAvailable: string; schedulerReachable: string }) => {
      const parseBool = (value: string, flag: string): boolean => {
        if (value === "true") return true;
        if (value === "false") return false;
        throw new Error(`${flag} must be true or false`);
      };
      out.json(await tickMissedSlotWatchdog({
        root: ctx.cwd,
        receipts: createFileReceiptStore(ctx.cwd),
        gaps: createFileGapIssueAdapter(ctx.cwd),
        runtime: createStaticRuntimeProbe({
          app_available: parseBool(opts.appAvailable, "--app-available"),
          scheduler_reachable: parseBool(opts.schedulerReachable, "--scheduler-reachable"),
        }),
      }));
    });
  watchdog
    .command("status")
    .description("Show watchdog enablement and live gap pointer without mutating tickets")
    .action(async () => {
      out.json(await watchdogStatus(ctx.cwd));
    });
  watchdog
    .command("disable")
    .description("Independently disable the watchdog while retaining prior evidence")
    .action(async () => {
      out.json(await disableWatchdog(ctx.cwd));
    });
  watchdog
    .command("enable")
    .description("Re-enable a previously disabled watchdog")
    .action(async () => {
      out.json(await enableWatchdog(ctx.cwd));
    });

  const rollback = autonomy.command("rollback").description(
    "Independently disable/re-enable schedules, scout, and enforcement with baseline evidence retention",
  );
  rollback
    .command("baseline")
    .description("Record approved installed version and evidence inventory before disable")
    .action(async () => {
      out.json(await captureRollbackBaseline(ctx.cwd));
    });
  rollback
    .command("disable")
    .description("Independently disable one surface without deleting prior evidence")
    .requiredOption("--surface <schedules|scout|enforcement>", "Surface to disable")
    .action(async (opts: { surface: string }) => {
      if (!(ROLLBACK_SURFACES as readonly string[]).includes(opts.surface)) {
        throw new Error("--surface must be schedules, scout, or enforcement");
      }
      out.json(await disableRollbackSurface(ctx.cwd, opts.surface as RollbackSurface));
    });
  rollback
    .command("re-enable")
    .description("Restore one surface to the approved installed baseline version")
    .requiredOption("--surface <schedules|scout|enforcement>", "Surface to re-enable")
    .action(async (opts: { surface: string }) => {
      if (!(ROLLBACK_SURFACES as readonly string[]).includes(opts.surface)) {
        throw new Error("--surface must be schedules, scout, or enforcement");
      }
      out.json(await reEnableRollbackSurface(ctx.cwd, opts.surface as RollbackSurface));
    });
  rollback
    .command("status")
    .description("Show surface enablement, baseline id, and evidence retention")
    .action(async () => {
      out.json(await rollbackStatus(ctx.cwd));
    });

  autonomy
    .command("verify-payload")
    .description("Exercise a current synthetic PostToolUse or Stop payload")
    .option("--file <path>", "Read JSON from a file instead of stdin")
    .option("--allow-remote", "Allow Stop follow-ups to mutate the bound remote", false)
    .action(async (opts: { file?: string; allowRemote: boolean }) => {
      const payload = await readJson(opts.file);
      const event = payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).hook_event_name
        : undefined;
      if (event === "PostToolUse") {
        out.json({ event, mode: "local", result: await handlePostToolUse(payload) });
        return;
      }
      if (event !== "Stop") throw new Error("unsupported_hook_payload");
      const stopPayload = validateStopPayload(payload);
      const state = (await ctx.store.exists()) ? await ctx.store.readState() : undefined;
      const followUps = parseExplicitFollowUps(stopPayload.last_assistant_message);
      out.json({
        event,
        mode: opts.allowRemote ? "remote" : "dry",
        result: opts.allowRemote
          ? await dispatchStopHook(payload, state) ?? {}
          : {
              ordinary: buildStopHookOutput(state) ?? {},
              follow_ups: followUps.map((item) => ({ item, request: buildFollowUpRequest(item) })),
            },
      });
    });
}
