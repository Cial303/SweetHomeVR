// File loading: .sh3d, OBJ (plain, multiple files or zipped), GLB/glTF, DAE, 3DS.
//
// Files are kept in memory as a map of path -> bytes ("entries"). Loaders ask
// for related files (MTL, textures, .bin) through a LoadingManager URL
// modifier that serves those bytes as blob URLs. Blob URLs are only ever made
// from our own in-memory bytes, never from a picked File (Quest Browser bug,
// see SPEC.md).

import * as THREE from 'three';
import { unzipSync } from 'fflate';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { parseHome, buildHome } from './sh3d.js';

export class UserError extends Error {}

// ---------------------------------------------------------------------------
// Bytes helpers
// ---------------------------------------------------------------------------

/** Detects a file format from its first bytes. */
export function sniff(bytes) {
	if (!bytes || bytes.length < 4) return 'unknown';
	const b = bytes;
	if (b[0] === 0x50 && b[1] === 0x4b) return 'zip'; // "PK"
	if (b[0] === 0x67 && b[1] === 0x6c && b[2] === 0x54 && b[3] === 0x46) return 'glb'; // "glTF"
	if (b[0] === 0x4d && b[1] === 0x4d) return '3ds'; // 0x4D4D main chunk
	const head = new TextDecoder().decode(b.subarray(0, Math.min(b.length, 1024))).trimStart();
	if (head.startsWith('<?xml') || head.startsWith('<COLLADA')) {
		return /COLLADA/i.test(new TextDecoder().decode(b.subarray(0, Math.min(b.length, 4096)))) ? 'dae' : 'xml';
	}
	if (head.startsWith('{')) return 'gltf';
	return 'obj';
}

function imageMime(bytes) {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
	if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
	if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
	return 'application/octet-stream';
}

const WHITE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

const normPath = (p) => {
	const out = [];
	for (const part of p.replace(/\\/g, '/').split('/')) {
		if (part === '' || part === '.') continue;
		if (part === '..') out.pop(); else out.push(part);
	}
	return out.join('/');
};
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const extOf = (p) => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '');

// ---------------------------------------------------------------------------
// In-memory entry store
// ---------------------------------------------------------------------------

/** A set of in-memory files addressable by path, served to loaders as blob URLs. */
export class EntryStore {
	constructor(entries = new Map()) {
		this.entries = entries; // Map<path, Uint8Array>
		this.urls = new Map();
		this.manager = new THREE.LoadingManager();
		// Loaders request "mem:<path>"; we answer with a blob URL for those bytes.
		this.manager.setURLModifier((url) => {
			if (!url.startsWith('mem:')) return url;
			const path = this.find(url.slice(4));
			// A missing texture becomes a 1x1 white pixel rather than a failed request.
			return path ? this.url(path) : WHITE_PIXEL;
		});
	}

	static fromZip(bytes) {
		let files;
		try { files = unzipSync(bytes); } catch (e) { throw new UserError('This file is not a valid ZIP archive.'); }
		const m = new Map();
		for (const [k, v] of Object.entries(files)) if (!k.endsWith('/')) m.set(k, v);
		return new EntryStore(m);
	}

	get(path) { const p = this.find(path); return p ? this.entries.get(p) : null; }

	/**
	 * Finds an entry: exact, URL-decoded (Sweet Home 3D encodes spaces as %20
	 * in model paths), case-insensitive, by file name only, and finally by file
	 * name ignoring the extension (an MTL may say .jpg for a .png).
	 */
	find(path) {
		if (!path) return null;
		const candidates = [normPath(path)];
		try { const d = normPath(decodeURIComponent(path)); if (d !== candidates[0]) candidates.push(d); } catch { /* not encoded */ }
		for (const p of candidates) if (this.entries.has(p)) return p;
		const keys = [...this.entries.keys()];
		for (const p of candidates) {
			const lower = p.toLowerCase();
			const k = keys.find((k) => k.toLowerCase() === lower);
			if (k) return k;
		}
		for (const p of candidates) {
			const base = baseName(p.toLowerCase());
			const k = keys.find((k) => baseName(k.toLowerCase()) === base);
			if (k) return k;
		}
		for (const p of candidates) {
			const stem = (s) => baseName(s.toLowerCase()).replace(/\.[^.]*$/, '');
			const dir = dirOf(p.toLowerCase());
			const k = keys.find((k) => dirOf(k.toLowerCase()) === dir && stem(k) === stem(p));
			if (k) return k;
		}
		return null;
	}

