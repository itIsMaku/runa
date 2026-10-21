import type { PackageManager } from '../types.js';

export const npm: PackageManager = {
  id: 'npm',
  lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'],
  runScript: (name) => ({ bin: 'npm', args: ['run', name], argumentSeparator: '--' }),
};
