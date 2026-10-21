/**
 * Bridge to the Python ML worker.
 *
 * Design notes
 * ------------
 * TensorFlow is never imported into the Node process. The API spawns
 * `python -m citrusguard.inference.worker` as a short-lived subprocess and
 * exchanges JSON over stdio. This keeps the web deploy image small, isolates
 * native crashes, and matches the serverless execution model.
 *
 * The production model artifact is NOT read from the web container's disk.
 * It is fetched from Supabase Storage (`trained-models/production/`) into a
 * cache directory and re-verified against the checksum recorded in Postgres on
 * every cold start.
 */

import "server-only";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { APP_CONFIG, BUCKETS } from "@/lib/env";
import { AppError, serverLog } from "@/lib/server";

export interface WorkerResult {
  ok: boolean;
  stage?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; detail?: string };
  quality?: Record<string, unknown>;
}

export interface PythonAvailability {
  available: boolean;
  version?: string;
  message: string;
}

// --------------------------------------------------------------------------
// Locating the ML package
// --------------------------------------------------------------------------
function repoRoot(): string {
  return process.env.CITRUSGUARD_PROJECT_ROOT?.trim() || process.cwd();
}

function mlPackageDir(): string {
  return join(repoRoot(), "ml");
}

// --------------------------------------------------------------------------
// Python availability
// --------------------------------------------------------------------------
let cachedPython: PythonAvailability | null = null;

export async function checkPython(): Promise<PythonAvailability> {
  if (cachedPython) return cachedPython;

  const result = await runRaw(["--version"], 20_000);
  if (result.code !== 0) {
    cachedPython = {
      available: false,
      message:
        "The Python ML runtime is not available on this server. Install it with `pip install -r requirements.txt` and set CITRUSGUARD_PYTHON.",
    };
    return cachedPython;
  }

  const version = (result.stdout || result.stderr).trim();
  const hasMl = existsSync(join(mlPackageDir(), "citrusguard", "__init__.py"));
  cachedPython = hasMl
    ? { available: true, version, message: "Python runtime ready." }
    : {
        available: false,
        version,
        message: "The ml/ package was not found next to the web app. Check CITRUSGUARD_PROJECT_ROOT.",
      };
  return cachedPython;
}

interface RawResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Environment shared by every Python child (one-shot worker, long-lived server
 * and the CLI). Centralised so the three cannot drift: the model cache path,
 * thread caps and TensorFlow log level must be identical whichever entry point
 * runs.
 */
function workerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: mlPackageDir(),
    PYTHONIOENCODING: "utf-8",
    // Keep TensorFlow quiet and single-threaded in constrained containers.
    TF_CPP_MIN_LOG_LEVEL: process.env.TF_CPP_MIN_LOG_LEVEL ?? "2",
    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS ?? "2",
    CITRUSGUARD_PROJECT_ROOT: repoRoot(),
  };
}

