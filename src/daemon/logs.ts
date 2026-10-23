import { stripVTControlCharacters } from 'node:util';
import { RunaError } from '../errors.js';
import type { LogEntry, LogPage } from './types.js';

/** Bounded scrollback, including partial progress lines and hostile terminal escapes. */
export class LogBuffer {
  private entries: LogEntry[] = [];
  private sequence = 0;
  private size = 0;
  private readonly pending = new Map<LogEntry['stream'], string>();

  append(text: string, stream: LogEntry['stream']): void {
    const clean = stripVTControlCharacters(text).replace(/\r/g, '\n');
    const lines = ((this.pending.get(stream) ?? '') + clean).split('\n');
    this.pending.set(stream, (lines.pop() ?? '').slice(-4096));
    for (const line of lines) {
      this.push(line.slice(0, 4096), stream);
    }
  }

  message(text: string): void {
    this.push(stripVTControlCharacters(text).slice(0, 4096), 'system');
  }

  flush(): void {
    for (const [stream, text] of this.pending) {
      if (text) {
        this.push(text, stream);
      }
    }
    this.pending.clear();
  }

  private push(text: string, stream: LogEntry['stream']): void {
    this.entries.push({ sequence: ++this.sequence, time: Date.now(), stream, text });
    this.size += text.length;
    while (this.entries.length > 2000 || this.size > 262144) {
      this.size -= this.entries.shift()?.text.length ?? 0;
    }
  }

  snapshot(): LogEntry[] {
    const tail = [...this.pending]
      .filter(([, text]) => text)
      .map(([stream, text]) => ({
        sequence: this.sequence + 1,
        time: Date.now(),
        stream,
        text,
      }));
    return [...this.entries, ...tail];
  }

  read(after?: number, limit = 100): LogPage {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (after !== undefined && (!Number.isInteger(after) || after < 0 || after > this.sequence))
    ) {
      throw new RunaError(
        'INVALID_ARGUMENT',
        'Log limit must be 1–1000 and cursor must be a valid nonnegative sequence for this process.',
      );
    }
    const logs =
      after === undefined
        ? this.entries.slice(-limit)
        : this.entries.filter((entry) => entry.sequence > after).slice(0, limit);
    const nextCursor = logs.at(-1)?.sequence ?? after ?? this.sequence;
    const oldestSequence = this.entries[0]?.sequence ?? this.sequence;
    return {
      logs,
      nextCursor,
      oldestSequence,
      pending: Object.fromEntries([...this.pending].filter(([, text]) => text)),
      truncated: after !== undefined && after < oldestSequence - 1,
      hasMore: nextCursor < this.sequence,
    };
  }
}
