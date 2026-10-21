import { createContext } from './context.js';
import { builtinRunners } from './runners/index.js';
import { defaultScore, select } from './selection.js';
import type { Candidate, Project, Runner } from './types.js';

export { select };

export function detect(
  directory: string,
  platform: NodeJS.Platform = process.platform,
  runners: readonly Runner[] = builtinRunners,
): Project {
  const context = createContext(directory, platform);
  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  for (const runner of runners) {
    for (const task of runner.detect(context)) {
      const id = task.id ?? `${runner.id}:${task.name}`;
      if (ids.has(id)) {
        throw new Error(`Duplicate task ID "${id}" from runner "${runner.id}".`);
      }
      ids.add(id);
      candidates.push({ ...task, id, priority: runner.priority });
    }
  }
  candidates.sort(
    (a, b) =>
      defaultScore(a) - defaultScore(b) || a.priority - b.priority || a.id.localeCompare(b.id),
  );
  const best = candidates[0];
  const defaultId =
    best &&
    Number.isFinite(defaultScore(best)) &&
    candidates.filter((item) => defaultScore(item) === defaultScore(best)).length === 1
      ? best.id
      : undefined;
  return { cwd: context.cwd, candidates, defaultId };
}
