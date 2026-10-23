import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import type { Command, ExecutableCommand } from './types.js';

export function formatCommand(bin: string, args: readonly string[]): string {
  return [bin, ...args]
    .map((value) => (/^[\w./:@=+-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(' ');
}

// cmd.exe parses metacharacters even inside quotes. Escape each parsing layer;
// npm/yarn/pnpm shims introduce a second layer through their batch script.
function escapeWindowsArg(value: string, doubleEscape: boolean): string {
  let escaped = '';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') {
      slashes++;
      continue;
    }
    escaped += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  escaped += '\\'.repeat(slashes * 2);
  escaped = `"${escaped}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return doubleEscape ? escaped.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1') : escaped;
}

interface SpawnSpec {
  readonly bin: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

export function spawnSpec(
  bin: string,
  args: readonly string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnSpec {
  if (platform !== 'win32') {
    return { bin, args };
  }
  // Package managers also ship extensionless POSIX scripts next to their
  // Windows shims. Only consider executable PATHEXT entries for bare names.
  const extensions = path.win32.extname(bin)
    ? ['']
    : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const directories = /[\\/]/.test(bin) ? [''] : [cwd, ...(env.PATH || env.Path || '').split(';')];
  let resolved: string | undefined;
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = path.win32.resolve(cwd, directory, bin + extension);
      if (existsSync(file)) {
        resolved = file;
        break;
      }
    }
    if (resolved) {
      break;
    }
  }
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) {
    return { bin: resolved || bin, args };
  }
  const command = resolved.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [command, ...args.map((arg) => escapeWindowsArg(arg, doubleEscape))].join(' ');
  return {
    bin: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export function execute<T extends Command>(
  candidate: T,
  extraArgs: readonly string[],
  cwd: string,
): Omit<T, 'args'> & ExecutableCommand {
  const args = [...candidate.args];
  if (extraArgs.length && candidate.argumentSeparator) {
    args.push(candidate.argumentSeparator);
  }
  args.push(...extraArgs);
  return { ...candidate, args, cwd };
}

export async function run(command: ExecutableCommand): Promise<number> {
  const spec = spawnSpec(
    command.bin,
    command.args,
    command.cwd,
    process.platform,
    command.env ?? process.env,
  );
  return new Promise<number>((resolve, reject) => {
    const child = spawn(spec.bin, spec.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: 'inherit',
      shell: false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new Error(
          error.code === 'ENOENT'
            ? `"${command.bin}" is not installed or is not on PATH. Install the project's runner and try again.`
            : `Cannot start ${command.bin}: ${error.message}`,
        ),
      );
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 1) : 1));
    });
  });
}
