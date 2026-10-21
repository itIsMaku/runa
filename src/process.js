import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

export function formatCommand(bin, args) {
  return [bin, ...args].map((value) => /^[\w./:@=+-]+$/.test(value) ? value : JSON.stringify(value)).join(' ');
}

// cmd.exe parses metacharacters even inside quotes. Escape each parsing layer;
// npm/yarn/pnpm shims introduce a second layer through their batch script.
function escapeWindowsArg(value, doubleEscape) {
  let escaped = '';
  let slashes = 0;
  for (const character of value) {
    if (character === '\\') { slashes++; continue; }
    escaped += '\\'.repeat(character === '"' ? slashes * 2 + 1 : slashes) + character;
    slashes = 0;
  }
  escaped += '\\'.repeat(slashes * 2);
  escaped = `"${escaped}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  return doubleEscape ? escaped.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1') : escaped;
}

export function spawnSpec(bin, args, cwd, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { bin, args };
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  const directories = /[\\/]/.test(bin) ? [''] : [cwd, ...(env.PATH || env.Path || '').split(';')];
  let resolved;
  for (const directory of directories) {
    for (const extension of ['', ...extensions]) {
      const file = path.win32.resolve(cwd, directory, bin + extension);
      if (existsSync(file)) { resolved = file; break; }
    }
    if (resolved) break;
  }
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return { bin: resolved || bin, args };
  const command = resolved.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1');
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [command, ...args.map((arg) => escapeWindowsArg(arg, doubleEscape))].join(' ');
  return {
    bin: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export function execute(candidate, extraArgs, cwd) {
  const args = [...candidate.args];
  // npm and Cargo consume their own flags before --; other runners forward
  // directly (Go's program arguments go after the package name).
  if (extraArgs.length && (candidate.bin === 'npm' ||
      (candidate.bin === 'cargo' && ['run', 'test'].includes(args[0])))) args.push('--');
  args.push(...extraArgs);
  return { ...candidate, args, cwd };
}

export async function run(command) {
  const spec = spawnSpec(command.bin, command.args, command.cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.bin, spec.args, {
      cwd: command.cwd,
      stdio: 'inherit',
      shell: false,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    const handlers = new Map();
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => child.kill(signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new Error(error.code === 'ENOENT'
        ? `"${command.bin}" is not installed or is not on PATH. Install the project's runner and try again.`
        : `Cannot start ${command.bin}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve(code ?? (128 + (constants.signals[signal] ?? 1)));
    });
  });
}
