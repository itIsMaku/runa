import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSpec } from '../dist/process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(path.join(os.tmpdir(), 'runa package with spaces-'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this smoke test with npm run test:package.');

function invoke(bin, args, cwd = root) {
  const spec = spawnSpec(bin, args, cwd);
  const result = spawnSync(spec.bin, spec.args, {
    cwd,
    encoding: 'utf8',
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    timeout: 60000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

try {
  invoke(process.execPath, [npmCli, 'pack', '--pack-destination', temporary, '--silent']);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tarball = path.join(temporary, `${pkg.name}-${pkg.version}.tgz`);
  // The distributed package must work without TypeScript or lifecycle scripts.
  invoke(process.execPath, [
    npmCli,
    'install',
    '--global',
    '--prefix',
    temporary,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ]);
  const installed = path.join(
    temporary,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    pkg.name,
  );
  assert.equal(existsSync(path.join(installed, 'node_modules/typescript')), false);
  for (const alias of ['runa', 'runany']) {
    const executable =
      process.platform === 'win32'
        ? path.join(temporary, `${alias}.cmd`)
        : path.join(temporary, 'bin', alias);
    assert.equal(invoke(executable, ['--version'], temporary).trim(), pkg.version);
    assert.match(invoke(executable, ['--help'], temporary), /Usage: runa/);
  }
  const entry = path.join(installed, 'dist/bin.js');
  const listed = JSON.parse(invoke(process.execPath, [entry, '-C', installed, '--list', '--json']));
  assert.ok(listed.candidates.some((task) => task.id === 'npm:build'));
  const api = path.join(installed, 'dist/index.js');
  const apiUrl = pathToFileURL(api).href;
  invoke(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const api = await import(${JSON.stringify(apiUrl)}); if (!api.detect || !api.createNodeRunner) process.exit(1);`,
    ],
    temporary,
  );
  console.log(
    'Package smoke test passed: both aliases, compiled API, no runtime build dependency.',
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
