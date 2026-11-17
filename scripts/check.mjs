// Verificação rápida: sintaxe de todos os ficheiros JavaScript do repositório (sem node_modules nem gerados).
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const skip = new Set(['node_modules', 'dist', 'vendor', '.git']);

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* jsFiles(full);
    else if (/\.(c|m)?js$/.test(name)) yield full;
  }
}

let failures = 0;
for (const file of jsFiles(root)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    console.error(`✗ ${relative(root, file)}\n${error.stderr}`);
  }
}
console.log(failures ? `${failures} ficheiro(s) com erros` : 'Sintaxe OK');
process.exit(failures ? 1 : 0);
