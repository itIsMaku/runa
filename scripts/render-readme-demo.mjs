// Build first, then run this script to regenerate the README's PNG preview.
// This optional docs tool requires rsvg-convert (librsvg) on PATH.
// Demo data goes through the real TUI renderer; no project processes or tunnels run.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDashboard } from '../dist/tui/render.js';

process.env.TZ = 'UTC';
const timestamp = Date.UTC(2026, 0, 1, 13, 42);
const processes = [
  {
    id: 'web',
    project: 'storefront',
    cwd: '/projects/storefront',
    task: 'npm:dev',
    command: 'npm run dev',
    status: 'running',
    shareStatus: 'live',
    localUrl: 'http://localhost:5173',
    publicUrl: 'https://runa-demo.trycloudflare.com',
  },
  {
    id: 'api',
    project: 'api',
    cwd: '/projects/api',
    task: 'go:run',
    command: 'go run .',
    status: 'running',
    shareStatus: 'off',
    localUrl: 'http://localhost:8080',
  },
  {
    id: 'worker',
    project: 'worker',
    cwd: '/projects/worker',
    task: 'npm:worker',
    command: 'npm run worker',
    status: 'running',
    shareStatus: 'off',
  },
  {
    id: 'tests',
    project: 'storefront',
    cwd: '/projects/storefront',
    task: 'npm:test',
    command: 'npm run test',
    status: 'exited',
    shareStatus: 'off',
    exitCode: 0,
  },
].map((entry) => ({ ...entry, startedAt: timestamp }));
const output = [
  ['system', 'Started npm run dev'],
  ['stdout', '> storefront@1.0.0 dev'],
  ['stdout', '> vite --host'],
  ['stdout', ''],
  ['stdout', 'VITE  ready in 182 ms'],
  ['stdout', ''],
  ['stdout', 'Local: http://localhost:5173/'],
  ['stdout', '[vite] connected.'],
  ['stdout', '[vite] hmr update /src/App.tsx'],
  ['tunnel', 'Registered tunnel connection'],
  ['system', 'Public URL: https://runa-demo.trycloudflare.com'],
];
const frame = renderDashboard(
  {
    cwd: '/projects/storefront',
    selected: 'web',
    scroll: 0,
    message: 'Started npm:dev.',
    busy: false,
    connected: true,
    snapshot: {
      processes,
      logs: output.map(([stream, text], index) => ({
        sequence: index + 1,
        time: timestamp + index * 1000,
        stream,
        text,
      })),
    },
  },
  120,
  27,
);

const escapeXml = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const colors = {
  39: '#dbe4f0',
  90: '#8794aa',
  91: '#f38ba8',
  92: '#a6e3a1',
  93: '#f9e2af',
  95: '#cba6f7',
  96: '#89dceb',
  97: '#ffffff',
};
const cell = 8.4;
const lineHeight = 17;
const padding = 24;
const top = 72;
const width = 120 * cell + padding * 2;
const height = top + 27 * lineHeight + padding;
const elements = [];
for (const [row, line] of frame.split('\r\n').entries()) {
  let column = 0;
  let foreground = colors[39];
  let background;
  let bold = false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR escapes carry the real renderer's colors.
  for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      for (const code of part.slice(2, -1).split(';').map(Number)) {
        if (code === 0) {
          foreground = colors[39];
          background = undefined;
          bold = false;
        } else if (code === 1) {
          bold = true;
        } else if (colors[code]) {
          foreground = colors[code];
        } else if (code === 44 || code === 45) {
          background = code === 44 ? '#314b7c' : '#7350a2';
        }
      }
      continue;
    }
    const length = Array.from(part).length;
    if (!length) {
      continue;
    }
    const x = padding + column * cell;
    const y = top + row * lineHeight;
    if (background) {
      elements.push(
        `<rect x="${x}" y="${y - 13}" width="${length * cell}" height="${lineHeight}" fill="${background}"/>`,
      );
    }
    // Place glyphs in terminal cells; never stretch padded strings to a textLength.
    for (const [index, character] of Array.from(part).entries()) {
      if (character.trim()) {
        elements.push(
          `<text x="${x + index * cell}" y="${y}" fill="${foreground}"${bold ? ' font-weight="700"' : ''}>${escapeXml(character)}</text>`,
        );
      }
    }
    column += length;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
<title id="title">runa process dashboard</title>
<desc id="description">Demo of the real TUI renderer: three running processes, one completed test task, live storefront logs, and an example public preview URL.</desc>
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" fill="#101722" stroke="#303c50"/>
<path d="M 1 43 H ${width - 1}" stroke="#303c50"/>
<circle cx="24" cy="23" r="5" fill="#f38ba8"/>
<circle cx="42" cy="23" r="5" fill="#f9e2af"/>
<circle cx="60" cy="23" r="5" fill="#a6e3a1"/>
<text x="${width / 2}" y="28" text-anchor="middle" fill="#8794aa" font-family="sans-serif" font-size="13">runa — process dashboard</text>
<g font-family="'DejaVu Sans Mono', 'SFMono-Regular', Consolas, monospace" font-size="14" xml:space="preserve">
${elements.join('\n')}
</g>
</svg>
`;
const directory = new URL('../docs/assets/', import.meta.url);
mkdirSync(directory, { recursive: true });
const destination = new URL('tui.png', directory);
const result = spawnSync('rsvg-convert', ['--zoom', '2'], { input: svg, maxBuffer: 10485760 });
if (result.error || result.status !== 0) {
  throw new Error(
    'Could not render the PNG preview. This optional docs tool requires rsvg-convert (librsvg).',
    {
      cause: result.error ?? new Error(result.stderr.toString()),
    },
  );
}
writeFileSync(destination, result.stdout);
console.log(`Generated ${fileURLToPath(destination)}`);
