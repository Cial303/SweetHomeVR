// Sweet Home VR: app entry point.
// 2D page (home screen) with an orbit-controlled dollhouse preview, file
// loading, and the Enter VR / Enter AR buttons. The XR modes live in xr.js.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from '../config.js';
import { openFiles, UserError } from './formats.js';
import { optimiseModel } from './optimise.js';
import { XRExperience } from './xr.js';
import { Lighting, TIMES } from './lighting.js';
import { listRecents, getRecent, addRecent, removeRecent, getLastLink, setLastLink } from './storage.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------

// alpha: AR shows the camera passthrough behind the model.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: new URLSearchParams(location.search).has('test') });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
$('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ec);

// The rig carries the camera and controllers; walk mode moves it.
const rig = new THREE.Group();
rig.name = 'rig';
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.set(8, 8, 8);
rig.add(camera);
scene.add(rig);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495; // stay above the ground

// One hemisphere light and one sun; time of day and optional shadows (lighting.js).
const lighting = new Lighting(scene, renderer);
const LIGHT_KEYS = { time: 'svr.time', shadows: 'svr.shadows' };
const savedTime = safeGet(LIGHT_KEYS.time);
if (TIMES.includes(savedTime)) lighting.setTime(savedTime);
if (safeGet(LIGHT_KEYS.shadows) === '1') lighting.setShadows(true);

// anchor: dollhouse placement in XR (identity on the 2D page and at 1:1).
// centerer: puts the model's bottom-centre at the anchor's origin.
const anchor = new THREE.Group();
anchor.name = 'anchor';
const centerer = new THREE.Group();
centerer.name = 'centerer';
anchor.add(centerer);
scene.add(anchor);

let current = null; // result of openFiles(), with root replaced by the merged model

const xr = new XRExperience({ renderer, scene, camera, rig, anchor, centerer, lighting, onEnd: () => {
	controls.enabled = true;
	scene.background = lighting.background();
	lighting.fit();
	frame('iso');
} });

// When the light changes (here or from the headset menu): remember it and update the views.
lighting.onChange = () => {
	safeSet(LIGHT_KEYS.time, lighting.time);
	safeSet(LIGHT_KEYS.shadows, lighting.shadows ? '1' : '0');
	if (!renderer.xr.isPresenting) scene.background = lighting.background();
	document.body.classList.toggle('dark-sky', lighting.time === 'night'); // light text over the night sky
	xr.updateSky();
	xr.updateLabels();
	$('time').value = lighting.time;
	$('shadows').checked = lighting.shadows;
};
lighting.onChange();

window.addEventListener('resize', () => {
	if (renderer.xr.isPresenting) return;
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
	timer.update(time);
	const dt = Math.min(timer.getDelta(), 0.1);
	if (renderer.xr.isPresenting) xr.update(dt);
	else controls.update();
	renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(text, isError = false) {
	$('status').textContent = text;
	$('status').classList.toggle('error', isError);
}

function sceneStats(root) {
	let triangles = 0, drawCalls = 0;
	root.traverse((o) => {
		if (!o.isMesh || !o.visible) return;
		const g = o.geometry;
		const count = g.index ? g.index.count : g.attributes.position.count;
		triangles += count / 3;
		drawCalls += Array.isArray(o.material) ? Math.max(1, g.groups.length) : 1;
	});
	return { triangles: Math.round(triangles), drawCalls };
}

function escapeHtml(t) {
	return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showStats() {
	if (!current) { $('stats').textContent = ''; return; }
	const { triangles, drawCalls } = sceneStats(current.root);
	const s = current.stats;
	const fmt = (n) => n.toLocaleString('en-GB');
	const lines = [`${fmt(triangles)} triangles · ${fmt(drawCalls)} draw calls${current.merged ? ` (merged from ${fmt(current.merged.sourceMeshes)} meshes)` : ''}`];
	if (current.kind === 'sh3d') {
		lines.push(`${s.walls} walls · ${s.rooms} rooms · ${s.pieces} pieces · ${s.openings} openings${s.levels > 1 ? ` · ${s.levels} levels` : ''}`);
		if (s.missingModels) lines.push(`${s.missingModels} model(s) could not be read (shown as boxes)`);
	} else if (current.unit) {
		lines.push(`Units: ${current.unit}`);
	}
	const html = [`<div class="name">${escapeHtml(current.label || '')}</div>`, ...lines.map((l) => `<div>${l}</div>`)];
	if (triangles > CONFIG.triangleWarning) html.push(`<div class="warn">Heavy model: over ${fmt(CONFIG.triangleWarning)} triangles may run slowly on Quest 2.</div>`);
	$('stats').innerHTML = html.join('');
	return { triangles, drawCalls };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function disposeCurrent() {
	if (!current) return;
	current.root.traverse((o) => {
		if (o.geometry) o.geometry.dispose();
		const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
		for (const m of mats) { m.map?.dispose(); m.dispose(); }
	});
	current.store?.dispose();
	centerer.clear();
	current = null;
}

/**
 * Loads [{ name, bytes }] and shows it.
 * source: { type: 'link', url } | { type: 'file' } | { type: 'recent' } (not re-saved)
 */
async function load(files, label, source = { type: 'file' }) {
	setStatus(`Opening ${label}…`);
	try {
		const result = await openFiles(files, { units: $('units').value, onProgress: (t) => setStatus(t) });
		setStatus('Optimising for Quest…');
		await new Promise((r) => setTimeout(r, 0)); // let the status paint
		// ?nomerge (debugging only): show the scene exactly as loaded.
		const merged = new URLSearchParams(location.search).has('nomerge')
			? { group: result.root, layers: Object.fromEntries(['main', 'walls', 'floors', 'ceilings', 'ground'].map((n) => [n, result.root.getObjectByName(n === 'main' ? 'furniture' : n) || new THREE.Group()])), stats: null }
			: optimiseModel(result.root);
		disposeCurrent();
		current = { ...result, label, root: merged.group, layers: merged.layers, merged: merged.stats };
		centerer.add(current.root);
		// Bottom-centre of the model (without the ground) at the origin.
		const b = current.bounds;
		centerer.position.set(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
		anchor.updateMatrixWorld(true);
		// More than one level (distinct elevations): walk mode lets you stand on
		// anything, so stairs work. One level: you stay on the floor.
		const elevations = new Set([...(result.home?.levels.values() ?? [])].filter((l) => l.viewable).map((l) => l.elevation));
		xr.setModel({ group: current.root, layers: current.layers, bounds: current.bounds, observer: current.observer, skyColor: result.home?.skyColor, multiLevel: elevations.size > 1 });
		// Sharper textures at grazing angles (floors), without any flicker.
		const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
		current.root.traverse((o) => {
			for (const m of [].concat(o.material || [])) {
				if (m.map && m.map.anisotropy !== aniso) { m.map.anisotropy = aniso; m.map.needsUpdate = true; }
			}
		});
		lighting.setHome({ compass: result.home?.compass, skyColor: result.home?.skyColor });
		lighting.setSubject(centerer, current.bounds);
		frame('iso');
		updateXRButtons();
		setStatus(`Loaded ${label}.`);
		showStats();
		document.title = `${label} · Sweet Home VR`;
		// Remember it for one-tap reopening (only once it opened successfully).
		if (source.type !== 'recent') addRecent({ name: label, files, source }).then(renderRecents);
	} catch (e) {
		console.error(e);
		setStatus(e instanceof UserError ? e.message : `Could not open ${label}: ${e.message}`, true);
		throw e;
	}
}

/** Fits the camera to the model. view: 'iso' | 'ne' | 'nw' | 'se' | 'sw' | 'top'. */
function frame(view = 'iso') {
	if (!current) return;
	// After an XR session the camera carries the headset's projection: reset it.
	camera.fov = 50;
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.quaternion.identity();
	const box = (current.bounds && !current.bounds.isEmpty() ? current.bounds.clone() : new THREE.Box3().setFromObject(current.root)).translate(centerer.position);
	const center = box.getCenter(new THREE.Vector3());
	const size = box.getSize(new THREE.Vector3());
	const radius = Math.max(size.x, size.z, size.y) * 0.5 + 0.5;
	const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
	const dirs = {
		iso: [1, 1.1, 1.25], se: [1, 1.1, 1], sw: [-1, 1.1, 1], ne: [1, 1.1, -1], nw: [-1, 1.1, -1], top: [0, 1, 0.0001],
	};
	const d = new THREE.Vector3(...(dirs[view] || dirs.iso)).normalize();
	camera.position.copy(center).addScaledVector(d, dist);
	camera.near = Math.max(0.01, dist / 200);
	camera.far = dist * 20;
	camera.updateProjectionMatrix();
	controls.target.copy(center);
	controls.update();
}

/**
 * Rewrites Dropbox shared links to a direct, CORS-enabled download URL:
 * www.dropbox.com -> dl.dropboxusercontent.com, force dl=1, keep rlkey.
 * This is an unofficial workaround (SPEC.md); failures are reported politely.
 */
export function directLink(url) {
	let u;
	try { u = new URL(url.trim()); } catch { return url.trim(); }
	if (/(^|\.)dropbox\.com$/i.test(u.hostname) && !/dropboxusercontent/i.test(u.hostname)) {
		u.hostname = 'dl.dropboxusercontent.com';
		u.searchParams.delete('raw');
		u.searchParams.set('dl', '1');
	}
	return u.toString();
}

/**
 * Downloads a URL into bytes, showing progress in the status line.
 * no-store: after editing the home on the Mac, always get the new version.
 */
async function download(url, name, expectedSize = 0) {
	const res = await fetch(url, { cache: 'no-store' });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const total = expectedSize || Number(res.headers.get('Content-Length')) || 0;
	if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
	const reader = res.body.getReader();
	const chunks = [];
	let got = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		got += value.length;
		setStatus(`Downloading ${name}… ${Math.min(100, Math.round((got / total) * 100))}% of ${(total / 1048576).toFixed(1)} MB`);
	}
	const bytes = new Uint8Array(got);
	let off = 0;
	for (const c of chunks) { bytes.set(c, off); off += c.length; }
	return bytes;
}

async function loadUrl(url, { remember = true } = {}) {
	url = url.trim();
	const direct = directLink(url);
	const name = decodeURIComponent(new URL(direct, location.href).pathname.split('/').pop() || 'model');
	setStatus(`Downloading ${name}…`);
	let bytes;
	try {
		bytes = await download(direct, name);
	} catch (e) {
		setStatus(`Could not download that link (${e.message}). For Dropbox, use a shared link to a single file.`, true);
		throw e;
	}
	if (remember) { setLastLink(url); $('link-input').value = url; }
	return load([{ name, bytes }], name, { type: 'link', url });
}

// ---------------------------------------------------------------------------
// Dropbox Chooser (official drop-in, https://www.dropbox.com/developers/chooser)
// ---------------------------------------------------------------------------
// The Chooser script must come from dropbox.com (it is Dropbox's own UI), so
// it is the one script not vendored. It is only loaded when an app key is set
// in config.js. Direct links are CORS-enabled and expire after 4 hours, which
// is fine: what we open is cached under Recent.

const MODEL_EXTENSIONS = ['.sh3d', '.zip', '.obj', '.mtl', '.glb', '.gltf', '.bin', '.dae', '.3ds', '.jpg', '.jpeg', '.png'];

function setupDropbox() {
	const key = CONFIG.dropboxAppKey;
	if (!key) return;
	const s = document.createElement('script');
	s.src = 'https://www.dropbox.com/static/api/2/dropins.js';
	s.id = 'dropboxjs';
	s.dataset.appKey = key;
	s.onload = () => {
		if (window.Dropbox?.isBrowserSupported?.() === false) return;
		$('open-dropbox').hidden = false;
		$('open-file').classList.remove('primary'); // Dropbox becomes the main way in
	};
	s.onerror = () => console.warn('Dropbox Chooser could not be loaded');
	document.head.appendChild(s);
}

function openFromDropbox() {
	if (!window.Dropbox) { setStatus('Dropbox is not available right now. Try Open from link instead.', true); return; }
	// Must run directly in the click handler, or the browser blocks the popup.
	window.Dropbox.choose({
		linkType: 'direct',
		multiselect: true, // an OBJ can come with its .mtl and textures
		extensions: MODEL_EXTENSIONS,
		success: async (picked) => {
			const label = picked.length === 1 ? picked[0].name : `${picked.length} files`;
			let files;
			try {
				files = [];
				for (const f of picked) files.push({ name: f.name, bytes: await download(f.link, f.name, f.bytes) });
			} catch (e) {
				setStatus(`Could not download from Dropbox (${e.message}).`, true);
				return;
			}
			load(files, label, { type: 'dropbox' }).catch(() => {});
		},
		cancel: () => {},
	});
}

// ---------------------------------------------------------------------------
// Recent models
// ---------------------------------------------------------------------------

function ago(date) {
	const s = (Date.now() - date) / 1000;
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

async function renderRecents() {
	const list = $('recent');
	const items = await listRecents();
	$('recent-section').hidden = items.length === 0;
	list.replaceChildren(...items.map((r) => {
		const li = document.createElement('li');
		const open = document.createElement('button');
		open.className = 'recent-open';
		open.title = 'Open the saved copy';
		const mb = (r.size / 1048576).toFixed(r.size < 10485760 ? 1 : 0);
		const kind = { link: 'Link', dropbox: 'Dropbox', file: 'File' }[r.source.type] || 'File';
		open.innerHTML = `<span class="recent-name"></span><span class="recent-meta">${kind} · ${mb} MB · ${ago(r.date)}</span>`;
		open.querySelector('.recent-name').textContent = r.name;
		open.addEventListener('click', async () => {
			const rec = await getRecent(r.id);
			if (!rec) { setStatus('That saved copy is no longer available.', true); renderRecents(); return; }
			load(rec.files, rec.name, { type: 'recent' }).catch(() => {});
		});
		li.append(open);
		if (r.source.type === 'link') {
			const refresh = document.createElement('button');
			refresh.className = 'recent-icon';
			refresh.textContent = '↻';
			refresh.title = 'Download the latest version from the same link';
			refresh.setAttribute('aria-label', `Update ${r.name} from its link`);
			refresh.addEventListener('click', () => loadUrl(r.source.url).catch(() => {}));
			li.append(refresh);
		}
		const del = document.createElement('button');
		del.className = 'recent-icon';
		del.textContent = '×';
		del.title = 'Remove from this list';
		del.setAttribute('aria-label', `Remove ${r.name}`);
		del.addEventListener('click', async () => { await removeRecent(r.id); renderRecents(); });
		li.append(del);
		return li;
	}));
}

// ---------------------------------------------------------------------------
// Enter VR (shown only when the browser supports it; passthrough is chosen in the headset)
// ---------------------------------------------------------------------------

let xrSupport = { vr: false, ar: false };

function updateXRButtons() {
	const box = $('xr-buttons');
	box.replaceChildren();
	if (!xrSupport.vr && !xrSupport.ar) return;
	// One button: an AR-capable session can switch between VR and passthrough
	// from the in-headset menu.
	const kind = xrSupport.ar ? 'ar' : 'vr';
	const b = document.createElement('button');
	b.className = 'xr';
	// Simple headset glyph, then the label.
	b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 7h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4.2l-2.1-2.4a2.3 2.3 0 0 0-3.4 0L8.2 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm3.5 3a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5zm9 0a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5z"/></svg>';
	b.append('Enter VR');
	b.disabled = !current;
	b.title = current ? '' : 'Open a model first';
	b.addEventListener('click', async () => {
		try {
			controls.enabled = false;
			await xr.start(kind);
		} catch (e) {
			controls.enabled = true;
			console.error(e);
			setStatus(`Could not start VR: ${e.message}`, true);
		}
	});
	box.append(b);
}

XRExperience.supported().then((s) => { xrSupport = s; updateXRButtons(); });

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

$('open-file').addEventListener('click', () => $('file-input').click());
$('open-dropbox').addEventListener('click', openFromDropbox);
setupDropbox();
$('file-input').addEventListener('change', async (ev) => {
	const picked = [...ev.target.files];
	ev.target.value = '';
	if (!picked.length) return;
	// Read every file straight away; never make a blob URL from a picked File
	// (Quest Browser can then fail with ERR_ACCESS_DENIED).
	let files;
	try {
		files = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
	} catch (e) {
		setStatus('Quest Browser blocked this file type. Rename it to .zip and try again', true);
		return;
	}
	load(files, picked.length === 1 ? picked[0].name : `${picked.length} files`, { type: 'file' }).catch(() => {});
});

$('open-link').addEventListener('click', () => {
	const url = $('link-input').value;
	if (url.trim()) loadUrl(url).catch(() => {});
});
$('time').addEventListener('change', (e) => lighting.setTime(e.target.value));
$('shadows').addEventListener('change', (e) => lighting.setShadows(e.target.checked));
$('link-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('open-link').click(); });
$('units').value = CONFIG.defaultObjUnits;
$('link-input').value = getLastLink();
renderRecents();

$('collapse').addEventListener('click', () => {
	const c = $('panel').classList.toggle('collapsed');
	$('collapse').textContent = c ? '+' : '–';
});

// ?model=<url> opens a model straight away (also used by the screenshot tests).
const params = new URLSearchParams(location.search);
const initial = params.get('model');
const ready = initial ? loadUrl(initial, { remember: false }).then(() => true, () => false) : Promise.resolve(true);
if (!initial) setStatus('Open a Sweet Home 3D file to start.');

// Test hooks for scripts/screenshots.js
window.__svr = {
	lighting,
	ready,
	frame: (view) => { frame(view); controls.update(); renderer.render(scene, camera); },
	look: (pos, target) => { camera.position.set(...pos); controls.target.set(...target); controls.update(); renderer.render(scene, camera); },
	stats: () => ({ ...(current?.stats || {}), ...sceneStats(current?.root || new THREE.Group()), merged: current?.merged }),
	scene,
	xr,
	renderer,
	get current() { return current; },
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
