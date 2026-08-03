import type { CliContext } from "./context.js";
import { migrateOnDisk } from "../migration/disk.js";
import type { StateV3T } from "../schema/v3.js";

/** Migrate the one-release V2 bridge exactly once before a mutating lean command. */
export async function requireLeanState(ctx: CliContext): Promise<StateV3T> {
  try {
    return await ctx.store.readStateV3();
  } catch {
    await migrateOnDisk(ctx.cwd, { dryRun: false });
    return ctx.store.readStateV3();
  }
}

export async function writeLeanState(ctx: CliContext, state: StateV3T): Promise<StateV3T> {
  await ctx.store.writeStateV3(state);
  return state;
}

export function activeLeanGoal(state: StateV3T) {
  return state.active_goal_id ? state.goals[state.active_goal_id] : undefined;
}
