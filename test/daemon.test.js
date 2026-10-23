import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { connectDaemon } from '../dist/daemon/client.js';
import { readState } from '../dist/daemon/state.js';

test('separate clients share one authenticated manager and its process logs', {
  timeout: 30000,
}, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runa-daemon-'));
  let client;
  t.after(async () => {
    try {
      await client?.request({ action: 'shutdown' });
      for (
        let attempt = 0;
        attempt < 100 && existsSync(path.join(directory, 'daemon.lock'));
        attempt++
      ) {
        await setTimeout(30);
      }
    } finally {
      const state = readState(directory);
      if (state) {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
  assert.equal(await connectDaemon(false, directory), undefined);
  const connections = await Promise.all([
    connectDaemon(true, directory),
    connectDaemon(true, directory),
  ]);
  client = connections[0];
  const other = connections[1];
  const state = readState(directory);
  assert.ok(state);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path.join(directory, 'daemon.json')).mode & 0o077, 0);
  }
  const unauthorized = await new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: state.port, method: 'POST', path: '/rpc' },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once('error', reject);
    request.end('{"action":"shutdown"}');
  });
  assert.equal(unauthorized, 403);
  writeFileSync(
    path.join(directory, '.runany.json'),
    JSON.stringify({
      default: 'dev',
      commands: {
        dev: [
          process.execPath,
          '-e',
          'console.log("shared manager log"); setInterval(() => {}, 1000)',
        ],
      },
    }),
  );
  const entry = await client.request({
    action: 'start',
    cwd: directory,
    task: 'config:dev',
    env: { ...process.env },
  });
  let snapshot;
  for (let attempt = 0; attempt < 100; attempt++) {
    snapshot = await other.request({ action: 'snapshot', selected: entry.id });
    if (snapshot.logs.some((line) => line.text === 'shared manager log')) {
      break;
    }
    await setTimeout(30);
  }
  assert.equal(snapshot.processes[0].id, entry.id);
  assert.ok(snapshot.logs.some((line) => line.text === 'shared manager log'));
  assert.equal(readState(directory).pid, state.pid);
  assert.equal(
    readFileSync(path.join(directory, 'daemon.json'), 'utf8').includes('shared manager log'),
    false,
  );
  await other.request({ action: 'stop', id: entry.id });
  await client.request({ action: 'restart', id: entry.id });
  assert.equal((await other.request({ action: 'snapshot' })).processes[0].status, 'running');
  await other.request({ action: 'stop', id: entry.id });
  await other.request({ action: 'remove', id: entry.id });
  assert.equal((await client.request({ action: 'snapshot' })).processes.length, 0);
});
