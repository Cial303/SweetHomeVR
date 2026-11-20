// Scripted VR session in headless Chromium using Meta's WebXR emulator (IWER):
// enter VR, point at the model, rotate/zoom, grab, orbs (point and touch) and
// menu, VR/passthrough switch, jump in at 1:1, walk, snap turn, teleport,
// pull with the trigger, turn and height options, solid walls, see-through,
// exit, and re-enter from another spot. Screenshots go to test-output/xr-*.png.
//   npm run xr-test             (uses the first private fixture, else userGuideExample)
//   npm run xr-test -- tests/fixtures/SweetHome3DExample.sh3d

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './serve.js';

const root = path.resolve(import.meta.dirname, '..');
const privateDir = path.join(root, 'tests/fixtures/private');
// The model to test with: the one named on the command line, else your own
// file in tests/fixtures/private/, else a downloaded Sweet Home 3D example
// (npm run fixtures), else the example home that ships with the repository.
const own = fs.existsSync(privateDir) ? fs.readdirSync(privateDir).find((f) => f.endsWith('.sh3d')) : null;
const fixture = process.argv[2] || (own ? `tests/fixtures/private/${own}`
	: fs.existsSync(path.join(root, 'tests/fixtures/userGuideExample.sh3d')) ? 'tests/fixtures/userGuideExample.sh3d' : 'examples/example-home.sh3d');
const out = path.join(root, 'test-output');
fs.mkdirSync(out, { recursive: true });

const server = await startServer(8129);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// Install the emulated headset before the app runs: a Quest 2 by default, or
// XR_DEVICE=oculusQuest1 | metaQuest3 | metaQuestPro to check the others'
// controller layouts (this says nothing about their speed).
const DEVICE = process.env.XR_DEVICE || 'metaQuest2';
await page.addInitScript({ path: path.join(root, 'node_modules/iwer/build/iwer.min.js') });
await page.addInitScript((name) => {
	if (!IWER[name]) throw new Error(`Unknown device ${name}`);
	const d = new IWER.XRDevice(IWER[name]);
	d.stereoEnabled = false; // one view, so screenshots are easy to read
	d.installRuntime({ forceInstall: true });
	window.__device = d;
}, DEVICE);

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
		stage: [...x.stage.position.toArray(), x.stage.rotation.y],
		figure: x.figure.visible, figureHeight: x.figure.visible ? new (x.rig.position.constructor)().setFromMatrixScale(x.figure.matrixWorld).y * 1.75 : 0 };
});
/**
 * World position of a target on the open menu: a button or switch (id), a
 * choice's option (id, value) or a point along a slider (id, 0..1).
 */
const menuPoint = (id, value) => page.evaluate(async ({ id, value }) => {
	const THREE = await import('three');
	const p = window.__svr.xr.menu;
	const r = p.rects().find((b) => b.id === id && (b.slider || value === undefined || b.value === value));
	if (!r) throw new Error(`no menu target ${id} ${value ?? ''}`);
	const x = r.slider ? r.track.x + r.track.w * (value ?? 0) : r.x + r.w / 2;
	const u = x / p.size.w, v = 1 - (r.y + r.h / 2) / p.size.h;
	const g = p.mesh.geometry.parameters;
	p.mesh.updateMatrixWorld(true);
	return p.mesh.localToWorld(new THREE.Vector3((u - 0.5) * g.width, (v - 0.5) * g.height, 0)).toArray();
}, { id, value });
/** A menu cell's current state: { value, label, disabled, note }. */
const cell = (menu, id) => page.evaluate(({ menu, id }) => { const c = window.__svr.xr.menus[menu].get(id); return { value: c.value, label: c.label, disabled: !!c.disabled, note: c.note ?? null }; }, { menu, id });
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
const clickMenu = async (id, value) => { await aimW('right', R, await menuPoint(id, value)); await frames(5); await click('right', 'trigger'); };
/** World point on top of the model (plinth centre, slightly forward). */
const modelTop = () => page.evaluate(() => { const x = window.__svr.xr; return x.stage.localToWorld(x.doll.pos.clone().add(new (x.doll.pos.constructor)(0.05, 0.02, 0.25))).toArray(); });

