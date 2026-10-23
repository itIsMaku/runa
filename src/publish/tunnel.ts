import { startProcess } from '../managed-process.js';
import type { PublishOptions, TunnelProvider } from './types.js';

/** Share an already-running, ready HTTP origin without restarting its application. */
export async function openTunnel(
  target: string,
  cwd: string,
  options: PublishOptions,
  provider: TunnelProvider,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  signal.throwIfAborted();
  let resolveUrl: (url: string) => void = () => {};
  const found = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const output = { stdout: '', stderr: '' };
  const process = startProcess(
    { ...provider.createCommand(target, cwd), env },
    {
      onOutput(text, stream) {
        options.onOutput?.(text, stream);
        output[stream] = (output[stream] + text).slice(-32768);
        const url = provider.findPublicUrl(output[stream]);
        if (url) {
          resolveUrl(url);
        }
      },
    },
  );
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  const exited = process.exit.then((result): never => {
    throw (
      result.error ??
      new Error(`${provider.id} tunnel exited with code ${result.code}. Sharing stopped.`)
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = await Promise.race([
      found,
      exited,
      aborted,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `${provider.id} did not provide a public URL in time. Check its output and network connection.`,
              ),
            ),
          options.tunnelTimeoutMs ?? 30000,
        );
      }),
    ]);
    clearTimeout(timer);
    options.onMessage?.(`Public URL: ${url}`);
    options.onPublicUrl?.(url);
    await Promise.race([exited, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await process.stop();
  }
}
