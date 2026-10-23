import { stripVTControlCharacters } from 'node:util';
import type { ProcessInfo, Snapshot } from '../daemon/types.js';
import type { Candidate } from '../types.js';

export type Modal =
  | { kind: 'tasks'; tasks: readonly Candidate[]; index: number; defaultId?: string }
  | { kind: 'port'; value: string }
  | { kind: 'shutdown' };

export interface DashboardModel {
  readonly cwd: string;
  readonly snapshot: Snapshot;
  readonly selected?: string;
  readonly scroll: number;
  readonly message: string;
  readonly busy: boolean;
  readonly connected: boolean;
  readonly modal?: Modal;
}

const codes = {
  dim: '90',
  cyan: '96',
  purple: '95',
  green: '92',
  red: '91',
  yellow: '93',
  white: '39',
  selected: '97;44',
  title: '97;45',
  bold: '1',
};
type Color = keyof typeof codes;
export const paint = (text: string, color: Color): string => `\x1b[${codes[color]}m${text}\x1b[0m`;

export function plain(text: string): string {
  return Array.from(stripVTControlCharacters(text))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && (code < 127 || code > 159);
    })
    .join('')
    .normalize('NFC');
}

export function fit(text: string, width: number): string {
  const characters = Array.from(plain(text));
  if (characters.length > width) {
    return `${characters.slice(0, Math.max(0, width - 1)).join('')}…`;
  }
  return characters.join('') + ' '.repeat(Math.max(0, width - characters.length));
}

function status(process: ProcessInfo): { label: string; color: Color } {
  if (process.status === 'running') {
    return { label: '● RUNNING', color: 'green' };
  }
  if (process.status === 'failed') {
    return { label: `● FAILED (${process.exitCode ?? '?'})`, color: 'red' };
  }
  if (process.status === 'stopping') {
    return { label: '◌ STOPPING', color: 'yellow' };
  }
  return { label: process.status === 'exited' ? '○ EXITED' : '○ STOPPED', color: 'dim' };
}

function box(title: string, width: number, lines: readonly string[], height: number): string[] {
  const inner = Math.max(1, width - 2);
  const caption = Array.from(` ${title} `).slice(0, inner).join('');
  return [
    paint(`╭${caption}${'─'.repeat(Math.max(0, inner - Array.from(caption).length))}╮`, 'purple'),
    ...Array.from(
      { length: Math.max(0, height - 2) },
      (_, index) => `${paint('│', 'dim')}${lines[index] ?? ' '.repeat(inner)}${paint('│', 'dim')}`,
    ),
    paint(`╰${'─'.repeat(inner)}╯`, 'purple'),
  ];
}

