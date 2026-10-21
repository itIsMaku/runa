import type { Runner } from '../types.js';

export const goRunner: Runner = {
  id: 'go',
  priority: 40,
  detect(context) {
    const source = 'go.mod';
    if (!context.has(source)) {
      return [];
    }
    const tasks = [
      { name: 'test', source, bin: 'go', args: ['test', './...'] },
      { name: 'build', source, bin: 'go', args: ['build', './...'] },
    ];
    if (
      context.files.some(
        (file) =>
          file.endsWith('.go') &&
          !file.endsWith('_test.go') &&
          /^\s*package\s+main\b/m.test(context.read(file)),
      )
    ) {
      tasks.unshift({ name: 'run', source, bin: 'go', args: ['run', '.'] });
    }
    return tasks;
  },
};
