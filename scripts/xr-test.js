// Scripted VR session in headless Chromium using Meta's WebXR emulator (IWER):
// enter VR, point at the model, rotate/zoom, grab, orbs (point and touch) and
// menu, VR/passthrough switch, jump in at 1:1, walk, snap turn, teleport,
// pull with the trigger, turn and height options, exit, and re-enter from
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
	return { mode: x.mode, presenting: window.__svr.renderer.xr.isPresenting, session: x.sessionMode, view: x.view,
		showroom: x.showroom.visible, walkSky: x.walkSky.visible, yaw: x.doll.yaw, zoom: x.doll.zoom, pos: x.doll.pos.toArray(),
		marker: x.markers.some((m) => m.visible), rig: x.rig.position.toArray(), rigYaw: x.rig.rotation.y, head, lift: x.lift,
		ceilings: x.model?.layers.ceilings.visible, menu: x.menu ? Object.keys(x.menus).find((k) => x.menus[k] === x.menu) : null,
		hover: x.menu?.hover ?? null, anchorScale: x.anchor.scale.x, orbs: x.orbs.filter((o) => o.holder).length,
		orbGlow: Math.max(...x.orbs.map((o) => o.glow)), snap: x.snapAngle, height: x.personHeight,
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
	p.mesh.updateMatrixWorld(true);
	return p.mesh.localToWorld(new THREE.Vector3((u - 0.5) * g.width, (v - 0.5) * g.height, 0)).toArray();
}, id);
/** World position of the orb on a hand ('left' or 'right'). */
const orbPoint = (hand) => page.evaluate(async (hand) => {
	const THREE = await import('three');
	const o = window.__svr.xr.orbs.find((o) => o.holder?.handedness === hand);
	return o.group.getWorldPosition(new THREE.Vector3()).toArray();
}, hand);
/** Converts a world point to tracking space (where IWER poses live). */
const toLocal = (p) => page.evaluate((p) => { const x = window.__svr.xr; x.rig.updateMatrixWorld(true); return x.rig.worldToLocal(new (x.rig.position.constructor)(...p)).toArray(); }, p);
/** Aims from a tracking-space point at a world point. */
const aimW = async (hand, from, world) => aim(hand, from, await toLocal(world));
const lookDown = (a = -0.45) => page.evaluate((a) => { window.__device.quaternion.set(Math.sin(a / 2), 0, 0, Math.cos(a / 2)); }, a);
const lookAhead = () => page.evaluate(() => window.__device.quaternion.set(0, 0, 0, 1));
const R = [0.25, 1.1, -0.25], L = [-0.25, 1.0, -0.2];
const restRight = () => aim('right', R, [0.6, 1.1, -1.5]); // pointing at nothing
const restLeft = () => aim('left', L, [-0.6, 1.0, -1.5]);
const clickMenu = async (id) => { await aimW('right', R, await menuPoint(id)); await frames(5); await click('right', 'trigger'); };
/** World point on top of the model (plinth centre, slightly forward). */
const modelTop = () => page.evaluate(() => { const x = window.__svr.xr; return x.stage.localToWorld(x.doll.pos.clone().add(new (x.doll.pos.constructor)(0.05, 0.02, 0.25))).toArray(); });

console.log(`Fixture: ${fixture}`);
await page.goto(`http://localhost:8129/?test&model=${encodeURIComponent(fixture)}`);
check('model loads', await page.evaluate(() => window.__svr.ready));
const enterVR = page.locator('#xr-buttons button', { hasText: 'Enter VR' });
check('one Enter VR button', await enterVR.count() === 1 && await page.locator('#xr-buttons button').count() === 1);

// Head 1.6 m up, looking slightly down at the plinth.
await page.evaluate(() => window.__device.position.set(0, 1.6, 0));
await lookDown();
await restRight();
await restLeft();
await enterVR.click();
// Wait until the session is up: both controllers have orbs and the plinth was placed.
await page.waitForFunction(() => { const x = window.__svr.xr; return x.mode && !x.pendingRecentre && x.orbs.every((o) => o.holder); }, null, { timeout: 8000 }).catch(() => {});
await frames(10);
let s = await state();
check('enters the VR dollhouse', s.presenting && s.mode === 'dollhouse' && s.showroom, JSON.stringify({ mode: s.mode, session: s.session }));
check('eyes lifted in the dollhouse', Math.abs(s.rig[1] - 0.25) < 1e-6, `rig y ${s.rig[1]}`);
check('an orb on each hand', s.orbs === 2);
check('menu opens once on entry', s.menu === 'dollhouse');
await shot('dollhouse-menu');
await click('right', 'b-button');
check('B closes the menu', (await state()).menu === null);
await shot('dollhouse');

