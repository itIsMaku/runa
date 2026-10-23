import { constants } from 'node:os';
import { type ManagedProcess, startProcess } from '../managed-process.js';
import type { ExecutableCommand } from '../types.js';
import { findLocalUrl, localTarget, portIsOpen, waitForHttp } from './local-url.js';
import { ensureProvider, InstallDeclined } from './provider-setup.js';
import { findTunnelProvider } from './providers/index.js';
import { openTunnel } from './tunnel.js';
import type { PublishOptions, TunnelProvider } from './types.js';

export { findTunnelProvider, tunnelProviders } from './providers/index.js';
export type { PublishOptions, TunnelProvider } from './types.js';

class AppExited extends Error {
  constructor(readonly code: number) {
    super(`Application exited with code ${code}.`);
  }
}

class Interrupted extends Error {
  constructor(readonly code: number) {
    super('Publishing stopped.');
  }
}

function timeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }),
  ]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });
}

export function publishPlan(port: number | undefined, provider: TunnelProvider, cwd: string) {
  const target = port === undefined ? undefined : localTarget(port);
  return {
    provider: provider.id,
    target: target ?? 'auto (from application startup output)',
    tunnel: target ? provider.createCommand(target, cwd) : undefined,
  };
}

/** Start an app and a temporary public tunnel; own and clean up both process trees. */
export async function publish(
  command: ExecutableCommand,
  options: PublishOptions = {},
  provider: TunnelProvider = findTunnelProvider(),
): Promise<number> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(new Interrupted(130));
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) {
    cancel();
  }
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Signals can arrive during any asynchronous operation (including cleanup).
  void aborted.catch(() => {});
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => controller.abort(new Interrupted(128 + constants.signals[name]));
    handlers.set(name, handler);
    process.on(name, handler);
  }
  const message = options.onMessage ?? ((text: string) => console.error(`runa: ${text}`));
  const output =
    options.onOutput ??
    ((text: string, stream: 'stdout' | 'stderr') => process[stream].write(text));
  let app: ManagedProcess | undefined;
  let tunneling: Promise<void> | undefined;
  let shared = false;
  try {
    const explicitTarget = options.port === undefined ? undefined : localTarget(options.port);
    signal.throwIfAborted();
    await ensureProvider(provider, command.cwd, options, signal, message);
    signal.throwIfAborted();
    if (explicitTarget && (await portIsOpen(explicitTarget))) {
      throw new Error(
        `${explicitTarget} is already in use. Stop that service or choose a different application port.`,
      );
    }
    signal.throwIfAborted();
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60000);
    let resolveTarget: (url: string) => void = () => {};
    const targetDetected = new Promise<string>((resolve) => {
      resolveTarget = resolve;
    });
    const pending = { stdout: '', stderr: '' };
    app = startProcess(command, {
      stdin: 'inherit',
      onOutput(text, stream) {
        output(text, stream);
        if (explicitTarget) {
          return;
        }
        pending[stream] = (pending[stream] + text).slice(-32768);
        // Wait for a whole line so a chunk ending in :3 isn't mistaken for :3000.
        const end = pending[stream].lastIndexOf('\n');
        if (end < 0) {
          return;
        }
        const target = findLocalUrl(pending[stream].slice(0, end + 1));
        pending[stream] = pending[stream].slice(end + 1);
        if (target) {
          resolveTarget(target);
        }
      },
    });
    const appExited = app.exit.then((result): never => {
      if (result.error) {
        throw result.error;
      }
      throw new AppExited(result.code);
    });
    message(
      explicitTarget
        ? `Waiting for ${explicitTarget}…`
        : 'Waiting for a local URL in application output (or use --publish --port <port>)…',
    );
    const target =
      explicitTarget ??
      (await Promise.race([
        timeout(
          targetDetected,
          Math.max(1, deadline - Date.now()),
          'Could not detect a local URL. Run again with --publish --port <port>.',
          signal,
        ),
        appExited,
        aborted,
      ]));
    await Promise.race([waitForHttp(target, deadline, signal), appExited, aborted]);
    signal.throwIfAborted();
    message(
      `Sharing ${target} via ${provider.id}. Anyone with the URL can access this app. Ctrl+C stops sharing.`,
    );
    tunneling = openTunnel(
      target,
      command.cwd,
      {
        ...options,
        onMessage: message,
        onOutput: (text) => output(text, 'stderr'),
        onPublicUrl: (url) => {
          shared = true;
          options.onPublicUrl?.(url);
        },
      },
      provider,
      signal,
      command.env,
    );
    await Promise.race([tunneling, appExited, aborted]);
    return 0;
  } catch (error) {
    if (signal.aborted && signal.reason instanceof Interrupted) {
      return signal.reason.code;
    }
    if (error instanceof InstallDeclined) {
      message('Sharing cancelled. No application or tunnel was started.');
      return 0;
    }
    if (error instanceof AppExited && error.code === 0 && !shared) {
      throw new Error(
        'Application exited before it could be shared. Choose a long-running web task.',
      );
    }
    if (error instanceof AppExited || error instanceof Interrupted) {
      return error.code;
    }
    throw error;
  } finally {
    controller.abort();
    await Promise.allSettled([tunneling, app?.stop()]);
    for (const [name, handler] of handlers) {
      process.off(name, handler);
    }
    options.signal?.removeEventListener('abort', cancel);
  }
}
