export const NUDGE_THRESHOLD = 15;

export interface NudgeStateLike {
  user_msgs_since_wiki_write: number;
  last_wiki_write_at?: string;
  last_user_msg_at?: string;
}

export function computeNudge(count: number, threshold: number = NUDGE_THRESHOLD): {
  due: boolean;
  count: number;
  threshold: number;
} {
  return { due: count >= threshold, count, threshold };
}

export function tickUserMessage(state: NudgeStateLike, at: string): NudgeStateLike {
  return {
    ...state,
    user_msgs_since_wiki_write: state.user_msgs_since_wiki_write + 1,
    last_user_msg_at: at,
  };
}

export function resetOnWikiWrite(state: NudgeStateLike, at: string): NudgeStateLike {
  return {
    ...state,
    user_msgs_since_wiki_write: 0,
    last_wiki_write_at: at,
  };
}
