import type { Runner, Task } from '../types.js';

export const cargoRunner: Runner = {
  id: 'cargo',
  priority: 40,
  detect(context) {
    const source = 'Cargo.toml';
    if (!context.has(source)) {
      return [];
    }
    const names = ['test', 'build', 'check'];
    if (context.has('src/main.rs') || /^\s*\[\[bin\]\]/m.test(context.read(source))) {
      names.unshift('run');
    }
    return names.map(
      (name): Task => ({
        name,
        source,
        bin: 'cargo',
        args: [name],
        argumentSeparator: ['run', 'test'].includes(name) ? '--' : undefined,
      }),
    );
  },
};
