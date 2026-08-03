import {
  UserHarnessState,
  emptyUserState,
  type UserHarnessStateT,
} from "../schema/user-state.js";
import { userHarnessPaths, type UserHarnessPaths } from "./user-paths.js";
import {
  ensureDir,
  fileExists,
  readJsonIfExists,
  writeJsonAtomic,
} from "./io.js";
import { nowIso } from "./ids.js";

export class UserHarnessStore {
  readonly paths: UserHarnessPaths;

  constructor(homeOverride?: string) {
    this.paths = userHarnessPaths(homeOverride);
  }

  async exists(): Promise<boolean> {
    return fileExists(this.paths.stateFile);
  }

  async ensure(): Promise<UserHarnessStateT> {
    const existing = await readJsonIfExists<unknown>(this.paths.stateFile);
    if (existing !== undefined) return UserHarnessState.parse(existing);
    await ensureDir(this.paths.dir);
    const state = emptyUserState(nowIso());
    await writeJsonAtomic(this.paths.stateFile, state);
    return state;
  }

  async read(): Promise<UserHarnessStateT> {
    return this.ensure();
  }

  async write(state: UserHarnessStateT): Promise<void> {
    const validated = UserHarnessState.parse({ ...state, updated_at: nowIso() });
    await writeJsonAtomic(this.paths.stateFile, validated);
  }

  async update(
    mutator: (state: UserHarnessStateT) => Promise<UserHarnessStateT> | UserHarnessStateT,
  ): Promise<UserHarnessStateT> {
    const current = await this.read();
    const next = await mutator(current);
    await this.write(next);
    return next;
  }
}
