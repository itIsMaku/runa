import { existsSync } from 'node:fs';
import path from 'node:path';
import { type ManagedProcess, type ProcessExit, startProcess } from '../managed-process.js';
import { formatCommand } from '../process.js';
import type { ExecutableCommand } from '../types.js';
import type { PublishOptions, TunnelProvider } from './types.js';

export class InstallDeclined extends Error {}

async function waitForProcess(
  process: ManagedProcess,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<ProcessExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      process.exit,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
        if (timeoutMs !== undefined) {
          timer = setTimeout(
            () => reject(new Error('Checking tunnel tools timed out.')),
            timeoutMs,
          );
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await process.stop();
  }
}

async function probe(command: ExecutableCommand, signal: AbortSignal): Promise<ProcessExit> {
  signal.throwIfAborted();
  return waitForProcess(startProcess(command), signal, 10000);
}

function extendPath(entries: readonly string[]): void {
  const current = process.env.PATH ?? process.env.Path ?? '';
  const directories = new Set(current.split(path.delimiter).filter(Boolean));
  for (const directory of entries) {
    if (existsSync(directory)) {
      directories.add(directory);
    }
  }
  process.env.PATH = [...directories].join(path.delimiter);
}

export async function ensureProvider(
  provider: TunnelProvider,
  cwd: string,
  options: PublishOptions,
  signal: AbortSignal,
  message: (text: string) => void,
): Promise<void> {
  const initial = await probe(provider.checkCommand(cwd), signal);
  signal.throwIfAborted();
  if (!initial.error && initial.code === 0) {
    return;
  }
  const unavailable = `${provider.id} tunnel is unavailable. ${provider.installHint}`;
  // A failed version command can mean a broken installation, not a missing tool.
  if (!initial.notFound || !options.confirmInstall) {
    throw new Error(unavailable);
  }
  for (const installer of provider.installers ?? []) {
    if (!installer.platforms.includes(process.platform)) {
      continue;
    }
    const available = await probe(installer.checkCommand(cwd), signal);
    signal.throwIfAborted();
    if (available.error || available.code !== 0) {
      continue;
    }
    const command = installer.installCommand(cwd);
    const approved = await options.confirmInstall(
      { tool: provider.checkCommand(cwd).bin, command },
      signal,
    );
    signal.throwIfAborted();
    if (!approved) {
      throw new InstallDeclined('Installation declined.');
    }
    message(`Installing: ${formatCommand(command.bin, command.args)}`);
    signal.throwIfAborted();
    const installed = await waitForProcess(
      startProcess(command, { stdin: 'inherit', inheritOutput: true }),
      signal,
    );
    signal.throwIfAborted();
    if (installed.error || installed.code !== 0) {
      throw new Error(
        `Installation failed${installed.error ? `: ${installed.error.message}` : ` with code ${installed.code}`}. ${provider.installHint}`,
      );
    }
    extendPath(installer.pathEntries?.() ?? []);
    const verified = await probe(provider.checkCommand(cwd), signal);
    signal.throwIfAborted();
    if (verified.error || verified.code !== 0) {
      throw new Error(
        `Installation finished, but ${provider.checkCommand(cwd).bin} is still unavailable. Check PATH or restart your terminal. ${provider.installHint}`,
      );
    }
    message(`${provider.checkCommand(cwd).bin} is ready. Continuing…`);
    return;
  }
  throw new Error(
    `${unavailable} No supported package manager was found for automatic installation.`,
  );
}
