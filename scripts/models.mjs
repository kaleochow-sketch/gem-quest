// Rebuilds the 3D models: runs each Blender script in scripts/blender/
// headless and writes public/models/<name>.glb.
//   npm run models            (all)
//   npm run models -- dog     (scripts whose name contains "dog")
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

const BLENDER =
  process.env.BLENDER ??
  ['/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/snap/bin/blender'].find((p) => existsSync(p)) ??
  'blender';
const only = process.argv[2];
mkdirSync('public/models', { recursive: true });

for (const file of readdirSync('scripts/blender').filter((f) => f.endsWith('.py') && !f.startsWith('_'))) {
  const name = file.replace(/\.py$/, '');
  if (only && !name.includes(only)) continue;
  console.log(`blender: ${name}`);
  execFileSync(BLENDER, ['-b', '--factory-startup', '-noaudio', '-P', `scripts/blender/${file}`, '--', `public/models/${name}.glb`], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
console.log('models -> public/models/');
