#!/usr/bin/env node
/**
 * Writes dist/build-info.json so `/health` can report the exact build that is
 * running. Deployments are hard to compare by hand; the commit short SHA makes
 * "is the fix deployed?" a one-glance question.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");

const git = (args) => {
  try {
    return execSync(`git ${args}`, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
};

const info = {
  commit: git("rev-parse --short HEAD"),
  branch: git("rev-parse --abbrev-ref HEAD"),
  builtAt: new Date().toISOString(),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "build-info.json"),
  `${JSON.stringify(info, null, 2)}\n`,
  "utf8",
);
console.log(`build info: ${info.commit} (${info.branch}) built at ${info.builtAt}`);
