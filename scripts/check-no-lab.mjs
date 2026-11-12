// Release guard: lab pages are throwaway test harnesses and must never ship.
//   RELEASE=1 node scripts/check-no-lab.mjs     (npm run check:no-lab)
// With RELEASE=1 it fails (exit 1) if any src/pages/lab-* exists. Without RELEASE=1 it only reports
// what it found and exits 0, and says plainly that nothing was enforced.
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const pages = new URL('../src/pages/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const labs = existsSync(pages) ? (await readdir(pages)).filter((n) => /^lab-/i.test(n)) : [];
const release = process.env.RELEASE === '1';

if (release && labs.length) {
  console.log(`FAIL: RELEASE=1 and ${labs.length} lab page(s) exist:\n- ${labs.map((n) => 'src/pages/' + n).join('\n- ')}\nDelete them before a release build.`);
  process.exit(1);
}
if (release) console.log('ok: RELEASE=1 and no src/pages/lab-* exists');
else console.log(`SKIP: RELEASE is not 1, so nothing is enforced (${labs.length ? 'lab pages present: ' + labs.join(', ') : 'no lab pages present'})`);
