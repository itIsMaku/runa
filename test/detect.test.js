import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, select } from '../src/detect.js';
import { execute } from '../src/process.js';

function fixture(t, files = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'runany-detect-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return directory;
}

test('packageManager overrides lockfiles and dev beats start', (t) => {
  const directory = fixture(t, {
    'package.json': { packageManager: 'yarn@4.0.0', scripts: { start: 'node server.js', dev: 'vite', test: 'vitest' } },
    'pnpm-lock.yaml': '',
  });
  const project = detect(directory);
  assert.equal(project.defaultId, 'yarn:dev');
  assert.deepEqual(select(project).args, ['run', 'dev']);
  assert.equal(select(project, 'test').bin, 'yarn');
});

for (const [lock, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']]) {
  test(`detects ${manager} from ${lock}`, (t) => {
    const project = detect(fixture(t, { 'package.json': { scripts: { start: 'app' } }, [lock]: '' }));
    assert.equal(project.defaultId, `${manager}:start`);
  });
}

test('package without scripts does not invent a runnable app', (t) => {
  assert.deepEqual(detect(fixture(t, { 'package.json': { name: 'library' } })).candidates, []);
});

test('Makefile supports multiple targets, continuations, descriptions and excludes patterns', (t) => {
  const project = detect(fixture(t, { Makefile: '.PHONY: dev test\nVERSION := 1\n%.o: %.c\n# comment\ndev serve: ## Start server\n\techo hello\ntest \\\ncheck: ## Check\n\techo ok\n' }));
  assert.equal(project.defaultId, 'make:dev');
  assert.deepEqual(new Set(project.candidates.map((item) => item.name)), new Set(['dev', 'serve', 'test', 'check']));
  assert.equal(select(project, 'dev').description, 'Start server');
});

test('uses Make filename precedence', (t) => {
  const project = detect(fixture(t, { Makefile: 'start:\n', GNUmakefile: 'dev:\n' }));
  assert.equal(project.defaultId, 'make:dev');
  assert.equal(project.candidates.length, 1);
});

test('explicit task must disambiguate runners; default prefers package scripts', (t) => {
  const project = detect(fixture(t, { 'package.json': { scripts: { dev: 'vite', test: 'vitest' } }, Makefile: 'dev:\ntest:\n' }));
  assert.equal(project.defaultId, 'npm:dev');
  assert.throws(() => select(project, 'test'), /ambiguous.*npm:test.*make:test/);
  assert.equal(select(project, 'make:test').bin, 'make');
  assert.throws(() => select(project, 'missing'), /Unknown task/);
});

test('configuration sets default and overrides named tasks', (t) => {
  const project = detect(fixture(t, {
    '.runany.json': { default: 'api', commands: { api: ['node', 'api.js'], test: ['custom-test', '--verbose'] } },
    'package.json': { scripts: { dev: 'vite', test: 'vitest' } },
  }));
  assert.equal(project.defaultId, 'config:api');
  assert.deepEqual(select(project, 'test').args, ['--verbose']);
});

test('invalid JSON and configuration give actionable errors', (t) => {
  assert.throws(() => detect(fixture(t, { 'package.json': '{oops' })), /Cannot read.*package.json/);
  for (const config of [null, [], {}, { commands: [] }, { commands: { dev: 'node app.js' } }, { commands: { dev: [] } }, { commands: { dev: ['node', 1] } }, { commands: {}, default: 'missing' }]) {
    assert.throws(() => detect(fixture(t, { '.runany.json': JSON.stringify(config) })), /\.runany.json/);
  }
});

test('never auto-selects test, build, or arbitrary config commands', (t) => {
  const project = detect(fixture(t, { 'package.json': { scripts: { test: 'test', build: 'build' } } }));
  assert.equal(select(project), undefined);
});

test('discovery never evaluates Makefiles or package scripts', (t) => {
  const directory = fixture(t, { Makefile: '$(shell touch SHOULD_NOT_EXIST)\ndev:\n\ttouch SHOULD_NOT_EXIST\n', 'package.json': { scripts: { dev: 'touch SHOULD_NOT_EXIST' } } });
  detect(directory);
  assert.deepEqual(detect(directory).candidates.map((item) => item.id), ['npm:dev', 'make:dev']);
  assert.throws(() => readFileSync(path.join(directory, 'SHOULD_NOT_EXIST')), /ENOENT/);
});

test('Compose uses the detected filename explicitly', (t) => {
  const project = detect(fixture(t, { 'docker-compose.yml': 'services: {}' }));
  assert.deepEqual(select(project).args, ['compose', '-f', 'docker-compose.yml', 'up']);
});

test('Python prefers local virtualenv and Django over standalone files', (t) => {
  const directory = fixture(t, { 'manage.py': '', 'main.py': '', '.venv/bin/python': '', '.venv/Scripts/python.exe': '' });
  const unix = select(detect(directory, 'linux'));
  assert.equal(unix.bin, path.join(directory, '.venv/bin/python'));
  assert.deepEqual(unix.args, ['manage.py', 'runserver']);
  assert.equal(select(detect(directory, 'win32')).bin, path.join(directory, '.venv/Scripts/python.exe'));
});

test('Python fallback uses the Windows launcher or python3', (t) => {
  const directory = fixture(t, { 'app.py': 'print("hello")' });
  assert.deepEqual(select(detect(directory, 'win32')).args, ['-3', 'app.py']);
  assert.equal(select(detect(directory, 'linux')).bin, 'python3');
});

test('Rust library exposes build/test but no default; binary runs', (t) => {
  const library = fixture(t, { 'Cargo.toml': '[package]\nname="lib"' });
  assert.equal(detect(library).defaultId, undefined);
  const binary = fixture(t, { 'Cargo.toml': '[package]', 'src/main.rs': 'fn main() {}' });
  assert.equal(detect(binary).defaultId, 'cargo:run');
  const explicit = fixture(t, { 'Cargo.toml': '[[bin]]\nname="app"\npath="cli.rs"' });
  assert.equal(detect(explicit).defaultId, 'cargo:run');
});

test('Go library exposes build/test but only main package runs', (t) => {
  const library = fixture(t, { 'go.mod': 'module lib', 'lib.go': 'package lib', 'lib_test.go': 'package main' });
  assert.equal(detect(library).defaultId, undefined);
  assert.deepEqual(select(detect(library), 'test').args, ['test', './...']);
  const binary = fixture(t, { 'go.mod': 'module app', 'main.go': 'package main\nfunc main() {}' });
  assert.deepEqual(select(detect(binary)).args, ['run', '.']);
});

test('.NET library is not run; multiple runnable projects require a choice', (t) => {
  assert.equal(detect(fixture(t, { 'lib.csproj': '<Project />' })).defaultId, undefined);
  const single = detect(fixture(t, { 'api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />' }));
  assert.deepEqual(select(single).args, ['run', '--project', 'api.csproj']);
  const multiple = detect(fixture(t, { 'api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />', 'worker.csproj': '<OutputType>Exe</OutputType>' }));
  assert.equal(multiple.defaultId, undefined);
});

test('forwarded npm and cargo application arguments get the separator', () => {
  assert.deepEqual(execute({ bin: 'npm', args: ['run', 'dev'] }, ['--port', '3000'], '.').args, ['run', 'dev', '--', '--port', '3000']);
  assert.deepEqual(execute({ bin: 'cargo', args: ['run'] }, ['hello'], '.').args, ['run', '--', 'hello']);
  assert.deepEqual(execute({ bin: 'pnpm', args: ['run', 'dev'] }, ['--port', '3000'], '.').args, ['run', 'dev', '--port', '3000']);
});
