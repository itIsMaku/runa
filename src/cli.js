import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { detect, select } from './detect.js';
import { execute, formatCommand, run } from './process.js';

const help = `runa — discover and run a project's tasks

Usage: runa [task | runner:task] [options] [-- arguments...]

  runa                         Run the detected dev/start/serve/run/up task
  runa test                    Run a named task
  runa make:dev                Choose a specific runner
  runa -- --port 3000           Forward arguments to the default task

Options:
  --list, -l                   List discovered tasks without executing them
  --dry-run                    Print the command without executing it
  --choose                     Choose a task interactively
  --cwd <directory>, -C <dir>   Use a different project directory
  --json                       Machine-readable output (with --list/--dry-run)
  --help, -h                   Show help
  --version, -v                Show version

Config: .runany.json with "default" and "commands" (arrays of executable + args).
Runs in the selected directory; never searches parent directories.
`;

function parse(argv) {
  const options = { cwd: process.cwd(), extra: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { options.extra = argv.slice(index + 1); break; }
    if (['--help', '-h'].includes(arg)) options.help = true;
    else if (['--version', '-v'].includes(arg)) options.version = true;
    else if (['--list', '-l'].includes(arg)) options.list = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--choose') options.choose = true;
    else if (arg === '--json') options.json = true;
    else if (['--cwd', '-C'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a directory.`);
      options.cwd = value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}". Put task arguments after --.`);
    else if (!options.task) options.task = arg;
    else throw new Error(`Unexpected argument "${arg}". Put task arguments after --.`);
  }
  if (options.json && !options.list && !options.dryRun) throw new Error('--json requires --list or --dry-run.');
  return options;
}

function printTasks(project) {
  for (const candidate of project.candidates) {
    const marker = candidate.id === project.defaultId ? '*' : ' ';
    console.log(`${marker} ${candidate.id.padEnd(25)} ${formatCommand(candidate.bin, candidate.args)}`);
    if (candidate.description) console.log(`    ${candidate.description.replace(/[\r\n\x1b]/g, ' ')}`);
  }
}

export async function main(argv) {
  const options = parse(argv);
  if (options.help) { console.log(help); return 0; }
  if (options.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  const project = detect(options.cwd);
  if (options.list) {
    if (options.json) console.log(JSON.stringify(project, null, 2));
    else if (!project.candidates.length) console.log('No supported tasks found. Add .runany.json to define a command.');
    else printTasks(project);
    return 0;
  }
  if (!project.candidates.length) throw new Error('No supported tasks found. Add .runany.json or run runa --help.');
  let candidate = select(project, options.task);
  if (options.choose || !candidate) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('No unambiguous default task. Run runa --list and specify a task explicitly.');
    }
    printTasks(project);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await input.question('Task (runner:task, empty to cancel): ')).trim();
      if (!answer) return 0;
      candidate = select(project, answer);
    } finally { input.close(); }
  }
  const command = execute(candidate, options.extra, project.cwd);
  if (options.json) console.log(JSON.stringify(command, null, 2));
  else console[options.dryRun ? 'log' : 'error'](`runa: ${candidate.source} → ${formatCommand(command.bin, command.args)}`);
  return options.dryRun ? 0 : run(command);
}
