import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

interface TaskResult {
  task: string;
  durationMs: number;
  diff: string;
  testExitCode: number | null;
  testOutput: string;
  judgeScore: number;
  judgeRationale: string;
  transcriptUrl?: string;
  attempts?: TaskResult[];
  succeededAtAttempt?: number | null;
}

interface Platform {
  id: string;
  name: string;
  gpu: string;
  ram: string;
}

interface ModelStats {
  id: string;
  platformId: string;
  name: string;
  tag: string | null;
  backend: string;
  rocm: string;
  inferenceProfile?: string | null;
  totalTasks: number;
  passedTasks: number;
  successRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

interface TaskAggregate {
  id: string;
  results: Record<string, TaskResult>;
}

async function safeReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function getDirectories(source: string) {
  try {
    const entries = await readdir(source, { withFileTypes: true });
    return entries.filter((dir) => dir.isDirectory()).map((dir) => dir.name);
  } catch {
    return [];
  }
}

async function main() {
  const rootDir = resolve(process.cwd());
  const docsDir = join(rootDir, "docs");
  const dataPath = join(docsDir, "data.json");

  const platforms: Record<string, Platform> = {};
  const models: ModelStats[] = [];
  const tasksMap: Record<string, TaskAggregate> = {};

  const benchmarkResultsDir = join(rootDir, "benchmark_results");
  let platformDirs: string[] = [];
  if (existsSync(benchmarkResultsDir)) {
    platformDirs = await getDirectories(benchmarkResultsDir);
  }
  
  // Array of { platform, modelDir, modelName, tag, backend, rocm, inferenceProfile }
  const scanTargets: Array<{ platform: Platform; dir: string; name: string; tag: string | null; backend: string; rocm: string; inferenceProfile: string | null }> = [];

  for (const dirName of platformDirs) {
    const fullPath = join(benchmarkResultsDir, dirName);
    const platformJsonPath = join(fullPath, "platform.json");

    if (!existsSync(platformJsonPath)) {
      console.warn(`Skipping ${dirName}: no platform.json found.`);
      continue;
    }

    const content = await safeReadFile(platformJsonPath);
    if (!content) continue;

    let platformData: Platform;
    try {
      platformData = { id: dirName, name: dirName, ...JSON.parse(content) };
    } catch (e) {
      console.error(`Error parsing ${platformJsonPath}`, e);
      continue;
    }

    platforms[platformData.id] = platformData;

    const subDirs = await getDirectories(fullPath);
    for (const subDir of subDirs) {
      if (subDir.endsWith("_results")) {
        // Read optional run-meta.json for model tag, backend, rocm, and inference profile
        let modelTag: string | null = null;
        let backend = "unknown";
        let rocm = "N/A";
        let inferenceProfile: string | null = null;
        let exactModelId: string | null = null;
        const metaPath = join(fullPath, subDir, "run-meta.json");
        const metaContent = await safeReadFile(metaPath);
        if (metaContent) {
          try {
            const meta = JSON.parse(metaContent);
            modelTag = meta.modelTag || null;
            if (meta.backend) backend = meta.backend;
            if (meta.rocm) rocm = meta.rocm;
            if (meta.inferenceProfile) inferenceProfile = meta.inferenceProfile;
            if (meta.exactModelId) exactModelId = meta.exactModelId;
          } catch {}
        }

        // Strip the tag suffix from the directory name for a clean model name
        let modelName = subDir.replace("_results", "");
        if (modelTag) {
          modelName = modelName.replace(new RegExp(`-${modelTag}$`), "");
        }
        if (exactModelId) {
          modelName = exactModelId;
        }

        scanTargets.push({
          platform: platformData,
          dir: join(fullPath, subDir),
          name: modelName,
          tag: modelTag,
          backend,
          rocm,
          inferenceProfile
        });
      }
    }
  }

  for (const target of scanTargets) {
    const modelUniqueId = target.tag
      ? `${target.platform.id}::${target.name}::${target.tag}`
      : `${target.platform.id}::${target.name}`;
    const files = await readdir(target.dir);
    const jsonFiles = files.filter((f) => f.startsWith("results-") && f.endsWith(".json") && !f.includes("-attempt"));

    let totalTasks = 0;
    let passedTasks = 0;
    let totalDurationMs = 0;

    for (const file of jsonFiles) {
      const filePath = join(target.dir, file);
      const content = await safeReadFile(filePath);
      if (!content) continue;

      try {
        const result: TaskResult = JSON.parse(content);
        
        totalTasks++;
        if (result.judgeScore >= 1) {
          passedTasks++;
        }
        totalDurationMs += result.durationMs || 0;

        const taskId = result.task;
        
        const transcriptName = `transcript-${taskId}.json`;
        if (existsSync(join(target.dir, transcriptName))) {
          const relativeDir = target.dir.substring(target.dir.indexOf("benchmark_results"));
          result.transcriptUrl = `https://github.com/kyuz0/pi-bench/blob/main/${relativeDir}/${transcriptName}`.replace(/\\/g, "/");
        }

        if (result.attempts && Array.isArray(result.attempts)) {
          result.attempts.forEach((attempt, idx) => {
            const attemptTranscript = `transcript-${taskId}-attempt${idx + 1}.json`;
            if (existsSync(join(target.dir, attemptTranscript))) {
              const relativeDir = target.dir.substring(target.dir.indexOf("benchmark_results"));
              attempt.transcriptUrl = `https://github.com/kyuz0/pi-bench/blob/main/${relativeDir}/${attemptTranscript}`.replace(/\\/g, "/");
            }
          });
        }

        if (!tasksMap[taskId]) {
          tasksMap[taskId] = { id: taskId, results: {} };
        }
        tasksMap[taskId].results[modelUniqueId] = result;
      } catch (err) {
        console.error(`Error parsing ${filePath}:`, err);
      }
    }

    if (totalTasks > 0) {
      const relativeDir = target.dir.substring(target.dir.indexOf("benchmark_results"));
      const runUrl = `https://github.com/kyuz0/pi-bench/tree/main/${relativeDir}`.replace(/\\/g, "/");

      models.push({
        id: modelUniqueId,
        platformId: target.platform.id,
        name: target.name,
        tag: target.tag,
        backend: target.backend,
        rocm: target.rocm,
        inferenceProfile: target.inferenceProfile,
        runUrl: runUrl,
        totalTasks,
        passedTasks,
        successRate: passedTasks / totalTasks,
        totalDurationMs,
        avgDurationMs: Math.round(totalDurationMs / totalTasks)
      });
    }
  }

  models.sort((a, b) => b.successRate - a.successRate);

  const finalData = {
    metadata: {
      generatedAt: new Date().toISOString(),
      judgeModel: "gemini-3.1-pro-preview"
    },
    platforms: Object.values(platforms),
    models,
    tasks: Object.values(tasksMap)
  };

  if (!existsSync(docsDir)) {
    await mkdir(docsDir, { recursive: true });
  }

  await writeFile(dataPath, JSON.stringify(finalData, null, 2), "utf-8");
  console.log(`Report generated: ${models.length} models, ${Object.values(platforms).length} platforms, ${Object.keys(tasksMap).length} tasks.`);
}

main().catch(console.error);
