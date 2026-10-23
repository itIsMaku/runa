import { stripVTControlCharacters } from 'node:util';
import type { LogEntry } from './types.js';

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
}
