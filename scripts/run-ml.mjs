/**
 * Cross-platform launcher for the Python side of CitrusGuard.
 *
 * Why this exists instead of a plain `python -m citrusguard ...` in package.json:
 *
 *   - The Python package root is `ml/`, so `-m citrusguard` only resolves when the
 *     working directory is `ml/` (or PYTHONPATH points at it).
 *   - `PYTHONPATH=. python -m ...` - the usual fix - is POSIX shell syntax. npm
 *     runs scripts through cmd.exe on Windows, where that form does not work, so
 *     the ml:* scripts failed on Windows while appearing correct in package.json.
 *   - Node's `spawn` has neither problem: `cwd` and `env` are plain options on
 *     every platform.
 *
 * Usage:
 *   node scripts/run-ml.mjs model train --parts Leaves
 *
 * Every argument after the script name is forwarded verbatim, the child's exit
 * code becomes this process's exit code, and its stdio is inherited so output
 * and Ctrl-C behave normally. No secret is read or printed here; the Python side
 * reads its configuration from the environment and `.env.local` as usual.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const mlRoot = resolve(projectRoot, "ml");

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  console.log("Usage: node scripts/run-ml.mjs <citrusguard args...>");
  console.log("Example: node scripts/run-ml.mjs dataset verify");
  console.log("Runs `python -m citrusguard <args>` with cwd=ml/ and PYTHONPATH=.");
  process.exit(argv.length === 0 ? 1 : 0);
}

if (!existsSync(resolve(mlRoot, "citrusguard", "__main__.py"))) {
  console.error(`\n  ERROR  No Python package at ${mlRoot}`);
  console.error("  Expected ml/citrusguard/__main__.py. Is the repository complete?\n");
  process.exit(1);
}

/**
 * `CITRUSGUARD_PYTHON` lets a deployment name an interpreter explicitly
 * (a venv, a full path). It is optional; `python` is the default.
 */
const interpreter = process.env.CITRUSGUARD_PYTHON?.trim() || "python";

const child = spawn(interpreter, ["-m", "citrusguard", ...argv], {
  cwd: mlRoot,
  // `ml` (not `.`) is used so the child also works if a future caller changes
  // the working directory; both are equivalent here because cwd IS ml/.
  env: { ...process.env, PYTHONPATH: mlRoot },
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  const code = /** @type {{ code?: string }} */ (error).code;
  if (code === "ENOENT") {
    console.error(`\n  ERROR  Python interpreter not found: ${interpreter}`);
    console.error("  Install Python 3.10+ and make sure it is on PATH, or set CITRUSGUARD_PYTHON.\n");
    process.exit(1);
  }
  console.error(`\n  ERROR  Could not start ${interpreter}: ${error.message}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Mirror the shell convention: 128 + signal number.
    process.exit(typeof signal === "string" ? 1 : 1);
  }
  process.exit(code ?? 1);
});