// Point at the model: marker appears.
await aimW('right', R, await modelTop());
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

// Pushing it down stops at the plinth top (0.6 m).
await aim('left', [-0.2, 1.0, -0.4], [-0.2, 0.8, -1.4]); await frames(3);
await button('left', 'squeeze', 1); await frames(4);
await aim('left', [-0.2, 0.3, -0.4], [-0.2, 0.1, -1.4]); await frames(8);
s = await state();
await button('left', 'squeeze', 0); await frames(4);
check('model stays on top of the plinth', Math.abs(s.pos[1] - 0.6) < 1e-6, `y ${s.pos[1].toFixed(3)}`);

// Left orb (hand raised into view): the right laser makes it glow, a click opens the menu.
await aim('left', [-0.12, 1.2, -0.4], [0.1, 0.9, -1.2]);
await frames(3);
await aimW('right', R, await orbPoint('left'));
await page.waitForFunction(() => Math.max(...window.__svr.xr.orbs.map((o) => o.glow)) > 0.5, null, { timeout: 2000 }).catch(() => {});
s = await state();
check('laser makes the orb glow', s.orbGlow > 0.5, `glow ${s.orbGlow.toFixed(2)}`);
await shot('orb-hover');
await click('right', 'trigger');
s = await state();
check('orb click opens the menu', s.menu === 'dollhouse');
await shot('menu-and-controls');

// Menu: Recentre puts the model back, Ceilings toggles, View switches to passthrough.
await aimW('right', R, await menuPoint('recentre')); await frames(5);
s = await state();
check('laser hovers the menu', s.hover === 'recentre', `hover=${s.hover}`);
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

// Light and shadows.
const t0 = await page.evaluate(() => window.__svr.lighting.time);
await clickMenu('light');
const t1 = await page.evaluate(() => window.__svr.lighting.time);
check('Light changes the time of day', t1 !== t0, `${t0} -> ${t1}`);
for (let i = 0; i < 3; i++) await clickMenu('light'); // round to where it was
await clickMenu('shadows');
s = await page.evaluate(() => ({ on: window.__svr.lighting.shadows, map: window.__svr.renderer.shadowMap.enabled, time: window.__svr.lighting.time }));
check('Shadows turn on', s.on && s.map && s.time === t0, JSON.stringify(s));
await restRight(); await frames(5);
await shot('dollhouse-shadows');
s = await state();
if (s.session === 'ar') {
	await clickMenu('view');
	s = await state();
	check('View switches to passthrough', s.view === 'ar' && !s.showroom && Math.abs(s.rig[1]) < 1e-6);
	await shot('passthrough');
	await clickMenu('view');
	s = await state();
	check('View switches back to VR', s.view === 'vr' && s.showroom && Math.abs(s.rig[1] - 0.25) < 1e-6);
} else {
	check('View switch (needs an AR session)', false, `session ${s.session}`);
}
await restRight(); await frames(3);
await click('right', 'trigger');
check('clicking elsewhere closes the menu', (await state()).menu === null);

// Touch the left orb with the right controller: the menu opens.
await aim('left', [-0.12, 1.2, -0.4], [0.1, 0.9, -1.2]); await frames(3);
const orbL = await toLocal(await orbPoint('left'));
await aim('right', orbL, [orbL[0], orbL[1], orbL[2] - 1]); await frames(5);
check('touching an orb opens the menu', (await state()).menu === 'dollhouse');
await restRight(); await restLeft(); await frames(5);
await click('right', 'b-button');

// Trigger on the model: jump in at 1:1.
await aimW('right', R, await modelTop()); await frames(6);
await click('right', 'trigger');
s = await state();
check('trigger on model enters 1:1', s.mode === 'walk' && s.anchorScale === 1, JSON.stringify(s.rig.map((v) => +v.toFixed(2))));
await lookAhead();
await restRight();
await frames(10);
await shot('walk-trigger');
await click('left', 'y-button');
s = await state();
check('Y returns to dollhouse', s.mode === 'dollhouse');

