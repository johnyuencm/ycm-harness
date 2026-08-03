import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

export const WikiSource = z.object({
  id: SlugId,
  title: ShortText,
  raw_path: ShortText,
  origin: ShortText.optional(),
  added_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type WikiSourceT = z.infer<typeof WikiSource>;

export const WikiPage = z.object({
  id: SlugId,
  title: ShortText,
  source_ids: z.array(SlugId).default(() => []),
  tags: z.array(SlugId).default(() => []),
  body_path: ShortText,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type WikiPageT = z.infer<typeof WikiPage>;

export const WikiLogKind = z.enum([
  "wiki.created",
  "source.added",
  "page.upserted",
  "wiki.checkpoint",
  "wiki.linted",
  "wiki.queried",
]);
export type WikiLogKindT = z.infer<typeof WikiLogKind>;

export const WikiLogEntry = z.object({
  id: SlugId,
  kind: WikiLogKind,
  ref: SlugId.optional(),
  note: LongText.optional(),
  at: IsoDateTime,
});
export type WikiLogEntryT = z.infer<typeof WikiLogEntry>;

export const WikiState = z.object({
  initialized: z.boolean().default(false),
  initialized_at: IsoDateTime.optional(),
  sources: z.record(WikiSource).default(() => ({})),
  pages: z.record(WikiPage).default(() => ({})),
  log: z.array(WikiLogEntry).default(() => []),
});
export type WikiStateT = z.infer<typeof WikiState>;

export function emptyWikiState(): WikiStateT {
  return { initialized: false, sources: {}, pages: {}, log: [] };
}
