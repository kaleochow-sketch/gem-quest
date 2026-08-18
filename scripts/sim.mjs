import * as esbuild from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(join(tmpdir(), 'gemquest-sim-'));
const out = join(dir, 'sim.mjs');
await esbuild.build({
  entryPoints: ['src/tools/sim.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile: out,
});
await import(pathToFileURL(out).href);
await rm(dir, { recursive: true, force: true });
