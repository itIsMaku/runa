import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { spawnSpec } from './process.js';
import type { ExecutableCommand } from './types.js';

export interface ProcessExit {
  readonly code: number;
  readonly error?: Error;
}

export interface ManagedProcess {
  readonly exit: Promise<ProcessExit>;
  stop(): Promise<void>;
}

interface ProcessOptions {
  readonly stdin?: 'inherit' | 'ignore';
  readonly onOutput?: (output: string, stream: 'stdout' | 'stderr') => void;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

async function killWindowsTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return;
  }
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  await new Promise<void>((resolve) => {
    const killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      child.kill();
      resolve();
    });
    killer.once('exit', () => resolve());
  });
}

/** Supervise a process tree while observing output, without shell interpolation. */
export function startProcess(
  command: ExecutableCommand,
  options: ProcessOptions = {},
): ManagedProcess {
  const spec = spawnSpec(command.bin, command.args, command.cwd);
  const child = spawn(spec.bin, spec.args, {
    cwd: command.cwd,
    stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  const exit = new Promise<ProcessExit>((resolve) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.setEncoding('utf8');
      child[stream]?.on('data', (data: string) => {
        try {
          options.onOutput?.(data, stream);
        } catch (error) {
          resolve({ code: 1, error: error instanceof Error ? error : new Error(String(error)) });
        }
      });
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve({
        code: 1,
        error: new Error(
          error.code === 'ENOENT'
            ? `"${command.bin}" is not installed or is not on PATH.`
            : `Cannot start ${command.bin}: ${error.message}`,
        ),
      });
    });
    child.once('exit', (code, signal) => {
      resolve({ code: code ?? 128 + (signal ? (constants.signals[signal] ?? 1) : 1) });
    });
  });
  let stopping: Promise<void> | undefined;
  return {
    exit,
    stop() {
      stopping ??= (async () => {
        if (process.platform === 'win32') {
          await killWindowsTree(child);
          return;
        }
        killGroup(child, 'SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exit,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          // npm and similar tools may leave descendants after their own exit.
          killGroup(child, 'SIGKILL');
        }
      })();
      return stopping;
    },
  };
}
