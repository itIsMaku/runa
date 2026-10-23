import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSpec } from '../dist/process.js';

const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

function fixture(t, files = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runany cli with spaces-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(
      path.join(directory, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return directory;
}

function invoke(cwd, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.ifError(result.error);
  return result;
}

test('help and version work without a project', (t) => {
  const directory = fixture(t);
  assert.match(invoke(directory, '--help').stdout, /Usage: runa/);
  assert.equal(invoke(directory, '--version').stdout.trim(), '0.1.0');
});

test('empty and unsupported projects give an actionable error', (t) => {
  const result = invoke(fixture(t));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No supported tasks.*\.runany.json/);
});

test('invalid options and missing arguments fail clearly', (t) => {
  const cwd = fixture(t);
  for (const args of [['--cwd'], ['--nope'], ['dev', '--port'], ['dev', '3000'], ['--json']]) {
    const result = invoke(cwd, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runa:/);
  }
});

test('--cwd discovers a project elsewhere and --json is parseable', (t) => {
  const cwd = fixture(t, { 'package.json': { scripts: { dev: 'node app.js' } } });
  const result = invoke(os.tmpdir(), '-C', cwd, '--list', '--json');
  assert.equal(result.status, 0, result.stderr);
  const project = JSON.parse(result.stdout);
  assert.equal(project.cwd, cwd);
  assert.equal(project.defaultId, 'npm:dev');
});

test('--list and --dry-run do not execute project code', (t) => {
  const cwd = fixture(t, {
    '.runany.json': {
      default: 'dev',
      commands: { dev: [process.execPath, '-e', 'require("fs").writeFileSync("MARKER", "ran")'] },
    },
  });
  const list = invoke(cwd, '--list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /config:dev/);
  const dryRun = invoke(cwd, '--dry-run', '--json', '--', 'hello world');
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).args.at(-1), 'hello world');
  assert.equal(existsSync(path.join(cwd, 'MARKER')), false);
});

test('--publish dry-run previews automatic and explicit targets without executing anything', (t) => {
  const cwd = fixture(t, {
    '.runany.json': {
      default: 'dev',
      commands: { dev: [process.execPath, '-e', 'require("fs").writeFileSync("MARKER", "ran")'] },
    },
  });
  const automatic = invoke(cwd, '--publish', '--dry-run', '--json');
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.equal(JSON.parse(automatic.stdout).publish.provider, 'cloudflare');
  assert.match(JSON.parse(automatic.stdout).publish.target, /auto/);
  const explicit = invoke(cwd, '--publish', '--port', '3000', '--dry-run', '--json');
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).publish.target, 'http://127.0.0.1:3000');
  assert.equal(existsSync(path.join(cwd, 'MARKER')), false);
});

test('publish rejects invalid ports, unsupported providers, and incompatible flags', (t) => {
  const cwd = fixture(t, { 'package.json': { scripts: { dev: 'node app.cjs' } } });
  for (const args of [
    ['--publish', '--port'],
    ['--publish', '--port', '0'],
    ['--publish', '--port', '65536'],
    ['--publish', '--port', '-1'],
    ['--publish', '--port', '3.5'],
    ['--publish', '--tunnel'],
    ['--publish', '--tunnel', 'missing', '--dry-run'],
    ['--publish', '--list'],
    ['--port', '3000'],
    ['--tunnel', 'cloudflare'],
  ]) {
    const result = invoke(cwd, ...args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /runa:/);
  }
});

