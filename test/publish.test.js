import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { findTunnelProvider, publish, publishPlan } from '../dist/publish/index.js';
import { findLocalUrl, localTarget, portIsOpen, validatePort } from '../dist/publish/local-url.js';

const appScript = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((req, res) => {
  res.end('hello from the app');
  if (req.url === '/shutdown') server.close();
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => {
  const port = server.address().port;
  fs.writeFileSync('app-port', String(port));
  if (process.argv[3] !== 'quiet') {
    process.stdout.write('Local: http://127.0.0.1:');
    setTimeout(() => process.stdout.write(port + '/\n'), 20);
  }
});
`;

const tunnelScript = String.raw`
const http = require('node:http');
const fs = require('node:fs');
const target = new URL(process.argv[2]);
fs.writeFileSync('tunnel-target', target.origin);
const proxy = http.createServer((req, res) => {
  const forwarded = http.request(target, { method: req.method }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  forwarded.on('error', () => { res.statusCode = 502; res.end(); });
  req.pipe(forwarded);
});
proxy.listen(0, '127.0.0.1', () => {
  fs.writeFileSync('tunnel-port', String(proxy.address().port));
  process.stderr.write('Created https://fixture-test.trycloudflare.com\n');
});
`;

function fixture(t, files = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'runa publish with spaces-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({
    'app.cjs': appScript,
    'tunnel.cjs': tunnelScript,
    ...files,
  })) {
    writeFileSync(path.join(cwd, file), content);
  }
  return cwd;
}

function command(cwd, script, args = []) {
  return { bin: process.execPath, args: [script, ...args], cwd };
}

function provider(overrides = {}) {
  return {
    id: 'fixture',
    installHint: 'Install the fixture tool.',
    checkCommand: (cwd) => command(cwd, '-e', ['process.exit(0)']),
    createCommand: (target, cwd) => command(cwd, 'tunnel.cjs', [target]),
    findPublicUrl: findTunnelProvider().findPublicUrl,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    startupTimeoutMs: 5000,
    tunnelTimeoutMs: 5000,
    onMessage() {},
    onOutput() {},
    ...overrides,
  };
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function assertClosed(port) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await portIsOpen(localTarget(port)))) {
      return;
    }
    await setTimeout(50);
  }
  assert.fail(`Port ${port} remains open after publish cleanup.`);
}

test('detects loopback origins, ANSI output, IPv6, and wildcard listeners', () => {
  const cases = [
    ['Local: http://localhost:5173/', 'http://localhost:5173'],
    ['Server: https://127.0.0.1:8443/path', 'https://127.0.0.1:8443'],
    ['http://0.0.0.0:8000', 'http://127.0.0.1:8000'],
    ['http://[::]:8080/', 'http://[::1]:8080'],
    ['http://[::1]:8080/', 'http://[::1]:8080'],
    [
      `${String.fromCharCode(27)}[32mhttp://localhost:3000/${String.fromCharCode(27)}[0m`,
      'http://localhost:3000',
    ],
  ];
  for (const [output, expected] of cases) {
    assert.equal(findLocalUrl(output), expected);
  }
  for (const invalid of [
    'https://docs.example.com/',
    'http://localhost.evil.example:3000',
    'http://192.168.1.2:3000',
    'http://localhost:65536/',
    'http://localhost:0/',
    'http://user:password@localhost:3000/',
  ]) {
    assert.equal(findLocalUrl(invalid), undefined);
  }
});

test('validates ports and rejects unknown providers', () => {
  for (const value of ['0', '65536', '-1', '3.5', '1e3', '', 'foo']) {
    assert.throws(() => validatePort(value), /integer from 1 to 65535/);
  }
  assert.equal(validatePort('3000'), 3000);
  assert.throws(() => findTunnelProvider('missing'), /Unknown tunnel provider/);
});

