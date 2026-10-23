import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../context.js';
import { readState, stateDirectory } from './state.js';
import type { DaemonClient, DaemonRequest, DaemonState } from './types.js';

export function clientFor(state: DaemonState): DaemonClient {
  return {
    request<T>(data: DaemonRequest): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port: state.port,
            path: '/rpc',
            method: 'POST',
            headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => {
              body += chunk;
            });
            response.once('end', () => {
              try {
                const reply: unknown = JSON.parse(body);
                if (!isRecord(reply) || response.statusCode !== 200) {
                  throw new Error(
                    isRecord(reply) && typeof reply.error === 'string'
                      ? reply.error
                      : 'Process manager request failed.',
                  );
                }
                resolve(reply.result as T);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.once('error', reject);
        request.setTimeout(10000, () =>
          request.destroy(new Error('Process manager did not respond.')),
        );
        request.end(JSON.stringify(data));
      });
    },
  };
}

export async function connectDaemon(
  start = true,
  directory = stateDirectory(),
): Promise<DaemonClient | undefined> {
  let launched = 0;
  const deadline = Date.now() + (start ? 15000 : 1000);
  while (Date.now() < deadline) {
    const state = readState(directory);
    if (state) {
      const client = clientFor(state);
      try {
        await client.request({ action: 'ping' });
        return client;
      } catch {
        // A daemon from an old terminal/session may no longer be alive.
      }
    }
    if (!start) {
      return undefined;
    }
    if (Date.now() - launched > 2000) {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('../bin.js', import.meta.url)), '--internal-daemon'],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, RUNA_STATE_DIR: directory },
        },
      );
      child.on('error', () => {});
      child.unref();
      launched = Date.now();
    }
    await setTimeout(100);
  }
  throw new Error(
    'Could not connect to the runa process manager. Check permissions in the runa state directory.',
  );
}
