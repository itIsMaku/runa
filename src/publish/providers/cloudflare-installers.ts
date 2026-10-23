import os from 'node:os';
import path from 'node:path';
import type { ProviderInstaller } from '../types.js';

export const cloudflareInstallers: readonly ProviderInstaller[] = [
  {
    id: 'homebrew',
    platforms: ['darwin', 'linux'],
    checkCommand: (cwd) => ({ bin: 'brew', args: ['--version'], cwd }),
    installCommand: (cwd) => ({ bin: 'brew', args: ['install', 'cloudflared'], cwd }),
    pathEntries: () => [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      path.join(os.homedir(), '.linuxbrew/bin'),
    ],
  },
  {
    id: 'winget',
    platforms: ['win32'],
    checkCommand: (cwd) => ({ bin: 'winget', args: ['--version'], cwd }),
    installCommand: (cwd) => ({
      bin: 'winget',
      args: ['install', '--id', 'Cloudflare.cloudflared', '--exact', '--source', 'winget'],
      cwd,
    }),
    pathEntries: () => [
      ...(process.env.LOCALAPPDATA
        ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')]
        : []),
      ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter((directory): directory is string => Boolean(directory))
        .map((directory) => path.join(directory, 'cloudflared')),
    ],
  },
];
