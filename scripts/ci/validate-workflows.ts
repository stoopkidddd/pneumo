import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

// Key lists: https://tangled.org/docs/spindles/workflows/
// This checks supported keys and container shapes, not the full spindle schema.
const common = ["when", "engine", "clone", "environment", "cache", "steps", "runs_on", "audience"];
const nixos = ["registry", "substituters", "services", "virtualisation"];

function mapping(value: unknown, at: string, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${at}: expected a mapping`);
  }
  const result = value as Record<string, unknown>;
  if (keys) {
    for (const key of Object.keys(result)) {
      if (!keys.includes(key)) throw new Error(`${at}: unsupported key ${JSON.stringify(key)}`);
    }
  }
  return result;
}

function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected a list`);
  return value;
}

function validate(value: unknown): void {
  const workflow = mapping(value, "workflow");
  const engine = workflow.engine;
  if (engine !== "nixery" && engine !== "microvm" && engine !== "dummy") {
    throw new Error("workflow.engine: expected nixery, microvm or dummy");
  }
  // NixOS options are accepted on every microVM image, but ignored on non-NixOS images.
  const engineKeys =
    engine === "nixery"
      ? ["dependencies"]
      : engine === "microvm"
        ? ["image", "dependencies", ...nixos]
        : [];
  mapping(workflow, `workflow (${engine})`, [...common, ...engineKeys]);

  if (workflow.when !== undefined) {
    for (const [index, value] of list(workflow.when, "when").entries()) {
      const at = `when[${index}]`;
      const trigger = mapping(value, at, ["event", "branch", "tag", "types", "paths", "schedule"]);
      if (trigger.schedule !== undefined) {
        for (const [index, entry] of list(trigger.schedule, `${at}.schedule`).entries()) {
          mapping(entry, `${at}.schedule[${index}]`, ["cron", "timezone"]);
        }
      }
    }
  }
  if (workflow.clone !== undefined) {
    mapping(workflow.clone, "clone", ["skip", "depth", "submodules", "tags"]);
  }
  if (workflow.environment !== undefined) mapping(workflow.environment, "environment");
  if (workflow.cache !== undefined) {
    for (const [index, entry] of list(workflow.cache, "cache").entries()) {
      mapping(entry, `cache[${index}]`, [
        "key",
        "paths",
        "hash",
        "fallback",
        "compression-level",
        "when",
      ]);
    }
  }
  if (workflow.steps !== undefined) {
    for (const [index, entry] of list(workflow.steps, "steps").entries()) {
      const step = mapping(entry, `steps[${index}]`, ["name", "command", "environment"]);
      if (step.environment !== undefined) mapping(step.environment, `steps[${index}].environment`);
    }
  }
  if (workflow.dependencies !== undefined) {
    if (engine === "nixery") {
      const registries = mapping(workflow.dependencies, "dependencies");
      for (const [registry, packages] of Object.entries(registries)) {
        list(packages, `dependencies.${registry}`);
      }
    } else {
      list(workflow.dependencies, "dependencies");
    }
  }
  for (const key of nixos) {
    // These are open-ended registry/NixOS option maps, not spindle key namespaces.
    if (workflow[key] !== undefined) mapping(workflow[key], key);
  }
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = resolve(root, ".tangled/workflows");
const files = process.argv.slice(2);
if (files.length === 0) {
  files.push(
    ...readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => resolve(directory, name)),
  );
}
for (const file of files) {
  try {
    const document = parseDocument(readFileSync(file, "utf8"));
    if (document.errors.length > 0) throw document.errors[0];
    validate(document.toJS());
    console.log(`workflow valid: ${file}`);
  } catch (error) {
    console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
