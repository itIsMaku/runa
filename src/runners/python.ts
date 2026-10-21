import path from 'node:path';
import type { Runner } from '../types.js';

export const pythonRunner: Runner = {
  id: 'python',
  priority: 40,
  detect(context) {
    const local = context.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
    const bin = context.has(local)
      ? path.join(context.cwd, local)
      : context.platform === 'win32'
        ? 'py'
        : 'python3';
    const prefix = bin === 'py' ? ['-3'] : [];
    if (context.has('manage.py')) {
      return [
        { name: 'dev', source: 'manage.py', bin, args: [...prefix, 'manage.py', 'runserver'] },
        { name: 'test', source: 'manage.py', bin, args: [...prefix, 'manage.py', 'test'] },
      ];
    }
    const source = ['main.py', 'app.py'].find((file) => context.has(file));
    return source ? [{ name: 'run', source, bin, args: [...prefix, source] }] : [];
  },
};
