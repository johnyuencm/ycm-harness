import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

export const SmokeOutcome = z.enum(["pass", "fail", "not_applicable"]);
export type SmokeOutcomeT = z.infer<typeof SmokeOutcome>;

export const SmokeRecordingMode = z.enum(["executed", "manual"]);
export type SmokeRecordingModeT = z.infer<typeof SmokeRecordingMode>;

export const SmokeEvidence = z.object({
  id: SlugId,
  task_id: SlugId.optional(),
  phase_id: SlugId.optional(),
  outcome: SmokeOutcome,
  recording_mode: SmokeRecordingMode.default(() => "manual" as const),
  command: ShortText.optional(),
  environment: ShortText.optional(),
  expected: LongText.optional(),
  actual: LongText.optional(),
  exit_code: z.number().int().optional(),
  log_file: ShortText.optional(),
  log_sha256: ShortText.optional(),
  executed_at: IsoDateTime.optional(),
  artifact_paths: z.array(ShortText).default(() => []),
  reason_not_applicable: LongText.optional(),
  recorded_at: IsoDateTime,
});
export type SmokeEvidenceT = z.infer<typeof SmokeEvidence>;
