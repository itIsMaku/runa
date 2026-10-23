import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promptForInstall } from '../dist/publish/install-prompt.js';
import { ensureProvider, InstallDeclined } from '../dist/publish/provider-setup.js';

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'runa install with spaces-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const node = (script) => ({ bin: process.execPath, args: ['-e', script], cwd });
  const provider = {
    id: 'fixture',
    installHint: 'Install the fixture tool manually.',
    checkCommand: () =>
      existsSync(path.join(cwd, 'installed'))
        ? node('process.exit(0)')
        : { bin: 'runa-missing-install-tool-123', args: [], cwd },
    installers: [
      {
        id: 'fixture-manager',
        platforms: [process.platform],
        checkCommand: () => node('process.exit(0)'),
        installCommand: () =>
          node('require("node:fs").writeFileSync("installed", "installed after consent")'),
      },
    ],
  };
  return { cwd, node, provider };
}

test('missing tools are installed only after approval and then checked again', async (t) => {
  const { cwd, provider } = fixture(t);
  const messages = [];
  let prompts = 0;
  await ensureProvider(
    provider,
    cwd,
    {
      async confirmInstall(request) {
        prompts++;
        assert.equal(request.tool, 'runa-missing-install-tool-123');
        assert.equal(request.command.bin, process.execPath);
        assert.equal(existsSync(path.join(cwd, 'installed')), false);
        return true;
      },
    },
    new AbortController().signal,
    (text) => messages.push(text),
  );
  assert.equal(prompts, 1);
  assert.equal(readFileSync(path.join(cwd, 'installed'), 'utf8'), 'installed after consent');
  assert.match(messages.join('\n'), /Installing:.*\n.*ready. Continuing/);
});

test('declining installation leaves the tool and application untouched', async (t) => {
  const { cwd, provider } = fixture(t);
  await assert.rejects(
    ensureProvider(
      provider,
      cwd,
      { confirmInstall: async () => false },
      new AbortController().signal,
      () => {},
    ),
    InstallDeclined,
  );
  assert.equal(existsSync(path.join(cwd, 'installed')), false);
});

test('without an approval callback, missing tools fail without invoking installers', async (t) => {
  const { cwd, provider } = fixture(t);
  provider.installers[0].checkCommand = () => {
    throw new Error('Installer should not be checked.');
  };
  await assert.rejects(
    ensureProvider(provider, cwd, {}, new AbortController().signal, () => {}),
    /unavailable.*manually/,
  );
  assert.equal(existsSync(path.join(cwd, 'installed')), false);
});

test('an installed tool that fails its version check is not automatically reinstalled', async (t) => {
  const { cwd, provider, node } = fixture(t);
  provider.checkCommand = () => node('process.exit(2)');
  await assert.rejects(
    ensureProvider(
      provider,
      cwd,
      {
        async confirmInstall() {
          assert.fail('Broken tools must not trigger installation.');
        },
      },
      new AbortController().signal,
      () => {},
    ),
    /unavailable/,
  );
});

test('unavailable package managers keep the manual instructions and never prompt', async (t) => {
  const { cwd, provider } = fixture(t);
  provider.installers[0].checkCommand = () => ({ bin: 'runa-missing-manager-123', args: [], cwd });
  await assert.rejects(
    ensureProvider(
      provider,
      cwd,
      {
        async confirmInstall() {
          assert.fail('No installer is available.');
        },
      },
      new AbortController().signal,
      () => {},
    ),
    /manually.*No supported package manager/,
  );
});

test('failed installation does not continue or claim success', async (t) => {
  const { cwd, provider, node } = fixture(t);
  provider.installers[0].installCommand = () => node('process.exit(5)');
  await assert.rejects(
    ensureProvider(
      provider,
      cwd,
      { confirmInstall: async () => true },
      new AbortController().signal,
      () => {},
    ),
    /Installation failed with code 5/,
  );
  assert.equal(existsSync(path.join(cwd, 'installed')), false);
});

test('a successful installer must make the version check pass', async (t) => {
  const { cwd, provider, node } = fixture(t);
  provider.installers[0].installCommand = () => node('process.exit(0)');
  await assert.rejects(
    ensureProvider(
      provider,
      cwd,
      { confirmInstall: async () => true },
      new AbortController().signal,
      () => {},
    ),
    /Installation finished.*still unavailable/,
  );
});

test('aborting an installation stops it before the application starts', async (t) => {
  const { cwd, provider, node } = fixture(t);
  const controller = new AbortController();
  const reason = new Error('Installation interrupted.');
  provider.installers[0].installCommand = () => node('setInterval(() => {}, 1000)');
  await assert.rejects(
    ensureProvider(provider, cwd, { confirmInstall: async () => true }, controller.signal, () => {
      setTimeout(() => controller.abort(reason), 100);
    }),
    (error) => error === reason,
  );
  assert.equal(existsSync(path.join(cwd, 'installed')), false);
});

async function answerPrompt(t, answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  let written = '';
  let pending = '';
  const queue = [...answers];
  output.on('data', (chunk) => {
    written += chunk;
    pending += chunk;
    if (pending.includes('[y/N]')) {
      pending = '';
      const next = queue.shift();
      setImmediate(() => (next === null ? input.end() : input.write(`${next}\n`)));
    }
  });
  const result = await promptForInstall(
    {
      tool: 'cloudflared',
      command: { bin: 'brew', args: ['install', 'cloudflared'], cwd: process.cwd() },
    },
    new AbortController().signal,
    input,
    output,
  );
  return { result, written };
}

test('install prompt accepts y/yes and displays the exact installer command', async (t) => {
  for (const answer of ['y', ' YES ']) {
    const { result, written } = await answerPrompt(t, [answer]);
    assert.equal(result, true);
    assert.match(written, /brew install cloudflared\? \[y\/N\]/);
  }
});

test('install prompt defaults to no for n, empty input, or EOF', async (t) => {
  for (const answer of ['n', 'NO', '', null]) {
    assert.equal((await answerPrompt(t, [answer])).result, false);
  }
});

test('install prompt repeats for invalid answers', async (t) => {
  const { result, written } = await answerPrompt(t, ['maybe', 'y']);
  assert.equal(result, true);
  assert.match(written, /Please answer y or n/);
});

test('an unanswered install prompt can be aborted without hanging', async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  const controller = new AbortController();
  output.once('data', () => setImmediate(() => controller.abort()));
  await assert.rejects(
    promptForInstall(
      {
        tool: 'cloudflared',
        command: { bin: 'brew', args: ['install', 'cloudflared'], cwd: process.cwd() },
      },
      controller.signal,
      input,
      output,
    ),
  );
});
