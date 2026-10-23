import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DaemonState } from './types.js';

export function stateDirectory(): string {
  if (process.env.RUNA_STATE_DIR) {
    return path.resolve(process.env.RUNA_STATE_DIR);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'runa');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'runa');
  }
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
    'runa',
  );
}

export function readState(directory = stateDirectory()): DaemonState | undefined {
  try {
    const state: unknown = JSON.parse(readFileSync(path.join(directory, 'daemon.json'), 'utf8'));
    if (
      state &&
      typeof state === 'object' &&
      'protocol' in state &&
      state.protocol === 1 &&
      'pid' in state &&
      typeof state.pid === 'number' &&
      Number.isInteger(state.pid) &&
      state.pid > 0 &&
      'port' in state &&
      typeof state.port === 'number' &&
      Number.isInteger(state.port) &&
      state.port > 0 &&
      state.port <= 65535 &&
      'token' in state &&
      typeof state.token === 'string' &&
      /^[a-f0-9]{64}$/.test(state.token)
    ) {
      return state as DaemonState;
    }
  } catch {
    // An absent or stale discovery file is recovered during daemon startup.
  }
  return undefined;
}

export function claimLock(directory: string): boolean {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      try {
        if (statSync(file).mtimeMs < Date.now() - os.uptime() * 1000 - 1000) {
          unlinkSync(file);
          continue;
        }
        const pid = Number(readFileSync(file, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return false;
          } catch (probe) {
            if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') {
              return false;
            }
          }
        } else if (Date.now() - statSync(file).mtimeMs < 5000) {
          return false;
        }
        unlinkSync(file);
      } catch {
        // Another contender may already have removed a stale lock.
      }
    }
  }
  return false;
}

export function releaseState(directory: string): void {
  for (const name of ['daemon.json', 'daemon.lock']) {
    const file = path.join(directory, name);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
}