// Walk in (observer camera) from the menu.
await lookDown();
await click('left', 'x-button');
check('X opens the menu', (await state()).menu === 'dollhouse');
await clickMenu('walk');
s = await state();
check('Walk in enters 1:1', s.mode === 'walk' && s.anchorScale === 1 && s.walkSky, JSON.stringify({ rig: s.rig.map((v) => +v.toFixed(2)) }));
await lookAhead();
await restRight();
await frames(10);
await shot('walk-in-observer');

// Right stick forward: teleport arc to the floor ahead; release to go there.
let h0;
await aim('right', R, [0.25, 0, -1.0]); // steeply down: lands about 1 m ahead
await lookDown(-0.6);
await stick('right', 0, -1); await frames(8);
s = await state();
check('teleport arc shows a valid landing', s.arc && s.ring && s.valid === true, JSON.stringify({ arc: s.arc, ring: s.ring, valid: s.valid }));
await shot('teleport-arc');
const land = s.ring;
await stick('right', 0, 0); await frames(25);
s = await state();
check('teleport moves you to the ring', s.head && Math.hypot(s.head[0] - land[0], s.head[2] - land[2]) < 0.05 && Math.abs(s.rig[1] - land[1]) < 0.05,
	`landed ${land.map((v) => v.toFixed(2))}, head ${s.head.map((v) => v.toFixed(2))}, feet ${s.rig[1].toFixed(2)}`);
check('arc hides after teleport', !s.arc);
await lookAhead();
await restRight();
await frames(5);
await shot('teleported');

// Hold a trigger, aim behind you (where you came from), release: teleport.
await aim('right', R, [0.25, 0, 0.8]); await frames(3);
h0 = (await state()).head;
await button('right', 'trigger', 1); await frames(8);
s = await state();
check('trigger shows the teleport arc', s.arc && s.valid === true, JSON.stringify({ arc: s.arc, ring: s.ring, valid: s.valid }));
const land2 = s.ring;
await button('right', 'trigger', 0); await frames(25);
s = await state();
check('trigger release teleports', land2 && Math.hypot(s.head[0] - land2[0], s.head[2] - land2[2]) < 0.05, `moved ${Math.hypot(s.head[0] - h0[0], s.head[2] - h0[2]).toFixed(2)} m`);
await restRight(); await frames(3);

// Furniture is not a floor: find a furniture top, check the arc flies
// through it to the floor below, and that standing there uses that floor.
s = await page.evaluate(async () => {
	const THREE = await import('three');
	const x = window.__svr.xr, t = x.targets(), b = x.model.bounds;
	const ray = new THREE.Raycaster();
	for (let i = 0; i < 400; i++) {
		const p = new THREE.Vector3(b.min.x + (i % 20 + 0.5) / 20 * (b.max.x - b.min.x), 0, b.min.z + (Math.floor(i / 20) + 0.5) / 20 * (b.max.z - b.min.z));
		x.centerer.localToWorld(p);
		ray.set(p.clone().setY(1.5), new THREE.Vector3(0, -1, 0));
		const h = ray.intersectObjects([...x.model.layers.main.children, ...x.model.layers.walls.children], false)[0];
		if (!h || !x.model.layers.main.children.includes(h.object) || h.point.y < 0.3 || h.point.y > 1.2) continue;
		if (h.face.normal.clone().transformDirection(h.object.matrixWorld).y < 0.9) continue;
		// Skip windows and anything else standing on a wall (walls do stop the arc).
		if (ray.intersectObjects(x.model.layers.walls.children, false).length) continue;
		const seg = x.hitSegment(h.point.clone().setY(h.point.y + 0.5), h.point.clone().setY(-0.05), t); // from above the top down past the floor
		const under = new THREE.Raycaster(h.point.clone().setY(h.point.y + 0.1), new THREE.Vector3(0, -1, 0)).intersectObjects([...t.walkable], false)[0];
		return { top: +h.point.y.toFixed(2), topPoint: h.point.toArray(), arcLands: seg ? +seg.point.y.toFixed(2) : null, arcValid: seg?.valid, floorBelow: under ? +under.point.y.toFixed(2) : null };
	}
	return null;
});
check('one level: arc goes through furniture to the floor', s && s.arcValid === true && s.floorBelow !== null && s.floorBelow < s.top - 0.25 && Math.abs(s.arcLands - s.floorBelow) < 0.01, JSON.stringify(s));