	url(path) {
		if (!this.urls.has(path)) {
			const bytes = this.entries.get(path);
			this.urls.set(path, URL.createObjectURL(new Blob([bytes], { type: imageMime(bytes) })));
		}
		return this.urls.get(path);
	}

	dispose() { for (const u of this.urls.values()) URL.revokeObjectURL(u); this.urls.clear(); }
}

// ---------------------------------------------------------------------------
// Materials: Lambert everywhere, Phong only where the model asks for shininess
// ---------------------------------------------------------------------------

function simplifyMaterial(src) {
	if (src.userData?.simplified) return src;
	const opacity = src.opacity ?? 1;
	const params = {
		name: src.name, color: src.color ? src.color.clone() : new THREE.Color(0xcccccc),
		map: src.map || null, opacity, transparent: src.transparent || opacity < 1,
		alphaTest: src.alphaTest || 0, side: src.side ?? THREE.FrontSide,
		vertexColors: !!src.vertexColors,
	};
	if (params.map) params.map.colorSpace = THREE.SRGBColorSpace;
	const shiny = src.isMeshPhongMaterial && src.shininess > 1 && src.specular && (src.specular.r + src.specular.g + src.specular.b) > 0.15;
	const m = shiny ? new THREE.MeshPhongMaterial({ ...params, shininess: src.shininess, specular: src.specular.clone() }) : new THREE.MeshLambertMaterial(params);
	if (m.transparent) m.depthWrite = false;
	m.userData.simplified = true;
	return m;
}

function simplifyMaterials(obj) {
	const seen = new Map();
	const conv = (m) => { if (!seen.has(m)) seen.set(m, simplifyMaterial(m)); return seen.get(m); };
	obj.traverse((o) => {
		if (!o.isMesh) return;
		o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material || new THREE.MeshLambertMaterial());
		o.castShadow = o.receiveShadow = false;
	});
	return obj;
}

// ---------------------------------------------------------------------------
// Model loading from entries
// ---------------------------------------------------------------------------

const MODEL_EXTS = ['obj', 'glb', 'gltf', 'dae', '3ds'];

/** Loads a model from an entry path; the format is detected from its bytes. */
export async function loadModelEntry(store, path) {
	const bytes = store.get(path);
	if (!bytes) throw new Error(`Missing entry ${path}`);
	const kind = sniff(bytes);
	if (kind === 'zip') {
		// Nested zip: find the model inside it.
		const inner = EntryStore.fromZip(bytes);
		const main = findMainModel([...inner.entries.keys()], inner);
		if (!main) throw new Error(`No model inside ${path}`);
		try { return await loadModelEntry(inner, main); } finally { /* blob URLs stay alive for textures */ }
	}
	const folder = dirOf(store.find(path));
	const base = `mem:${folder}`;
	switch (kind) {
		case 'glb':
		case 'gltf': {
			const loader = new GLTFLoader(store.manager);
			const data = kind === 'glb' ? bytes.slice().buffer : new TextDecoder().decode(bytes);
			const gltf = await loader.parseAsync(data, base);
			return simplifyMaterials(gltf.scene);
		}
		case 'dae': {
			const loader = new ColladaLoader(store.manager);
			const collada = loader.parse(new TextDecoder().decode(bytes), base);
			return simplifyMaterials(collada.scene);
		}
		case '3ds': {
			const loader = new TDSLoader(store.manager);
			loader.setResourcePath(base);
			return simplifyMaterials(loader.parse(bytes.slice().buffer, base));
		}
		default:
			return loadObj(store, new TextDecoder().decode(bytes), folder);
	}
}

