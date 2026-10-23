import type { ExecutableCommand } from '../types.js';

export type ProcessStatus = 'running' | 'stopping' | 'stopped' | 'exited' | 'failed';
export type ShareStatus = 'off' | 'starting' | 'live' | 'error';

export interface ProcessInfo {
  readonly id: string;
  readonly project: string;
  readonly cwd: string;
  readonly task: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly startedAt: number;
  readonly exitCode?: number;
  readonly localUrl?: string;
  readonly publicUrl?: string;
  readonly shareStatus: ShareStatus;
  readonly shareError?: string;
}

export interface LogEntry {
  readonly sequence: number;
  readonly time: number;
  readonly stream: 'stdout' | 'stderr' | 'system' | 'tunnel';
  readonly text: string;
}

export interface Snapshot {
  readonly processes: readonly ProcessInfo[];
  readonly logs: readonly LogEntry[];
}

export interface LogPage {
  readonly logs: readonly LogEntry[];
  readonly pending: Readonly<Partial<Record<LogEntry['stream'], string>>>;
  readonly nextCursor: number;
  readonly oldestSequence: number;
  readonly truncated: boolean;
  readonly hasMore: boolean;
}

export interface ProcessLogs extends LogPage {
  readonly process: ProcessInfo;
}

export type DaemonRequest =
  | { action: 'ping' }
  | { action: 'snapshot'; selected?: string }
  | { action: 'inspect'; id: string }
  | { action: 'logs'; id: string; after?: number; limit?: number }
  | { action: 'start'; cwd: string; task: string; args?: readonly string[]; env: NodeJS.ProcessEnv }
  | { action: 'stop' | 'restart' | 'remove' | 'unpublish'; id: string }
  | { action: 'publish'; id: string; port?: number; env: NodeJS.ProcessEnv }
  | { action: 'shutdown' };

export interface DaemonState {
  readonly protocol: 1;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

export interface DaemonClient {
  request<T = unknown>(
    request: DaemonRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>;
}

export interface ProcessDefinition {
  readonly task: string;
  readonly command: ExecutableCommand;
}
