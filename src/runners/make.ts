import type { Runner, Task } from '../types.js';

export const makeRunner: Runner = {
  id: 'make',
  priority: 20,
  detect(context) {
    const source = ['GNUmakefile', 'makefile', 'Makefile'].find((file) => context.has(file));
    if (!source) {
      return [];
    }
    const tasks: Task[] = [];
    const seen = new Set<string>();
    // Static targets only: never evaluate a Makefile during discovery.
    for (const line of context
      .read(source)
      .replace(/\\\r?\n/g, ' ')
      .split(/\r?\n/)) {
      const match = /^([^\s#:=][^:=]*?)\s*:(?!=)(.*)$/.exec(line);
      if (!match?.[1]) {
        continue;
      }
      for (const name of match[1].trim().split(/\s+/)) {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(name) || seen.has(name)) {
          continue;
        }
        seen.add(name);
        tasks.push({
          name,
          source,
          bin: 'make',
          args: [name],
          description: /##\s*(.+)$/.exec(match[2] ?? '')?.[1] ?? '',
        });
      }
    }
    return tasks;
  },
};
