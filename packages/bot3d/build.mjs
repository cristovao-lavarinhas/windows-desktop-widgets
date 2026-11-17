// Gera um bundle IIFE (window.Bot3DLib) e copia-o para o renderer de cada widget.
// Os renderers correm em sandbox com CSP "script-src 'self'", por isso o bot tem de ser um ficheiro local.
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, 'dist', 'bot3d.js');
const targets = ['todo', 'claude-usage'].map((widget) =>
  join(here, '..', '..', 'widgets', widget, 'src', 'renderer', 'vendor', 'bot3d.js'));

await build({
  entryPoints: [join(here, 'src', 'bot3d.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'Bot3DLib',
  target: 'chrome130',
  outfile: output,
  legalComments: 'eof',
});

for (const target of targets) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(output, target);
}
console.log(`bot3d: ${targets.length} cópias geradas`);