console.log(`Fixture: ${fixture}   Device: ${DEVICE}`);
// The empty page: two welcome notes by the cards; they go once a model is open.
await page.goto('http://localhost:8129/?test');
await page.waitForFunction(() => !document.getElementById('welcome').hidden, null, { timeout: 5000 }).catch(() => {});
const welcome = () => page.evaluate(() => {
	const r = (el) => el.getBoundingClientRect(), w = document.getElementById('welcome');
	if (w.hidden) return { shown: false };
	const over = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
	const cards = [r(document.getElementById('panel')), r(document.getElementById('view'))];
	const notes = [...w.querySelectorAll('.step')];
	const texts = [...w.querySelectorAll('.num, .text')].map(r);
	return { shown: true, layout: w.dataset.layout, notes: notes.length, clear: !texts.some((t) => cards.some((c) => over(t, c))), inside: texts.every((t) => t.top >= 0 && t.bottom <= innerHeight),
		under: Math.abs(r(notes[0]).left - cards[0].left) < 2 && r(notes[0]).top > cards[0].bottom && Math.abs(r(notes[1]).left - cards[1].left) < 2 && r(notes[1]).top > cards[1].bottom,
		formats: /\.sh3d.*\.zip.*\.obj.*\.glb/.test(notes[0].textContent) && !/\.sh3d/.test(document.getElementById('panel').textContent) };
});
let wl = await welcome();
check('welcome notes sit under the two cards on the empty page', wl.shown && wl.notes === 2 && wl.layout === 'below' && wl.under && wl.clear && wl.inside && wl.formats, JSON.stringify(wl));
await shot('welcome');
await page.goto(`http://localhost:8129/?test&model=${encodeURIComponent(fixture)}`);
check('model loads', await page.evaluate(() => window.__svr.ready));
await frames(5);
check('welcome notes go once a model is open', (await welcome()).shown === false);
const enterVR = page.locator('#xr-buttons button', { hasText: 'Enter VR' });
check('one Enter VR button', await enterVR.count() === 1 && await page.locator('#xr-buttons button.xr').count() === 1);
// "Send to my Quest" is for computers and phones: in a headset's own browser (which the emulator says it is) it is not offered.
{
	const ua = await page.evaluate(() => navigator.userAgent);
	const onHeadset = /OculusBrowser|\bQuest\b/i.test(ua);
	check('Send to my Quest is offered on computers only', await page.locator('#send-quest').count() === (onHeadset ? 0 : 1), `headset browser: ${onHeadset}`);
}

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
check('dollhouse: eyes where a 2 m person\'s would be (1.89 m)', Math.abs(s.head[1] - 1.89) < 0.005 && Math.abs(s.rig[1] - 0.29) < 0.005, `eyes ${s.head[1].toFixed(3)} m, raised ${s.rig[1].toFixed(3)} m`);
check('an orb on each hand', s.orbs === 2);
{
	// No two large surfaces at the same height: the model's floor is clear of the plinth top.
	const gap = await page.evaluate(() => { const x = window.__svr.xr, V = x.rig.position.constructor; const floor = x.centerer.localToWorld(new V(0, x.model.bounds.min.y, 0)).y;
		const top = Math.max(...x.pedestal.children.map((m) => m.getWorldPosition(new V()).y + m.geometry.parameters.height / 2)); return { gap: floor - top, near: x.camera.near, far: x.camera.far }; });
	check('the model\'s floor is clear of the plinth top (no flicker)', gap.gap > 0.003 && gap.gap < 0.006 && gap.near === 0.05 && gap.far === 300, JSON.stringify(gap));
}
check('scale figure stands by the dollhouse at the model\'s scale', s.figure && Math.abs(s.figureHeight - 1.75 * s.anchorScale) < 1e-3, `figure ${s.figureHeight.toFixed(3)} m, scale ${s.anchorScale.toFixed(3)}`);
check('menu opens once on entry', s.menu === 'dollhouse');
{
	// The dollhouse menu opens to the left of where you look, out of the model's way.
	const m = await page.evaluate(() => {
		const x = window.__svr.xr, V = x.rig.position.constructor;
		const head = x.headWorld(), menu = x.menu.mesh.getWorldPosition(new V());
		const fwd = new V(0, 0, -1).transformDirection(x.camera.matrixWorld).setY(0).normalize();
		const to = menu.clone().sub(head).setY(0);
		const angle = Math.atan2(fwd.clone().cross(to.clone().normalize()).y, fwd.dot(to.clone().normalize())) * 180 / Math.PI; // + = left
		const model = x.anchor.getWorldPosition(new V()).sub(head).setY(0);
		return { angle: +angle.toFixed(1), distance: +to.length().toFixed(2), modelDistance: +model.length().toFixed(2) };
	});
	check('dollhouse menu opens on the left, away from the face', m.angle > 28 && m.angle < 40 && m.distance > 0.9, JSON.stringify(m));
	// The menu: switches for on/off, choices with every option shown, a slider, buttons; not too tall.
	const kinds = await page.evaluate(() => {
		const x = window.__svr.xr, kinds = (p) => Object.fromEntries([...p.cells.values()].map((c) => [c.id, c.type]));
		const g = (p) => p.mesh.geometry.parameters;
		return { doll: kinds(x.menus.dollhouse), walk: kinds(x.menus.walk), heights: Object.values(x.menus).map((p) => +g(p).height.toFixed(2)), width: g(x.menus.walk).width };
	});
	const want = { shadows: 'switch', depth: 'switch', ceilings: 'switch', light: 'choice', view: 'choice', seethrough: 'slider', exit: 'button' };
	const ok = Object.entries(want).every(([id, t]) => kinds.doll[id] === t && kinds.walk[id] === t)
		&& kinds.doll.figure === 'switch' && kinds.doll.levels === 'choice' && kinds.walk.solid === 'switch' && kinds.walk.turn === 'choice' && kinds.walk.height === 'choice';
	check('menus use switches, choices, a slider and buttons, and fit in view', ok && Math.max(...kinds.heights) < 0.7, JSON.stringify({ heights: kinds.heights, width: kinds.width }));
}
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

