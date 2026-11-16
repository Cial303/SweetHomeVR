// Scripted VR session in headless Chromium using Meta's WebXR emulator (IWER):
// enter VR, point at the model, rotate/zoom, grab, menu orb and menu, jump in
// at 1:1, walk, snap turn, teleport, walk-mode menu, exit, and re-enter from
// another spot. Screenshots go to test-output/xr-*.png.
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
const THREE_deg = (r) => r * 180 / Math.PI;
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
	const head = x.mode ? x.headWorld().toArray() : null;
	return { mode: x.mode, presenting: window.__svr.renderer.xr.isPresenting, yaw: x.doll.yaw, zoom: x.doll.zoom, pos: x.doll.pos.toArray(),
		marker: x.markers.some((m) => m.visible), rig: x.rig.position.toArray(), rigYaw: x.rig.rotation.y, head,
		ceilings: x.model?.layers.ceilings.visible, menu: x.menu ? Object.keys(x.menus).find((k) => x.menus[k] === x.menu) : null,
		hover: x.menu?.hover ?? null, anchorScale: x.anchor.scale.x, orbScale: x.orb.scale.x, snap: x.snapAngle,
		arc: x.arc.dots.visible, ring: x.arc.ring.visible ? x.arc.ring.position.toArray() : null, valid: x.tele?.result?.valid ?? null,
		stage: [...x.stage.position.toArray(), x.stage.rotation.y] };
});
/** World position of a button's centre on the open menu. */
const menuPoint = (id) => page.evaluate(async (id) => {
	const THREE = await import('three');
	const p = window.__svr.xr.menu;
	const r = p.rects().find((b) => b.id === id);
	const u = (r.x + r.w / 2) / p.size.w, v = 1 - (r.y + r.h / 2) / p.size.h;
	const g = p.mesh.geometry.parameters;
	return p.mesh.localToWorld(new THREE.Vector3((u - 0.5) * g.width, (v - 0.5) * g.height, 0)).toArray();
}, id);
const orbPoint = () => page.evaluate(async () => {
	const THREE = await import('three');
	return window.__svr.xr.orb.getWorldPosition(new THREE.Vector3()).toArray();
});
/** Converts a point in the user's tracking space (where IWER poses live) to the world. */
const toWorld = (p) => page.evaluate((p) => { const x = window.__svr.xr; x.rig.updateMatrixWorld(true); return x.rig.localToWorld(new (x.rig.position.constructor)(...p)).toArray(); }, p);
/** Converts a world point to tracking space, for aiming controllers in walk mode. */
const toLocal = (p) => page.evaluate((p) => { const x = window.__svr.xr; x.rig.updateMatrixWorld(true); return x.rig.worldToLocal(new (x.rig.position.constructor)(...p)).toArray(); }, p);
const lookDown = (a = -0.45) => page.evaluate((a) => { window.__device.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); }, a);
const R = [0.25, 1.1, -0.25], L = [-0.25, 1.0, -0.2];
const restRight = () => aim('right', R, [0.6, 1.1, -1.5]); // pointing at nothing
const clickMenu = async (id) => { await aim('right', R, await toLocal(await menuPoint(id))); await frames(5); await click('right', 'trigger'); };

console.log(`Fixture: ${fixture}`);
await page.goto(`http://localhost:8129/?test&model=${encodeURIComponent(fixture)}`);
check('model loads', await page.evaluate(() => window.__svr.ready));
const enterVR = page.locator('#xr-buttons button', { hasText: 'Enter VR' });
check('Enter VR button shown', await enterVR.count() === 1);
check('Enter AR button shown', await page.locator('#xr-buttons button', { hasText: 'Enter AR' }).count() === 1);

// Head 1.6 m up, looking slightly down at the plinth.
await page.evaluate(() => window.__device.position.set(0, 1.6, 0));
await lookDown();
await restRight();
await aim('left', L, [-0.6, 0.5, -1.5]);
await enterVR.click();
await frames(30);
let s = await state();
check('enters VR dollhouse', s.presenting && s.mode === 'dollhouse', JSON.stringify(s.mode));
check('menu opens once on entry', s.menu === 'dollhouse');
await shot('dollhouse-menu');
await click('right', 'b-button');
check('B closes the menu', (await state()).menu === null);
await shot('dollhouse');

// Point at the model: marker appears.
await aim('right', R, [0.05, 0.9, -1.0]);
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

// The orb over the left hand opens the menu (left hand raised into view).
await aim('left', [-0.12, 1.2, -0.4], [0.1, 0.9, -1.2]);
await frames(3);
await aim('right', R, await orbPoint()); await frames(5);
s = await state();
check('laser highlights the orb', s.orbScale > 1.2, `scale ${s.orbScale.toFixed(2)}`);
await shot('orb-hover');
await click('right', 'trigger');
s = await state();
check('orb click opens the menu', s.menu === 'dollhouse');

// Menu: Recentre puts the model back, Ceilings toggles.
await aim('right', R, await menuPoint('recentre')); await frames(5);
s = await state();
check('laser hovers the menu', s.hover === 'recentre', `hover=${s.hover}`);
await shot('menu-hover');
await click('right', 'trigger');
s = await state();
check('Recentre resets the model', Math.abs(s.pos[0]) < 1e-6 && Math.abs(s.yaw) < 1e-6 && s.zoom === 1 && s.menu === null);
await click('right', 'a-button');
check('A opens the menu', (await state()).menu === 'dollhouse');
const c0 = (await state()).ceilings;
await clickMenu('ceilings');
s = await state();
check('Ceilings toggles and the menu stays open', s.ceilings === !c0 && s.menu === 'dollhouse');
await clickMenu('ceilings'); // back on
await restRight(); await frames(3);
await click('right', 'trigger');
check('clicking elsewhere closes the menu', (await state()).menu === null);

