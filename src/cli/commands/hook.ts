import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { handlePostToolUse } from "../../autonomy/deeds.js";
import { buildScoutStartupContext, scoutObligationEnabled } from "../../autonomy/scout.js";
import { buildHookOutput, buildSessionDigest, type NudgeDigest } from "../../hooks/session-start.js";
import { buildStopHookOutput, dispatchStopHook } from "../../hooks/stop.js";
import { computeNudge, NUDGE_THRESHOLD } from "../../session/nudge.js";
import type { StateT } from "../../schema/state.js";

async function readPayload(): Promise<unknown | undefined> {
  let raw = "";
  let size = 0;
  for await (const chunk of process.stdin.setEncoding("utf8")) {
    size += Buffer.byteLength(chunk, "utf8");
    if (size > 128 * 1024) throw new Error("hook_payload_too_large");
    raw += chunk;
  }
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_hook_json");
  }
}

async function readAnyState(ctx: CliContext): Promise<StateT | undefined> {
  if (!(await ctx.store.exists())) return undefined;
  try {
    return (await ctx.store.readStateV3()) as unknown as StateT;
  } catch {
    return await ctx.store.readState();
  }
}

export function registerHook(program: Command, ctx: CliContext, out: CliOutput): void {
  const hook = program.command("hook").description("Cursor/Codex hook entry points");

  hook
    .command("session-start")
    .description("Emit Cursor/Codex session-start additional_context JSON")
    .option("--payload-stdin", "Read the bounded native SessionStart payload from stdin", false)
    .action(async (opts: { payloadStdin?: boolean }) => {
      let startupPayload: unknown | undefined;
      if (opts.payloadStdin) {
        try {
          startupPayload = await readPayload();
        } catch {
          // SessionStart is fail-open: malformed or oversized host input keeps the ordinary digest.
        }
      }
      const state = await readAnyState(ctx);
      const userState = (await ctx.userStore.exists()) ? await ctx.userStore.read() : undefined;
      let nudge: NudgeDigest | undefined;
      if (state) {
        const counter = state.session_nudge ?? { user_msgs_since_wiki_write: 0 };
        const result = computeNudge(counter.user_msgs_since_wiki_write);
        nudge = { due: result.due, count: result.count, threshold: NUDGE_THRESHOLD };
      }
      const digest = buildSessionDigest(state, { userState, nudge });
      const scoutContext = startupPayload === undefined || !scoutObligationEnabled()
        ? undefined
        : await buildScoutStartupContext(startupPayload);
      out.json(buildHookOutput(digest, scoutContext));
    });

  hook
    .command("post-tool-use")
    .description("Record allowlisted successful deed evidence from current PostToolUse stdin")
    .action(async () => {
      try {
        const payload = await readPayload();
        if (payload === undefined) {
          out.json({ status: "ignored" });
          return;
        }
        out.json(await handlePostToolUse(payload));
      } catch {
        // PostToolUse is fail-open: malformed host input must not break the agent loop.
        out.json({ status: "ignored" });
      }
    });

  hook
    .command("stop")
    .description("Dispatch current Stop stdin, preserving ordinary premature-stop behavior")
    .action(async () => {
      const state = await readAnyState(ctx);
      const payload = await readPayload();
      out.json(payload === undefined
        ? buildStopHookOutput(state) ?? {}
        : await dispatchStopHook(payload, state) ?? {});
    });
}