export function renderDashboard(model: DashboardModel, columns: number, rows: number): string {
  const width = Math.max(1, columns);
  const height = Math.max(1, rows);
  if (width < 40 || height < 18) {
    return Array.from({ length: height }, (_, index) =>
      paint(
        fit(
          [
            'runa',
            'Resize to at least 40 columns × 18 rows.',
            'q closes the dashboard; apps keep running.',
          ][index] ?? '',
          width,
        ),
        'cyan',
      ),
    ).join('\r\n');
  }
  const processes = model.snapshot.processes;
  const selected = processes.find((entry) => entry.id === model.selected);
  const running = processes.filter((entry) => entry.status === 'running').length;
  const lines = [
    paint(' runa ', 'title') +
      paint(
        fit(
          ` ${width >= 80 ? 'PROCESS STUDIO · ' : ''}${model.connected ? '●' : '○ OFFLINE'} ${running} running · ${processes.length} total`,
          width - 6,
        ),
        'cyan',
      ),
    paint(fit(` ${model.cwd}`, width), 'dim'),
    '',
  ];
  const bodyHeight = height - 7;
  const sidebarWidth = width >= 80 ? Math.min(38, Math.floor(width * 0.32)) : width;
  const listHeight =
    width >= 80 ? bodyHeight : Math.min(8, Math.max(4, Math.floor(bodyHeight / 3)));
  const list: string[] = [];
  const selectedIndex = Math.max(
    0,
    processes.findIndex((entry) => entry.id === model.selected),
  );
  const visibleCount = Math.max(1, Math.floor((listHeight - 2) / 3));
  const start = Math.max(0, selectedIndex - visibleCount + 1);
  for (const process of processes.slice(start, start + visibleCount)) {
    const active = process.id === model.selected;
    list.push(
      paint(
        fit(` ${active ? '›' : ' '} ${process.project}`, sidebarWidth - 2),
        active ? 'selected' : 'white',
      ),
    );
    list.push(paint(fit(`   ${process.task}`, sidebarWidth - 2), 'cyan'));
    list.push(
      paint(
        fit(
          `   ${status(process).label}${process.shareStatus === 'live' ? '  ↗ LIVE' : ''}`,
          sidebarWidth - 2,
        ),
        status(process).color,
      ),
    );
  }
  if (processes.length === 0) {
    list.push(paint(fit(' No processes yet', sidebarWidth - 2), 'white'));
    list.push(paint(fit(' Press n to start a task', sidebarWidth - 2), 'cyan'));
  }
  const sidebar = box('PROCESSES', sidebarWidth, list, listHeight);
  const logWidth = width >= 80 ? width - sidebarWidth - 1 : width;
  const logHeight = width >= 80 ? bodyHeight : bodyHeight - listHeight;
  const contentWidth = Math.max(1, logWidth - 2);
  const logLines: string[] = [];
  if (selected) {
    logLines.push(
      paint(
        fit(` ${selected.task} · ${status(selected).label}`, contentWidth),
        status(selected).color,
      ),
    );
    logLines.push(paint(fit(` ${selected.command}`, contentWidth), 'dim'));
    const directory = ` ${plain(selected.cwd)}`;
    logLines.push(
      paint(
        Array.from(directory).length > contentWidth
          ? ` …${Array.from(directory)
              .slice(-(contentWidth - 2))
              .join('')}`
          : fit(directory, contentWidth),
        'dim',
      ),
    );
    if (selected.publicUrl) {
      logLines.push(paint(fit(` ↗ ${selected.publicUrl}`, contentWidth), 'green'));
    } else if (selected.shareStatus === 'starting') {
      logLines.push(paint(fit(' ◌ Connecting public tunnel…', contentWidth), 'yellow'));
    } else if (selected.shareError) {
      logLines.push(paint(fit(` ! ${selected.shareError}`, contentWidth), 'red'));
    } else {
      logLines.push(
        paint(fit(` ${selected.localUrl ?? 'Waiting for a local URL…'}`, contentWidth), 'cyan'),
      );
    }
    logLines.push(paint('─'.repeat(contentWidth), 'dim'));
    const available = Math.max(1, logHeight - 7);
    const wrapped: { text: string; color: Color }[] = [];
    const wrapWidth = Math.max(1, contentWidth - 11);
    for (const entry of model.snapshot.logs) {
      const text = Array.from(plain(entry.text));
      const prefix = ` ${new Date(entry.time).toTimeString().slice(0, 8)} `;
      for (let index = 0; index < Math.max(1, text.length); index += wrapWidth) {
        wrapped.push({
          text: `${index === 0 ? prefix : ' '.repeat(10)}${text.slice(index, index + wrapWidth).join('')}`,
          color:
            entry.stream === 'stderr'
              ? 'red'
              : entry.stream === 'system'
                ? 'purple'
                : entry.stream === 'tunnel'
                  ? 'cyan'
                  : 'white',
        });
      }
    }
    const end = Math.max(
      0,
      wrapped.length - Math.min(model.scroll, Math.max(0, wrapped.length - available)),
    );
    for (const line of wrapped.slice(Math.max(0, end - available), end)) {
      logLines.push(paint(fit(line.text, contentWidth), line.color));
    }
    if (wrapped.length === 0) {
      logLines.push(paint(fit(' Waiting for output…', contentWidth), 'dim'));
    }
  } else {
    logLines.push(paint(fit(' Your projects, one terminal.', contentWidth), 'cyan'));
    logLines.push(' '.repeat(contentWidth));
    for (const text of [
      ' n  Detect and start a task here',
      ' ↑↓ Switch between processes',
      ' p  Share the selected app',
      ' q  Close TUI, keep apps running',
    ]) {
      logLines.push(paint(fit(text, contentWidth), 'dim'));
    }
  }
  const logs = box(
    model.scroll > 0 ? 'LOGS · SCROLLBACK' : 'LIVE LOGS',
    logWidth,
    logLines,
    logHeight,
  );
  if (width >= 80) {
    for (let index = 0; index < bodyHeight; index++) {
      lines.push(`${sidebar[index] ?? ''} ${logs[index] ?? ''}`);
    }
  } else {
    lines.push(...sidebar, ...logs);
  }
  lines.push(
    paint(
      fit(` ${model.busy ? '◌ ' : '● '}${model.message}`, width),
      model.busy ? 'yellow' : 'cyan',
    ),
  );
  lines.push(paint(fit(' n new  ↑↓ select  s stop  r restart  p publish  d remove', width), 'dim'));
  lines.push(paint(fit(' PgUp/PgDn logs  End live  q detach  Q stop all', width), 'dim'));
  if (model.modal) {
    const modal = model.modal;
    const modalLines: string[] = [];
    if (modal.kind === 'tasks') {
      modalLines.push(
        ' Choose a task in the current directory',
        ' ↑↓ navigate · Enter start · Esc cancel',
        '',
      );
      const count = Math.max(1, height - 10);
      const first = Math.max(0, modal.index - count + 1);
      for (const [index, task] of modal.tasks.slice(first, first + count).entries()) {
        modalLines.push(
          `${first + index === modal.index ? ' ›' : '  '} ${task.id}${task.id === modal.defaultId ? ' ★' : ''}`,
        );
      }
    } else if (modal.kind === 'port') {
      modalLines.push(
        ' Local app port (the app must already be running)',
        ` > ${modal.value}█`,
        '',
        ' Enter share · Esc cancel',
      );
    } else {
      modalLines.push(
        ' Stop ALL managed processes and tunnels?',
        '',
        ' y stop all and quit · n / Esc cancel',
      );
    }
    const modalHeight = Math.min(height - 2, modalLines.length + 2);
    const modalWidth = Math.min(width, 76);
    const modalBox = box(
      modal.kind === 'tasks' ? 'START A PROCESS' : modal.kind === 'port' ? 'PUBLISH' : 'STOP ALL',
      modalWidth,
      modalLines.map((text, index) =>
        paint(
          fit(text, modalWidth - 2),
          modal.kind === 'tasks' && index >= 3 && text.startsWith(' ›') ? 'selected' : 'white',
        ),
      ),
      modalHeight,
    );
    const top = Math.max(1, Math.floor((height - modalHeight) / 2));
    for (let index = 0; index < modalBox.length; index++) {
      lines[top + index] = ' '.repeat(Math.floor((width - modalWidth) / 2)) + modalBox[index];
    }
  }
  return lines
    .slice(0, height)
    .map(
      (line) =>
        line + ' '.repeat(Math.max(0, width - Array.from(stripVTControlCharacters(line)).length)),
    )
    .join('\r\n');
}
