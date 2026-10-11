/**
 * Thin wrapper over the `citrusguard` CLI.
 *
 * Keeping every Python invocation behind this one module means the rest of the
 * app never touches `child_process`, and there is exactly one place where the
 * CLI's JSON contract is understood.
 */

import "server-only";

import { runCli } from "@/lib/ml/client";

/**
 * A read-only status command. Never throws for a missing artefact.
 *
 * Generic so each caller declares the CLI payload shape it depends on. The
 * Python side is the real contract, so an untyped `Record<string, unknown>`
 * return here would push every access into a cast - and a cast would keep
 * compiling even if the CLI's keys changed.
 */
export async function execCliStatus<T = Record<string, unknown>>(args: string[]): Promise<T> {
  return (await runCli(args, 120_000)) as T;
}

/** A mutating command. May take minutes (training); call it from a job, not a request. */
export async function execCliCommand<T = Record<string, unknown>>(
  args: string[],
  timeoutMs: number,
): Promise<T> {
  return (await runCli(args, timeoutMs)) as T;
}

export type { ModelBundleHandle } from "@/lib/ml/client";
export { ensureProductionBundle, runPrediction, checkPython } from "@/lib/ml/client";