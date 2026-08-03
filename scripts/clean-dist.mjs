import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

rmSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist"), { recursive: true, force: true });
