import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { stripVTControlCharacters } from 'node:util';

export function validatePort(value: string | number): number {
  const text = String(value);
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Publish port must be an integer from 1 to 65535.');
  }
  return port;
}

export function localTarget(port: number): string {
  return `http://127.0.0.1:${validatePort(port)}`;
}

/** Accept loopback URLs only; never infer a target from a network/documentation URL. */
export function findLocalUrl(output: string): string | undefined {
  const text = stripVTControlCharacters(output);
  const pattern =
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d{1,5})?(?=[/\s"'<>)]|$)/gi;
  for (const match of text.matchAll(pattern)) {
    try {
      const url = new URL(match[0]);
      if (url.port) {
        validatePort(url.port);
      }
      if (url.hostname === '0.0.0.0') {
        url.hostname = '127.0.0.1';
      } else if (url.hostname === '[::]') {
        url.hostname = '[::1]';
      }
      return url.origin;
    } catch {
      // Ignore malformed/invalid ports and continue to the next complete URL.
    }
  }
  return undefined;
}

export async function portIsOpen(target: string): Promise<boolean> {
  const url = new URL(target);
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function responds(target: string, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = (target.startsWith('https:') ? https : http).request(target, {
      method: 'HEAD',
      signal,
    });
    request.once('response', (response) => {
      response.destroy();
      resolve(true);
    });
    request.once('error', () => resolve(false));
    request.setTimeout(500, () => request.destroy(new Error('Readiness probe timed out.')));
    request.end();
  });
}

export async function waitForHttp(
  target: string,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await responds(target, signal)) {
      return;
    }
    await setTimeout(100, undefined, { signal });
  }
  throw new Error(`No HTTP response from ${target}. Check the app's port and startup output.`);
}
