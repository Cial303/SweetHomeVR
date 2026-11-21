// glTF files: which extensions a file declares (so the right decoders load),
// a plain GLB opening, a KTX2 file opening without its textures, and the
// compressed-glTF decoders being vendored with their licences. Draco decodes
// in workers, so that part runs in the browser (npm run shots checks that the
// decoders start under the page's security policy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gltfExtensions, openFiles, GLTF_COMPRESSION } from '../js/formats.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/** A one-triangle GLB, with extra top-level JSON (e.g. extensionsUsed). */
function makeGlb(extra = {}) {
	const bin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
	const json = {
		asset: { version: '2.0' },
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
		bufferViews: [{ buffer: 0, byteLength: 36 }],
		buffers: [{ byteLength: 36 }],
		...extra,
	};
	let text = JSON.stringify(json);
	while (text.length % 4) text += ' ';
	const jsonBytes = new TextEncoder().encode(text);
	const total = 12 + 8 + jsonBytes.length + 8 + bin.byteLength;
	const out = new Uint8Array(total);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, 0x46546c67, true); // "glTF"
	dv.setUint32(4, 2, true);
	dv.setUint32(8, total, true);
	dv.setUint32(12, jsonBytes.length, true);
	dv.setUint32(16, 0x4e4f534a, true); // "JSON"
	out.set(jsonBytes, 20);
	dv.setUint32(20 + jsonBytes.length, bin.byteLength, true);
	dv.setUint32(24 + jsonBytes.length, 0x004e4942, true); // "BIN"
	out.set(new Uint8Array(bin.buffer), 28 + jsonBytes.length);
	return out;
}

test('gltfExtensions: reads extensionsUsed and extensionsRequired from GLB and glTF', () => {
	const glb = makeGlb({ extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_texture_basisu'], extensionsRequired: ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'] });
	const e = gltfExtensions(glb);
	assert.deepEqual(e.used.sort(), ['EXT_meshopt_compression', 'KHR_draco_mesh_compression', 'KHR_texture_basisu']);
	assert.deepEqual(e.required.sort(), ['EXT_meshopt_compression', 'KHR_draco_mesh_compression']);
	assert.deepEqual(gltfExtensions(makeGlb()), { used: [], required: [] });
	const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_meshopt_compression'] }));
	assert.deepEqual(gltfExtensions(gltf), { used: ['KHR_meshopt_compression'], required: [] });
	// Every compression handled has a name for messages.
	for (const x of ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_meshopt_compression', 'KHR_texture_basisu']) assert.ok(GLTF_COMPRESSION[x], x);
});

test('gltfExtensions: broken or hostile files give empty lists, never an error', () => {
	const none = { used: [], required: [] };
	const glb = makeGlb({ extensionsUsed: ['KHR_texture_basisu'] });
	assert.deepEqual(gltfExtensions(glb.subarray(0, 40)), none); // cut short
	const wrongChunk = glb.slice(); new DataView(wrongChunk.buffer).setUint32(16, 0x12345678, true);
	assert.deepEqual(gltfExtensions(wrongChunk), none);
	assert.deepEqual(gltfExtensions(new TextEncoder().encode('{"extensionsUsed": "not a list"}')), none);
	assert.deepEqual(gltfExtensions(new TextEncoder().encode('{"extensionsUsed": [1, {}, "EXT_x"]}')).used, ['EXT_x']);
	assert.deepEqual(gltfExtensions(new Uint8Array([1, 2, 3])), none);
});

/** The one-triangle GLB with a KTX2 texture (the bytes are never decoded). */
function makeKtx2Glb(required) {
	const ext = { extensionsUsed: ['KHR_texture_basisu'], ...(required ? { extensionsRequired: ['KHR_texture_basisu'] } : {}) };
	return makeGlb({
		...ext,
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], baseColorTexture: { index: 0 } } }],
		textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
		images: [{ uri: 'data:image/ktx2;base64,AAAA' }],
	});
}

test('a GLB whose KTX2 textures are required still opens: plain surfaces in its own colours, with a note', async () => {
	globalThis.self ??= globalThis; // GLTFLoader reads self.URL when it loads a texture (browsers have it)
	const result = await openFiles([{ name: 'ktx2.glb', bytes: makeKtx2Glb(true) }]);
	const meshes = [];
	result.root.traverse((o) => { if (o.isMesh && o.name !== 'ground') meshes.push(o); });
	assert.equal(meshes.length, 1);
	const m = meshes[0].material;
	assert.deepEqual(m.color.toArray().map((v) => Math.round(v * 100) / 100), [1, 0, 0], 'the base colour survives');
	assert.equal(m.map?.image?.width, 1, 'the texture is a white pixel');
	assert.equal(result.store.allNotes().length, 1);
	assert.match(result.store.allNotes()[0], /KTX2 textures can't be shown/);
});

test('a plain GLB opens without loading any decoder', async () => {
	const result = await openFiles([{ name: 'triangle.glb', bytes: makeGlb() }]);
	let tris = 0;
	result.root.traverse((o) => { if (o.isMesh && o.name !== 'ground') tris += o.geometry.attributes.position.count / 3; });
	assert.equal(tris, 1);
	assert.equal(result.unit, 'm'); // glTF is in metres
});

test('the compressed-glTF decoders are vendored, with their licences', () => {
	const libs = path.join(ROOT, 'vendor/three/addons/libs');
	for (const f of ['draco/gltf/draco_wasm_wrapper.js', 'draco/gltf/draco_decoder.wasm', 'draco/LICENSE', 'meshopt_decoder.module.js']) {
		assert.ok(fs.existsSync(path.join(libs, f)), f);
	}
	assert.match(fs.readFileSync(path.join(libs, 'draco/LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
	assert.match(fs.readFileSync(path.join(libs, 'meshopt_decoder.module.js'), 'utf8').slice(0, 300), /MIT License/);
	assert.ok(fs.existsSync(path.join(ROOT, 'vendor/three/addons/loaders/DRACOLoader.js')));
	// The policy forbids JavaScript eval: none of the decoders may need it.
	for (const f of ['draco/gltf/draco_wasm_wrapper.js', 'meshopt_decoder.module.js']) {
		assert.ok(!/\beval\(|new Function\b/.test(fs.readFileSync(path.join(libs, f), 'utf8')), `no eval in ${f}`);
	}
});
