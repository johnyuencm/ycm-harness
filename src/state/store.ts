import { State, emptyState, migrateStateIfNeeded, type StateT } from "../schema/state.js";
import { StateV3, type StateV3T } from "../schema/v3.js";
import { Event, type EventT } from "../schema/event.js";
import { harnessPaths, type HarnessPaths } from "./paths.js";
import {
  appendJsonl,
  ensureDir,
  fileExists,
  readJsonIfExists,
  writeJsonAtomic,
} from "./io.js";
import { nowIso, shortId } from "./ids.js";

export interface InitOptions {
  root: string;
  force?: boolean;
}

export class HarnessStore {
  readonly paths: HarnessPaths;

  constructor(root: string) {
    this.paths = harnessPaths(root);
  }

  async exists(): Promise<boolean> {
    return fileExists(this.paths.stateFile);
  }

  async init(options: { force?: boolean } = {}): Promise<StateT> {
    const exists = await this.exists();
    if (exists && !options.force) {
      throw new Error(
        `ycm-harness already initialized at ${this.paths.dir}. Use --force to reinitialize.`,
      );
    }
    await ensureDir(this.paths.dir);
    await ensureDir(this.paths.goalsDir);
    await ensureDir(this.paths.phasesDir);
    await ensureDir(this.paths.tasksDir);
    await ensureDir(this.paths.checkpointsDir);
    await ensureDir(this.paths.sessionsDir);
    await ensureDir(this.paths.smokeDir);

    const state = emptyState(nowIso());
    await this.writeState(state);
    await this.recordEvent({
      id: shortId("evt"),
      kind: "init",
      at: state.created_at,
    });
    return state;
  }

  async readState(): Promise<StateT> {
    const raw = await readJsonIfExists<unknown>(this.paths.stateFile);
    if (raw === undefined) {
      throw new Error(
        `ycm-harness not initialized at ${this.paths.dir}. Run 'ycm-harness init' first.`,
      );
    }
    return State.parse(migrateStateIfNeeded(raw));
  }

  /** Read the lean V3 state without weakening the legacy V2 parser. */
  async readStateV3(): Promise<StateV3T> {
    const raw = await readJsonIfExists<unknown>(this.paths.stateFile);
    if (raw === undefined) throw new Error(`ycm-harness not initialized at ${this.paths.dir}. Run 'ycm-harness init' first.`);
    return StateV3.parse(raw);
  }

  async writeState(state: StateT): Promise<void> {
    const validated = State.parse({ ...state, updated_at: nowIso() });
    await writeJsonAtomic(this.paths.stateFile, validated);
  }

  async writeStateV3(state: StateV3T): Promise<void> {
    const validated = StateV3.parse({ ...state, updated_at: nowIso() });
    await writeJsonAtomic(this.paths.stateFile, validated);
  }

  async update(mutator: (state: StateT) => Promise<StateT> | StateT): Promise<StateT> {
    const current = await this.readState();
    const next = await mutator(current);
    await this.writeState(next);
    return next;
  }

  async updateV3(mutator: (state: StateV3T) => Promise<StateV3T> | StateV3T): Promise<StateV3T> {
    const current = await this.readStateV3();
    const next = await mutator(current);
    await this.writeStateV3(next);
    return next;
  }

  async recordEvent(event: EventT): Promise<EventT> {
    const validated = Event.parse(event);
    await appendJsonl(this.paths.eventsFile, validated);
    return validated;
  }
}
