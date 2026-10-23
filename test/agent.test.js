import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clientFor } from '../dist/daemon/client.js';
import { LogBuffer } from '../dist/daemon/logs.js';
import { readState } from '../dist/daemon/state.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

function fixture(t) {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'runa agent with spaces-')));
  const state = path.join(cwd, 'state');
  const tools = path.join(cwd, 'tools');
  mkdirSync(tools);
  // Never reach a real tunnel tool or package manager on the host.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  Object.assign(env, { PATH: tools, RUNA_STATE_DIR: state });
  const tunnel = path.join(tools, 'tunnel.cjs');
  writeFileSync(
    tunnel,
    'if (process.argv.includes("--version")) process.exit(0); console.log("https://agent-fixture.trycloudflare.com"); setInterval(() => {}, 1000);',
  );
  const launcher = path.join(
    tools,
    process.platform === 'win32' ? 'cloudflared.cmd' : 'cloudflared',
  );
  writeFileSync(
    launcher,
    process.platform === 'win32'
      ? `@"${process.execPath}" "${tunnel}" %*\r\n`
      : `#!${process.execPath}\nrequire('./tunnel.cjs');\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(cwd, 'app.cjs'),
    `
    const server = require('node:http').createServer((_request, response) => response.end('agent app'));
    console.log(JSON.stringify(process.argv.slice(2)));
    console.error('agent stderr');
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
  `,
  );
  writeFileSync(
    path.join(cwd, '.runany.json'),
    JSON.stringify({
      default: 'dev',
      commands: {
        dev: [process.execPath, 'app.cjs'],
        worker: [
          process.execPath,
          '-e',
          'console.log("worker alive"); setInterval(() => {}, 1000)',
        ],
        fail: [process.execPath, '-e', 'console.error("intentional failure"); process.exit(7)'],
      },
    }),
  );
  async function invoke(args, expected = 0, override = {}) {
    let reply;
    try {
      reply = await exec(process.execPath, [bin, 'agent', ...args], {
        cwd,
        env: { ...env, ...override },
        timeout: 20000,
      });
      assert.equal(expected, 0, reply.stdout);
    } catch (error) {
      assert.equal(error.code, expected, error.stderr || error.stdout || error.message);
      reply = error;
    }
    assert.equal(reply.stderr, '');
    const lines = reply.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const line of lines) {
      assert.equal(line.version, 1);
      assert.equal(line.ok, expected === 0);
    }
    return lines.length === 1 ? lines[0] : lines;
  }
  t.after(async () => {
    const current = readState(state);
    if (current) {
      await clientFor(current).request({ action: 'shutdown' });
      for (
        let attempt = 0;
        attempt < 100 && existsSync(path.join(state, 'daemon.lock'));
        attempt++
      ) {
        await delay(30);
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, state, tools, invoke };
}

test('agent discovery is machine-readable and has no manager or execution side effects', async (t) => {
  const { state, invoke } = fixture(t);
  assert.equal((await invoke(['capabilities'])).result.agentApiVersion, 1);
  assert.ok(
    (await invoke(['discover', '-C', '.'])).result.candidates.some(
      (task) => task.id === 'config:dev',
    ),
  );
  assert.deepEqual((await invoke(['list'])).result.processes, []);
  assert.equal((await invoke(['start', 'missing'], 1)).error.code, 'INVALID_TASK');
  assert.equal(
    (await invoke(['logs', 'missing', '--tail', '0'], 1)).error.code,
    'INVALID_ARGUMENT',
  );
  assert.equal((await invoke(['inspect', 'missing'], 1)).error.code, 'NOT_FOUND');
  assert.equal(existsSync(path.join(state, 'daemon.json')), false);
});

test('agent and dashboard clients share processes, logs, sharing, and lifecycle controls', {
  timeout: 90000,
}, async (t) => {
  const { cwd, state, tools, invoke } = fixture(t);
  const first = (
    await invoke(['start', '-C', '.', '--wait-ready', '--', 'literal with spaces', '--help'])
  ).result;
  const id = first.id;
  assert.equal(first.cwd, cwd);
  assert.equal(await (await fetch(first.localUrl)).text(), 'agent app');
  const client = clientFor(readState(state));
  const snapshot = await client.request({ action: 'snapshot', selected: id });
  assert.equal(snapshot.processes[0].id, id);
  assert.ok(snapshot.logs.some((line) => line.text === '["literal with spaces","--help"]'));
  assert.ok(snapshot.logs.some((line) => line.stream === 'stderr' && line.text === 'agent stderr'));
  assert.equal((await invoke(['list', '-C', '.'])).result.processes[0].id, id);
  assert.equal((await invoke(['inspect', id])).result.id, id);
  assert.equal((await invoke(['remove', id], 1)).error.code, 'CONFLICT');
  const logs = (await invoke(['logs', id, '--tail', '2'])).result;
  assert.equal(logs.logs.length, 2);
  assert.equal(
    (await invoke(['logs', id, '--after', String(logs.nextCursor)])).result.logs.length,
    0,
  );
  assert.equal((await invoke(['logs', id, '--after', '999999'], 1)).error.code, 'INVALID_ARGUMENT');
  const followed = await invoke(['logs', id, '--follow', '--timeout', '700']);
  assert.equal(followed.at(-1).result.reason, 'timeout');
  assert.equal((await invoke(['inspect', id])).result.status, 'running');
  // Missing dependencies produce JSON without prompts or automatic installation.
  const empty = path.join(tools, 'empty');
  mkdirSync(empty);
  assert.equal(
    (await invoke(['publish', id], 1, { PATH: empty })).error.code,
    'DEPENDENCY_UNAVAILABLE',
  );
  const published = (await invoke(['publish', id])).result;
  assert.equal(published.publicUrl, 'https://agent-fixture.trycloudflare.com');
  assert.equal(published.startedAt, first.startedAt);
  assert.equal((await invoke(['publish', id])).result.publicUrl, published.publicUrl);
  assert.equal((await client.request({ action: 'snapshot' })).processes[0].shareStatus, 'live');
  assert.equal((await invoke(['unpublish', id])).result.status, 'running');
  assert.equal(await (await fetch(first.localUrl)).text(), 'agent app');
  assert.equal((await invoke(['stop', id])).result.status, 'stopped');
  const restarted = (await invoke(['restart', id, '--wait-ready'])).result;
  assert.equal(restarted.id, id);
  assert.ok(restarted.startedAt >= first.startedAt);
  assert.ok(
    (await invoke(['logs', id, '--after', String(logs.nextCursor)])).result.logs.length > 0,
  );
  await client.request({ action: 'stop', id });
  assert.equal((await invoke(['inspect', id])).result.status, 'stopped');
  assert.deepEqual((await invoke(['remove', id])).result, { removed: id });
  assert.equal((await invoke(['inspect', id], 1)).error.code, 'NOT_FOUND');
  assert.deepEqual((await invoke(['list'])).result.processes, []);
});

test('readiness timeout retains process ID and running app; exits retain their real code', {
  timeout: 45000,
}, async (t) => {
  const { invoke } = fixture(t);
  const timeout = await invoke(['start', 'worker', '--wait-ready', '--timeout', '3000'], 124);
  assert.equal(timeout.error.code, 'TIMEOUT');
  const worker = timeout.error.details.process;
  assert.equal((await invoke(['inspect', worker.id])).result.status, 'running');
  assert.equal((await invoke(['wait', worker.id, '--for', 'running'])).result.id, worker.id);
  await invoke(['stop', worker.id]);
  assert.equal(
    (await invoke(['wait', worker.id, '--for', 'ready'], 1)).error.code,
    'PROCESS_EXITED',
  );
  const failed = (await invoke(['start', 'fail'])).result;
  const exited = (await invoke(['wait', failed.id, '--for', 'exited'])).result;
  assert.equal(exited.status, 'failed');
  assert.equal(exited.exitCode, 7);
  const followed = await invoke(['logs', failed.id, '--follow']);
  assert.equal(followed.at(-1).result.reason, 'exited');
  assert.ok(
    followed.some((line) =>
      line.result.logs?.some((entry) => entry.text === 'intentional failure'),
    ),
  );
  await invoke(['shutdown']);
});

test('cursor pages never skip complete lines or advance over partial output', () => {
  const logs = new LogBuffer();
  logs.append('partial', 'stdout');
  assert.deepEqual(logs.read().pending, { stdout: 'partial' });
  assert.equal(logs.read().nextCursor, 0);
  logs.append(' complete\nsecond\nthird\n', 'stdout');
  const page = logs.read(0, 2);
  assert.deepEqual(
    page.logs.map((entry) => entry.text),
    ['partial complete', 'second'],
  );
  assert.equal(page.hasMore, true);
  assert.deepEqual(
    logs.read(page.nextCursor, 2).logs.map((entry) => entry.text),
    ['third'],
  );
  assert.deepEqual(logs.read(3).logs, []);
  for (let index = 0; index < 3000; index++) {
    logs.message(String(index));
  }
  const stale = logs.read(1, 10);
  assert.equal(stale.truncated, true);
  assert.equal(stale.logs.length, 10);
  assert.equal(stale.logs[0].sequence, stale.oldestSequence);
  assert.equal(stale.hasMore, true);
  assert.throws(() => logs.read(-1), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => logs.read(0, 0), { code: 'INVALID_ARGUMENT' });
});

test('agent refuses an older manager without replacing it or stopping its apps', async (t) => {
  const { state, invoke } = fixture(t);
  const actions = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    actions.push(JSON.parse(body).action);
    response.end(JSON.stringify({ result: { protocol: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  mkdirSync(state);
  writeFileSync(
    path.join(state, 'daemon.json'),
    JSON.stringify({
      protocol: 1,
      pid: process.pid,
      port: server.address().port,
      token: 'a'.repeat(64),
    }),
  );
  const reply = await invoke(['start'], 1);
  assert.equal(reply.error.code, 'DAEMON_UPGRADE_REQUIRED');
  assert.ok(actions.length > 0);
  assert.ok(actions.every((action) => action === 'ping'));
  // This fixture is not a real manager and does not own any processes.
  rmSync(path.join(state, 'daemon.json'));
});

test('interrupting an agent wait returns JSON and leaves the managed app running', {
  skip: process.platform === 'win32',
  timeout: 20000,
}, async (t) => {
  const { cwd, state, invoke } = fixture(t);
  const worker = (await invoke(['start', 'worker'])).result;
  const reply = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { runAgent } = await import(${JSON.stringify(new URL('../dist/agent/index.js', import.meta.url).href)}); const result = runAgent(['wait', ${JSON.stringify(worker.id)}, '--for', 'ready']); process.stderr.write('READY\\n'); process.exitCode = await result;`,
      ],
      {
        cwd,
        env: { ...process.env, RUNA_STATE_DIR: state },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        if (error?.code !== 130) {
          reject(error ?? new Error('Expected cancellation'));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    child.stderr.once('data', () => child.kill('SIGINT'));
  });
  assert.equal(reply.stderr, 'READY\n');
  assert.equal(JSON.parse(reply.stdout).error.code, 'CANCELLED');
  assert.equal((await invoke(['inspect', worker.id])).result.status, 'running');
});
