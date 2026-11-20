// Solid walls and see-through (js/walls.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import { WallCollider, SeeThrough, SEE_THROUGH_MAX } from '../js/walls.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

/** A wall box (metres) from x0 to x1, centred on z, 15 cm thick, 2.5 m tall, floor at y = 0. */
function wall(x0, x1, z) {
	const g = new THREE.BoxGeometry(x1 - x0, 2.5, 0.15).translate((x0 + x1) / 2, 1.25, z);
	g.computeBoundsTree();
	return new THREE.Mesh(g, new THREE.MeshLambertMaterial());
}

const walk = (c, from, to) => c.move(new THREE.Vector3(...from), new THREE.Vector3(...to), 0, 1.6);

test('walking into a wall stops a body radius in front of it, even in one long move', () => {
	const c = new WallCollider();
	c.setMeshes([wall(-3, 3, -1)]);
	const p = walk(c, [0, 1.6, 0], [0, 1.6, -3]);
	assert.ok(Math.abs(p.z - (-1 + 0.075 + 0.2)) < 0.01, `stopped at z ${p.z.toFixed(3)}`);
	assert.ok(Math.abs(p.x) < 1e-6);
});

test('a slanting walk slides along the wall', () => {
	const c = new WallCollider();
	c.setMeshes([wall(-3, 3, -1)]);
	const p = walk(c, [0, 1.6, -0.6], [1, 1.6, -1.6]);
	assert.ok(p.x > 0.9, `slid to x ${p.x.toFixed(2)}`);
	assert.ok(p.z > -0.73, `still out of the wall, z ${p.z.toFixed(3)}`);
});

test('a 0.9 m doorway lets you through; the wall beside it does not', () => {
	const c = new WallCollider();
	c.setMeshes([wall(-3, -0.45, -1), wall(0.45, 3, -1)]);
	assert.ok(walk(c, [0, 1.6, 0], [0, 1.6, -2]).z < -1.99, 'through the doorway');
	assert.ok(walk(c, [1.5, 1.6, 0], [1.5, 1.6, -2]).z > -0.73, 'stopped by the wall');
});

test('a wall high above the head (a lintel) does not block', () => {
	const c = new WallCollider();
	const g = new THREE.BoxGeometry(2, 0.3, 0.15).translate(0, 2.25, -1);
	g.computeBoundsTree();
	c.setMeshes([new THREE.Mesh(g)]);
	assert.ok(walk(c, [0, 1.6, 0], [0, 1.6, -2]).z < -1.99);
});

test('example home: walking at a merged wall stops in front of it', async () => {
	const fs = await import('node:fs');
	const path = await import('node:path');
	const { unzipSync } = await import('fflate');
	const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
	const { parseHome, buildHome } = await import('../js/sh3d.js');
	const { prepareObjText } = await import('../js/formats.js');
	const { optimiseModel } = await import('../js/optimise.js');
	const entries = unzipSync(new Uint8Array(fs.readFileSync(path.resolve(import.meta.dirname, '../examples/example-home.sh3d'))));
	const home = parseHome(new TextDecoder().decode(entries['Home.xml']));
	const built = await buildHome(home, { loadModel: async (ref) => new OBJLoader().parse(prepareObjText(new TextDecoder().decode(entries[ref])).replace(/^\s*mtllib.*$/gm, '')) });
	const { group, layers } = optimiseModel(built.root);
	group.position.set(3, 0, -2); // somewhere off the origin, as in the headset
	group.updateMatrixWorld(true);
	const walls = layers.walls.children.filter((m) => (m.userData.storey ?? 0) === 0);
	const c = new WallCollider();
	c.setMeshes(walls);
	// From the middle of the ground floor, the nearest wall at chest height.
	const box = new THREE.Box3().setFromObject(layers.floors);
	const start = box.getCenter(new THREE.Vector3()).setY(box.min.y + 1.6);
	const ray = new THREE.Raycaster();
	let best = null;
	for (let i = 0; i < 72; i++) {
		const a = i / 72 * Math.PI * 2, dir = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
		ray.set(start.clone().setY(box.min.y + 1), dir);
		const h = ray.intersectObjects(walls, false)[0];
		if (h && h.distance > 0.4 && (!best || h.distance < best.d)) best = { dir, d: h.distance };
	}
	assert.ok(best, 'a wall around the middle of the ground floor');
	const to = start.clone().addScaledVector(best.dir, best.d + 1);
	const p = c.move(start, to, box.min.y, start.y);
	const went = p.clone().sub(start).dot(best.dir);
	assert.ok(went > best.d - 0.3 && went < best.d - 0.15, `wall at ${best.d.toFixed(2)} m, stopped after ${went.toFixed(2)} m`);
});

test('no walls: the collider is inactive and moves freely', () => {
	const c = new WallCollider();
	c.setMeshes([]);
	assert.equal(c.active, false);
	assert.ok(walk(c, [0, 1.6, 0], [0, 1.6, -2]).z < -1.99);
});

test('see-through fades walls and furniture only, and restores them exactly', () => {
	const shared = new THREE.MeshLambertMaterial({ color: 0xffffff });
	const glass = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.4 });
	const layer = (...meshes) => { const g = new THREE.Group(); if (meshes.length) g.add(...meshes); return g; };
	const wallMesh = new THREE.Mesh(new THREE.BufferGeometry(), shared);
	const window = new THREE.Mesh(new THREE.BufferGeometry(), glass);
	const floor = new THREE.Mesh(new THREE.BufferGeometry(), shared);
	const s = new SeeThrough();
	s.setModel({ walls: layer(wallMesh), main: layer(window), floors: layer(floor), ceilings: layer(), ground: layer() });
	assert.notEqual(wallMesh.material, shared, 'the wall got its own copy of the shared material');
	assert.equal(floor.material, shared);
	s.set(1);
	assert.ok(Math.abs(wallMesh.material.opacity - (1 - SEE_THROUGH_MAX)) < 1e-9);
	assert.equal(wallMesh.material.transparent, true);
	assert.equal(wallMesh.material.depthWrite, false);
	assert.ok(Math.abs(window.material.opacity - 0.4 * (1 - SEE_THROUGH_MAX)) < 1e-9, 'glass fades from its own opacity');
	assert.equal(floor.material.opacity, 1);
	assert.equal(floor.material.transparent, false);
	s.restore();
	assert.equal(wallMesh.material.opacity, 1);
	assert.equal(wallMesh.material.transparent, false);
	assert.equal(wallMesh.material.depthWrite, true);
	assert.equal(window.material.opacity, 0.4);
	assert.equal(window.material.transparent, true);
});
