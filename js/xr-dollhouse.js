// Dollhouse mode (SPEC.md, "XR dollhouse mode"): the home on a plinth in a
// gallery room (VR view) or floating over passthrough (AR view), about
// 1.2 m across. Thumbstick left/right rotates it, up/down zooms; a grip held
// while moving the controller moves it (upright, never into the plinth); the
// laser shows a person-height marker where you point, and the trigger steps
// inside, at 1:1, on that spot. You look down at it as a 2 m tall person
// would, whatever your own height (the head's real height is measured on
// entry, on Recentre and when coming back from walking).
// (On screen this will be called the "scale model", milestone B; the code
// keeps the word dollhouse.)

import * as THREE from 'three';
import { UP } from './xr-targets.js';
import { yawOf } from './xr-input.js';
import { PLINTH_REST, EYE_BELOW_TOP, FIGURE_GAP, buildMarkers } from './xr-scene.js';

const DOLLHOUSE_PERSON = 2.0; // metres
const DOLLHOUSE_LIFT_START = 0.25; // used for the first frames, before the head height is known
const DOLLHOUSE_LIFT_MAX = 1.4; // (lying on the floor is not a case to support)
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const ROTATE_SPEED = 1.6; // rad/s at full stick
const ZOOM_SPEED = 1.2; // e-folds/s at full stick

export class Dollhouse {
	/** xr: the XRExperience. */
	constructor(xr) {
		this.xr = xr;
		this.name = 'dollhouse';
		// The model on the plinth, in stage space: position, turn and zoom.
		this.doll = { pos: new THREE.Vector3(0, PLINTH_REST, -xr.plinthDistance), yaw: 0, zoom: 1 };
		this.dollLift = DOLLHOUSE_LIFT_START; // VR dollhouse lift, from the measured head height
		this.grab = null; // grabbing the model: { c, p0, yaw0, aPos0, aYaw0 }
		this.markers = buildMarkers(); // one "stand here" marker per controller
		xr.hideFromPhotos(...this.markers);
	}

	/** A new model: the markers and the scale figure go into model space (they turn and zoom with it). */
	setModel(model) {
		const xr = this.xr;
		xr.centerer.add(...this.markers, xr.figure);
		// The scale figure stands on the ground just in front of the home's
		// left corner, at the model's scale.
		const b = model.bounds;
		xr.figure.position.set(b.min.x + 0.6, b.min.y, b.max.z + FIGURE_GAP);
		xr.figure.visible = false;
	}

	/** A new session: the model back in the middle, and the view lift for the first frames. */
	begin() {
		this.reset();
		this.dollLift = DOLLHOUSE_LIFT_START;
	}

	reset() {
		this.doll.pos.set(0, PLINTH_REST, -this.xr.plinthDistance);
		this.doll.yaw = 0;
		this.doll.zoom = 1;
	}

	/** measure: take the head height now (false at session start, when there is no pose yet). */
	enter({ measure = true } = {}) {
		const xr = this.xr;
		xr.rig.position.set(0, 0, 0);
		xr.rig.rotation.set(0, 0, 0);
		xr.lift = 0;
		if (measure) this.measureLift(xr.camera.matrix);
		xr.stage.visible = true;
		for (const c of xr.input.controllers) xr.input.setLaser(c, true);
		xr.applyView();
		xr.applyStoreys();
		this.apply();
		xr.ui.setWelcome(xr.ui.welcomeOn);
	}

	/** Leaving the dollhouse (for walking, or the session ended). */
	exit() {
		this.grab = null;
		for (const m of this.markers) m.visible = false;
		this.xr.stage.visible = false;
	}

	/** Places the model from this.doll: on the stage, turned and zoomed. */
	apply() {
		const xr = this.xr;
		const p = xr.stage.localToWorld(this.doll.pos.clone());
		xr.anchor.position.copy(p);
		xr.anchor.rotation.set(0, xr.stage.rotation.y + this.doll.yaw, 0);
		xr.anchor.scale.setScalar(xr.baseScale * this.doll.zoom);
		xr.anchor.updateMatrixWorld(true);
		xr.lighting?.fit(); // the sun follows the model; shadows re-render
	}

	/** Moves the room, plinth and model in front of where the user now stands and looks. */
	recentre(headMatrix = this.xr.camera.matrixWorld) {
		const xr = this.xr;
		const head = new THREE.Vector3().setFromMatrixPosition(headMatrix);
		const yaw = yawOf(headMatrix);
		xr.stage.position.set(head.x, 0, head.z);
		xr.stage.rotation.set(0, yaw, 0);
		xr.stage.updateMatrixWorld(true);
		this.reset();
		this.apply();
	}

