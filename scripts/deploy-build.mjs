/** Builds the game into docs/, which GitHub Pages serves directly. */
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

await rm('docs', { recursive: true, force: true });
await mkdir('docs', { recursive: true });

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2022'],
  outfile: 'docs/bundle.js',
});

await cp('public', 'docs', { recursive: true });
// Stops Pages running the files through Jekyll.
await writeFile('docs/.nojekyll', '');
console.log('built -> docs/ (GitHub Pages)');
