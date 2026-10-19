// Small web variants of the brand images, made from the committed masters with sharp.
//   node scripts/build_web_assets.mjs
// - public/brand/velvet-phone.webp: the velvet for portrait phones, 1080w and 80 KB or less.
//   A 9:16 crop from the centre of velvet-4k.webp (a portrait screen only ever shows the
//   centre of the landscape velvet), so phones get more texture per pixel than the 2560w file
//   gave them, at a fifth of its weight. The texture is near-monochrome, so it is encoded as
//   luminance with its cool cast as a flat tint (free in WebP's chroma planes), at the highest
//   quality that fits the budget.
// - public/brand/r-chrome-160.webp: the header-sized chrome R (15 KB budget).
// sharp writes no EXIF, XMP or ICC unless asked, so the outputs carry no metadata.
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

const BRAND = new URL('../public/brand/', import.meta.url);
const VELVET_BUDGET = 80_000;
const MARK_BUDGET = 15_000;
const TINT = { r: 118, g: 130, b: 160 };

async function velvetPhone() {
  const src = new URL('velvet-4k.webp', BRAND).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const m = await sharp(src).metadata();
  const cw = Math.round((m.height * 9) / 16);
  const left = Math.round((m.width - cw) / 2);
  const encode = (q) =>
    sharp(src)
      .extract({ left, top: 0, width: cw, height: m.height })
      .resize({ width: 1080, kernel: 'mitchell' })
      .grayscale()
      .tint(TINT)
      .webp({ quality: q, effort: 6 })
      .toBuffer({ resolveWithObject: true });
  let lo = 5;
  let hi = 95;
  let best = null;
  while (lo <= hi) {
    const q = (lo + hi) >> 1;
    const out = await encode(q);
    if (out.data.length <= VELVET_BUDGET) {
      best = { q, ...out };
      lo = q + 1;
    } else hi = q - 1;
  }
  if (!best) throw new Error('velvet-phone: nothing fits the budget');
  await writeFile(new URL('velvet-phone.webp', BRAND), best.data);
  console.log(`velvet-phone.webp ${best.info.width}x${best.info.height} q${best.q} ${best.data.length} B`);
}

async function headerMark() {
  const src = new URL('r-chrome-640.webp', BRAND).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const { data, info } = await sharp(src).resize({ width: 160 }).webp({ quality: 88, alphaQuality: 92, effort: 6 }).toBuffer({ resolveWithObject: true });
  if (data.length > MARK_BUDGET) throw new Error(`r-chrome-160: ${data.length} B is over ${MARK_BUDGET}`);
  await writeFile(new URL('r-chrome-160.webp', BRAND), data);
  console.log(`r-chrome-160.webp ${info.width}x${info.height} ${data.length} B`);
}

await velvetPhone();
await headerMark();