	/**
	 * VR dollhouse: works out the lift that puts the eyes where a 2 m tall
	 * person's would be, from the head's real height above the floor.
	 * headLocal: the head pose in tracking space (camera.matrix, or the
	 * viewer pose).
	 */
	measureLift(headLocal) {
		const xr = this.xr;
		const y = new THREE.Vector3().setFromMatrixPosition(headLocal).y;
		// (Ignore nonsense heights: no pose yet, or the 2D camera's position.)
		if (y > 0.3 && y < 2.5) this.dollLift = THREE.MathUtils.clamp(DOLLHOUSE_PERSON - EYE_BELOW_TOP - y, 0, DOLLHOUSE_LIFT_MAX);
		if (xr.mode === 'dollhouse') xr.setLift(xr.vrView ? this.dollLift : 0);
	}

	update(dt) {
		const xr = this.xr, ui = xr.ui, input = xr.input;
		ui.faceWelcome();
		if (ui.buttons()) return;
		const { action } = ui.point();
		const { pointable } = xr.targets();
		let jumpTo = null;
		const markers = [];
		for (const c of input.active()) {
			input.setLaser(c, c.claim.trigger !== 'tool'); // (a hand holding a tool has no laser)
			if (c.claim.trigger === null) {
				input.setRaycaster(c, xr.raycaster);
				const modelHit = xr.raycaster.intersectObjects(pointable, false)[0];
				if (modelHit) {
					input.showHit(c, modelHit.distance);
					const floor = xr.findFloor(modelHit.point, 0.01);
					if (floor) {
						markers[c.index] = floor;
						if (c.state.down.trigger) jumpTo = floor;
					}
				} else {
					input.showHit(c, null);
				}
			}

			// Grip: grab and move the model, keeping it upright (yaw only).
			if (c.state.down.grip && c.claim.grip === null && !this.grab) {
				const p = new THREE.Vector3();
				const yaw = input.pose(c, p);
				this.grab = { c, p0: p, yaw0: yaw, aPos0: xr.anchor.position.clone(), aYaw0: xr.anchor.rotation.y };
			}
			if (this.grab?.c === c && c.state.up.grip) this.grab = null;
		}

		// Actions that leave the dollhouse end this frame's dollhouse update.
		if (jumpTo) { xr.setMode('walk', xr.centerer.worldToLocal(jumpTo.clone()), null); return; }
		if (action) {
			xr.menuAction(action);
			if (xr.mode !== 'dollhouse' || !xr.session) return;
		}

		// One "stand here" marker per controller.
		this.markers.forEach((m, i) => {
			m.visible = !!markers[i];
			if (markers[i]) m.position.copy(xr.centerer.worldToLocal(markers[i].clone()));
		});

		// A controller that drops out mid-grab (battery, tracking) lets go.
		if (this.grab && (!this.grab.c.source || !this.grab.c.state.grip)) this.grab = null;
		if (this.grab) {
			const p = new THREE.Vector3();
			const yaw = input.pose(this.grab.c, p);
			const dy = yaw - this.grab.yaw0;
			const off = this.grab.aPos0.clone().sub(this.grab.p0).applyAxisAngle(UP, dy);
			const world = p.add(off);
			this.doll.pos.copy(xr.stage.worldToLocal(world));
			this.doll.yaw = this.grab.aYaw0 + dy - xr.stage.rotation.y;
			// Never push it into the plinth (or, off the plinth, below the floor).
			const { W, D } = xr.plinthSize;
			const onPlinth = xr.vrView && Math.abs(this.doll.pos.x) < W / 2 && Math.abs(this.doll.pos.z + xr.plinthDistance) < D / 2;
			this.doll.pos.y = Math.max(this.doll.pos.y, onPlinth ? PLINTH_REST : 0);
		}

		// Thumbsticks: left/right rotates, up/down zooms (either controller).
		let sx = 0, sy = 0;
		for (const c of input.active()) { sx += c.state.stick.x; sy += c.state.stick.y; }
		if (sx) this.doll.yaw -= sx * ROTATE_SPEED * dt;
		if (sy) this.doll.zoom = THREE.MathUtils.clamp(this.doll.zoom * Math.exp(-sy * ZOOM_SPEED * dt), ZOOM_MIN, ZOOM_MAX);
		this.apply();
	}
}

