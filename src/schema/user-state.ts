import { z } from "zod";
import { IsoDateTime } from "./common.js";
import { WikiState, emptyWikiState } from "./wiki.js";

export const USER_STATE_VERSION = 1 as const;

export const UserHarnessState = z.object({
  version: z.literal(USER_STATE_VERSION),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  wiki: WikiState.default(() => emptyWikiState()),
});
export type UserHarnessStateT = z.infer<typeof UserHarnessState>;

export function emptyUserState(now: string): UserHarnessStateT {
  return {
    version: USER_STATE_VERSION,
    created_at: now,
    updated_at: now,
    wiki: emptyWikiState(),
  };
}
