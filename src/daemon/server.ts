import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isRecord } from '../context.js';
import { detect, select } from '../detect.js';
import { RunaError } from '../errors.js';
import { execute } from '../process.js';
import { ProcessManager } from './manager.js';
import { claimLock, releaseState, stateDirectory } from './state.js';
import type { DaemonState } from './types.js';

function environment(value: unknown): NodeJS.ProcessEnv {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
    throw new Error('Invalid process environment.');
  }
  return value as NodeJS.ProcessEnv;
}

/** Authenticated local-only RPC; the terminal is a detachable client. */
export async function runDaemon(directory = stateDirectory()): Promise<void> {
  if (!claimLock(directory)) {
    return;
  }
  const manager = new ProcessManager();
  const token = randomBytes(32).toString('hex');
  let activity = Date.now();
  let closing = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (
      request.method !== 'POST' ||
      request.url !== '/rpc' ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(403).end(JSON.stringify({ error: 'Unauthorized.', code: 'UNAUTHORIZED' }));
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 1048576) {
          response.writeHead(413).end(JSON.stringify({ error: 'Request too large.' }));
          return;
        }
      }
      const data: unknown = JSON.parse(body);
      if (!isRecord(data) || typeof data.action !== 'string' || closing) {
        throw new Error('Invalid request or daemon shutting down.');
      }
      activity = Date.now();
      let result: unknown = {};
      if (data.action === 'ping') {
        result = { protocol: 1, agentApiVersion: 1 };
      } else if (data.action === 'snapshot') {
        result = manager.snapshot(typeof data.selected === 'string' ? data.selected : undefined);
      } else if (
        data.action === 'start' &&
        typeof data.cwd === 'string' &&
        typeof data.task === 'string'
      ) {
        const project = detect(data.cwd);
        const task = select(project, data.task);
        if (!task) {
          throw new Error('Task not found.');
        }
        if (
          data.args !== undefined &&
          (!Array.isArray(data.args) ||
            data.args.some((arg: unknown) => typeof arg !== 'string' || arg.includes('\0')))
        ) {
          throw new RunaError('INVALID_ARGUMENT', 'Task arguments must be an array of strings.');
        }
        result = manager.start({
          task: task.id,
          command: {
            ...execute(task, (data.args as string[] | undefined) ?? [], project.cwd),
            env: environment(data.env),
          },
        });
      } else if (data.action === 'shutdown') {
        await shutdown();
        response.end(JSON.stringify({ result: {} }));
        return;
      } else if (typeof data.id === 'string') {
        switch (data.action) {
          case 'inspect':
            result = manager.inspect(data.id);
            break;
          case 'logs':
            if (
              (data.after !== undefined && typeof data.after !== 'number') ||
              (data.limit !== undefined && typeof data.limit !== 'number')
            ) {
              throw new RunaError('INVALID_ARGUMENT', 'Log cursor and limit must be numbers.');
            }
            result = manager.logs(data.id, data.after, data.limit);
            break;
          case 'stop':
            await manager.stop(data.id);
            break;
          case 'restart':
            await manager.restart(data.id);
            break;
          case 'remove':
            manager.remove(data.id);
            break;
          case 'unpublish':
            await manager.unpublish(data.id);
            break;
          case 'publish':
            if (data.port !== undefined && typeof data.port !== 'number') {
              throw new Error('Invalid port.');
            }
            await manager.publish(data.id, data.port, environment(data.env));
            break;
          default:
            throw new Error('Unknown action.');
        }
      } else {
        throw new Error('Invalid request.');
      }
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(400).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof RunaError ? error.code : 'INVALID_REQUEST',
        }),
      );
    }
  });
  const idle = setInterval(() => {
    if (!manager.active && Date.now() - activity > 60000) {
      void shutdown();
    }
  }, 10000);
  async function shutdown(): Promise<void> {
    if (closing) {
      return;
    }
    closing = true;
    clearInterval(idle);
    await manager.close();
    server.close();
    server.closeIdleConnections();
    releaseState(directory);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.off(signal, onSignal);
    }
  }
  const onSignal = () => {
    void shutdown();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not start process manager.');
    }
    const state: DaemonState = { protocol: 1, pid: process.pid, port: address.port, token };
    const temporary = path.join(directory, `daemon-${process.pid}.json`);
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, path.join(directory, 'daemon.json'));
  } catch (error) {
    await shutdown();
    throw error;
  }
}
