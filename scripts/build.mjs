/** Builds TypeScript into staging before atomically promoting each output. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Repository root containing the compiler configuration and live output. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Live package output kept available to globally linked installations. */
const destinationRoot = join(root, "dist");

/** Recursively lists file paths relative to a root directory. */
async function listFiles(directory, prefix = "") {
  /** Files discovered below this directory. */
  const files = [];
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    /** Entry path relative to the requested directory. */
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Runs the repository-local TypeScript compiler into an isolated directory. */
async function compile(stagingRoot) {
  /** Cross-platform path to the compiler's JavaScript entry point. */
  const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
  await new Promise((resolvePromise, rejectPromise) => {
    /** Compiler child process whose exit gates all live-output changes. */
    const child = spawn(
      process.execPath,
      [compiler, "-p", join(root, "tsconfig.json"), "--outDir", stagingRoot],
      { cwd: root, stdio: "inherit" },
    );
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(
          new Error(
            `TypeScript compilation failed${signal === null ? ` with exit code ${String(code)}` : ` from signal ${signal}`}`,
          ),
        );
    });
  });
}

/** Removes now-empty directories below the live output root. */
async function pruneEmptyDirectories(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    /** Child directory inspected after its own descendants are pruned. */
    const child = join(directory, entry.name);
    await pruneEmptyDirectories(child);
    if ((await readdir(child)).length === 0) await rmdir(child);
  }
}

/** Atomically promotes staged files, then atomically unlinks stale outputs. */
async function promote(stagingRoot) {
  /** Complete output manifest produced by the successful compiler run. */
  const stagedFiles = await listFiles(stagingRoot);
  /** Manifest lookup used to identify stale live artifacts. */
  const expected = new Set(stagedFiles);
  await mkdir(destinationRoot, { recursive: true });
  for (const path of stagedFiles) {
    /** Final destination for this compiler output. */
    const destination = join(destinationRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await rename(join(stagingRoot, path), destination);
  }
  for (const path of await listFiles(destinationRoot)) {
    if (!expected.has(path)) await rm(join(destinationRoot, path));
  }
  await pruneEmptyDirectories(destinationRoot);
}

/** Unique sibling-volume staging directory supporting atomic file renames. */
const stagingRoot = await mkdtemp(
  join(dirname(destinationRoot), ".agent-task-manager-build-"),
);
try {
  await compile(stagingRoot);
  await promote(stagingRoot);
} finally {
  await rm(stagingRoot, { force: true, recursive: true });
}
