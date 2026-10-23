import type { TunnelProvider } from '../types.js';
import { cloudflareInstallers } from './cloudflare-installers.js';

export const cloudflare: TunnelProvider = {
  id: 'cloudflare',
  installHint:
    'Install cloudflared: https://developers.cloudflare.com/tunnel/downloads/ (macOS: brew install cloudflared).',
  installers: cloudflareInstallers,
  checkCommand: (cwd) => ({ bin: 'cloudflared', args: ['--version'], cwd }),
  createCommand: (target, cwd) => ({
    bin: 'cloudflared',
    args: [
      'tunnel',
      '--no-autoupdate',
      '--url',
      target,
      '--http-host-header',
      new URL(target).host,
    ],
    cwd,
  }),
  findPublicUrl: (output) =>
    /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[/\s]|$)/i.exec(output)?.[0],
};
