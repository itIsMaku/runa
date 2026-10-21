import type { Runner } from '../types.js';

export const composeRunner: Runner = {
  id: 'compose',
  priority: 30,
  detect(context) {
    const source = [
      'compose.yaml',
      'compose.yml',
      'docker-compose.yaml',
      'docker-compose.yml',
    ].find((file) => context.has(file));
    if (!source) {
      return [];
    }
    return ['up', 'down', 'logs'].map((name) => ({
      name,
      source,
      bin: 'docker',
      args: ['compose', '-f', source, name, ...(name === 'logs' ? ['--follow'] : [])],
    }));
  },
};
