import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Stamps a content hash onto the asset URLs and the service-worker cache
 * name. Without this, a returning player keeps whatever the browser and the
 * service worker cached last time, and a deploy can go unseen for a launch
 * or more.
 */
export async function stampBuild(outDir) {
  const bundle = await readFile(join(outDir, 'bundle.js'), 'utf8');
  const styles = await readFile(join(outDir, 'styles.css'), 'utf8');
  const hash = createHash('sha1').update(bundle).update(styles).digest('hex').slice(0, 10);

  const indexPath = join(outDir, 'index.html');
  let index = await readFile(indexPath, 'utf8');
  index = index
    .replace('href="styles.css"', `href="styles.css?v=${hash}"`)
    .replace('src="bundle.js"', `src="bundle.js?v=${hash}"`);
  await writeFile(indexPath, index);

  const swPath = join(outDir, 'sw.js');
  let sw = await readFile(swPath, 'utf8');
  sw = sw
    .replace(/const VERSION = '[^']+'/, `const VERSION = 'gem-quest-${hash}'`)
    .replace("'styles.css'", `'styles.css?v=${hash}'`)
    .replace("'bundle.js'", `'bundle.js?v=${hash}'`);
  await writeFile(swPath, sw);

  console.log(`stamped build ${hash}`);
  return hash;
}
