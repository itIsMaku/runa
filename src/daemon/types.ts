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

export type DaemonRequest =
  | { action: 'ping' }
  | { action: 'snapshot'; selected?: string }
  | { action: 'start'; cwd: string; task: string; env: NodeJS.ProcessEnv }
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
  request<T = unknown>(request: DaemonRequest): Promise<T>;
}

export interface ProcessDefinition {
  readonly task: string;
  readonly command: ExecutableCommand;
}
