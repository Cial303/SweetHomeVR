// Scripted VR session in headless Chromium using Meta's WebXR emulator (IWER):
// enter VR, point at the model, rotate/zoom, jump in at 1:1, come back, use
// the menu, grab and move the model, exit. Screenshots go to test-output/xr-*.png.
//   npm run xr-test             (uses the first private fixture, else userGuideExample)
//   npm run xr-test -- tests/fixtures/SweetHome3DExample.sh3d

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './serve.js';

const root = path.resolve(import.meta.dirname, '..');
const privateDir = path.join(root, 'tests/fixtures/private');
const fixture = process.argv[2] || (fs.existsSync(privateDir) && fs.readdirSync(privateDir).find((f) => f.endsWith('.sh3d'))
	? `tests/fixtures/private/${fs.readdirSync(privateDir).find((f) => f.endsWith('.sh3d'))}` : 'tests/fixtures/userGuideExample.sh3d');
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });

const server = await startServer(8129);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Install the emulated Quest 2 before the app runs.
await page.addInitScript({ path: path.join(root, 'node_modules/iwer/build/iwer.min.js') });
await page.addInitScript(() => {
	const d = new IWER.XRDevice(IWER.metaQuest2);
	d.stereoEnabled = false; // one view, so screenshots are easy to read
	d.installRuntime({ forceInstall: true });
	window.__device = d;
});

let step = 0;
const results = [];
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `xr-${String(++step).padStart(2, '0')}-${name}.png`) }); };
const frames = (n = 10) => page.waitForTimeout(n * 20);

/** Points a controller from `from` at `to` (world metres, local-floor space). */
const aim = (hand, from, to) => page.evaluate(async ({ hand, from, to }) => {
	const THREE = await import('three');
	const c = window.__device.controllers[hand];
	const dir = new THREE.Vector3(...to).sub(new THREE.Vector3(...from)).normalize();
	const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
	c.position.set(...from);
	c.quaternion.set(q.x, q.y, q.z, q.w);
}, { hand, from, to });
const button = (hand, id, v) => page.evaluate(({ hand, id, v }) => window.__device.controllers[hand].updateButtonValue(id, v), { hand, id, v });
const click = async (hand, id) => { await button(hand, id, 1); await frames(4); await button(hand, id, 0); await frames(4); };
const stick = (hand, x, y) => page.evaluate(({ hand, x, y }) => window.__device.controllers[hand].updateAxes('thumbstick', x, y), { hand, x, y });
const state = () => page.evaluate(() => {
	const x = window.__svr.xr;
	return { mode: x.mode, presenting: window.__svr.renderer.xr.isPresenting, yaw: x.doll.yaw, zoom: x.doll.zoom, pos: x.doll.pos.toArray(),
		marker: x.markers.some((m) => m.visible), rig: x.rig.position.toArray(), ceilings: x.model?.layers.ceilings.visible, hover: x.panel.hover, anchorScale: x.anchor.scale.x };
});
/** World position of a menu button's centre. */
const menuPoint = (id) => page.evaluate(async (id) => {
	const THREE = await import('three');
	const p = window.__svr.xr.panel;
	const r = p.rects().find((b) => b.id === id);
	const u = (r.x + r.w / 2) / p.size.w, v = 1 - (r.y + r.h / 2) / p.size.h;
	const g = p.mesh.geometry.parameters;
	const local = new THREE.Vector3((u - 0.5) * g.width, (v - 0.5) * g.height, 0);
	return p.mesh.localToWorld(local).toArray();
}, id);

console.log(`Fixture: ${fixture}`);
await page.goto(`http://localhost:8129/?test&model=${encodeURIComponent(fixture)}`);
check('model loads', await page.evaluate(() => window.__svr.ready));
const enterVR = page.locator('#xr-buttons button', { hasText: 'Enter VR' });
check('Enter VR button shown', await enterVR.count() === 1);
check('Enter AR button shown', await page.locator('#xr-buttons button', { hasText: 'Enter AR' }).count() === 1);

// Head 1.6 m up, looking slightly down at the pedestal.
await page.evaluate(() => {
	const d = window.__device;
	d.position.set(0, 1.6, 0);
	const a = -0.45; d.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2));
});
await aim('right', [0.25, 1.1, -0.25], [0.6, 1.1, -1.5]); // pointing away from everything
await aim('left', [-0.25, 1.1, -0.25], [-0.6, 0.5, -1.5]);
await enterVR.click();
await frames(30);
let s = await state();
check('enters VR dollhouse', s.presenting && s.mode === 'dollhouse', JSON.stringify(s.mode));
await shot('dollhouse');

// Point at the model: marker appears.
await aim('right', [0.25, 1.1, -0.25], [0.05, 0.9, -1.0]);
await frames(10);
s = await state();
check('marker shows when pointing at the model', s.marker);
await shot('pointing');

