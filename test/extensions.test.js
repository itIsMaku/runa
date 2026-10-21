import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  builtinRunners,
  createNodeRunner,
  detect,
  execute,
  packageManagers,
  select,
} from '../dist/index.js';

function fixture(t, files = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'runa-extension-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(cwd, file), content);
  }
  return cwd;
}

test('a new runner participates in discovery, selection, and argument forwarding without core changes', (t) => {
  const customRunner = {
    id: 'custom',
    priority: 40,
    detect: (context) =>
      context.has('project.custom')
        ? [
            {
              name: 'launch-api',
              source: 'project.custom',
              bin: 'custom-runtime',
              args: ['launch', context.read('project.custom')],
              defaultRank: 3,
              argumentSeparator: '--app-args',
            },
          ]
        : [],
  };
  const cwd = fixture(t, { 'project.custom': 'api' });
  const project = detect(cwd, process.platform, [...builtinRunners, customRunner]);
  const task = select(project);
  assert.equal(task.id, 'custom:launch-api');
  assert.deepEqual(execute(task, ['hello world'], cwd).args, [
    'launch',
    'api',
    '--app-args',
    'hello world',
  ]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(project)));
});

test('adding a package manager needs no changes to the Node runner or process executor', (t) => {
  const customManager = {
    id: 'custom-pm',
    lockfiles: ['custom.lock'],
    runScript: (name) => ({
      bin: 'custom-pm',
      args: ['execute', name],
      argumentSeparator: '--args',
    }),
  };
  const runners = [createNodeRunner([...packageManagers, customManager])];
  const cwd = fixture(t, {
    'package.json': JSON.stringify({
      packageManager: 'custom-pm@1.0.0',
      scripts: { dev: 'serve' },
    }),
    'package-lock.json': '',
  });
  const task = select(detect(cwd, process.platform, runners));
  assert.equal(task.id, 'custom-pm:dev');
  assert.deepEqual(execute(task, ['--port', '1234'], cwd).args, [
    'execute',
    'dev',
    '--args',
    '--port',
    '1234',
  ]);
  const locked = fixture(t, { 'package.json': '{"scripts":{"dev":"serve"}}', 'custom.lock': '' });
  assert.equal(select(detect(locked, process.platform, runners)).id, 'custom-pm:dev');
});

test('runner registration order does not change preference and equal defaults require a choice', (t) => {
  const runner = (id, priority) => ({
    id,
    priority,
    detect: () => [{ name: 'run', source: 'fixture', bin: id, args: [] }],
  });
  const cwd = fixture(t);
  assert.equal(
    detect(cwd, process.platform, [runner('second', 40), runner('first', 10)]).defaultId,
    'first:run',
  );
  assert.equal(
    detect(cwd, process.platform, [runner('first', 40), runner('second', 40)]).defaultId,
    undefined,
  );
});

test('duplicate task IDs are rejected instead of selecting the wrong runner', (t) => {
  const runner = {
    id: 'duplicate',
    priority: 40,
    detect: () => [{ name: 'run', source: 'fixture', bin: 'runner', args: [] }],
  };
  assert.throws(
    () => detect(fixture(t), process.platform, [runner, runner]),
    /Duplicate task ID "duplicate:run"/,
  );
});

test('unsupported detectors can return no tasks without affecting other runners', (t) => {
  const runner = { id: 'empty', priority: 0, detect: () => [] };
  const project = detect(fixture(t, { 'main.py': '' }), process.platform, [
    runner,
    ...builtinRunners,
  ]);
  assert.equal(project.defaultId, 'python:run');
});
