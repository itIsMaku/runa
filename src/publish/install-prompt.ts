import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { formatCommand } from '../process.js';
import type { InstallRequest } from './types.js';

export async function promptForInstall(
  request: InstallRequest,
  signal: AbortSignal,
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<boolean> {
  signal.throwIfAborted();
  const readline = createInterface({ input, output });
  const closed = new Promise<false>((resolve) => readline.once('close', () => resolve(false)));
  readline.on('SIGINT', () => process.emit('SIGINT'));
  try {
    const prompt = `runa: ${request.tool} is not installed. Install using ${formatCommand(request.command.bin, request.command.args)}? [y/N] `;
    while (true) {
      const answer = await Promise.race([readline.question(prompt, { signal }), closed]);
      signal.throwIfAborted();
      if (answer === false) {
        return false;
      }
      const normalized = answer.trim().toLowerCase();
      if (['y', 'yes'].includes(normalized)) {
        return true;
      }
      if (['', 'n', 'no'].includes(normalized)) {
        return false;
      }
      output.write('Please answer y or n.\n');
    }
  } finally {
    readline.close();
  }
}
