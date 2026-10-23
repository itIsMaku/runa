import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { detect, select } from './detect.js';
import { execute, formatCommand, run } from './process.js';
import { findTunnelProvider, publish, publishPlan } from './publish/index.js';
import { promptForInstall } from './publish/install-prompt.js';
import { validatePort } from './publish/local-url.js';
import type { Project } from './types.js';

const help = `runa — discover and run a project's tasks

Usage: runa [task | runner:task] [options] [-- arguments...]

  runa                         Run the detected dev/start/serve/run/up task
  runa test                    Run a named task
  runa make:dev                Choose a specific runner
  runa -- --port 3000           Forward arguments to the default task
  runa --publish               Start the app and share it through a public URL

Options:
  --list, -l                   List discovered tasks without executing them
  --dry-run                    Print the command without executing it
  --choose                     Choose a task interactively
  --publish                    Share the app via a temporary Cloudflare tunnel
  --port <port>                Local app port for --publish (otherwise auto-detect)
  --tunnel <provider>           Tunnel provider for --publish (default: cloudflare)
  --cwd <directory>, -C <dir>   Use a different project directory
  --json                       Machine-readable output (with --list/--dry-run)
  --help, -h                   Show help
  --version, -v                Show version

Config: .runany.json with "default" and "commands" (arrays of executable + args).
Runs in the selected directory; never searches parent directories.
`;

interface Options {
  cwd: string;
  extra: string[];
  task?: string;
  help?: boolean;
  version?: boolean;
  list?: boolean;
  dryRun?: boolean;
  choose?: boolean;
  json?: boolean;
  publish?: boolean;
  port?: number;
  tunnel?: string;
}

function parse(argv: readonly string[]): Options {
  const options: Options = { cwd: process.cwd(), extra: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === '--') {
      options.extra = argv.slice(index + 1);
      break;
    }
    if (['--help', '-h'].includes(arg)) {
      options.help = true;
    } else if (['--version', '-v'].includes(arg)) {
      options.version = true;
    } else if (['--list', '-l'].includes(arg)) {
      options.list = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--choose') {
      options.choose = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--publish') {
      options.publish = true;
    } else if (arg === '--port') {
      const value = argv[++index];
      if (value === undefined) {
        throw new Error('--port requires a local application port.');
      }
      options.port = validatePort(value);
    } else if (arg === '--tunnel') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) {
        throw new Error('--tunnel requires a provider name.');
      }
      options.tunnel = value;
    } else if (['--cwd', '-C'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('-')) {
        throw new Error(`${arg} requires a directory.`);
      }
      options.cwd = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}". Put task arguments after --.`);
    } else if (!options.task) {
      options.task = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}". Put task arguments after --.`);
    }
  }
  if (options.json && !options.list && !options.dryRun) {
    throw new Error('--json requires --list or --dry-run.');
  }
  if ((options.port !== undefined || options.tunnel !== undefined) && !options.publish) {
    throw new Error('--port and --tunnel require --publish. Put application arguments after --.');
  }
  if (options.publish && options.list) {
    throw new Error('--publish cannot be combined with --list.');
  }
  return options;
}

function printTasks(project: Project): void {
  for (const candidate of project.candidates) {
    const marker = candidate.id === project.defaultId ? '*' : ' ';
    console.log(
      `${marker} ${candidate.id.padEnd(25)} ${formatCommand(candidate.bin, candidate.args)}`,
    );
    if (candidate.description) {
      const description = candidate.description
        .replace(/[\r\n]/g, ' ')
        .replaceAll(String.fromCharCode(27), ' ');
      console.log(`    ${description}`);
    }
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parse(argv);
  if (options.help) {
    console.log(help);
    return 0;
  }
  if (options.version) {
    console.log(
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    );
    return 0;
  }
  const project = detect(options.cwd);
  if (options.list) {
    if (options.json) {
      console.log(JSON.stringify(project, null, 2));
    } else if (!project.candidates.length) {
      console.log('No supported tasks found. Add .runany.json to define a command.');
    } else {
      printTasks(project);
    }
    return 0;
  }
  if (!project.candidates.length) {
    throw new Error('No supported tasks found. Add .runany.json or run runa --help.');
  }
  let candidate = select(project, options.task);
  if (options.choose || !candidate) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'No unambiguous default task. Run runa --list and specify a task explicitly.',
      );
    }
    printTasks(project);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await input.question('Task (runner:task, empty to cancel): ')).trim();
      if (!answer) {
        return 0;
      }
      candidate = select(project, answer);
    } finally {
      input.close();
    }
  }
  if (!candidate) {
    throw new Error('No task selected.');
  }
  const command = execute(candidate, options.extra, project.cwd);
  const provider = options.publish ? findTunnelProvider(options.tunnel) : undefined;
  if (options.json) {
    const plan = provider
      ? { ...command, publish: publishPlan(options.port, provider, project.cwd) }
      : command;
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console[options.dryRun ? 'log' : 'error'](
      `runa: ${candidate.source} → ${formatCommand(command.bin, command.args)}`,
    );
  }
  if (provider) {
    if (options.dryRun) {
      if (!options.json) {
        const plan = publishPlan(options.port, provider, project.cwd);
        console.log(`runa: Publish via ${plan.provider}: ${plan.target}`);
        if (plan.tunnel) {
          console.log(`runa: ${formatCommand(plan.tunnel.bin, plan.tunnel.args)}`);
        }
      }
      return 0;
    }
    return publish(
      command,
      {
        port: options.port,
        confirmInstall: process.stdin.isTTY && process.stderr.isTTY ? promptForInstall : undefined,
      },
      provider,
    );
  }
  return options.dryRun ? 0 : run(command);
}