test('--publish reports a missing cloudflared before launching the application', (t) => {
  const cwd = fixture(t, {
    '.runany.json': {
      default: 'dev',
      commands: { dev: [process.execPath, '-e', 'require("fs").writeFileSync("MARKER", "ran")'] },
    },
  });
  const env = { ...process.env };
  for (const key of Object.keys(env).filter((name) => name.toLowerCase() === 'path')) {
    env[key] = cwd;
  }
  const result = spawnSync(process.execPath, [cli, '--publish'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install cloudflared/);
  assert.equal(existsSync(path.join(cwd, 'MARKER')), false);
});

test('SIGINT stops a published CLI session and both servers', {
  skip: process.platform === 'win32',
  timeout: 15000,
}, async (t) => {
  const cwd = fixture(t, {
    '.runany.json': { default: 'dev', commands: { dev: [process.execPath, 'app.cjs'] } },
    'app.cjs': `
      const http = require('node:http');
      const fs = require('node:fs');
      const server = http.createServer((_req, res) => res.end('app'));
      server.listen(0, '127.0.0.1', () => {
        fs.writeFileSync('app-port', String(server.address().port));
        console.log('Local: http://127.0.0.1:' + server.address().port);
      });
    `,
    cloudflared: `#!/usr/bin/env node
      if (process.argv.includes('--version')) {
        console.log('cloudflared fixture');
      } else {
        const http = require('node:http');
        const fs = require('node:fs');
        const server = http.createServer((_req, res) => res.end('tunnel'));
        server.listen(0, '127.0.0.1', () => {
          fs.writeFileSync('tunnel-port', String(server.address().port));
          console.log('https://cli-test.trycloudflare.com');
        });
      }
    `,
  });
  chmodSync(path.join(cwd, 'cloudflared'), 0o755);
  const child = spawn(process.execPath, [cli, '--publish'], {
    cwd,
    env: { ...process.env, PATH: `${cwd}${path.delimiter}${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const read = (chunk) => {
    output += chunk;
    if (output.includes('Public URL: https://cli-test.trycloudflare.com')) {
      child.kill('SIGINT');
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  t.after(() => child.kill('SIGTERM'));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 130, output);
  const { portIsOpen, localTarget } = await import('../dist/publish/local-url.js');
  for (const file of ['app-port', 'tunnel-port']) {
    const port = Number(readFileSync(path.join(cwd, file), 'utf8'));
    assert.equal(await portIsOpen(localTarget(port)), false, `${file} was left running`);
  }
});

test('executes in the project directory with literal arguments and preserves exit code', (t) => {
  const cwd = fixture(t, {
    '.runany.json': { default: 'dev', commands: { dev: [process.execPath, 'app.cjs'] } },
    'app.cjs':
      'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); process.exitCode = 7;',
  });
  const args = [
    'hello world',
    '',
    'a"b',
    'a&b',
    '$(echo injected)',
    '%PATH%',
    'C:\\some path\\',
    'žluťoučký',
  ];
  const result = invoke(cwd, '--', ...args);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: realpathSync(cwd), args });
});

test('real npm scripts receive literal forwarded arguments', (t) => {
  const cwd = fixture(t, {
    'package.json': { scripts: { dev: 'node app.cjs' } },
    'app.cjs': 'console.log("RESULT:" + JSON.stringify(process.argv.slice(2)));',
  });
  const args = ['--port', '3000', 'hello world', 'a&b', 'a"b', 'end\\', '%RUNANY_LITERAL%'];
  const result = invoke(cwd, '--', ...args);
  assert.equal(result.status, 0, result.stderr);
  const match = /^RESULT:(.*)$/m.exec(result.stdout);
  assert.ok(match, result.stdout);
  assert.deepEqual(JSON.parse(match[1]), args);
});

test('unknown runner and absent executable have helpful errors', (t) => {
  const cwd = fixture(t, {
    '.runany.json': {
      default: 'dev',
      commands: { dev: ['runany-executable-that-does-not-exist-12345'] },
    },
  });
  const missing = invoke(cwd);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not installed or is not on PATH/);
  assert.match(invoke(cwd, 'unknown').stderr, /Unknown task/);
});

test('Windows resolves a cmd shim instead of a sibling POSIX script', {
  skip: process.platform !== 'win32',
}, (t) => {
  const cwd = fixture(t, { runner: '#!/bin/sh\n', 'runner.cmd': '@echo ok\r\n' });
  const spec = spawnSpec('runner', [], cwd, 'win32', { PATHEXT: '.EXE;.CMD', PATH: cwd });
  assert.equal(spec.bin, 'cmd.exe');
  assert.match(spec.args.at(-1), /runner\.cmd/i);
  assert.equal(spec.windowsVerbatimArguments, true);
});

test('non-interactive ambiguous default fails without hanging or guessing', (t) => {
  const cwd = fixture(t, {
    'package.json': { scripts: { build: 'echo build', test: 'echo test' } },
  });
  const result = invoke(cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No unambiguous default.*--list/);
});

test('does not discover or run tasks in parent directories', (t) => {
  const cwd = fixture(t, {
    'package.json': { scripts: { dev: 'echo parent' } },
    'nested/.keep': '',
  });
  const result = invoke(path.join(cwd, 'nested'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No supported tasks/);
});

test('SIGTERM reaches child and results in signal exit code', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (t) => {
  const cwd = fixture(t, {
    '.runany.json': { default: 'dev', commands: { dev: [process.execPath, 'app.cjs'] } },
    'app.cjs': 'console.log("READY"); setInterval(() => {}, 1000);',
  });
  const child = spawn(process.execPath, [cli], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
    if (output.includes('READY')) {
      child.kill('SIGTERM');
    }
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(result.code, 143);
  assert.equal(result.signal, null);
});
