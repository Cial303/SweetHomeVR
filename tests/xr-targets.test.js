// What the lasers, the teleport arc and the feet may hit (js/xr-targets.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { targetSets, findFloor, hitSegment } from '../js/xr-targets.js';

const mat = new THREE.MeshLambertMaterial();
const box = (w, h, d, x, y, z, userData = {}) => {
	const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(x, y, z), mat);
	Object.assign(m.userData, userData);
	m.updateMatrixWorld(true);
	return m;
};
const group = (...children) => { const g = new THREE.Group(); if (children.length) g.add(...children); return g; };

/** A room: a floor, one wall, a table (top at 0.75 m), a door, and the ground. */
function home({ multiLevel = false, rooms = true } = {}) {
	const floor = box(6, 0.02, 6, 0, -0.01, 0);
	const wall = box(6, 2.5, 0.15, 0, 1.25, -3);
	const table = box(1.6, 0.75, 0.8, 1, 0.375, 0);
	const door = box(0.9, 2.1, 0.05, -1, 1.05, -2.9, { opening: true });
	const ground = box(40, 0.02, 40, 0, -0.03, 0);
	const layers = { main: group(table, door), walls: group(wall), floors: rooms ? group(floor) : group(), ground: group(ground), ceilings: group() };
	return { model: { layers, multiLevel }, floor, wall, table, door, ground };
}

const ray = new THREE.Raycaster();
const V = (...a) => new THREE.Vector3(...a);

test('one level: you stand on floors and the ground only; the arc flies through furniture', () => {
	const h = home();
	const t = targetSets(h.model);
	assert.deepEqual(t.walkableList, [h.floor, h.ground]);
	assert.ok(t.walkable.has(h.floor) && !t.walkable.has(h.table));
	assert.ok(t.solid.includes(h.wall) && !t.solid.includes(h.table) && !t.solid.includes(h.door));
	assert.deepEqual(t.pointable, [h.table, h.door, h.wall, h.floor]);
	assert.deepEqual(t.floors, [h.floor, h.ground]);
	// From above the table straight down: lands on the floor, valid.
	const seg = hitSegment(ray, V(1, 1.5, 0), V(1, -0.05, 0), t);
	assert.ok(seg.valid && Math.abs(seg.point.y) < 1e-6, JSON.stringify(seg.point));
});

test('several levels: furniture (and so stairs) can be stood on; doors and windows never stop the arc', () => {
	const h = home({ multiLevel: true });
	const t = targetSets(h.model);
	assert.ok(t.walkable.has(h.table) && !t.walkable.has(h.door));
	assert.ok(t.solid.includes(h.table) && !t.solid.includes(h.door));
	const seg = hitSegment(ray, V(1, 1.5, 0), V(1, -0.05, 0), t);
	assert.ok(seg.valid && Math.abs(seg.point.y - 0.75) < 1e-6, JSON.stringify(seg.point));
});

test('no rooms (OBJ, GLB): anything but walls can be stood on', () => {
	const h = home({ rooms: false });
	const t = targetSets(h.model);
	assert.ok(t.walkable.has(h.table) && t.walkable.has(h.ground) && !t.walkable.has(h.wall) && !t.walkable.has(h.door));
});

test('walls stop the arc and are never a landing; hidden storeys are left out', () => {
	const h = home();
	let t = targetSets(h.model);
	const seg = hitSegment(ray, V(0, 1.2, 0), V(0, 1.2, -4), t);
	assert.ok(seg && !seg.valid && seg.normal.z > 0.9, 'the normal faces the side the arc came from');
	assert.equal(hitSegment(ray, V(0, 1, 0), V(0, 1, 0), t), null, 'a zero-length segment hits nothing');
	h.table.visible = false;
	h.wall.visible = false;
	t = targetSets(h.model);
	assert.ok(!t.pointable.includes(h.table) && !t.solid.includes(h.wall));
	assert.equal(hitSegment(ray, V(0, 1.2, 0), V(0, 1.2, -4), t), null);
});

test('findFloor takes the first upward-facing floor below a point', () => {
	const h = home();
	const t = targetSets(h.model);
	const p = findFloor(ray, t.floors, V(2, 0.4, 1), 0.01);
	assert.ok(p && Math.abs(p.y) < 1e-6 && Math.abs(p.x - 2) < 1e-6);
	assert.equal(findFloor(ray, t.floors, V(30, 0.4, 30), 0.01), null, 'outside the ground: no floor');
});
