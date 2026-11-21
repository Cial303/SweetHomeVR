// Compares the screenshots of two runs of scripts/xr-test.js, by name (step
// numbers shift when a shot is skipped). Decodes the images in headless
// Chromium, so no image library is needed. Changed pixels are painted red
// into diff-<name>.png in the second folder.
//   node scripts/xr-compare.js test-output/before test-output/after
// Run both with XR_STEADY=1 (see scripts/xr-test.js), on the same machine.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) { console.log('usage: node scripts/xr-compare.js <dirA> <dirB>'); process.exit(2); }
// Shots taken after walking with the stick: frame timing moves you a little. Reported, looked at by eye.
const LOOSE = /-(walk-menu|height-1\.4|walk-solid-wall)\./;
const TOLERANCE = 24; // per channel, out of 255
const SHARE = 0.001; // at most 0.1% of the pixels may differ
const files = (d) => new Map(fs.readdirSync(d).filter((f) => /^xr-\d+-.*\.png$/.test(f) || f === 'xr-photo.jpg').map((f) => [f.replace(/^xr-\d+-/, ''), f]));
const A = files(dirA), B = files(dirB);
const url = (d, f) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${fs.readFileSync(path.join(d, f)).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();
let fail = 0;
for (const [name, fa] of A) {
	const fb = B.get(name);
	if (!fb) { console.log(`MISSING  ${name}`); fail++; continue; }
	const r = await page.evaluate(async ([a, b, tol]) => {
		const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
		const [ia, ib] = await Promise.all([load(a), load(b)]);
		if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
		const pixels = (i) => { const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height); };
		const pa = pixels(ia).data, img = pixels(ib), pb = img.data;
		let n = 0, max = 0;
		for (let k = 0; k < pa.length; k += 4) {
			const e = Math.max(Math.abs(pa[k] - pb[k]), Math.abs(pa[k + 1] - pb[k + 1]), Math.abs(pa[k + 2] - pb[k + 2]));
			if (e > max) max = e;
			if (e > tol) { n++; pb[k] = 255; pb[k + 1] = pb[k + 2] = 0; }
		}
		if (!n) return { share: 0, max };
		const c = new OffscreenCanvas(ia.width, ia.height);
		c.getContext('2d').putImageData(img, 0, 0);
		const blob = await c.convertToBlob({ type: 'image/png' });
		const diff = await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(blob); });
		return { share: n / (pa.length / 4), max, diff };
	}, [url(dirA, fa), url(dirB, fb), TOLERANCE]);
	const loose = LOOSE.test(fa), ok = !r.size && r.share <= SHARE;
	if (!ok && !loose) fail++;
	if (r.diff) fs.writeFileSync(path.join(dirB, `diff-${name.replace(/\.jpg$/, '.png')}`), Buffer.from(r.diff.split(',')[1], 'base64'));
	console.log(`${ok ? 'SAME ' : loose ? 'LOOSE' : 'DIFF '}  ${name}  ${r.size ?? `${(r.share * 100).toFixed(3)}% pixels, max ${r.max}`}`);
}
for (const name of B.keys()) if (!A.has(name)) console.log(`NEW      ${name}`);
await browser.close();
process.exitCode = fail ? 1 : 0;