/**
 * Prepares OBJ text for three.js's OBJLoader:
 *
 * 1. Removes line ("l") and point ("p") records. A single stray "l" record
 *    makes OBJLoader turn a whole object into LineSegments; Sweet Home 3D
 *    ignores them, and we never draw lines anyway.
 * 2. Triangulates faces with 4+ corners properly. OBJLoader splits polygons
 *    into a fan from the first corner, which only works for convex shapes:
 *    on a U-shaped face (e.g. Sweet Home 3D's door frame) the fan fills in
 *    the doorway. Concave quads and all larger polygons go through earcut.
 */
export function prepareObjText(text) {
	const verts = [];
	const out = [];
	const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
	for (const line of text.split(/\r?\n/)) {
		const t = line.trimStart();
		if (t.startsWith('v ')) {
			const p = t.split(/\s+/);
			verts.push(new THREE.Vector3(+p[1], +p[2], +p[3]));
		} else if (/^[lp]\s/.test(t)) {
			continue;
		} else if (t.startsWith('f ')) {
			const toks = t.split(/\s+/).slice(1).filter(Boolean);
			if (toks.length >= 4) {
				const tris = triangulateFace(toks, verts, a, b, c);
				if (tris) { for (const tri of tris) out.push(`f ${tri.join(' ')}`); continue; }
			}
		}
		out.push(line);
	}
	return out.join('\n');
}

/** Returns triangles (arrays of 3 face tokens) for an OBJ polygon, or null to keep it as is. */
function triangulateFace(toks, verts, a, b, c) {
	const pts = toks.map((tok) => {
		const i = parseInt(tok, 10);
		return verts[i < 0 ? verts.length + i : i - 1];
	});
	if (pts.some((p) => !p)) return null;
	// Polygon normal (Newell's method)
	const n = new THREE.Vector3();
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i], q = pts[(i + 1) % pts.length];
		n.x += (p.y - q.y) * (p.z + q.z);
		n.y += (p.z - q.z) * (p.x + q.x);
		n.z += (p.x - q.x) * (p.y + q.y);
	}
	if (n.lengthSq() === 0) return null;
	const faces = (idx) => idx.map((tri) => {
		// Keep each triangle facing the same way as the polygon.
		const [i, j, k] = tri;
		a.subVectors(pts[j], pts[i]); b.subVectors(pts[k], pts[i]);
		return c.crossVectors(a, b).dot(n) < 0 ? [toks[i], toks[k], toks[j]] : [toks[i], toks[j], toks[k]];
	});
	if (pts.length === 4) {
		// Convex quad: the usual split works; otherwise split along the other diagonal.
		const ok = (i, j, k) => { a.subVectors(pts[j], pts[i]); b.subVectors(pts[k], pts[i]); return c.crossVectors(a, b).dot(n) > 0; };
		if (ok(0, 1, 2) && ok(0, 2, 3)) return null;
		return faces([[1, 2, 3], [1, 3, 0]]);
	}
	// Project on the plane most facing the normal, then earcut.
	const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
	const flat = pts.map((p) => (az >= ax && az >= ay ? new THREE.Vector2(p.x, p.y) : ax >= ay ? new THREE.Vector2(p.y, p.z) : new THREE.Vector2(p.z, p.x)));
	let idx;
	try { idx = THREE.ShapeUtils.triangulateShape(flat, []); } catch { return null; }
	if (!idx || idx.length < pts.length - 2) return null;
	return faces(idx);
}

async function loadObj(store, text, folder) {
	text = prepareObjText(text);
	const objLoader = new OBJLoader(store.manager);
	const mtlNames = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
	for (const name of mtlNames) {
		const mtlBytes = store.get(folder + name);
		if (!mtlBytes) continue;
		const mtl = new MTLLoader(store.manager);
		const creator = mtl.parse(new TextDecoder().decode(mtlBytes), `mem:${folder}`);
		creator.preload();
		objLoader.setMaterials(creator);
		break; // OBJLoader supports a single material library
	}
	return simplifyMaterials(objLoader.parse(text));
}