// More than one level: furniture (and so stairs) can be stood on.
s = await page.evaluate(async (top) => {
	const THREE = await import('three');
	const x = window.__svr.xr;
	const was = x.model.multiLevel;
	x.model.multiLevel = true;
	x._targets = null; // the mesh sets are cached per model
	const t = x.targets(), p = new THREE.Vector3(...top);
	const seg = x.hitSegment(p.clone().setY(p.y + 0.5), p.clone().setY(-0.05), t);
	x.model.multiLevel = was;
	x._targets = null;
	return { arcLands: seg ? +seg.point.y.toFixed(2) : null, arcValid: seg?.valid };
}, s.topPoint);
check('several levels: you can stand on furniture', s.arcValid === true && s.arcLands > 0.25, JSON.stringify(s));

// Left stick forward: walk at about 0.75 m/s where the head looks.
h0 = (await state()).head;
await stick('left', 0, -1); await frames(40); await stick('left', 0, 0); await frames(3);
s = await state();
const walked = Math.hypot(s.head[0] - h0[0], s.head[2] - h0[2]);
check('left stick walks (about 0.75 m/s)', walked > 0.2 && walked < 1.0, `${walked.toFixed(2)} m`);

// Hold a grip and pull the hand back: you move forward.
h0 = s.head;
await aim('right', [0.2, 1.1, -0.5], [0.2, 1.1, -1.5]); await frames(3);
await button('right', 'squeeze', 1); await frames(3);
for (let i = 1; i <= 5; i++) { await aim('right', [0.2, 1.1, -0.5 + i * 0.06], [0.2, 1.1, -1.5]); await frames(2); }
await button('right', 'squeeze', 0); await frames(3);
s = await state();
const pulled = Math.hypot(s.head[0] - h0[0], s.head[2] - h0[2]);
check('grip pull moves you', pulled > 0.2 && pulled < 0.4, `${pulled.toFixed(2)} m`);
await restRight();

// Right stick right: one snap turn.
const ry0 = s.rigYaw;
h0 = s.head;
await stick('right', 1, 0); await frames(15); await stick('right', 0, 0); await frames(5);
s = await state();
const turned = THREE_deg(ry0 - s.rigYaw);
check(`right stick snap-turns ${s.snap}°`, Math.abs(turned - s.snap) < 0.5 && Math.hypot(s.head[0] - h0[0], s.head[2] - h0[2]) < 1e-3, `${turned.toFixed(1)}°`);

// Walk-mode menu: Turn cycles 15/30/45, Height changes the eye level, Dollhouse goes back.
await click('right', 'a-button');
s = await state();
check('A opens the walk menu', s.menu === 'walk');
await shot('walk-menu');
const turns = [];
for (let i = 0; i < 3; i++) { await clickMenu('turn'); turns.push((await state()).snap); }
check('Turn cycles through 15°, 30°, 45°', [...turns].sort((a, b) => a - b).join() === '15,30,45', turns.join(' → '));
const feet = (await state()).rig[1] - (await state()).lift;
await clickMenu('height');
s = await state();
check('Height 1.4 m puts the eyes at 1.29 m', s.height === 1.4 && Math.abs(s.head[1] - feet - 1.29) < 0.01, `eyes ${(s.head[1] - feet).toFixed(2)} m`);
await shot('height-1.4');
for (let i = 0; i < 3; i++) await clickMenu('height'); // 1.7, 2.0, back to yours
s = await state();
check('Height back to your own', s.height === 0 && Math.abs(s.head[1] - feet - 1.6) < 0.01);
await clickMenu('dollhouse');
s = await state();
check('Dollhouse returns from walk', s.mode === 'dollhouse' && s.rig[0] === 0 && s.rig[2] === 0 && s.menu === null);

// Exit from the menu.
await lookDown();
await click('right', 'a-button');
await clickMenu('exit');
await frames(10);
s = await state();
check('Exit ends the session', !s.presenting);
await shot('back-to-2d');

// Re-enter from another spot, facing another way: the room and plinth come to you.
await page.evaluate(() => {
	const d = window.__device;
	d.position.set(1.2, 1.6, 0.8);
	const yaw = 0.9, a = -0.45;
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
