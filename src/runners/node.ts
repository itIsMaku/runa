import { isRecord } from '../context.js';
import { packageManagers } from '../package-managers/index.js';
import type { PackageManager, Runner, Task } from '../types.js';

/** Package-manager support is injected; the detector has no manager-specific branches. */
export function createNodeRunner(managers: readonly PackageManager[] = packageManagers): Runner {
  return {
    id: 'node',
    priority: 10,
    detect(context) {
      if (!context.has('package.json')) {
        return [];
      }
      const pkg = context.readJson('package.json');
      if (!isRecord(pkg)) {
        throw new Error('package.json must contain an object.');
      }
      const declared =
        typeof pkg.packageManager === 'string'
          ? pkg.packageManager.slice(0, pkg.packageManager.lastIndexOf('@'))
          : undefined;
      const manager =
        managers.find((item) => item.id === declared) ??
        managers.find((item) => item.lockfiles.some((file) => context.has(file))) ??
        managers.find((item) => item.id === 'npm');
      if (!isRecord(pkg.scripts)) {
        return [];
      }
      if (!manager) {
        throw new Error('No package manager registered for package.json.');
      }
      const tasks: Task[] = [];
      for (const [name, script] of Object.entries(pkg.scripts)) {
        if (typeof script !== 'string' || !script.trim() || name.startsWith('-')) {
          continue;
        }
        tasks.push({
          id: `${manager.id}:${name}`,
          name,
          source: 'package.json',
          description: script,
          ...manager.runScript(name),
        });
      }
      return tasks;
    },
  };
}
