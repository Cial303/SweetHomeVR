// Sweet Home VR: app entry point.
// Phase 1: 2D page with an orbit-controlled dollhouse preview.
// The XR states (dollhouse / walk) arrive in phases 2 and 3.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from '../config.js';
import { openFiles, UserError } from './formats.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Renderer, scene, camera
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: new URLSearchParams(location.search).has('test') });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
$('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe6ec);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 500);
camera.position.set(8, 8, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495; // stay above the ground

// One hemisphere light and one directional light, no shadows (SPEC.md, performance).
const hemi = new THREE.HemisphereLight(0xffffff, 0x8d8a85, 2.2);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.6, 1, 0.35);
scene.add(hemi, sun);

const modelHolder = new THREE.Group();
scene.add(modelHolder);

let current = null; // result of openFiles()

window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
	controls.update();
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

function showStats() {
	if (!current) { $('stats').textContent = ''; return; }
	const { triangles, drawCalls } = sceneStats(current.root);
	const s = current.stats;
	const fmt = (n) => n.toLocaleString('en-GB');
	const lines = [`${fmt(triangles)} triangles · ${fmt(drawCalls)} draw calls`];
	if (current.kind === 'sh3d') {
		lines.push(`${s.walls} walls · ${s.rooms} rooms · ${s.pieces} pieces · ${s.openings} openings${s.levels ? ` · ${s.levels} levels` : ''}`);
		if (s.missingModels) lines.push(`${s.missingModels} model(s) could not be read (shown as boxes)`);
	} else if (current.unit) {
		lines.push(`Units: ${current.unit}`);
	}
	const html = lines.map((l) => `<div>${l}</div>`);
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
	modelHolder.clear();
	current = null;
}

/** Loads [{ name, bytes }] and shows it. */
async function load(files, label) {
	setStatus(`Opening ${label}…`);
	try {
		const result = await openFiles(files, { units: $('units').value, onProgress: (t) => setStatus(t) });
		disposeCurrent();
		current = result;
		modelHolder.add(result.root);
		if (result.home) scene.background = new THREE.Color(result.home.skyColor);
		frame('iso');
		setStatus(`${label}`);
		showStats();
		document.title = `${label} · Sweet Home VR`;
	} catch (e) {
		console.error(e);
		setStatus(e instanceof UserError ? e.message : `Could not open ${label}: ${e.message}`, true);
		throw e;
	}
}

/** Fits the camera to the model. view: 'iso' | 'ne' | 'nw' | 'se' | 'sw' | 'top'. */
function frame(view = 'iso') {
	if (!current) return;
	const box = current.bounds && !current.bounds.isEmpty() ? current.bounds : new THREE.Box3().setFromObject(current.root);
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

async function loadUrl(url) {
	const direct = directLink(url);
	const name = decodeURIComponent(new URL(direct, location.href).pathname.split('/').pop() || 'model');
	setStatus(`Downloading ${name}…`);
	let bytes;
	try {
		const res = await fetch(direct);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		setStatus(`Could not download that link (${e.message}). For Dropbox, use a shared link to a single file.`, true);
		throw e;
	}
	return load([{ name, bytes }], name);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

$('open-file').addEventListener('click', () => $('file-input').click());
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
	load(files, picked.length === 1 ? picked[0].name : `${picked.length} files`).catch(() => {});
});

$('open-link').addEventListener('click', () => {
	const url = $('link-input').value;
	if (url.trim()) loadUrl(url).catch(() => {});
});
$('link-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('open-link').click(); });
$('units').value = CONFIG.defaultObjUnits;

$('collapse').addEventListener('click', () => {
	const c = $('panel').classList.toggle('collapsed');
	$('collapse').textContent = c ? '+' : '–';
});

// ?model=<url> opens a model straight away (also used by the screenshot tests).
const params = new URLSearchParams(location.search);
const initial = params.get('model');
const ready = initial ? loadUrl(initial).then(() => true, () => false) : Promise.resolve(true);
if (!initial) setStatus('Open a Sweet Home 3D file to start.');

// Test hooks for scripts/screenshots.js
window.__svr = {
	ready,
	frame: (view) => { frame(view); controls.update(); renderer.render(scene, camera); },
	look: (pos, target) => { camera.position.set(...pos); controls.target.set(...target); controls.update(); renderer.render(scene, camera); },
	stats: () => ({ ...(current?.stats || {}), ...sceneStats(current?.root || new THREE.Group()) }),
	/** Furniture whose bounds reach more than 1 m outside the walls. */
	outliers: () => {
		const walls = current?.root.getObjectByName('walls');
		const furniture = current?.root.getObjectByName('furniture');
		if (!walls || !furniture) return [];
		const wb = new THREE.Box3().setFromObject(walls).expandByScalar(1);
		return furniture.children.filter((p) => !wb.containsBox(new THREE.Box3().setFromObject(p))).map((p) => {
			const b = new THREE.Box3().setFromObject(p);
			const f = (v) => v.toArray().map((n) => n.toFixed(1)).join(',');
			return `${p.name} [${f(b.min)}]..[${f(b.max)}]`;
		});
	},
	scene,
	get current() { return current; },
};
