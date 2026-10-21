import { isRecord } from '../context.js';
import type { Runner, Task } from '../types.js';

export const configRunner: Runner = {
  id: 'config',
  priority: 0,
  detect(context) {
    if (!context.has('.runany.json')) {
      return [];
    }
    const config = context.readJson('.runany.json');
    if (!isRecord(config) || !isRecord(config.commands)) {
      throw new Error('.runany.json must contain a commands object.');
    }
    const tasks: Task[] = [];
    for (const [name, value] of Object.entries(config.commands)) {
      if (
        !name ||
        !Array.isArray(value) ||
        !value.length ||
        value.some((part: unknown) => typeof part !== 'string' || part.includes('\0')) ||
        typeof value[0] !== 'string' ||
        !value[0]
      ) {
        throw new Error(`.runany.json: command "${name}" must be a nonempty array of strings.`);
      }
      tasks.push({
        name,
        source: '.runany.json',
        bin: value[0],
        args: value.slice(1) as string[],
        isDefault: config.default === name,
        override: true,
      });
    }
    if (
      config.default !== undefined &&
      (typeof config.default !== 'string' || !Object.hasOwn(config.commands, config.default))
    ) {
      throw new Error('.runany.json: default must name one of its commands.');
    }
    return tasks;
  },
};