function findMainModel(paths, store) {
	const byExt = (ext) => paths.find((p) => extOf(p) === ext && !p.startsWith('__MACOSX/'));
	for (const ext of MODEL_EXTS) { const p = byExt(ext); if (p) return p; }
	// Sweet Home 3D entries may have no extension: sniff them.
	for (const p of paths) { const k = sniff(store.entries.get(p)); if (['glb', 'dae', '3ds'].includes(k)) return p; }
	return null;
}

// ---------------------------------------------------------------------------
// Public entry point: open what the user picked or downloaded
// ---------------------------------------------------------------------------

export const UNIT_SCALE = { cm: 0.01, m: 1, mm: 0.001, in: 0.0254 };

/**
 * Opens one or more files.
 * @param files  [{ name, bytes: Uint8Array }]
 * @param opts   { units: 'auto'|'cm'|'m'|'mm'|'in', onProgress(text) }
 * @returns { kind: 'sh3d'|'model', root, bounds, observer, stats, store }
 */
export async function openFiles(files, opts = {}) {
	if (!files.length) throw new UserError('No file selected.');
	const progress = opts.onProgress || (() => {});

	let store;
	let mainPath = null;
	if (files.length === 1 && sniff(files[0].bytes) === 'zip') {
		progress('Unzipping…');
		store = EntryStore.fromZip(files[0].bytes);
		if (store.entries.has('Home.xml')) return openSh3d(store, progress);
		if (store.entries.has('Home')) throw new UserError('Re-save this file in Sweet Home 3D 5.3 or later.');
		mainPath = findMainModel([...store.entries.keys()], store);
		if (!mainPath) throw new UserError('No 3D model (.sh3d, .obj, .glb, .dae, .3ds) found inside this ZIP.');
	} else {
		store = new EntryStore(new Map(files.map((f) => [f.name, f.bytes])));
		const names = files.map((f) => f.name);
		mainPath = names.find((n) => MODEL_EXTS.includes(extOf(n))) || names.find((n) => ['glb', 'dae', '3ds'].includes(sniff(store.entries.get(n)))) || names[0];
	}

	progress('Loading model…');
	const object = await loadModelEntry(store, mainPath);
	const fmt = sniff(store.get(mainPath));
	const isMetric = fmt === 'glb' || fmt === 'gltf' || fmt === 'dae'; // glTF is metres; COLLADA declares its own unit
	return placeModel(object, store, { units: isMetric ? 'm' : opts.units || 'auto', name: baseName(mainPath) });
}

async function openSh3d(store, progress) {
	progress('Reading Home.xml…');
	const home = parseHome(new TextDecoder().decode(store.entries.get('Home.xml')));
	const texLoader = new THREE.TextureLoader(store.manager);
	const built = await buildHome(home, {
		loadModel: (ref) => loadModelEntry(store, ref),
		loadTexture: (ref) => (store.find(ref) ? texLoader.load(`mem:${ref}`) : null),
		onProgress: (done, total) => progress(`Loading furniture ${done}/${total}…`),
	});
	return { kind: 'sh3d', ...built, home, store };
}

/** Wraps a generic model: unit conversion, centred on the origin, resting on y = 0. */
function placeModel(object, store, { units, name }) {
	const box = new THREE.Box3().setFromObject(object);
	const size = box.getSize(new THREE.Vector3());
	let unit = units;
	if (unit === 'auto') unit = Math.max(size.x, size.y, size.z) > 100 ? 'cm' : 'm';
	const s = UNIT_SCALE[unit] ?? 1;
	const root = new THREE.Group();
	root.name = name;
	const center = box.getCenter(new THREE.Vector3());
	object.position.set(-center.x, -box.min.y, -center.z);
	const scaled = new THREE.Group();
	scaled.scale.setScalar(s);
	scaled.add(object);
	root.add(scaled);

	const bounds = new THREE.Box3().setFromObject(root);
	const bsize = bounds.getSize(new THREE.Vector3());
	const ground = new THREE.Mesh(new THREE.PlaneGeometry(bsize.x + 6, bsize.z + 6).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xa8a8a8 }));
	ground.position.y = -0.005;
	ground.name = 'ground';
	root.add(ground);
	root.updateMatrixWorld(true);
	return { kind: 'model', root, bounds, observer: null, unit, stats: {}, store };
}