function runRaw(args: string[], timeoutMs: number, stdin?: string): Promise<RawResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(APP_CONFIG.python, args, {
      cwd: mlPackageDir(),
      env: workerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolvePromise({ code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

// --------------------------------------------------------------------------
// Long-lived inference server
// --------------------------------------------------------------------------
// The one-shot worker re-imports TensorFlow and reloads ~58 MB of Keras weights
// for every image. That cost does not depend on the image, so it is paid once
// here instead. The server is a per-Node-process singleton: the first request
// starts it, every later request reuses the warm interpreter. If it cannot be
// started or dies, `runPrediction` falls back to the one-shot worker, so this
// is purely additive.
//
// The server handles one request at a time; inference is CPU-bound, so running
// images in parallel inside one interpreter would not go faster and would make
// latency unpredictable. Requests are therefore written immediately (the server
// queues them on its stdin) and matched by id on the way back.

interface ServerCall {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

let server: import("node:child_process").ChildProcess | null = null;
let serverBuffer = "";
let serverSeq = 0;
let serverDisabled = false;
const serverCalls = new Map<number, ServerCall>();

function onServerData(chunk: string): void {
  serverBuffer += chunk;
  let index = serverBuffer.indexOf("\n");
  while (index >= 0) {
    const line = serverBuffer.slice(0, index).trim();
    serverBuffer = serverBuffer.slice(index + 1);
    index = serverBuffer.indexOf("\n");
    if (!line) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A non-JSON line is a library banner on stdout; TensorFlow occasionally
      // prints one before any request. Ignore it rather than desyncing.
      continue;
    }
    const id = typeof parsed.id === "number" ? parsed.id : null;
    if (id === null) continue;
    const call = serverCalls.get(id);
    if (!call) continue;
    serverCalls.delete(id);
    clearTimeout(call.timer);
    call.resolve(parsed);
  }
}

function startServer(): void {
  if (server || serverDisabled) return;
  serverLog("ml", "starting persistent inference server");
  const child = spawn(APP_CONFIG.python, ["-m", "citrusguard.inference.server"], {
    cwd: mlPackageDir(),
    env: workerEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  server = child;
  serverBuffer = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", onServerData);
  child.stderr?.on("data", (chunk) => serverLog("ml", `[server] ${String(chunk).trim()}`));

  child.on("error", (error) => {
    serverLog("ml", `inference server failed to start: ${error.message}`);
    serverDisabled = true;
    server = null;
    const failure = new AppError("prediction_failed", "The inference server could not be started.");
    for (const call of serverCalls.values()) {
      clearTimeout(call.timer);
      call.reject(failure);
    }
    serverCalls.clear();
  });

  child.on("exit", (code, signal) => {
    serverLog("ml", `inference server exited (code=${code}, signal=${signal})`);
    server = null;
    serverBuffer = "";
    const failure = new AppError("prediction_failed", "The inference server stopped unexpectedly.");
    for (const call of serverCalls.values()) {
      clearTimeout(call.timer);
      call.reject(failure);
    }
    serverCalls.clear();
  });
}

/** Send one request to the warm server and await its response object. */
function callServer(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    startServer();
    if (!server?.stdin || server.stdin.destroyed) {
      rejectPromise(new AppError("prediction_failed", "The inference server is not available."));
      return;
    }
    const id = ++serverSeq;
    const timer = setTimeout(() => {
      serverCalls.delete(id);
      rejectPromise(
        new AppError("prediction_failed", `Prediction timed out after ${timeoutMs}ms.`),
      );
    }, timeoutMs);
    serverCalls.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    server.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
  });
}

/**
 * Load a production bundle into the warm server ahead of the first prediction.
 * Resolves to the measured warm-up time in seconds, or null when the server is
 * unavailable (so the caller simply falls back to the one-shot path).
 */
export async function warmInferenceServer(bundleDir: string, timeoutMs = 300_000): Promise<number | null> {
  if (serverDisabled) return null;
  try {
    const response = await callServer(
      { op: "load", bundle_dir: bundleDir },
      timeoutMs,
    );
    if (response.ok && typeof response.warm_seconds === "number") return response.warm_seconds;
    return null;
  } catch (error) {
    serverLog("ml", `warm-up skipped: ${(error as Error).message}`);
    return null;
  }
}

/** Run a `citrusguard` CLI subcommand and parse its JSON stdout. */
export async function runCli(args: string[], timeoutMs = 15 * 60_000): Promise<Record<string, unknown>> {
  const python = await checkPython();
  if (!python.available) {
    throw new AppError("model_not_configured", "The ML runtime is not available on this server.");
  }

  serverLog("ml", `running: citrusguard ${args.join(" ")}`);
  const result = await runRaw(["-m", "citrusguard", ...args], timeoutMs);

  const parsed = parseJsonLoose(result.stdout);
  if (result.code !== 0 || !parsed) {
    serverLog("ml", `cli failed (exit ${result.code})`, result.stderr.slice(-4000));
    const code = (parsed?.error as { code?: string } | undefined)?.code;
    throw new AppError(mapWorkerCode(code), extractCliMessage(parsed) ?? "The operation failed. See server logs.", {
      detail: result.stderr.slice(-2000),
    });
  }
  return parsed;
}

function parseJsonLoose(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // The CLI prints exactly one JSON document, but a stray library banner can
  // precede it, so scan forward to the first brace.
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  try {
    return JSON.parse(trimmed.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractCliMessage(parsed: Record<string, unknown> | null): string | null {
  const error = parsed?.error as { message?: string } | undefined;
  return typeof error?.message === "string" ? error.message : null;
}

function mapWorkerCode(code?: string): AppError["code"] {
  switch (code) {
    case "dataset_download_failed":
      return "dataset_download_failed";
    case "dataset_checksum_mismatch":
      return "dataset_validation_failed";
    case "dataset_validation_failed":
      return "dataset_validation_failed";
    case "dataset_archive_invalid":
      return "dataset_download_failed";
    case "model_not_configured":
      return "model_not_configured";
    case "image_invalid":
      return "image_invalid";
    case "image_quality_insufficient":
      return "image_quality_insufficient";
    case "routing_uncertain":
      return "routing_uncertain";
    case "prediction_failed":
      return "prediction_failed";
    case "unauthorized":
      return "unauthorized";
    case "admin_required":
      return "forbidden";
    case "storage_failed":
      return "storage_error";
    default:
      return "internal_error";
  }
}

// --------------------------------------------------------------------------
// Production model bundle
// --------------------------------------------------------------------------
export interface ModelBundleHandle {
  dir: string;
  version: string;
  checksum: string | null;
}

/**
 * Ensure the production model artifact is present locally, pulling it from
 * Supabase Storage when the cache is cold (which is always, on serverless).
 */
export async function ensureProductionBundle(
  supabase: { storage: { from(bucket: string): any } },
  options: { expectedVersion?: string | null; expectedChecksum?: string | null } = {},
): Promise<ModelBundleHandle> {
  const cacheRoot = resolve(repoRoot(), APP_CONFIG.modelCacheDir);
  const configPath = join(cacheRoot, "config.json");

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        model_version?: string;
        model_checksum?: string;
      };
      if (
        (!options.expectedVersion || config.model_version === options.expectedVersion) &&
        (!options.expectedChecksum || config.model_checksum === options.expectedChecksum)
      ) {
        return {
          dir: cacheRoot,
          version: config.model_version ?? "unknown",
          checksum: config.model_checksum ?? null,
        };
      }
      // A different version is now active: drop the stale cache.
      await rm(cacheRoot, { recursive: true, force: true });
    } catch {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  }

  const bucket = supabase.storage.from(BUCKETS.models);
  const configBlob = await bucket.download("production/config.json").catch(() => null);
  if (!configBlob) {
    const localProdDir = resolve(repoRoot(), "models/production");
    const localProdConfigPath = join(localProdDir, "config.json");
    if (existsSync(localProdConfigPath)) {
      try {
        const localManifest = JSON.parse(await readFile(localProdConfigPath, "utf8")) as {
          model_version?: string;
          model_checksum?: string;
          artifacts?: Record<string, string>;
        };
        if (
          (!options.expectedVersion || localManifest.model_version === options.expectedVersion) &&
          (!options.expectedChecksum || localManifest.model_checksum === options.expectedChecksum)
        ) {
          await mkdir(cacheRoot, { recursive: true });
          await copyFile(localProdConfigPath, configPath);
          for (const filename of Object.values(localManifest.artifacts ?? {})) {
            await copyFile(join(localProdDir, filename), join(cacheRoot, filename));
          }
          return {
            dir: cacheRoot,
            version: localManifest.model_version ?? "unknown",
            checksum: localManifest.model_checksum ?? null,
          };
        }
      } catch (err) {
        serverLog("ml", "Failed to seed model cache from models/production", err);
      }
    }

    throw new AppError(
      "model_not_configured",
      "Model is not configured. No production model has been deployed to Supabase Storage yet.",
    );
  }

  const manifest = JSON.parse(Buffer.from(configBlob as ArrayBuffer).toString("utf8")) as {
    model_version?: string;
    model_checksum?: string;
    artifacts?: Record<string, string>;
  };

  await mkdir(cacheRoot, { recursive: true });
  await writeFile(configPath, Buffer.from(configBlob as ArrayBuffer));

  for (const filename of Object.values(manifest.artifacts ?? {})) {
    const blob = await bucket.download(`production/${filename}`).catch(() => null);
    if (!blob) {
      await rm(cacheRoot, { recursive: true, force: true });
      throw new AppError(
        "model_not_configured",
        `The production model bundle is incomplete (missing ${filename}). Deploy a complete version from the admin panel.`,
      );
    }
    const buffer = Buffer.from(blob as ArrayBuffer);
    await writeFile(join(cacheRoot, filename), buffer);
  }

  return {
    dir: cacheRoot,
    version: manifest.model_version ?? "unknown",
    checksum: manifest.model_checksum ?? null,
  };
}

// --------------------------------------------------------------------------
// Prediction
// --------------------------------------------------------------------------
export interface PredictOptions {
  imageBytes: Buffer;
  extension: string;
  bundleDir: string;
  enableGradCam?: boolean;
  /** Explicit leaf/fruit choice from the uploader; null/omitted to auto-route. */
  inputTypeHint?: "leaf" | "fruit" | null;
  timeoutMs?: number;
}

export interface PredictOutcome {
  ok: boolean;
  payload: Record<string, unknown> | null;
  error: { code: string; message: string; detail?: string } | null;
  /** Populated even when the quality gate rejected the image. */
  quality: Record<string, unknown> | null;
  /** Artefact bytes read out of the worker's temp dir before it is cleaned up. */
  artifacts: {
    processed: { bytes: Buffer; extension: string } | null;
    heatmap: Buffer | null;
    overlay: Buffer | null;
  };
}

/**
 * Send one request to the preferred inference path: the warm, long-lived server
 * when it is running, else a one-shot `worker` subprocess. Returns the parsed
 * response object, or null when no JSON could be read at all.
 *
 * A model error or a timeout is returned as-is (the caller must not silently
 * retry a genuinely slow request). Only a server that could not start or that
 * has died falls through to the one-shot worker.
 */
async function invokeWorker(
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  if (!serverDisabled) {
    try {
      return await callServer(request, timeoutMs);
    } catch (error) {
      const alive = server !== null && server.exitCode === null && !server.killed;
      if (alive) throw error;
      serverLog(
        "ml",
        `inference server unavailable (${(error as Error).message}); using one-shot worker`,
      );
    }
  }

  const raw = await runRaw(
    ["-m", "citrusguard.inference.worker"],
    timeoutMs,
    JSON.stringify(request),
  );
  const parsed = parseJsonLoose(raw.stdout);
  if (!parsed) {
    serverLog("ml", `worker produced no JSON (exit ${raw.code})`, raw.stderr.slice(-4000));
  }
  return parsed;
}

/**
 * Run one prediction.
 *
 * The worker writes its artefacts into a private temp directory. Because the
 * process is short-lived and the temp dir is removed in a `finally` block, the
 * artefact *bytes* are read back and returned in memory. The caller uploads them
 * to `scan-images` and only then are they gone - nothing depends on the
 * container's filesystem surviving, which is what makes this safe on serverless.
 */
export async function runPrediction(options: PredictOptions): Promise<PredictOutcome> {
  const python = await checkPython();
  if (!python.available) {
    throw new AppError("model_not_configured", python.message);
  }

  const workDir = await mkdtemp(join(tmpdir(), "citrusguard-"));
  const imagePath = join(workDir, `upload.${options.extension}`);
  const explainDir = join(workDir, "explanation");
  await writeFile(imagePath, options.imageBytes);

  try {
    const request = {
      image_path: imagePath,
      bundle_dir: options.bundleDir,
      output_dir: explainDir,
      processed_name: "processed.png",
      enable_gradcam: options.enableGradCam ?? true,
      input_type_hint: options.inputTypeHint ?? null,
    };

    const timeoutMs = options.timeoutMs ?? 120_000;
    serverLog("ml", `predicting with bundle ${options.bundleDir}`);
    const startedAt = Date.now();
    const parsed = await invokeWorker(request, timeoutMs);
    if (!parsed) {
      throw new AppError("prediction_failed", "Prediction failed. Please try again.");
    }
    serverLog("ml", `inference responded in ${Date.now() - startedAt}ms (warm=${server !== null})`);

    const payload = (parsed.result as Record<string, unknown> | undefined) ?? null;
    const error = (parsed.error as PredictOutcome["error"]) ?? null;
    const quality = (parsed.quality as Record<string, unknown> | null) ?? null;

    const readIfPresent = async (path: unknown): Promise<Buffer | null> => {
      if (typeof path !== "string" || !path) return null;
      try {
        return await readFile(path);
      } catch {
        return null;
      }
    };

    const gradcam = (payload?.gradcam ?? null) as { heatmap_path?: string; overlay_path?: string } | null;
    const processedBytes = await readIfPresent(payload?.processed_path);
    const [heatmap, overlay] = await Promise.all([
      readIfPresent(gradcam?.heatmap_path),
      readIfPresent(payload?.explanation_path ?? gradcam?.overlay_path),
    ]);

    return {
      ok: Boolean(parsed.ok),
      payload,
      error,
      quality,
      artifacts: {
        processed: processedBytes ? { bytes: processedBytes, extension: "png" } : null,
        heatmap,
        overlay,
      },
    };
  } finally {
    // The worker runs out-of-process and its artefacts have already been read
    // into memory, so nothing depends on this temp directory surviving.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Utility used by tests and the health endpoint. */
export function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}
