// build.mjs — bundle wallet-core.mjs (ethers + ../lib/keyvault) into a single classic script the popup
// loads. The background + content + inpage scripts need NO bundling (background is an ESM service worker
// importing only the dep-free request-router.mjs; content/inpage are plain JS). So this is the one build step.
//
//   node build.mjs           → writes wallet-core.bundle.js next to popup.html
//
// Requires esbuild (already a dep of the akasha app). Run from akasha/extension/.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'wallet-core.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: join(here, 'wallet-core.bundle.js'),
  legalComments: 'none',
});

console.log('built wallet-core.bundle.js');
