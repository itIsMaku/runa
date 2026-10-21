import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const preferredNames = ['dev', 'start', 'serve', 'run', 'up', 'watch'];
const own = (object, key) => Object.hasOwn(object, key);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

export function detect(directory, platform = process.platform) {
  const cwd = path.resolve(directory);
  const has = (file) => existsSync(path.join(cwd, file));
  const read = (file) => readFileSync(path.join(cwd, file), 'utf8');
  const candidates = [];
  let configuredDefault;
  const add = (kind, source, name, bin, args, priority, description = '') => {
    candidates.push({ id: `${kind}:${name}`, name, source, bin, args, priority, description });
  };

  if (has('.runany.json')) {
    const config = readJson(path.join(cwd, '.runany.json'));
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        !config.commands || typeof config.commands !== 'object' || Array.isArray(config.commands)) {
      throw new Error('.runany.json must contain a commands object.');
    }
    for (const [name, value] of Object.entries(config.commands)) {
      if (!name || !Array.isArray(value) || !value.length ||
          value.some((part) => typeof part !== 'string' || part.includes('\0')) || !value[0]) {
        throw new Error(`.runany.json: command "${name}" must be a nonempty array of strings.`);
      }
      add('config', '.runany.json', name, value[0], value.slice(1), 0);
    }
    if (config.default !== undefined) {
      if (typeof config.default !== 'string' || !own(config.commands, config.default)) {
        throw new Error('.runany.json: default must name one of its commands.');
      }
      configuredDefault = `config:${config.default}`;
    }
  }

  if (has('package.json')) {
    const pkg = readJson(path.join(cwd, 'package.json'));
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
      throw new Error('package.json must contain an object.');
    }
    let manager = typeof pkg.packageManager === 'string'
      ? /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager)?.[1] : undefined;
    manager ??= [
      ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'],
    ].find(([file]) => has(file))?.[1] ?? 'npm';
    if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
      for (const [name, script] of Object.entries(pkg.scripts)) {
        if (typeof script !== 'string' || !script.trim() || name.startsWith('-')) continue;
        add(manager, 'package.json', name, manager, ['run', name], 10, script);
      }
    }
  }

  const makefile = ['GNUmakefile', 'makefile', 'Makefile'].find(has);
  if (makefile) {
    const seen = new Set();
    // Static targets only: never evaluate a Makefile during discovery.
    for (const line of read(makefile).replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
      const match = /^([^\s#:=][^:=]*?)\s*:(?!=)(.*)$/.exec(line);
      if (!match) continue;
      for (const target of match[1].trim().split(/\s+/)) {
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.\/-]*$/.test(target) || seen.has(target)) continue;
        seen.add(target);
        const description = /##\s*(.+)$/.exec(match[2])?.[1] ?? '';
        add('make', makefile, target, 'make', [target], 20, description);
      }
    }
  }

  const compose = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'].find(has);
  if (compose) {
    add('compose', compose, 'up', 'docker', ['compose', '-f', compose, 'up'], 30);
    add('compose', compose, 'down', 'docker', ['compose', '-f', compose, 'down'], 30);
    add('compose', compose, 'logs', 'docker', ['compose', '-f', compose, 'logs', '--follow'], 30);
  }

  const python = platform === 'win32'
    ? (has('.venv/Scripts/python.exe') ? [path.join(cwd, '.venv/Scripts/python.exe')] : ['py', '-3'])
    : (has('.venv/bin/python') ? [path.join(cwd, '.venv/bin/python')] : ['python3']);
  if (has('manage.py')) {
    add('python', 'manage.py', 'dev', python[0], [...python.slice(1), 'manage.py', 'runserver'], 40);
    add('python', 'manage.py', 'test', python[0], [...python.slice(1), 'manage.py', 'test'], 40);
  } else {
    const entry = ['main.py', 'app.py'].find(has);
    if (entry) add('python', entry, 'run', python[0], [...python.slice(1), entry], 40);
  }

  if (has('Cargo.toml')) {
    if (has('src/main.rs') || /^\s*\[\[bin\]\]/m.test(read('Cargo.toml'))) {
      add('cargo', 'Cargo.toml', 'run', 'cargo', ['run'], 40);
    }
    for (const name of ['test', 'build', 'check']) add('cargo', 'Cargo.toml', name, 'cargo', [name], 40);
  }
  if (has('go.mod')) {
    // A library is not runnable just because it has a go.mod.
    if (readdirSync(cwd).some((file) => file.endsWith('.go') && !file.endsWith('_test.go') &&
        /^\s*package\s+main\b/m.test(read(file)))) {
      add('go', 'go.mod', 'run', 'go', ['run', '.'], 40);
    }
    add('go', 'go.mod', 'test', 'go', ['test', './...'], 40);
    add('go', 'go.mod', 'build', 'go', ['build', './...'], 40);
  }
  for (const file of readdirSync(cwd).filter((file) => /\.(csproj|fsproj)$/.test(file))) {
    if (/<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(read(file)) ||
        /Sdk=["']Microsoft\.NET\.Sdk\.Web["']/i.test(read(file))) {
      add('dotnet', file, `run-${path.parse(file).name}`, 'dotnet', ['run', '--project', file], 40);
    }
    add('dotnet', file, `build-${path.parse(file).name}`, 'dotnet', ['build', file], 40);
    add('dotnet', file, `test-${path.parse(file).name}`, 'dotnet', ['test', file], 40);
  }

  // A specific entry point is runnable even if its name is not literally "run".
  const defaultScore = (candidate) => {
    if (candidate.id === configuredDefault) return -1;
    const index = preferredNames.indexOf(candidate.name);
    if (index >= 0) return candidate.priority * 10 + index;
    if (candidate.id.startsWith('dotnet:run-')) return candidate.priority * 10 + 3;
    return Infinity;
  };
  candidates.sort((a, b) => defaultScore(a) - defaultScore(b) ||
    a.priority - b.priority || a.id.localeCompare(b.id));
  const best = candidates[0];
  const defaultId = best && Number.isFinite(defaultScore(best)) &&
    candidates.filter((item) => defaultScore(item) === defaultScore(best)).length === 1 ? best.id : undefined;
  return { cwd, candidates, defaultId };
}

export function select(project, requested) {
  if (requested) {
    const exact = project.candidates.find((candidate) => candidate.id === requested);
    if (exact) return exact;
    const matches = project.candidates.filter((candidate) => candidate.name === requested);
    // Explicit configuration overrides ecosystem tasks of the same name.
    const configured = matches.find((candidate) => candidate.id.startsWith('config:'));
    if (configured) return configured;
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Task "${requested}" is ambiguous. Use ${matches.map((item) => item.id).join(' or ')}.`);
    throw new Error(`Unknown task "${requested}". Run runa --list to see available tasks.`);
  }
  return project.candidates.find((candidate) => candidate.id === project.defaultId);
}
