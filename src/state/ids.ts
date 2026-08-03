import { randomBytes } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortId(prefix?: string): string {
  const id = randomBytes(4).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "untitled";
}
