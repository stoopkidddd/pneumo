import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { CryptoVectors } from "./vectors.js";

const vectorUrl = new URL("../vectors/v1.json", import.meta.url);
const crosscheckUrl = new URL("../../../scripts/crosscheck_vectors.py", import.meta.url);
const sourceUrl = new URL("../src/", import.meta.url);

async function scanSourceDirectory(directory: URL, relativeDirectory: string): Promise<string[]> {
  const violations: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}${entry.name}`;
    const entryUrl = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      violations.push(
        ...(await scanSourceDirectory(new URL(`${entry.name}/`, directory), `${relativePath}/`)),
      );
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const source = await readFile(entryUrl, "utf8");
      if (/["']node:/.test(source)) {
        violations.push(`${relativePath}: Node module specifier`);
      }
      if (/\bBuffer\b/.test(source)) {
        violations.push(`${relativePath}: Node binary global`);
      }
    }
  }
  return violations;
}

export function findPortableSourceViolations(): Promise<string[]> {
  return scanSourceDirectory(sourceUrl, "");
}

export async function readCommittedVectors(): Promise<{
  text: string;
  vectors: CryptoVectors;
}> {
  const text = await readFile(vectorUrl, "utf8");
  return { text, vectors: JSON.parse(text) as CryptoVectors };
}

export async function runPythonCrosscheck(): Promise<void> {
  const child = spawn("python3", ["-I", fileURLToPath(crosscheckUrl), fileURLToPath(vectorUrl)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let diagnostic = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    diagnostic += chunk;
  });
  const result = await once(child, "close");
  const code = result[0] as number | null;
  const signal = result[1] as NodeJS.Signals | null;
  if (code !== 0) {
    const status = signal === null ? `exit ${String(code)}` : `signal ${signal}`;
    throw new Error(`Python vector cross-check failed (${status}): ${diagnostic.trim()}`);
  }
}
