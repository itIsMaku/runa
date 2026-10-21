import type { PackageManager } from '../types.js';

export const yarn: PackageManager = {
  id: 'yarn',
  lockfiles: ['yarn.lock'],
  runScript: (name) => ({ bin: 'yarn', args: ['run', name] }),
};
