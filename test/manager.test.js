import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { LogBuffer } from '../dist/daemon/logs.js';
import { ProcessManager } from '../dist/daemon/manager.js';
import { portIsOpen } from '../dist/publish/local-url.js';

const app = String.raw`
const fs = require('node:fs');
fs.appendFileSync('starts', 'start\n');
const server = require('node:http').createServer((_req, res) => res.end(process.env.RUNA_TEST_VALUE || 'app'));
server.listen(0, '127.0.0.1', () => {
  console.log('hello from this process');
  console.error('stderr is captured too');
  console.log('Local: http://127.0.0.1:' + server.address().port);
});
`;

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'runa-manager-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, 'app.cjs'), app);
  return cwd;
}

async function waitFor(read, predicate, label = 'condition') {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = read();
    if (predicate(result)) {
      return result;
    }
    await setTimeout(30);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('manager captures logs and environment, keeps independent tasks, and supports stop/restart', async (t) => {
  const cwd = fixture(t);
  const manager = new ProcessManager();
  t.after(() => manager.close());
  const entry = manager.start({
    task: 'config:dev',
    command: {
      bin: process.execPath,
      args: ['app.cjs'],
      cwd,
      env: { ...process.env, RUNA_TEST_VALUE: 'first-environment' },
    },
  });
  const first = await waitFor(
    () => manager.snapshot(entry.id),
    (state) => state.processes[0].localUrl && state.logs.some((line) => line.stream === 'stderr'),
  );
  const url = first.processes[0].localUrl;
  assert.equal(await (await fetch(url)).text(), 'first-environment');
  assert.match(first.logs.map((line) => line.text).join('\n'), /hello from this process/);
  assert.equal(JSON.stringify(first.processes).includes('RUNA_TEST_VALUE'), false);
  const second = manager.start({
    task: 'custom:worker',
    command: {
      bin: process.execPath,
      args: ['-e', 'console.log("worker"); setInterval(() => {}, 1000)'],
      cwd,
    },
  });
  assert.equal(manager.snapshot().processes.length, 2);
  assert.throws(() => manager.remove(entry.id), /Stop the process/);
  await manager.stop(entry.id);
  assert.equal(await portIsOpen(url), false);
  assert.equal(
    manager.snapshot().processes.find((item) => item.id === second.id).status,
    'running',
  );
  await manager.restart(entry.id);
  await waitFor(
    () => manager.snapshot().processes.find((item) => item.id === entry.id),
    (item) => item.localUrl && item.status === 'running',
  );
  assert.equal(readFileSync(path.join(cwd, 'starts'), 'utf8').trim().split('\n').length, 2);
  await manager.stop(entry.id);
  manager.remove(entry.id);
  assert.equal(manager.snapshot().processes.length, 1);
  await manager.close();
});

test('sharing an existing process and removing its tunnel never restarts or stops the app', async (t) => {
  const cwd = fixture(t);
  const provider = {
    id: 'fixture',
    installHint: '',
    checkCommand: () => ({ bin: process.execPath, args: ['--version'], cwd }),
    createCommand: (target) => ({
      bin: process.execPath,
      args: [
        '-e',
        'console.log("https://fixture.trycloudflare.com"); setInterval(() => {}, 1000)',
        target,
      ],
      cwd,
    }),
    findPublicUrl: (output) => /https:\/\/fixture\.trycloudflare\.com/.exec(output)?.[0],
  };
  const manager = new ProcessManager(provider);
  t.after(() => manager.close());
  const entry = manager.start({
    task: 'fixture:app',
    command: { bin: process.execPath, args: ['app.cjs'], cwd },
  });
  const get = () => manager.snapshot().processes[0];
  const initial = await waitFor(get, (item) => Boolean(item.localUrl));
  await manager.publish(entry.id, undefined, { ...process.env });
  const shared = await waitFor(get, (item) => item.shareStatus === 'live');
  assert.equal(shared.publicUrl, 'https://fixture.trycloudflare.com');
  assert.equal(shared.startedAt, initial.startedAt);
  await manager.unpublish(entry.id);
  assert.equal(get().shareStatus, 'off');
  assert.equal(get().status, 'running');
  assert.equal(await (await fetch(initial.localUrl)).text(), 'app');
  assert.equal(readFileSync(path.join(cwd, 'starts'), 'utf8').trim(), 'start');
  await manager.publish(entry.id, undefined, { ...process.env });
  await waitFor(get, (item) => item.shareStatus === 'live');
  await manager.stop(entry.id);
  assert.equal(get().shareStatus, 'off');
  assert.equal(await portIsOpen(initial.localUrl), false);
});

test('failed processes keep their exit code and remain removable from history', async (t) => {
  const cwd = fixture(t);
  const manager = new ProcessManager();
  t.after(() => manager.close());
  const entry = manager.start({
    task: 'fixture:fail',
    command: {
      bin: process.execPath,
      args: ['-e', 'console.error("failure"); process.exit(7)'],
      cwd,
    },
  });
  const failed = await waitFor(
    () => manager.snapshot(entry.id),
    (state) => state.processes[0].status === 'failed',
  );
  assert.equal(failed.processes[0].exitCode, 7);
  assert.match(failed.logs.map((line) => line.text).join('\n'), /failure/);
  manager.remove(entry.id);
  assert.equal(manager.snapshot().processes.length, 0);
});

test('log buffers retain partial output and bound scrollback memory', () => {
  const logs = new LogBuffer();
  logs.append('partial', 'stdout');
  assert.equal(logs.snapshot()[0].text, 'partial');
  logs.append(' complete\n', 'stdout');
  assert.equal(logs.snapshot()[0].text, 'partial complete');
  for (let index = 0; index < 4000; index++) {
    logs.append(`${index}: ${'x'.repeat(300)}\n`, 'stdout');
  }
  assert.ok(logs.snapshot().length <= 2000);
  assert.ok(logs.snapshot().reduce((size, line) => size + line.text.length, 0) <= 262144);
  assert.match(logs.snapshot().at(-1).text, /^3999:/);
});
