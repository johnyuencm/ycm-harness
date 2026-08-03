export interface CliOutput {
  out(text: string): void;
  err(text: string): void;
  json(value: unknown): void;
}

export function consoleOutput(): CliOutput {
  return {
    out(text) {
      process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    },
    err(text) {
      process.stderr.write(text + (text.endsWith("\n") ? "" : "\n"));
    },
    json(value) {
      process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    },
  };
}
