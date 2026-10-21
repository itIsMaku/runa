import path from 'node:path';
import type { Runner, Task } from '../types.js';

export const dotnetRunner: Runner = {
  id: 'dotnet',
  priority: 40,
  detect(context) {
    const tasks: Task[] = [];
    for (const source of context.files.filter((file) => /\.(csproj|fsproj)$/.test(file))) {
      const project = path.parse(source).name;
      const content = context.read(source);
      if (
        /<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(content) ||
        /Sdk=["']Microsoft\.NET\.Sdk\.Web["']/i.test(content)
      ) {
        tasks.push({
          name: `run-${project}`,
          source,
          bin: 'dotnet',
          args: ['run', '--project', source],
          defaultRank: 3,
        });
      }
      for (const command of ['build', 'test']) {
        tasks.push({
          name: `${command}-${project}`,
          source,
          bin: 'dotnet',
          args: [command, source],
        });
      }
    }
    return tasks;
  },
};