// Thumbstick right rotates, forward zooms in.
const yaw0 = s.yaw;
await stick('right', 1, 0); await frames(25); await stick('right', 0, 0); await frames(3);
s = await state();
check('thumbstick rotates', Math.abs(s.yaw - yaw0) > 0.2, `yaw ${yaw0.toFixed(2)} -> ${s.yaw.toFixed(2)}`);
await stick('right', 0, -1); await frames(25); await stick('right', 0, 0); await frames(3);
s = await state();
check('thumbstick zooms', s.zoom > 1.2 && s.zoom <= 4, `zoom ${s.zoom.toFixed(2)}`);
await shot('rotated-zoomed');
await stick('right', 0, 1); await frames(25); await stick('right', 0, 0); await frames(3);

// Grip and move the controller: the model follows.
const pos0 = (await state()).pos;
await aim('left', [-0.2, 1.0, -0.4], [-0.2, 0.8, -1.4]);
await frames(3);
await button('left', 'squeeze', 1); await frames(4);
await aim('left', [0.1, 1.15, -0.4], [0.1, 0.95, -1.4]); await frames(8);
await button('left', 'squeeze', 0); await frames(4);
s = await state();
check('grip moves the model', Math.hypot(s.pos[0] - pos0[0], s.pos[1] - pos0[1]) > 0.2, `${pos0.map((v) => v.toFixed(2))} -> ${s.pos.map((v) => v.toFixed(2))}`);
await shot('moved');

// Menu: Recentre puts it back, Ceilings toggles.
await aim('left', [-0.25, 1.1, -0.25], [-0.6, 0.5, -1.5]);
let mp = await menuPoint('recentre');
await aim('right', [0.1, 1.2, -0.1], mp); await frames(5);
s = await state();
check('laser hovers the menu', s.hover === 'recentre', `hover=${s.hover}`);
await shot('menu-hover');
await click('right', 'trigger');
s = await state();
check('Recentre resets the model', Math.abs(s.pos[0]) < 1e-6 && Math.abs(s.yaw) < 1e-6 && s.zoom === 1);
mp = await menuPoint('ceilings');
await aim('right', [0.1, 1.2, -0.1], mp); await frames(5);
const c0 = (await state()).ceilings;
await click('right', 'trigger');
check('Ceilings toggles', (await state()).ceilings === !c0);
await click('right', 'trigger'); // back on

// Trigger on the model: jump in at 1:1.
await aim('right', [0.25, 1.1, -0.25], [0.05, 0.9, -1.0]); await frames(6);
await click('right', 'trigger');
s = await state();
check('trigger on model enters 1:1', s.mode === 'walk' && s.anchorScale === 1, JSON.stringify(s.rig.map((v) => +v.toFixed(2))));
await page.evaluate(() => { const d = window.__device; d.quaternion.set(0, 0, 0, 1); });
await aim('right', [0.25, 1.1, -0.25], [0.6, 1.1, -1.5]);
await frames(10);
await shot('walk-trigger');

// B returns to the dollhouse.
await click('right', 'b-button');
s = await state();
check('B returns to dollhouse', s.mode === 'dollhouse' && s.rig.every((v) => v === 0));

// Walk in (observer camera).
await page.evaluate(() => { const d = window.__device; const a = -0.45; d.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); });
mp = await menuPoint('walk');
await aim('right', [0.1, 1.2, -0.1], mp); await frames(5);
await click('right', 'trigger');
s = await state();
check('Walk in enters 1:1', s.mode === 'walk' && s.anchorScale === 1, JSON.stringify({ rig: s.rig.map((v) => +v.toFixed(2)), obs: await page.evaluate(() => window.__svr.xr.model.observer), cam: await page.evaluate(() => window.__svr.xr.camera.position.toArray().map((v) => +v.toFixed(2))) }));
await page.evaluate(() => { const d = window.__device; d.quaternion.set(0, 0, 0, 1); });
await aim('right', [0.25, 1.1, -0.25], [0.6, 1.1, -1.5]);
await frames(10);
await shot('walk-in-observer');
await click('left', 'y-button');
check('Y returns to dollhouse', (await state()).mode === 'dollhouse');

// Exit.
await page.evaluate(() => { const d = window.__device; const a = -0.45; d.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); });
mp = await menuPoint('exit');
await aim('right', [0.1, 1.2, -0.1], mp); await frames(5);
s = await state();
check('laser hovers Exit', s.hover === 'exit', `hover=${s.hover}`);
await click('right', 'trigger');
await frames(10);
s = await state();
check('Exit ends the session', !s.presenting);
await shot('back-to-2d');

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
await browser.close();
server.close();
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
