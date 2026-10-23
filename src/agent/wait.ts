import { setTimeout } from 'node:timers/promises';
import type { DaemonClient, ProcessInfo } from '../daemon/types.js';
import { RunaError } from '../errors.js';
import { localTarget, responds } from '../publish/local-url.js';

export const waitStates = ['running', 'ready', 'exited', 'published'] as const;
export type WaitState = (typeof waitStates)[number];
export const terminal = (process: ProcessInfo): boolean =>
  ['exited', 'stopped', 'failed'].includes(process.status);

export async function waitForState(
  client: DaemonClient,
  id: string,
  state: WaitState,
  signal: AbortSignal,
  port?: number,
): Promise<ProcessInfo> {
  let process: ProcessInfo | undefined;
  try {
    while (true) {
      signal.throwIfAborted();
      process = await client.request<ProcessInfo>({ action: 'inspect', id }, { signal });
      if (state === 'exited' && terminal(process)) {
        return process;
      }
      if (state !== 'exited' && terminal(process)) {
        throw new RunaError(
          'PROCESS_EXITED',
          `Process ${id} ${process.status} before becoming ${state}.`,
          { process },
        );
      }
      if (state === 'running' && process.status === 'running') {
        return process;
      }
      if (state === 'published') {
        if (process.shareStatus === 'live' && process.publicUrl) {
          return process;
        }
        if (process.shareStatus === 'error') {
          throw new RunaError('PUBLISH_FAILED', process.shareError ?? 'Tunnel failed.', {
            process,
          });
        }
        if (process.shareStatus === 'off') {
          throw new RunaError(
            'NOT_PUBLISHING',
            'Start sharing this process before waiting for a public URL.',
            { process },
          );
        }
      }
      if (state === 'ready') {
        const target = port === undefined ? process.localUrl : localTarget(port);
        if (target && (await responds(target, signal))) {
          return process;
        }
      }
      await setTimeout(150, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted && signal.reason instanceof RunaError) {
      throw new RunaError(signal.reason.code, signal.reason.message, {
        process: process ?? { id },
      });
    }
    throw error;
  }
}
