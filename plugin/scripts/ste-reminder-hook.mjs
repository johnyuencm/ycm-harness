#!/usr/bin/env node
// UserPromptSubmit hook for Claude Code and Codex.
// Rules loaded once at session start fade over a long session; this repeats the
// output-style rule on every prompt. Both hosts add plain stdout to the model context.
// Keep it short: it costs tokens on every turn.

export const STE_REMINDER =
  "ASD-STE100 ACTIVE (about 80% strict). Apply to this reply, every reply: " +
  "one idea per sentence; procedural sentences max 20 words, descriptive max 25; " +
  "active voice; imperative for instructions; simple present tense; " +
  "same word for the same thing; noun clusters max 3 words; " +
  "approved simple words (use, start, before, about, make sure, to). " +
  "Keep code, commands, paths and quoted errors exact. " +
  "Show structure or flow as a Mermaid diagram, not as prose.";

process.stdout.write(STE_REMINDER + "\n");
