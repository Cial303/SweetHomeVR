// Copies the runtime dependencies (libraries and the one font) from
// node_modules into vendor/ so the app never loads anything from a CDN. Run after changing versions in package.json:
//   npm install && npm run vendor
// Only the three.js addons listed in ADDONS are copied, plus every file they
// import through relative paths (followed recursively).

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const nm = path.join(root, 'node_modules');
const vendor = path.join(root, 'vendor');

const ADDONS = [
	'controls/OrbitControls.js',
	'loaders/OBJLoader.js',
	'loaders/MTLLoader.js',
	'loaders/GLTFLoader.js',
	'loaders/ColladaLoader.js',
	'loaders/TDSLoader.js',
	'utils/BufferGeometryUtils.js',
];

function copy(src, dst) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.copyFileSync(src, dst);
}

// Recursively copy a JS module and its relative imports.
function copyModule(srcBase, dstBase, rel, seen = new Set()) {
	if (seen.has(rel)) return;
	seen.add(rel);
	const src = path.join(srcBase, rel);
	copy(src, path.join(dstBase, rel));
	const code = fs.readFileSync(src, 'utf8');
	const re = /(?:import|export)[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
	for (const m of code.matchAll(re)) {
		const spec = m[1] || m[2];
		copyModule(srcBase, dstBase, path.normalize(path.join(path.dirname(rel), spec)), seen);
	}
}

fs.rmSync(vendor, { recursive: true, force: true });

// three.js core (three.module.js imports three.core.js)
copy(path.join(nm, 'three/build/three.module.js'), path.join(vendor, 'three/three.module.js'));
copy(path.join(nm, 'three/build/three.core.js'), path.join(vendor, 'three/three.core.js'));
copy(path.join(nm, 'three/LICENSE'), path.join(vendor, 'three/LICENSE'));
const seen = new Set();
for (const a of ADDONS) copyModule(path.join(nm, 'three/examples/jsm'), path.join(vendor, 'three/addons'), a, seen);

// three-mesh-bvh (single ES module that imports 'three')
copy(path.join(nm, 'three-mesh-bvh/build/index.module.js'), path.join(vendor, 'three-mesh-bvh/index.module.js'));
copy(path.join(nm, 'three-mesh-bvh/LICENSE'), path.join(vendor, 'three-mesh-bvh/LICENSE'));

// fflate (browser ES module build)
copy(path.join(nm, 'fflate/esm/browser.js'), path.join(vendor, 'fflate/fflate.module.js'));
copy(path.join(nm, 'fflate/LICENSE'), path.join(vendor, 'fflate/LICENSE'));

// Kalam, the handwriting font of the welcome notes (SIL Open Font Licence):
// the Latin subset in two weights, so the notes look the same on every device.
for (const weight of [400, 700]) copy(path.join(nm, `@fontsource/kalam/files/kalam-latin-${weight}-normal.woff2`), path.join(vendor, `kalam/kalam-latin-${weight}.woff2`));
copy(path.join(nm, '@fontsource/kalam/LICENSE'), path.join(vendor, 'kalam/LICENSE'));

const versions = Object.fromEntries(['three', 'three-mesh-bvh', 'fflate', '@fontsource/kalam'].map(
	(p) => [p, JSON.parse(fs.readFileSync(path.join(nm, p, 'package.json'), 'utf8')).version]));
fs.writeFileSync(path.join(vendor, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('Vendored', versions, `(${seen.size} three.js addon files)`);
