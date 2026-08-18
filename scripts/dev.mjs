import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2022'],
  outfile: 'dist/bundle.js',
});

await ctx.watch();
const { host, port } = await ctx.serve({ servedir: 'dist', host: '0.0.0.0', port: 5178 });
console.log(`Gem Quest dev server: http://${host}:${port}`);
