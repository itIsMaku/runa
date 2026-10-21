import type { PackageManager } from '../types.js';

export const pnpm: PackageManager = {
  id: 'pnpm',
  lockfiles: ['pnpm-lock.yaml'],
  runScript: (name) => ({ bin: 'pnpm', args: ['run', name] }),
};
