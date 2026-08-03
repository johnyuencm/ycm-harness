export type CavemanLevel = "lite" | "full";

const ARTICLES = new Set(["a", "an", "the"]);

const FILLER = new Set([
  "just",
  "really",
  "basically",
  "actually",
  "simply",
  "essentially",
  "generally",
  "very",
  "quite",
  "rather",
]);

const PLEASANTRIES = [
  /\bSure[,.!]?\s*/g,
  /\bCertainly[,.!]?\s*/g,
  /\bOf course[,.!]?\s*/g,
  /\bI'?d be happy to\s*/gi,
  /\bI'?d recommend\s*/gi,
  /\bHappy to (?:help|assist)\s*/gi,
  /\bThanks for (?:asking|the question)[,.!]?\s*/gi,
];

const HEDGES = [
  /\bIt might be worth\s+/gi,
  /\bYou could consider\s+/gi,
  /\bYou might want to consider\s+/gi,
  /\bYou may want to consider\s+/gi,
  /\bIt would be good to\s+/gi,
  /\bIt'?s worth noting that\s+/gi,
  /\bperhaps\s+/gi,
];

const SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, "to"],
  [/\bmake sure (?:to|that)\b/gi, "ensure"],
  [/\bthe reason is because\b/gi, "because"],
  [/\bperform an? (\w+)\b/gi, "$1"],
  [/\bimplement a solution for\b/gi, "fix"],
  [/\butilize\b/gi, "use"],
  [/\bextensive\b/gi, "big"],
];

interface Span {
  start: number;
  end: number;
}

function findProtectedSpans(text: string): Span[] {
  const raw: Span[] = [];
  const fence = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    raw.push({ start: m.index, end: m.index + m[0].length });
  }
  const inline = /`[^`\n]*`/g;
  while ((m = inline.exec(text)) !== null) {
    raw.push({ start: m.index, end: m.index + m[0].length });
  }
  const url = /\bhttps?:\/\/\S+/g;
  while ((m = url.exec(text)) !== null) {
    raw.push({ start: m.index, end: m.index + m[0].length });
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

function isProtected(spans: Span[], index: number): boolean {
  for (const s of spans) {
    if (index >= s.start && index < s.end) return true;
    if (s.start > index) return false;
  }
  return false;
}

export interface CompressOptions {
  level?: CavemanLevel;
}

export function caveman(input: string, opts: CompressOptions = {}): string {
  const level: CavemanLevel = opts.level ?? "full";
  const spans = findProtectedSpans(input);
  const segments: string[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (cursor < s.start) {
      segments.push(transformPlain(input.slice(cursor, s.start), level));
    }
    segments.push(input.slice(s.start, s.end));
    cursor = s.end;
  }
  if (cursor < input.length) {
    segments.push(transformPlain(input.slice(cursor), level));
  }
  return segments.join("");
}

function transformPlain(text: string, level: CavemanLevel): string {
  let out = text;
  for (const re of PLEASANTRIES) out = out.replace(re, "");
  for (const re of HEDGES) out = out.replace(re, "");
  for (const [re, sub] of SUBSTITUTIONS) out = out.replace(re, sub);
  if (level === "full") {
    out = out.replace(/\b([A-Za-z']+)\b/g, (match) => {
      const lower = match.toLowerCase();
      if (ARTICLES.has(lower)) return "";
      if (FILLER.has(lower)) return "";
      return match;
    });
  } else {
    out = out.replace(/\b([A-Za-z']+)\b/g, (match) => {
      const lower = match.toLowerCase();
      if (FILLER.has(lower)) return "";
      return match;
    });
  }
  out = out.replace(/[ \t]{2,}/g, " ");
  out = out.replace(/[ \t]+([,.;:!?])/g, "$1");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}
