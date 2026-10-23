import type { ExecutableCommand } from '../types.js';

export interface ProviderInstaller {
  readonly id: string;
  readonly platforms: readonly NodeJS.Platform[];
  checkCommand(cwd: string): ExecutableCommand;
  installCommand(cwd: string): ExecutableCommand;
  /** Newly installed binaries can need PATH entries before the shell is restarted. */
  pathEntries?(): readonly string[];
}

export interface InstallRequest {
  readonly tool: string;
  readonly command: ExecutableCommand;
}

export interface TunnelProvider {
  readonly id: string;
  readonly installHint: string;
  readonly installers?: readonly ProviderInstaller[];
  checkCommand(cwd: string): ExecutableCommand;
  createCommand(target: string, cwd: string): ExecutableCommand;
  findPublicUrl(output: string): string | undefined;
}

export interface PublishOptions {
  /** Omit to disable installation (e.g. non-interactive/library use). */
  readonly confirmInstall?: (request: InstallRequest, signal: AbortSignal) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly port?: number;
  readonly startupTimeoutMs?: number;
  readonly tunnelTimeoutMs?: number;
  readonly onMessage?: (message: string) => void;
  readonly onOutput?: (output: string, stream: 'stdout' | 'stderr') => void;
  readonly onPublicUrl?: (url: string) => void;
}
