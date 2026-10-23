import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { fit, plain, renderDashboard } from '../dist/tui/render.js';

function model(overrides = {}) {
  return {
    cwd: '/projects/demo',
    snapshot: { processes: [], logs: [] },
    selected: undefined,
    scroll: 0,
    message: 'Ready',
    busy: false,
    connected: true,
    ...overrides,
  };
}

test('empty dashboard explains how to start tasks and detach', () => {
  const screen = renderDashboard(model(), 120, 32);
  const text = stripVTControlCharacters(screen);
  assert.match(text, /PROCESS STUDIO/);
  assert.match(text, /Press n to start/);
  assert.match(text, /q detach/);
  assert.ok(screen.includes('\x1b['));
});

test('dashboard shows selected process logs, local/public URLs, and status colors', () => {
  const process = {
    id: 'one',
    cwd: '/projects/demo',
    project: 'demo',
    task: 'npm:dev',
    command: 'npm run dev',
    status: 'running',
    startedAt: Date.now(),
    shareStatus: 'live',
    publicUrl: 'https://demo.trycloudflare.com',
  };
  const screen = renderDashboard(
    model({
      selected: 'one',
      snapshot: {
        processes: [process],
        logs: [
          { sequence: 1, time: Date.now(), stream: 'stderr', text: 'Something useful in the log' },
        ],
      },
    }),
    120,
    32,
  );
  const text = stripVTControlCharacters(screen);
  assert.match(text, /npm:dev/);
  assert.match(text, /RUNNING/);
  assert.match(text, /https:\/\/demo.trycloudflare.com/);
  assert.match(text, /Something useful/);
  assert.ok(screen.includes('\x1b[91m'));
});

test('dashboard and task picker fit narrow and wide terminal layouts', () => {
  for (const width of [40, 60, 80, 120]) {
    for (const modal of [
      undefined,
      { kind: 'tasks', tasks: [{ id: 'npm:dev', name: 'dev' }], index: 0, defaultId: 'npm:dev' },
      { kind: 'shutdown' },
    ]) {
      const rows = stripVTControlCharacters(renderDashboard(model({ modal }), width, 30)).split(
        '\r\n',
      );
      assert.ok(rows.length <= 30);
      assert.ok(
        rows.every((row) => Array.from(row).length === width),
        `Width ${width}: ${rows.map((row) => Array.from(row).length).join(',')}`,
      );
    }
  }
});

test('terminal output is sanitized and truncated safely', () => {
  assert.equal(plain('hello\x1b[2J\x00world'), 'helloworld');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('ok', 4), 'ok  ');
});