// Trigger on the model: jump in at 1:1.
await aim('right', R, [0.05, 0.9, -1.0]); await frames(6);
await click('right', 'trigger');
s = await state();
check('trigger on model enters 1:1', s.mode === 'walk' && s.anchorScale === 1, JSON.stringify(s.rig.map((v) => +v.toFixed(2))));
await page.evaluate(() => window.__device.quaternion.set(0, 0, 0, 1));
await restRight();
await frames(10);
await shot('walk-trigger');

await click('left', 'y-button');
check('Y returns to dollhouse', (await state()).mode === 'dollhouse');

// Walk in (observer camera) from the menu.
await lookDown();
await click('left', 'x-button');
check('X opens the menu', (await state()).menu === 'dollhouse');
await clickMenu('walk');
s = await state();
check('Walk in enters 1:1', s.mode === 'walk' && s.anchorScale === 1, JSON.stringify({ rig: s.rig.map((v) => +v.toFixed(2)), obs: await page.evaluate(() => window.__svr.xr.model.observer) }));
await page.evaluate(() => window.__device.quaternion.set(0, 0, 0, 1));
await restRight();
await frames(10);
await shot('walk-in-observer');


let h0;
// Right stick forward: teleport arc to the floor ahead; release to go there.
await aim('right', R, [0.25, 0, -1.0]); // steeply down: lands about 1 m ahead
await lookDown(-0.6);
await stick('right', 0, -1); await frames(8);
s = await state();
check('teleport arc shows a valid landing', s.arc && s.ring && s.valid === true, JSON.stringify({ arc: s.arc, ring: s.ring, valid: s.valid }));
await shot('teleport-arc');
const land = s.ring;
h0 = s.head;
await stick('right', 0, 0); await frames(25);
s = await state();
check('teleport moves you to the ring', s.head && Math.hypot(s.head[0] - land[0], s.head[2] - land[2]) < 0.05 && Math.abs(s.rig[1] - land[1]) < 0.05,
	`landed ${land.map((v) => v.toFixed(2))}, head ${s.head.map((v) => v.toFixed(2))}, feet ${s.rig[1].toFixed(2)}`);
check('arc hides after teleport', !s.arc);
await page.evaluate(() => window.__device.quaternion.set(0, 0, 0, 1));
await restRight();
await frames(5);
await shot('teleported');

// Left stick forward: walk about 1.5 m/s where the head looks.
h0 = (await state()).head;
await stick('left', 0, -1); await frames(40); await stick('left', 0, 0); await frames(3);
s = await state();
const walked = Math.hypot(s.head[0] - h0[0], s.head[2] - h0[2]);
check('left stick walks', walked > 0.4 && walked < 2.5, `${walked.toFixed(2)} m`);
await shot('walked');

// Right stick right: one snap turn.
const ry0 = s.rigYaw;
h0 = s.head;
await stick('right', 1, 0); await frames(15); await stick('right', 0, 0); await frames(5);
s = await state();
const turned = THREE_deg(ry0 - s.rigYaw);
check('right stick snap-turns 30°', Math.abs(turned - 30) < 0.5 && Math.hypot(s.head[0] - h0[0], s.head[2] - h0[2]) < 1e-3, `${turned.toFixed(1)}°`);

// Walk-mode menu: A opens it, Turn switches 30°/45°, Dollhouse goes back.
await click('right', 'a-button');
s = await state();
check('A opens the walk menu', s.menu === 'walk');
await shot('walk-menu');
await clickMenu('snap');
s = await state();
check('Turn option switches to 45°', s.snap === 45);
await clickMenu('snap'); // back to 30
await clickMenu('dollhouse');
s = await state();
check('Dollhouse returns from walk', s.mode === 'dollhouse' && s.rig.every((v) => v === 0) && s.menu === null);

// Exit from the menu.
await lookDown();
await click('right', 'a-button');
await clickMenu('exit');
await frames(10);
s = await state();
check('Exit ends the session', !s.presenting);
await shot('back-to-2d');

// Re-enter from another spot, facing another way: the plinth comes to you.
await page.evaluate(() => {
	const d = window.__device;
	d.position.set(1.2, 1.6, 0.8);
	const yaw = 0.9, a = -0.45;
	// yaw about Y, then pitch about X
	const qy = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], qx = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
	const q = [qy[3] * qx[0] + qy[0] * qx[3] + qy[1] * qx[2] - qy[2] * qx[1], qy[3] * qx[1] - qy[0] * qx[2] + qy[1] * qx[3] + qy[2] * qx[0], qy[3] * qx[2] + qy[0] * qx[1] - qy[1] * qx[0] + qy[2] * qx[3], qy[3] * qx[3] - qy[0] * qx[0] - qy[1] * qx[1] - qy[2] * qx[2]];
	d.quaternion.set(...q);
});
await enterVR.click();
await frames(30);
s = await state();
check('re-entering puts the plinth in front of you', Math.abs(s.stage[0] - 1.2) < 0.02 && Math.abs(s.stage[2] - 0.8) < 0.02 && Math.abs(s.stage[3] - 0.9) < 0.02,
	`stage ${s.stage.map((v) => v.toFixed(2))}`);
check('menu does not reopen on re-entry', s.menu === null);
await shot('reentered');
await page.evaluate(() => window.__svr.xr.end());
await frames(5);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
await browser.close();
server.close();
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
