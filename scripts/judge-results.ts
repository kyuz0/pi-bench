/**
 * Host-side judge pass.
 *
 * Scores results-*.json files that were produced with --defer-judge, or re-scores an
 * existing run with a different judge. Runs on the HOST, so `claude` / `codex` use the
 * login you already have - no credentials ever enter a SWE-bench container.
 *
 * Usage:
 *   bun run scripts/judge-results.ts <results-dir-or-file> --judge-cli claude [--judge-model opus]
 *   bun run scripts/judge-results.ts <results-dir-or-file> --judge-cli codex  [--judge-model gpt-5.2-codex]
 *   bun run scripts/judge-results.ts <results-dir-or-file> --judge-model google/gemini-3.1-pro-preview
 *   bun run scripts/judge-results.ts <results-dir> --force        # re-judge already-scored results
 */

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildJudgePrompt,
  judgeWithCli,
  judgeWithModel,
  parseJudgeOutput,
  JUDGE_CLIS,
  type JudgeCli,
} from "../src/judge.ts";

// Resolve against the repo, not the caller's cwd, so this works from anywhere.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TASK_SEARCH_ROOTS = ["tasks/verified-mini", "tasks/curated", "tasks/synthetic", "tasks"].map((p) =>
  join(REPO_ROOT, p),
);

async function findTaskFile(taskId: string, extraRoot?: string): Promise<string | undefined> {
  const roots = extraRoot ? [extraRoot, ...TASK_SEARCH_ROOTS] : TASK_SEARCH_ROOTS;
  for (const root of roots) {
    const direct = join(root, `${taskId}.json`);
    if (existsSync(direct)) return direct;
  }
  // Fall back to scanning for a task whose id field matches.
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(root, entry), "utf-8"));
        if (parsed?.id === taskId) return join(root, entry);
      } catch {
        // not a task file
      }
    }
  }
  return undefined;
}

/** Result files for one run, excluding the summary and per-attempt duplicates. */
async function collectResultFiles(target: string): Promise<string[]> {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const entries = await readdir(target);
  return entries
    .filter((f) => f.startsWith("results-") && f.endsWith(".json") && !/-attempt\d+\.json$/.test(f))
    .sort()
    .map((f) => join(target, f));
}

async function recomputeSummary(resultsDir: string) {
  const files = await collectResultFiles(resultsDir);
  const results = [];
  for (const file of files) {
    results.push(JSON.parse(await readFile(file, "utf-8")));
  }
  if (results.length === 0) return;

  const passed = results.filter((r) => r.judgeScore === 1).length;
  const totalDuration = results.reduce((acc, r) => acc + (r.durationMs || 0), 0);
  const summary = {
    totalTasks: results.length,
    passedTasks: passed,
    passRate: passed / results.length,
    totalDurationMs: totalDuration,
    averageDurationMs: totalDuration / results.length,
    results,
  };
  await writeFile(join(resultsDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    `[INFO] Summary updated: ${(summary.passRate * 100).toFixed(2)}% (${passed}/${results.length}) → ${join(resultsDir, "summary.json")}`,
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "judge-cli": { type: "string" },
      "judge-model": { type: "string" },
      tasks: { type: "string" },
      force: { type: "boolean" },
      "no-summary": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const target = positionals[0];
  if (!target) {
    console.error(
      "Usage: bun run scripts/judge-results.ts <results-dir-or-file> [--judge-cli claude|codex] [--judge-model model] [--tasks dir] [--force]",
    );
    process.exit(1);
  }

  const judgeCli = values["judge-cli"] as JudgeCli | undefined;
  if (judgeCli && !JUDGE_CLIS.includes(judgeCli)) {
    console.error(`[ERROR] Unknown --judge-cli '${judgeCli}'. Supported: ${JUDGE_CLIS.join(", ")}`);
    process.exit(1);
  }

  // API judge setup (only when not using a CLI judge)
  let judgeModel: any;
  let auth: any;
  if (!judgeCli) {
    const spec = (values["judge-model"] as string | undefined) ?? "google/gemini-3.1-pro-preview";
    const parts = spec.split("/");
    judgeModel = parts.length > 1 ? getModel(parts[0] as any, parts.slice(1).join("/")) : undefined;
    if (!judgeModel) {
      console.error(`[ERROR] Could not resolve judge model '${spec}'.`);
      process.exit(1);
    }
    const authStorage = AuthStorage.create();
    const localModelsPath = join(REPO_ROOT, "models.json");
    const registry = existsSync(localModelsPath)
      ? ModelRegistry.create(authStorage, localModelsPath)
      : ModelRegistry.create(authStorage);
    auth = await registry.getApiKeyAndHeaders(judgeModel);
    if (!auth.ok) {
      console.error(`[ERROR] Judge auth failed: ${auth.error}`);
      process.exit(1);
    }
  }

  const judgeLabel = judgeCli
    ? `${judgeCli} CLI${values["judge-model"] ? ` (${values["judge-model"]})` : ""}`
    : `${judgeModel.provider}/${judgeModel.id}`;

  const files = await collectResultFiles(target);
  console.log(`[INFO] Judge: ${judgeLabel}`);
  console.log(`[INFO] ${files.length} result file(s) to consider`);

  let judged = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const result = JSON.parse(await readFile(file, "utf-8"));
    const needsJudging = values.force || result.judgeScore === null || result.judgeScore === undefined || result.judgePending;
    if (!needsJudging) {
      skipped++;
      continue;
    }

    const taskId = result.task ?? basename(file).replace(/^results-/, "").replace(/\.json$/, "");
    const taskFile = await findTaskFile(taskId, values.tasks as string | undefined);
    if (!taskFile) {
      console.warn(`[WARN] No task file found for '${taskId}' - skipping ${file}`);
      failed++;
      continue;
    }
    const task = JSON.parse(await readFile(taskFile, "utf-8"));

    const prompt = buildJudgePrompt({
      task,
      diff: result.diff ?? "",
      testExitCode: result.testExitCode ?? null,
      testOutput: result.testOutput ?? "",
      isSweContainer: Boolean(result.sweContainerTest),
    });

    try {
      const raw = judgeCli
        ? await judgeWithCli(judgeCli, prompt, values["judge-model"] as string | undefined)
        : await judgeWithModel(judgeModel, auth, prompt);
      const verdict = parseJudgeOutput(raw);

      result.judgeScore = verdict.score;
      result.judgeRationale = verdict.rationale;
      result.judgedBy = judgeLabel;
      delete result.judgePending;
      await writeFile(file, JSON.stringify(result, null, 2));

      judged++;
      console.log(`[${verdict.score === 1 ? "PASS" : "FAIL"}] ${taskId}`);
    } catch (e: any) {
      failed++;
      console.error(`[ERROR] Judging ${taskId} failed: ${e.message}`);
    }
  }

  console.log(`[INFO] Judged ${judged}, skipped ${skipped} (already scored), failed ${failed}`);

  if (!values["no-summary"]) {
    const info = await stat(target);
    await recomputeSummary(info.isDirectory() ? target : dirname(target));
  }

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
