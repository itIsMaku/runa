import type { ExecutableCommand } from '../types.js';

export interface TunnelProvider {
  readonly id: string;
  readonly installHint: string;
  checkCommand(cwd: string): ExecutableCommand;
  createCommand(target: string, cwd: string): ExecutableCommand;
  findPublicUrl(output: string): string | undefined;
}

export interface PublishOptions {
  readonly signal?: AbortSignal;
  readonly port?: number;
  readonly startupTimeoutMs?: number;
  readonly tunnelTimeoutMs?: number;
  readonly onMessage?: (message: string) => void;
  readonly onOutput?: (output: string, stream: 'stdout' | 'stderr') => void;
  readonly onPublicUrl?: (url: string) => void;
}