// Pushing it down stops just above the plinth top (0.6 m): never exactly on
// it, or the floor and the plinth flicker through each other.
await aim('left', [-0.2, 1.0, -0.4], [-0.2, 0.8, -1.4]); await frames(3);
await button('left', 'squeeze', 1); await frames(4);
await aim('left', [-0.2, 0.3, -0.4], [-0.2, 0.1, -1.4]); await frames(8);
s = await state();
await button('left', 'squeeze', 0); await frames(4);
check('model stays on top of the plinth, a few millimetres clear of it', s.pos[1] > 0.6 + 0.003 && s.pos[1] < 0.6 + 0.006, `y ${s.pos[1].toFixed(4)}`);

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
check('laser hovers the menu', s.hover?.startsWith('recentre|'), `hover=${s.hover}`);
await click('right', 'trigger');
s = await state();
check('Recentre resets the model', Math.abs(s.pos[0]) < 1e-6 && Math.abs(s.yaw) < 1e-6 && s.zoom === 1 && s.menu === null);
await click('right', 'a-button');
check('A opens the menu', (await state()).menu === 'dollhouse');
const c0 = (await state()).ceilings;
await clickMenu('ceilings');
s = await state();
check('Ceilings toggles and the menu stays open', s.ceilings === !c0 && s.menu === 'dollhouse' && (await cell('dollhouse', 'ceilings')).value === !c0);
await clickMenu('ceilings'); // back on

