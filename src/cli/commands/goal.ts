import path from "node:path";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { DEFAULT_GITHUB_TRACKER, GoalV3, type GoalV3T, type AssuranceT } from "../../schema/v3.js";
import { nowIso, shortId, slugify } from "../../state/ids.js";
import { requireLeanState, activeLeanGoal } from "../lean-state.js";
import { isLiveRemoteBackend, markTrackerLive, nextLocalTicket, providerForState } from "../../tickets/provider.js";
import { addWorktree, worktreeStatus, writeWorktreeMetadata } from "../../git/worktree.js";
import { goalWorktreeFile } from "../../state/paths.js";
import { evidenceRoot, freshCompletionEvidence } from "../../tickets/evidence.js";
import { requireContinuationClosure } from "../../continuation/closure.js";

function goalId(title: string): string {
  return `goal_${slugify(title)}_${shortId().slice(0, 4)}`;
}

function assertAssurance(value: string): AssuranceT {
  if (value === "standard" || value === "high") return value;
  throw new Error("assurance must be standard or high");
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export function registerGoal(program: Command, ctx: CliContext, out: CliOutput): void {
  const goal = program.command("goal").description("Manage lean goals");

  goal.command("create <title>")
    .description("Create and activate a lean goal")
    .option("-d, --description <text>")
    .option("--id <id>")
    .option("--assurance <standard|high>", "Assurance level", "standard")
    .option("--backend <local|github>", "Ticket backend", "local")
    .option("--owner <owner>", "GitHub repository owner", DEFAULT_GITHUB_TRACKER.owner)
    .option("--repo <repo>", "GitHub repository name", DEFAULT_GITHUB_TRACKER.repo)
    .option("--project-owner <owner>", "GitHub Projects owner", DEFAULT_GITHUB_TRACKER.project_owner)
    .option("--project <number>", "GitHub Project number", String(DEFAULT_GITHUB_TRACKER.project_number))
    .option("--parent <number>", "GitHub parent issue number")
    .action(async (title: string, opts: {
      description?: string;
      id?: string;
      assurance: string;
      backend: string;
      owner?: string;
      repo?: string;
      projectOwner?: string;
      project?: string;
      parent?: string;
    }) => {
      const state = await requireLeanState(ctx);
      const id = opts.id ?? goalId(title);
      if (state.goals[id]) throw new Error(`Goal already exists: ${id}`);
      const at = nowIso();
      const assurance = assertAssurance(opts.assurance);
      let backend: GoalV3T["backend"];
      if (opts.backend === "local") backend = { kind: "local" };
      else if (opts.backend === "github") {
        if (!opts.parent) throw new Error("GitHub goals require --parent <issue-number>.");
        backend = {
          kind: "github",
          owner: opts.owner || DEFAULT_GITHUB_TRACKER.owner,
          repo: opts.repo || DEFAULT_GITHUB_TRACKER.repo,
          project_owner: opts.projectOwner || DEFAULT_GITHUB_TRACKER.project_owner,
          project_number: parsePositiveInt(opts.project, "--project"),
          parent_issue_number: parsePositiveInt(opts.parent, "--parent"),
        };
      } else if (opts.backend === "multica") {
        throw new Error("Multica backend is deprecated. Use --backend github (or local).");
      } else throw new Error("backend must be local or github");
      const created = GoalV3.parse({ id, title, description: opts.description, status: "active", assurance, backend, created_at: at, updated_at: at });
      state.goals[id] = created;
      state.active_goal_id = id;
      if (backend.kind === "github") {
        await providerForState(state, id).list(id);
        markTrackerLive(state, id, at);
      }
      await ctx.store.writeStateV3(state);
      await ctx.store.recordEvent({ id: shortId("evt"), kind: "goal.created", at, goal_id: id, payload: { assurance, backend: backend.kind } });
      out.out(`Created goal ${id}: ${title} [${assurance}, ${backend.kind}]`);
    });

  goal.command("list").action(async () => {
    const state = await requireLeanState(ctx);
    const rows = Object.values(state.goals);
    if (!rows.length) return out.out("No goals yet.");
    for (const item of rows) out.out(`${item.id === state.active_goal_id ? "*" : " "} ${item.id} [${item.status}/${item.assurance}] ${item.title}`);
  });

  goal.command("activate <id>").action(async (id: string) => {
    const state = await requireLeanState(ctx);
    const target = state.goals[id];
    if (!target) throw new Error(`Unknown goal: ${id}`);
    const at = nowIso();
    state.active_goal_id = id;
    state.goals[id] = { ...target, status: "active", updated_at: at };
    await ctx.store.writeStateV3(state);
    out.out(`Activated goal ${id}`);
  });

  goal.command("status")
    .option("--goal <id>")
    .option("--json")
    .action(async (opts: { goal?: string; json?: boolean }) => {
      const state = await requireLeanState(ctx);
      const id = opts.goal ?? state.active_goal_id;
      const target = id ? state.goals[id] : undefined;
      if (!target) { if (opts.json) out.json({ status: "no-goal" }); else out.out("No active goal."); return; }
      const provider = providerForState(state, target.id);
      const tickets = await provider.list(target.id);
      if (isLiveRemoteBackend(target.backend)) { markTrackerLive(state, target.id); await ctx.store.writeStateV3(state); }
      const next = target.backend.kind === "local" ? nextLocalTicket(state, target.id) : tickets.find((ticket) => ticket.status === "in_progress") ?? tickets.find((ticket) => ticket.status === "todo");
      const payload = { goal_id: target.id, title: target.title, status: target.status, assurance: target.assurance, backend: target.backend.kind, active_ticket_id: target.active_ticket_id, next_ticket_id: next?.id, next_ticket_title: next?.title, stop_enforcement: target.stop_enforcement, worktree_status: target.worktree_status };
      if (opts.json) out.json(payload); else out.out(`${target.title} [${target.status}/${target.assurance}] next=${next?.id ?? "none"}`);
    });

  goal.command("block <id>").option("-r, --reason <text>").action(async (id: string, opts: { reason?: string }) => {
    const state = await requireLeanState(ctx);
    const target = state.goals[id];
    if (!target) throw new Error(`Unknown goal: ${id}`);
    const at = nowIso();
    state.goals[id] = { ...target, status: "blocked", updated_at: at };
    await ctx.store.writeStateV3(state);
    await ctx.store.recordEvent({ id: shortId("evt"), kind: "goal.blocked", at, goal_id: id, payload: { reason: opts.reason ?? "" } });
    out.out(`Blocked goal ${id}`);
  });

  goal.command("verify <id>").action(async (id: string) => {
    const state = await requireLeanState(ctx);
    const target = state.goals[id];
    if (!target) throw new Error(`Unknown goal: ${id}`);
    state.goals[id] = { ...target, status: "verifying", updated_at: nowIso() };
    await ctx.store.writeStateV3(state);
    out.out(`Goal ${id} is verifying`);
  });

  goal.command("complete <id>").action(async (id: string) => {
    const state = await requireLeanState(ctx);
    const target = state.goals[id];
    if (!target) throw new Error(`Unknown goal: ${id}`);
    const provider = providerForState(state, id);
    const tickets = await provider.list(id);
    if (isLiveRemoteBackend(target.backend)) markTrackerLive(state, id);
    if (tickets.some((ticket) => !["done", "cancelled"].includes(ticket.status))) throw new Error("Goal has unfinished tickets.");
    for (const ticket of tickets.filter((item) => item.status === "done")) {
      const local = state.local_tickets[ticket.id];
      const evidenceTicket = local ? { ...local, status: ticket.status, updated_at: ticket.updated_at } : ticket;
      if (evidenceTicket.code_changed && !(await freshCompletionEvidence(evidenceRoot(ctx.cwd, target), state, evidenceTicket))) {
        throw new Error(`Goal cannot complete: code-changing ticket ${ticket.id} lacks fresh independent PASS evidence.`);
      }
      if (provider.backend.kind !== "local") state.local_tickets[ticket.id] = evidenceTicket;
    }
    await requireContinuationClosure({
      root: evidenceRoot(ctx.cwd, target),
      surface: "goal-completion",
    });
    state.goals[id] = { ...target, status: "done", stop_enforcement: false, updated_at: nowIso() };
    if (state.active_goal_id === id) state.active_goal_id = undefined;
    await ctx.store.writeStateV3(state);
    out.out(`Completed goal ${id}`);
  });

  goal.command("abandon <id>").action(async (id: string) => {
    const state = await requireLeanState(ctx);
    const target = state.goals[id];
    if (!target) throw new Error(`Unknown goal: ${id}`);
    state.goals[id] = { ...target, status: "abandoned", stop_enforcement: false, updated_at: nowIso() };
    if (state.active_goal_id === id) state.active_goal_id = undefined;
    await ctx.store.writeStateV3(state);
    out.out(`Abandoned goal ${id}`);
  });

  goal.command("enforce <mode>").action(async (mode: string) => {
    const state = await requireLeanState(ctx);
    const target = activeLeanGoal(state);
    if (!target) throw new Error("No active goal.");
    if (mode === "on" && target.assurance !== "high") throw new Error("Stop enforcement is available only for high-assurance goals.");
    if (mode !== "on" && mode !== "off") throw new Error("enforce mode must be on or off");
    state.goals[target.id] = { ...target, stop_enforcement: mode === "on", updated_at: nowIso() };
    await ctx.store.writeStateV3(state);
    out.out(`Stop enforcement ${mode} for ${target.id}`);
  });

  const worktree = goal.command("worktree").description("Manage an optional goal worktree");
  worktree.command("init").option("--goal <id>").option("--path <path>").option("--branch <name>").action(async (opts: { goal?: string; path?: string; branch?: string }) => {
    const state = await requireLeanState(ctx);
    const target = opts.goal ? state.goals[opts.goal] : activeLeanGoal(state);
    if (!target) throw new Error("No active goal.");
    const worktreePath = opts.path ?? path.join(".worktrees", slugify(target.title));
    const branch = opts.branch ?? `harness/${target.id}`;
    const result = await addWorktree(ctx.cwd, { worktreePath, branch });
    await writeWorktreeMetadata(goalWorktreeFile(ctx.cwd, target.id), { worktree_path: result.worktreePath, branch: result.branch, base_sha: result.base_sha });
    state.goals[target.id] = { ...target, worktree_path: path.relative(ctx.cwd, result.worktreePath), branch: result.branch, base_sha: result.base_sha, worktree_status: "active", updated_at: nowIso() };
    await ctx.store.writeStateV3(state);
    out.out(`${result.reused ? "Reused" : "Created"} worktree ${path.relative(ctx.cwd, result.worktreePath)}`);
  });

  worktree.command("finish").option("--goal <id>").action(async (opts: { goal?: string }) => {
    const state = await requireLeanState(ctx);
    const target = opts.goal ? state.goals[opts.goal] : activeLeanGoal(state);
    if (!target?.worktree_path) throw new Error("Goal has no worktree.");
    const report = await worktreeStatus(path.resolve(ctx.cwd, target.worktree_path));
    out.out(`Worktree ${target.worktree_path} branch=${report.branch ?? "?"} dirty=${report.dirty}`);
  });
}
