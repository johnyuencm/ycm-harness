import path from "node:path";
import { HarnessStore } from "../state/store.js";
import { UserHarnessStore } from "../state/user-store.js";

export interface CliContext {
  cwd: string;
  store: HarnessStore;
  userStore: UserHarnessStore;
}

export function createContext(cwdOverride?: string): CliContext {
  const cwd = path.resolve(cwdOverride ?? process.cwd());
  return { cwd, store: new HarnessStore(cwd), userStore: new UserHarnessStore() };
}
