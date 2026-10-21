import type { PackageManager } from '../types.js';
import { bun } from './bun.js';
import { npm } from './npm.js';
import { pnpm } from './pnpm.js';
import { yarn } from './yarn.js';

/** Order resolves conflicting lockfiles. packageManager always wins. */
export const packageManagers: readonly PackageManager[] = [pnpm, yarn, bun, npm];
export { bun, npm, pnpm, yarn };