test('Cloudflare provider builds an explicit loopback tunnel and parses only its public hostname', () => {
  const cloudflare = findTunnelProvider();
  const plan = publishPlan(3000, cloudflare, process.cwd());
  assert.equal(plan.target, 'http://127.0.0.1:3000');
  assert.deepEqual(plan.tunnel.args, [
    'tunnel',
    '--no-autoupdate',
    '--url',
    plan.target,
    '--http-host-header',
    '127.0.0.1:3000',
  ]);
  assert.equal(
    cloudflare.findPublicUrl('INF https://some-random-name.trycloudflare.com\n'),
    'https://some-random-name.trycloudflare.com',
  );
  assert.equal(cloudflare.findPublicUrl('https://some.trycloudflare.com.evil.example'), undefined);
  assert.equal(cloudflare.findPublicUrl('https://developers.cloudflare.com/docs'), undefined);
});

for (const nested of [false, true]) {
  test(`forwards HTTP and cleans up ${nested ? 'nested process trees' : 'direct child processes'}`, {
    timeout: 15000,
  }, async (t) => {
    const cwd = fixture(t, {
      'wrapper.cjs':
        "require('node:child_process').spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit' }); setInterval(() => {}, 1000);",
    });
    const controller = new AbortController();
    let ready;
    const readyPromise = new Promise((resolve) => {
      ready = resolve;
    });
    const session = publish(
      nested ? command(cwd, 'wrapper.cjs', ['app.cjs']) : command(cwd, 'app.cjs'),
      options({ signal: controller.signal, onPublicUrl: ready }),
      nested
        ? provider({
            createCommand: (target, directory) =>
              command(directory, 'wrapper.cjs', ['tunnel.cjs', target]),
          })
        : provider(),
    );
    t.after(async () => {
      controller.abort();
      await session.catch(() => {});
    });
    const url = await Promise.race([
      readyPromise,
      session.then((code) => {
        throw new Error(`Exited before ready: ${code}`);
      }),
    ]);
    assert.equal(url, 'https://fixture-test.trycloudflare.com');
    const appPort = Number(readFileSync(path.join(cwd, 'app-port'), 'utf8'));
    const tunnelPort = Number(readFileSync(path.join(cwd, 'tunnel-port'), 'utf8'));
    assert.equal(readFileSync(path.join(cwd, 'tunnel-target'), 'utf8'), localTarget(appPort));
    const response = await fetch(localTarget(tunnelPort));
    assert.equal(await response.text(), 'hello from the app');
    controller.abort();
    assert.equal(await session, 130);
    await assertClosed(appPort);
    await assertClosed(tunnelPort);
  });
}

test('explicit port supports applications that print no URL', { timeout: 15000 }, async (t) => {
  const cwd = fixture(t);
  const port = await availablePort();
  const controller = new AbortController();
  const session = publish(
    command(cwd, 'app.cjs', [String(port), 'quiet']),
    options({
      port,
      signal: controller.signal,
      onPublicUrl: () => controller.abort(),
    }),
    provider(),
  );
  t.after(() => controller.abort());
  assert.equal(await session, 130);
  assert.equal(readFileSync(path.join(cwd, 'tunnel-target'), 'utf8'), localTarget(port));
  await assertClosed(port);
});

test('does not start or publish an app when the provider is missing', async (t) => {
  const cwd = fixture(t);
  await assert.rejects(
    publish(
      command(cwd, 'app.cjs'),
      options(),
      provider({
        checkCommand: (directory) => ({
          bin: 'runa-missing-tunnel-fixture-123',
          args: [],
          cwd: directory,
        }),
      }),
    ),
    /unavailable.*Install the fixture tool/,
  );
  assert.equal(existsSync(path.join(cwd, 'app-port')), false);
  assert.equal(existsSync(path.join(cwd, 'tunnel-target')), false);
});

