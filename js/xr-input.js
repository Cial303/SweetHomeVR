// XR controllers: laser rays, simple controller bodies, and per-frame
// button/thumbstick state with press/release edges.
//
// Quest controllers use the WebXR "xr-standard" gamepad mapping:
//   buttons[0] trigger, [1] grip (squeeze), [3] thumbstick press,
//   [4] A (right) / X (left), [5] B (right) / Y (left)
//   axes[2], axes[3] thumbstick x / y (y is negative when pushed forward)
// Teleport arc and snap turn are added in phase 3 (walk mode).

import * as THREE from 'three';

const DEADZONE = 0.2;
const RAY_LENGTH = 5;

export class XRInput {
	constructor(renderer, rig) {
		this.renderer = renderer;
		this.hands = { left: null, right: null };
		this.controllers = [];
		const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
		const bodyGeo = new THREE.BoxGeometry(0.035, 0.03, 0.11).translate(0, -0.005, 0.03);
		const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2b3036 });

		for (let i = 0; i < 2; i++) {
			const ray = renderer.xr.getController(i); // target-ray space
			const grip = renderer.xr.getControllerGrip(i); // where the hand holds it
			rig.add(ray, grip);

			const line = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
			line.scale.z = RAY_LENGTH;
			line.visible = false;
			ray.add(line);
			const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd9822b }));
			dot.visible = false;
			ray.add(dot);
			grip.add(new THREE.Mesh(bodyGeo, bodyMat));

			const c = { index: i, ray, grip, line, dot, source: null, handedness: null, state: emptyState() };
			ray.addEventListener('connected', (e) => {
				c.source = e.data;
				c.handedness = e.data.handedness;
				c.isController = !!e.data.gamepad && !e.data.hand;
				line.visible = c.isController;
				this.hands[c.handedness] = c;
			});
			ray.addEventListener('disconnected', () => {
				if (this.hands[c.handedness] === c) this.hands[c.handedness] = null;
				c.source = null;
				line.visible = false;
				dot.visible = false;
			});
			this.controllers.push(c);
		}
		this._m = new THREE.Matrix4();
	}

	/** Reads gamepads; call once per frame. */
	update() {
		for (const c of this.controllers) {
			const gp = c.source?.gamepad;
			const prev = c.state;
			const s = emptyState();
			if (gp) {
				const pressed = (i) => !!gp.buttons[i]?.pressed;
				s.trigger = pressed(0);
				s.grip = pressed(1);
				s.stickPress = pressed(3);
				s.a = pressed(4); // A or X
				s.b = pressed(5); // B or Y
				const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
				const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
				s.stick.set(Math.abs(ax) > DEADZONE ? ax : 0, Math.abs(ay) > DEADZONE ? ay : 0);
			}
			for (const k of ['trigger', 'grip', 'stickPress', 'a', 'b']) {
				s.down[k] = s[k] && !prev[k];
				s.up[k] = !s[k] && prev[k];
			}
			c.state = s;
		}
	}

	/** Active controllers (connected, with a gamepad). */
	active() { return this.controllers.filter((c) => c.source && c.isController); }

	/** Sets a raycaster from a controller's laser. */
	setRaycaster(c, raycaster) {
		c.ray.updateMatrixWorld(true);
		this._m.identity().extractRotation(c.ray.matrixWorld);
		raycaster.ray.origin.setFromMatrixPosition(c.ray.matrixWorld);
		raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._m).normalize();
		raycaster.far = RAY_LENGTH;
	}

	/** Shortens a laser to its hit distance and shows the hit dot (or hides it). */
	showHit(c, distance) {
		if (distance == null) {
			c.line.scale.z = RAY_LENGTH;
			c.dot.visible = false;
		} else {
			c.line.scale.z = distance;
			c.dot.position.set(0, 0, -distance);
			c.dot.visible = true;
		}
	}

	/** Controller world position and yaw (rotation about the vertical axis). */
	pose(c, outPos) {
		c.grip.updateMatrixWorld(true);
		outPos.setFromMatrixPosition(c.grip.matrixWorld);
		return yawOf(c.grip.matrixWorld);
	}

	setVisible(v) {
		for (const c of this.controllers) { c.ray.visible = v; c.grip.visible = v; }
	}
}

function emptyState() {
	return { trigger: false, grip: false, stickPress: false, a: false, b: false, stick: new THREE.Vector2(), down: {}, up: {} };
}

const _fwd = new THREE.Vector3();
/** Yaw (like Object3D.rotation.y) of a world matrix's forward (-Z) direction. */
export function yawOf(matrixWorld) {
	_fwd.set(0, 0, -1).transformDirection(matrixWorld);
	return Math.atan2(-_fwd.x, -_fwd.z);
}
