import type { PackageManager } from '../types.js';

export const bun: PackageManager = {
  id: 'bun',
  lockfiles: ['bun.lock', 'bun.lockb'],
  runScript: (name) => ({ bin: 'bun', args: ['run', name] }),
};