test('refuses to publish a pre-existing service on an explicit port', async (t) => {
  const cwd = fixture(t);
  const server = http.createServer((_req, res) => res.end('existing service'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    publish(command(cwd, 'app.cjs'), options({ port: server.address().port }), provider()),
    /already in use/,
  );
  assert.equal(existsSync(path.join(cwd, 'app-port')), false);
  assert.equal(existsSync(path.join(cwd, 'tunnel-target')), false);
});

test('app startup failure preserves its exit code and never starts a tunnel', async (t) => {
  const cwd = fixture(t);
  assert.equal(await publish(command(cwd, '-e', ['process.exit(7)']), options(), provider()), 7);
  assert.equal(existsSync(path.join(cwd, 'tunnel-target')), false);
  await assert.rejects(
    publish(command(cwd, '-e', ['process.exit(0)']), options(), provider()),
    /long-running web task/,
  );
});

test('startup timeout stops the app and explains how to set a port', async (t) => {
  const cwd = fixture(t);
  await assert.rejects(
    publish(
      command(cwd, 'app.cjs', ['0', 'quiet']),
      options({ startupTimeoutMs: 500 }),
      provider(),
    ),
    /--publish --port/,
  );
  if (existsSync(path.join(cwd, 'app-port'))) {
    await assertClosed(Number(readFileSync(path.join(cwd, 'app-port'), 'utf8')));
  }
  assert.equal(existsSync(path.join(cwd, 'tunnel-target')), false);
});

test('a tunnel exit or missing public URL stops the running app', async (t) => {
  for (const script of ['process.exit(3)', 'setInterval(() => {}, 1000)']) {
    const cwd = fixture(t);
    await assert.rejects(
      publish(
        command(cwd, 'app.cjs'),
        options({ tunnelTimeoutMs: 500 }),
        provider({
          createCommand: (_target, directory) => command(directory, '-e', [script]),
        }),
      ),
      /tunnel exited|did not provide a public URL/,
    );
    await assertClosed(Number(readFileSync(path.join(cwd, 'app-port'), 'utf8')));
  }
});

test('a logged URL does not start a tunnel before HTTP is ready', async (t) => {
  const cwd = fixture(t);
  const port = await availablePort();
  const script = `console.log('http://127.0.0.1:${port}'); setInterval(() => {}, 1000);`;
  await assert.rejects(
    publish(command(cwd, '-e', [script]), options({ startupTimeoutMs: 500 }), provider()),
    /No HTTP response/,
  );
  assert.equal(existsSync(path.join(cwd, 'tunnel-target')), false);
});

test('an already aborted session does not start an application or tunnel', async (t) => {
  const cwd = fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await publish(command(cwd, 'app.cjs'), options({ signal: controller.signal }), provider()),
    130,
  );
  assert.equal(existsSync(path.join(cwd, 'app-port')), false);
  assert.equal(existsSync(path.join(cwd, 'tunnel-target')), false);
});

test('a normal app exit after sharing stops the tunnel and returns zero', {
  timeout: 15000,
}, async (t) => {
  const cwd = fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const result = await publish(
    command(cwd, 'app.cjs'),
    options({
      signal: controller.signal,
      onPublicUrl() {
        const port = Number(readFileSync(path.join(cwd, 'app-port'), 'utf8'));
        http
          .get(`${localTarget(port)}/shutdown`, (response) => response.resume())
          .once('error', () => controller.abort());
      },
    }),
    provider(),
  );
  assert.equal(result, 0);
  await assertClosed(Number(readFileSync(path.join(cwd, 'tunnel-port'), 'utf8')));
});

test('a failing provider parser cleans up the app and tunnel instead of crashing', async (t) => {
  const cwd = fixture(t);
  await assert.rejects(
    publish(
      command(cwd, 'app.cjs'),
      options(),
      provider({
        findPublicUrl() {
          throw new Error('Provider parser failed.');
        },
      }),
    ),
    /Provider parser failed/,
  );
  for (const file of ['app-port', 'tunnel-port']) {
    await assertClosed(Number(readFileSync(path.join(cwd, file), 'utf8')));
  }
});
