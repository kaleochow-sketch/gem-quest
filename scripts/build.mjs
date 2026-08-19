import * as esbuild from 'esbuild';
import { stampBuild } from './stamp.mjs';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'dist/bundle.js',
});

await cp('public', 'dist', { recursive: true });
await stampBuild('dist');
console.log('built -> dist/');