// Light: pick an option; shadows: a switch.
const t0 = await page.evaluate(() => window.__svr.lighting.time);
const pick = t0 === 'sunset' ? 'noon' : 'sunset';
await clickMenu('light', pick);
const t1 = await page.evaluate(() => window.__svr.lighting.time);
check('Time of day: one click picks an option', t1 === pick && (await cell('dollhouse', 'light')).value === pick, `${t0} -> ${t1}`);
await shot('dollhouse-menu-sunset');
await clickMenu('light', t0);
await clickMenu('shadows');
s = await page.evaluate(() => ({ on: window.__svr.lighting.shadows, map: window.__svr.renderer.shadowMap.enabled, time: window.__svr.lighting.time }));
check('Shadows switch turns them on', s.on && s.map && s.time === t0 && (await cell('dollhouse', 'shadows')).value === true, JSON.stringify(s));

// See-through: press on the slider, drag, let go; walls and furniture fade, floors don't.
const glass = () => page.evaluate(() => {
	const x = window.__svr.xr, op = (layer) => x.model.layers[layer].children.map((m) => [].concat(m.material)[0]).filter((m) => m.userData.svrBase && !m.userData.svrBase.transparent);
	const wall = op('walls')[0], piece = op('main')[0], floor = x.model.layers.floors.children[0]?.material;
	return { amount: x.seeThroughAmount, wall: wall?.opacity, wallDepthWrite: wall?.depthWrite, piece: piece?.opacity, floor: floor?.opacity, floorTransparent: floor?.transparent, cast: x.model.layers.walls.children.some((m) => m.castShadow) };
});
await aimW('right', R, await menuPoint('seethrough', 0.1)); await frames(4);
await button('right', 'trigger', 1); await frames(4);
for (const f of [0.3, 0.5, 0.7]) { await aimW('right', R, await menuPoint('seethrough', f)); await frames(3); }
let g = await glass();
await button('right', 'trigger', 0); await frames(4);
const fade = 1 - 0.85 * g.amount;
check('See-through: dragging the slider fades walls and furniture', Math.abs(g.amount - 0.7) < 0.051 && Math.abs(g.wall - fade) < 1e-6 && Math.abs(g.piece - fade) < 1e-6 && !g.wallDepthWrite && !g.cast && g.floor === 1 && !g.floorTransparent && (await state()).menu === 'dollhouse', JSON.stringify(g));
await restRight(); await frames(5);
await shot('dollhouse-see-through');
await clickMenu('seethrough', 0); // a click at the start of the track: off
g = await glass();
check('See-through back to Off restores the model', g.amount === 0 && g.wall === 1 && g.piece === 1 && g.wallDepthWrite && g.cast && (await cell('dollhouse', 'seethrough')).value === 0, JSON.stringify(g));
await restRight(); await frames(5);
await shot('dollhouse-shadows');
s = await state();
if (s.session === 'ar') {
	await clickMenu('view', 'ar');
	s = await state();
	check('View switches to passthrough', s.view === 'ar' && !s.showroom && Math.abs(s.rig[1]) < 1e-6);
	await shot('passthrough');
	await clickMenu('view', 'vr');
	s = await state();
	check('View switches back to VR', s.view === 'vr' && s.showroom && Math.abs(s.rig[1] - 0.29) < 0.005);
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

// Aimed steeply up, the arc stays under door height (1.85 m above the feet), so it fits through doorways.
await aim('right', R, [0.25, 3.5, -1.2]); await frames(3);
await button('right', 'trigger', 1); await frames(6);
s = await page.evaluate(() => { const x = window.__svr.xr; return { top: Math.max(...x.arc.points.map((p) => p.y)) - (x.rig.position.y - x.lift), reach: x.arc.points.length }; });
await page.evaluate(() => { const x = window.__svr.xr; x.tele = null; x.arc.hide(); }); // cancel: no jump
await button('right', 'trigger', 0); await frames(5);
check('teleport arc stays under door height when aimed up', s.top < 1.86 && s.top > 1.5, `highest ${s.top.toFixed(2)} m above the feet`);
await restRight(); await frames(3);

// Furniture is not a floor: find a furniture top, check the arc flies
// through it to the floor below, and that standing there uses that floor.
s = await page.evaluate(async () => {
	const THREE = await import('three');
	const x = window.__svr.xr, b = x.model.bounds;
	// The one-level rule, whatever the test model is (restored below).
	const was = x.model.multiLevel;
	x.model.multiLevel = false;
	x._targets = null;
	const t = x.targets();
	const restore = (v) => { x.model.multiLevel = was; x._targets = null; return v; };
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
		return restore({ top: +h.point.y.toFixed(2), topPoint: h.point.toArray(), arcLands: seg ? +seg.point.y.toFixed(2) : null, arcValid: seg?.valid, floorBelow: under ? +under.point.y.toFixed(2) : null });
	}
	return restore(null);
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

// Walk-mode menu: Turn and Height are choices, Dollhouse goes back.
await click('right', 'a-button');
s = await state();
check('A opens the walk menu', s.menu === 'walk');
await shot('walk-menu');
const snap0 = s.snap, turns = [];
for (const t of [15, 45, snap0]) { await clickMenu('turn', t); turns.push((await state()).snap); }
check('Turn: 15°, 45° and back, one click each', turns.join() === `15,45,${snap0}` && (await cell('walk', 'turn')).value === snap0, turns.join(' → '));
const feet = (await state()).rig[1] - (await state()).lift;
await clickMenu('height', 1.4);
s = await state();
check('Height 1.4 m puts the eyes at 1.29 m', s.height === 1.4 && Math.abs(s.head[1] - feet - 1.29) < 0.01, `eyes ${(s.head[1] - feet).toFixed(2)} m`);
await shot('height-1.4');
await clickMenu('height', 0);
s = await state();
check('Height back to your own', s.height === 0 && Math.abs(s.head[1] - feet - 1.6) < 0.01);

// Solid walls: on, walking at a wall stops a body's width in front of it; off, you walk through.
{
	const wallAt = (a) => page.evaluate(async (a) => {
		const THREE = await import('three');
		const x = window.__svr.xr, head = x.headWorld(), feet = x.rig.position.y - x.lift;
		const ray = new THREE.Raycaster();
		// side: start that far to the right of the head (metres), looking the same way.
		const look = (ang, side = 0) => {
			const o = new THREE.Vector3(head.x + Math.cos(ang) * side, feet + 1.0, head.z - Math.sin(ang) * side);
			ray.set(o, new THREE.Vector3(-Math.sin(ang), 0, -Math.cos(ang)));
			return ray.intersectObjects(x.model.layers.walls.children, false)[0]?.distance ?? null;
		};
		if (a !== null) return { a, d: look(a), head: head.toArray() };
		// The nearest flat stretch of wall (0.8 m wide, square to you) 0.5-2 m
		// away, so you walk straight at it: the end of a short wall would let
		// you slide round it, as it should.
		const flat = (ang, d) => [-0.4, 0.4].every((s) => { const e = look(ang, s); return e !== null && Math.abs(e - d) < 0.03; });
		let best = null;
		for (let i = 0; i < 144; i++) { const ang = i / 144 * Math.PI * 2, d = look(ang); if (d && d > 0.5 && d < 2 && (!best || d < best.d) && flat(ang, d)) best = { a: ang, d }; }
		return best && { ...best, head: head.toArray() };
	}, a);
	const w = await wallAt(null);
	if (!w) {
		check('Solid walls (needs a flat wall 0.5-2 m away)', false);
	} else {
		await clickMenu('solid');
		check('Solid walls switch turns on', (await cell('walk', 'solid')).value === true && await page.evaluate(() => window.__svr.xr.solid));
		await click('right', 'b-button');
		await page.evaluate((a) => { // face the wall
			const x = window.__svr.xr, V = x.rig.position.constructor;
			x.rig.updateMatrixWorld(true);
			const f = new V(0, 0, -1).transformDirection(x.camera.matrixWorld);
			x.turn(a - Math.atan2(-f.x, -f.z));
		}, w.a);
		await stick('left', 0, -1); await frames(200); await stick('left', 0, 0); await frames(3);
		const stopped = await wallAt(w.a);
		const walked = Math.hypot(stopped.head[0] - w.head[0], stopped.head[2] - w.head[2]);
		check('Solid walls: you stop a body\'s width in front of a wall', stopped.d !== null && stopped.d > 0.17 && stopped.d < 0.3 && walked > w.d - 0.35, `wall was ${w.d.toFixed(2)} m away; walked ${walked.toFixed(2)} m, now ${stopped.d?.toFixed(2)} m from it`);
		await shot('walk-solid-wall');
		await page.evaluate(() => window.__svr.xr.menuAction('solid')); // off
		await stick('left', 0, -1); await frames(40); await stick('left', 0, 0); await frames(3);
		const through = await wallAt(w.a);
		const along = (through.head[0] - w.head[0]) * -Math.sin(w.a) + (through.head[2] - w.head[2]) * -Math.cos(w.a);
		check('Solid walls off: you walk through it', along > w.d + 0.05, `${along.toFixed(2)} m along, the wall at ${w.d.toFixed(2)} m`);
	}
	await click('right', 'a-button');
}
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
	d.position.set(1.2, 1.15, 0.8); // sitting down this time
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
check('sitting down: the eyes are still at 1.89 m', Math.abs(s.head[1] - 1.89) < 0.005 && Math.abs(s.rig[1] - 0.74) < 0.005, `eyes ${s.head[1].toFixed(3)} m, raised ${s.rig[1].toFixed(3)} m`);
// Stand up and press Recentre: measured again.
await page.evaluate(() => window.__device.position.set(1.2, 1.75, 0.8));
await frames(5);
await page.evaluate(() => window.__svr.xr.menuAction('recentre'));
await frames(5);
s = await state();
check('Recentre measures the height again', Math.abs(s.head[1] - 1.89) < 0.005 && Math.abs(s.rig[1] - 0.14) < 0.005, `eyes ${s.head[1].toFixed(3)} m, raised ${s.rig[1].toFixed(3)} m`);
await shot('reentered');
await page.evaluate(() => window.__svr.xr.end());
await frames(5);

// The example home (two storeys, lamps): level picker, lamps at night, figure.
await page.click('#open-example');
await page.waitForFunction(() => /Loaded example-home/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
await page.evaluate(() => window.__device.position.set(0, 1.6, 0));
await lookDown();
await restRight();
await restLeft();
await enterVR.click();
await page.waitForFunction(() => { const x = window.__svr.xr; return x.mode && !x.pendingRecentre && x.orbs.every((o) => o.holder); }, null, { timeout: 8000 }).catch(() => {});
await frames(10);
const storeys = () => page.evaluate(() => {
	const x = window.__svr.xr, shown = new Set(), hidden = new Set();
	for (const g of [...Object.values(x.model.layers), x.model.lamps]) for (const m of g?.children ?? []) (m.visible ? shown : hidden).add(m.userData.storey ?? 0);
	const topCeilings = x.model.layers.ceilings.children.filter((m) => m.visible).map((m) => m.userData.storey);
	return { count: x.model.storeys, shown: [...shown].sort(), hidden: [...hidden].sort(), topCeilings, level: x.menus.dollhouse.get('levels').value, levelOptions: x.menus.dollhouse.get('levels').options.map((o) => o.label).join(' '),
		pointable: x.targets().pointable.every((m) => m.visible), lamps: x.model.lamps?.children.length ?? 0, lampsOn: !!x.model.lamps?.visible, multi: x.model.multiLevel };
});
let lv = await storeys();
check('example home: two storeys, all shown', lv.count === 2 && lv.multi && lv.hidden.length === 0 && lv.level === 1 && lv.levelOptions === '1 All (2)', JSON.stringify(lv));
await click('right', 'a-button');
await shot('example-menu');
await clickMenu('levels', 0);
await frames(5);
lv = await storeys();
check('Levels shows the ground floor only, without its ceilings', lv.shown.join() === '0' && lv.hidden.includes(1) && lv.topCeilings.length === 0 && lv.level === 0 && lv.pointable, JSON.stringify(lv));
await page.evaluate(() => window.__svr.lighting.setTime('night'));
await frames(5);
lv = await storeys();
check('lamps glow at night', lv.lamps > 0 && lv.lampsOn, JSON.stringify(lv));
await click('right', 'b-button');
await shot('example-ground-floor-night');
await page.evaluate(() => window.__svr.lighting.setTime('morning'));
await click('right', 'a-button');
await clickMenu('levels', 1);
await frames(5);
lv = await storeys();
check('Levels: All shows every storey again', lv.hidden.length === 0 && lv.level === 1 && !lv.lampsOn, JSON.stringify(lv));
await clickMenu('figure');
await frames(3);
check('Figure can be switched off', !(await state()).figure);
await clickMenu('figure');
await frames(3);
check('and on again', (await state()).figure);
// Depth shading: switched on from the menu, prepared in the background, headset only.
const depth = () => page.evaluate(() => { const d = window.__svr.depth, x = window.__svr.xr; return { on: d.enabled, state: d.state, uniform: d.uniform.value, label: x.menus.dollhouse.get('depth').label, switched: x.menus.dollhouse.get('depth').value }; });
check('Depth starts off', (await depth()).switched === false && (await depth()).uniform === 0);
await clickMenu('depth');
await page.waitForFunction(() => window.__svr.depth.state === 'ready', null, { timeout: 120000 }).catch(() => {});
await frames(5);
let dp = await depth();
check('Depth shading is prepared and shown in the headset', dp.on && dp.state === 'ready' && dp.uniform === 1 && dp.switched === true && dp.label === 'Depth', JSON.stringify(dp));
await clickMenu('levels', 0); // ground floor only, then walk in: every storey comes back
await clickMenu('walk');
await frames(15);
lv = await storeys();
s = await state();
check('walking shows every storey and hides the figure', s.mode === 'walk' && lv.hidden.length === 0 && !s.figure, JSON.stringify({ mode: s.mode, hidden: lv.hidden, figure: s.figure }));
{
	// Several levels: furniture stops the arc (stairs can be stood on), but doors and windows don't.
	const o = await page.evaluate(() => {
		const x = window.__svr.xr, t = x.targets(), main = x.model.layers.main.children;
		const openings = main.filter((m) => m.userData.opening);
		return { openings: openings.length, inSolid: openings.filter((m) => t.solid.includes(m)).length, furnitureSolid: t.solid.some((m) => main.includes(m) && !m.userData.opening) };
	});
	check('several levels: the arc passes doors and windows, not other furniture', o.openings > 0 && o.inSolid === 0 && o.furnitureSolid, JSON.stringify(o));
}
await shot('example-walk-depth');
await page.evaluate(() => window.__svr.xr.end());
await frames(5);
dp = await depth();
check('Depth shading is not applied on the 2D page', dp.on && dp.uniform === 0, JSON.stringify(dp));
check('the page switch follows the headset menu', await page.isChecked('#depth') && /ready/.test(await page.textContent('#depth-note')));
await page.click('label.switch:has(#depth)'); // back off, as the next run expects

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(results.join('\n'));
await browser.close();
server.close();
process.exitCode = results.some((r) => r.startsWith('FAIL')) ? 1 : 0;
