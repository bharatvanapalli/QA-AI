import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import generatedOutputQuality from "../server/services/generatedOutputQuality.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DEFAULT_ROOTS = ["tests/fixtures/generated-output-quality"];
const CODE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const IGNORED_DIRECTORIES = new Set([
  "evidence",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const DEFAULT_MAX_FILES = 200;
const ABSOLUTE_MAX_FILES = 2_000;

function normalizeMaxFiles(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_FILES;
  return Math.min(ABSOLUTE_MAX_FILES, Math.max(1, Math.floor(numeric)));
}

async function collectCodeFiles(entry, files, maxFiles) {
  let stat;
  try {
    stat = await fs.lstat(entry);
  } catch (_) {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (CODE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
      files.add(path.resolve(entry));
    return;
  }
  if (!stat.isDirectory() || IGNORED_DIRECTORIES.has(path.basename(entry)))
    return;
  const children = await fs.readdir(entry, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    if (files.size >= maxFiles) {
      throw new Error(
        `Generated-output verification exceeded the ${maxFiles}-file safety limit.`,
      );
    }
    await collectCodeFiles(path.join(entry, child.name), files, maxFiles);
  }
}

export async function verifyGeneratedOutput({
  roots = DEFAULT_ROOTS,
  lint = true,
  format = true,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  const boundedMaxFiles = normalizeMaxFiles(maxFiles);
  const files = new Set();
  for (const root of roots) {
    const resolved = path.isAbsolute(root)
      ? root
      : path.resolve(repoRoot, root);
    await collectCodeFiles(resolved, files, boundedMaxFiles);
  }
  const codeFiles = [...files].sort();
  if (!codeFiles.length) {
    return { files: [], lintErrors: 0, lintWarnings: 0, unformatted: [] };
  }
  const fileMap = {};
  const keyToFile = new Map();
  for (const [index, file] of codeFiles.entries()) {
    const key = `file-${index}-${path.basename(file)}`;
    fileMap[key] = await fs.readFile(file, "utf8");
    keyToFile.set(key, file);
  }
  const result = await generatedOutputQuality.verifyGeneratedFileMap(fileMap, {
    lint,
    format,
    maxFiles: boundedMaxFiles,
  });
  return {
    ...result,
    files: codeFiles,
    unformatted: result.unformatted.map((file) => keyToFile.get(file) || file),
  };
}

function parseCliArgs(args) {
  const roots = [];
  let lint = true;
  let format = true;
  let maxFiles = DEFAULT_MAX_FILES;
  for (const arg of args) {
    if (arg === "--lint-only") format = false;
    else if (arg === "--format-only") lint = false;
    else if (arg.startsWith("--max-files="))
      maxFiles = Number(arg.slice("--max-files=".length));
    else roots.push(arg);
  }
  return {
    roots: roots.length ? roots : DEFAULT_ROOTS,
    lint,
    format,
    maxFiles: normalizeMaxFiles(maxFiles),
  };
}

async function main() {
  const result = await verifyGeneratedOutput(
    parseCliArgs(process.argv.slice(2)),
  );
  if (!result.files.length) {
    console.log(
      "Generated-output quality check: no JavaScript output files found.",
    );
    return;
  }
  if (result.lintOutput) process.stdout.write(result.lintOutput);
  if (result.unformatted.length) {
    console.error("Generated-output files requiring Prettier formatting:");
    for (const file of result.unformatted)
      console.error(`- ${path.relative(repoRoot, file)}`);
  }
  console.log(
    `Generated-output quality check: ${result.files.length} files, ${result.lintErrors} lint errors, ${result.unformatted.length} unformatted.`,
  );
  if (result.lintErrors || result.unformatted.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`Generated-output quality check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
