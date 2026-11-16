// XR session and modes (SPEC.md, "Experience and controls").
//
//   dollhouse  the home on a pedestal (VR showroom) or floating (AR):
//              thumbstick rotate/zoom, grip to move, laser + trigger to jump
//              in at 1:1, floating menu (Walk in, Ceilings, Recentre, Exit).
//   walk       the home at 1:1. Phase 2: you stand where you pointed;
//              B or Y returns to the dollhouse. Locomotion comes in phase 3.
//
// Scene graph (owned by main.js):
//   scene
//   ├─ rig ─ camera, controllers      moved to place the user in walk mode
//   └─ anchor ─ centerer ─ model      anchor: dollhouse position/yaw/scale
//                                     centerer: puts the model's bottom-centre at the origin

import * as THREE from 'three';
import { Panel } from './panel.js';
import { XRInput, yawOf } from './xr-input.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const PEDESTAL_HEIGHT = 0.85;
const PEDESTAL_DISTANCE = 1.0;
const DOLLHOUSE_SIZE = 1.2; // metres across
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const ROTATE_SPEED = 1.6; // rad/s at full stick
const ZOOM_SPEED = 1.2; // e-folds/s at full stick

export class XRExperience {
	/**
	 * @param opts.renderer, opts.scene, opts.camera, opts.rig, opts.anchor, opts.centerer
	 * @param opts.onEnd()  called after the session ends (2D page restores its view)
	 */
	constructor({ renderer, scene, camera, rig, anchor, centerer, onEnd }) {
		Object.assign(this, { renderer, scene, camera, rig, anchor, centerer, onEnd });
		this.model = null; // { group, layers, bounds, observer, home }
		this.session = null;
		this.sessionMode = null; // 'vr' | 'ar'
		this.mode = null; // 'dollhouse' | 'walk'
		this.doll = { pos: new THREE.Vector3(0, PEDESTAL_HEIGHT, -PEDESTAL_DISTANCE), yaw: 0, zoom: 1 };
		this.grab = null;
		this.raycaster = new THREE.Raycaster();
		this.raycaster.firstHitOnly = true;
		this.input = new XRInput(renderer, rig);
		this.input.setVisible(false);
		this.buildShowroom();
		this.buildMarker();
	}

	// -----------------------------------------------------------------------
	// Scene pieces
	// -----------------------------------------------------------------------

	buildShowroom() {
		// Calm, minimal room: light floor with a faint grid, soft gradient sky.
		const room = new THREE.Group();
		room.name = 'showroom';
		const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xeceef0 }));
		const grid = new THREE.GridHelper(28, 56, 0xb9c0c7, 0xd3d8dd);
		grid.material.transparent = true;
		grid.material.opacity = 0.35;
		grid.position.y = 0.002;
		const skyGeo = new THREE.SphereGeometry(40, 32, 16);
		const colors = [];
		const top = new THREE.Color(0xb7cde0), horizon = new THREE.Color(0xf5f7f9);
		const pos = skyGeo.attributes.position;
		for (let i = 0; i < pos.count; i++) {
			const t = Math.max(0, pos.getY(i) / 40);
			const c = horizon.clone().lerp(top, Math.pow(t, 0.7));
			colors.push(c.r, c.g, c.b);
		}
		skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
		const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }));
		room.add(sky, floor, grid);
		room.visible = false;
		this.showroom = room;
		this.scene.add(room);

		// Stage: what Recentre moves (pedestal + menu), positioned relative to the user.
		this.stage = new THREE.Group();
		this.stage.name = 'stage';
		const pedestal = new THREE.Group();
		const body = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, PEDESTAL_HEIGHT - 0.02, 64), new THREE.MeshLambertMaterial({ color: 0xffffff }));
		body.position.y = (PEDESTAL_HEIGHT - 0.02) / 2;
		const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.02, 64), new THREE.MeshLambertMaterial({ color: 0xf3f4f6 }));
		cap.position.y = PEDESTAL_HEIGHT - 0.01;
		pedestal.add(body, cap);
		pedestal.position.set(0, 0, -PEDESTAL_DISTANCE);
		this.pedestal = pedestal;

		this.panel = new Panel([
			{ id: 'walk', label: 'Walk in' },
			{ id: 'ceilings', label: 'Ceilings: on' },
			{ id: 'recentre', label: 'Recentre' },
			{ id: 'exit', label: 'Exit' },
		], { title: 'Sweet Home VR' });
		this.panel.mesh.position.set(-0.95, 1.2, -0.6);
		this.stage.add(pedestal, this.panel.mesh);
		this.stage.visible = false;
		this.scene.add(this.stage);
		// Face the panel towards the user's default standing spot.
		this.panel.mesh.lookAt(0, 1.45, 0);
	}

	buildMarker() {
		// Person-height marker, in real metres; it lives in model space so it
		// scales with the dollhouse.
		const m = new THREE.Group();
		const mat = new THREE.MeshLambertMaterial({ color: 0xd9822b, transparent: true, opacity: 0.9, depthTest: true });
		const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 1.3, 20), mat);
		body.position.y = 0.65;
		const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 12), mat);
		head.position.y = 1.55;
		const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd9822b, side: THREE.DoubleSide }));
		ring.position.y = 0.02;
		m.add(body, head, ring);
		m.visible = false;
		m.name = 'marker';
		this.markers = [m, m.clone()]; // one per controller
	}

	// -----------------------------------------------------------------------
	// Model and session
	// -----------------------------------------------------------------------

	/** model: { group, layers, bounds (Box3, model space, no ground), observer } */
	setModel(model) {
		this.model = model;
		this.centerer.add(...this.markers);
		const size = model.bounds.getSize(new THREE.Vector3());
		this.baseScale = DOLLHOUSE_SIZE / Math.max(size.x, size.z, 0.01);
		this.panel.setLabel('ceilings', `Ceilings: ${model.layers.ceilings.visible ? 'on' : 'off'}`);
	}

	static async supported() {
		const xr = navigator.xr;
		if (!xr) return { vr: false, ar: false };
		const check = (m) => xr.isSessionSupported(m).catch(() => false);
		const [vr, ar] = await Promise.all([check('immersive-vr'), check('immersive-ar')]);
		return { vr, ar };
	}

	async start(kind) {
		if (!this.model || this.session) return;
		const session = await navigator.xr.requestSession(kind === 'ar' ? 'immersive-ar' : 'immersive-vr', {
			requiredFeatures: ['local-floor'],
			optionalFeatures: ['bounded-floor'],
		});
		this.renderer.xr.setReferenceSpaceType('local-floor');
		this.renderer.xr.setFramebufferScaleFactor(1);
		await this.renderer.xr.setSession(session);
		this.renderer.xr.setFoveation(1);
		this.session = session;
		this.sessionMode = kind;
		this.saved = { background: this.scene.background };
		session.addEventListener('end', () => this.handleEnd());
		this.input.setVisible(true);
		this.stage.position.set(0, 0, 0);
		this.stage.rotation.set(0, 0, 0);
		this.resetDollhouse();
		this.enterDollhouse();
	}

	end() { this.session?.end(); }

	handleEnd() {
		this.session = null;
		this.mode = null;
		this.grab = null;
		this.input.setVisible(false);
		this.showroom.visible = false;
		this.stage.visible = false;
		for (const m of this.markers) m.visible = false;
		this.rig.position.set(0, 0, 0);
		this.rig.rotation.set(0, 0, 0);
		this.anchor.position.set(0, 0, 0);
		this.anchor.rotation.set(0, 0, 0);
		this.anchor.scale.setScalar(1);
		if (this.model) this.model.layers.ground.visible = true;
		this.scene.background = this.saved?.background ?? null;
		this.onEnd?.();
	}

	// -----------------------------------------------------------------------
	// Dollhouse
	// -----------------------------------------------------------------------

	resetDollhouse() {
		this.doll.pos.set(0, PEDESTAL_HEIGHT, -PEDESTAL_DISTANCE);
		this.doll.yaw = 0;
		this.doll.zoom = 1;
	}

	enterDollhouse() {
		this.mode = 'dollhouse';
		this.rig.position.set(0, 0, 0);
		this.rig.rotation.set(0, 0, 0);
		const vr = this.sessionMode === 'vr';
		this.showroom.visible = vr;
		this.pedestal.visible = vr;
		this.stage.visible = true;
		this.scene.background = null; // VR: the showroom sky sphere; AR: passthrough
		this.model.layers.ground.visible = false;
		this.applyDollhouse();
	}

	applyDollhouse() {
		const p = this.stage.localToWorld(this.doll.pos.clone());
		this.anchor.position.copy(p);
		this.anchor.rotation.set(0, this.stage.rotation.y + this.doll.yaw, 0);
		this.anchor.scale.setScalar(this.baseScale * this.doll.zoom);
		this.anchor.updateMatrixWorld(true);
	}

	/** Moves the pedestal and menu in front of where the user now stands and looks. */
	recentre() {
		const head = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld);
		const yaw = yawOf(this.camera.matrixWorld);
		this.stage.position.set(head.x, 0, head.z);
		this.stage.rotation.set(0, yaw, 0);
		this.stage.updateMatrixWorld(true);
		this.resetDollhouse();
		this.applyDollhouse();
	}

	toggleCeilings() {
		const c = this.model.layers.ceilings;
		c.visible = !c.visible;
		this.panel.setLabel('ceilings', `Ceilings: ${c.visible ? 'on' : 'off'}`);
	}

	/** Meshes the laser can hit, and meshes that count as floor. */
	targets() {
		const L = this.model.layers;
		return { pointable: [...L.main.children, ...L.floors.children], floors: [...L.floors.children, ...L.ground.children] };
	}

	/**
	 * Floor under a point: cast straight down (the model is only ever yawed
	 * and uniformly scaled, so "down" in model space is down in the world) and
	 * take the first upward-facing floor hit. Returns a world point or null.
	 */
	findFloor(worldPoint, lift) {
		this.raycaster.set(worldPoint.clone().addScaledVector(UP, lift), DOWN);
		this.raycaster.far = Infinity;
		const hits = this.raycaster.intersectObjects(this.targets().floors, false);
		const h = hits.find((x) => !x.face || x.face.normal.clone().transformDirection(x.object.matrixWorld).y > 0.7);
		return h ? h.point : null;
	}

	updateDollhouse(dt) {
		const { pointable } = this.targets();
		let hover = null;
		let jumpTo = null;
		let action = null;
		const markers = [];
		for (const c of this.input.active()) {
			this.input.setRaycaster(c, this.raycaster);
			const panelHit = this.stage.visible ? this.raycaster.intersectObject(this.panel.mesh, false)[0] : null;
			const modelHit = this.raycaster.intersectObjects(pointable, false)[0];
			if (panelHit) { // the menu is always on top of the model
				this.input.showHit(c, panelHit.distance);
				const id = this.panel.hitTest(panelHit.uv);
				hover ||= id;
				if (c.state.down.trigger && id) action = id;
			} else if (modelHit) {
				this.input.showHit(c, modelHit.distance);
				const floor = this.findFloor(modelHit.point, 0.01);
				if (floor) {
					markers[c.index] = floor;
					if (c.state.down.trigger) jumpTo = floor;
				}
			} else {
				this.input.showHit(c, null);
			}

			// Grip: grab and move the model, keeping it upright (yaw only).
			if (c.state.down.grip && !this.grab) {
				const p = new THREE.Vector3();
				const yaw = this.input.pose(c, p);
				this.grab = { c, p0: p, yaw0: yaw, aPos0: this.anchor.position.clone(), aYaw0: this.anchor.rotation.y };
			}
			if (this.grab?.c === c && c.state.up.grip) this.grab = null;
		}
		this.panel.setHover(hover);

		// Actions that leave the dollhouse end this frame's dollhouse update.
		if (jumpTo) { this.walkAt(this.centerer.worldToLocal(jumpTo.clone()), null); return; }
		if (action) {
			this.menuAction(action);
			if (this.mode !== 'dollhouse' || !this.session) return;
		}

		// One "stand here" marker per controller.
		this.markers.forEach((m, i) => {
			m.visible = !!markers[i];
			if (markers[i]) m.position.copy(this.centerer.worldToLocal(markers[i].clone()));
		});

		if (this.grab) {
			const p = new THREE.Vector3();
			const yaw = this.input.pose(this.grab.c, p);
			const dy = yaw - this.grab.yaw0;
			const off = this.grab.aPos0.clone().sub(this.grab.p0).applyAxisAngle(UP, dy);
			const world = p.add(off);
			this.doll.pos.copy(this.stage.worldToLocal(world));
			this.doll.yaw = this.grab.aYaw0 + dy - this.stage.rotation.y;
		}

		// Thumbsticks: left/right rotates, up/down zooms (either controller).
		let sx = 0, sy = 0;
		for (const c of this.input.active()) { sx += c.state.stick.x; sy += c.state.stick.y; }
		if (sx) this.doll.yaw -= sx * ROTATE_SPEED * dt;
		if (sy) this.doll.zoom = THREE.MathUtils.clamp(this.doll.zoom * Math.exp(-sy * ZOOM_SPEED * dt), ZOOM_MIN, ZOOM_MAX);
		this.applyDollhouse();
	}

	menuAction(id) {
		switch (id) {
			case 'walk': this.walkIn(); break;
			case 'ceilings': this.toggleCeilings(); break;
			case 'recentre': this.recentre(); break;
			case 'exit': this.end(); break;
		}
	}

	// -----------------------------------------------------------------------
	// Walk (1:1)
	// -----------------------------------------------------------------------

	/** Walk in at the Sweet Home 3D observer camera (or the model's centre). */
	walkIn() {
		this.setWalkTransform();
		const obs = this.model.observer;
		let modelPt, yaw = null;
		if (obs) {
			// Plan cm -> model metres: (x, elevation, y)
			const eye = this.centerer.localToWorld(new THREE.Vector3(obs.x / 100, obs.z / 100, obs.y / 100));
			const floor = this.findFloor(eye, 0) || eye.clone().setY(this.centerer.localToWorld(new THREE.Vector3()).y);
			modelPt = this.centerer.worldToLocal(floor.clone());
			yaw = Math.PI - obs.yaw; // Sweet Home 3D yaw -> three.js heading
		} else {
			const c = this.model.bounds.getCenter(new THREE.Vector3());
			const eye = this.centerer.localToWorld(c.setY(this.model.bounds.max.y));
			const floor = this.findFloor(eye, 0.01) || eye.setY(0);
			modelPt = this.centerer.worldToLocal(floor.clone());
		}
		this.walkAt(modelPt, yaw);
	}

	setWalkTransform() {
		this.anchor.position.set(0, 0, 0);
		this.anchor.rotation.set(0, 0, 0);
		this.anchor.scale.setScalar(1);
		this.anchor.updateMatrixWorld(true);
	}

	/** Enters 1:1 standing at a model-space floor point, optionally facing `yaw`. */
	walkAt(modelPt, yaw) {
		this.mode = 'walk';
		this.grab = null;
		for (const m of this.markers) m.visible = false;
		this.showroom.visible = false;
		this.stage.visible = false;
		for (const c of this.input.controllers) this.input.showHit(c, null);
		const ar = this.sessionMode === 'ar';
		this.model.layers.ground.visible = !ar;
		this.scene.background = ar ? null : new THREE.Color(this.model.skyColor ?? 0xcce4fc);
		this.setWalkTransform();
		const target = this.centerer.localToWorld(modelPt.clone());
		this.placeUser(target, yaw);
	}

	/**
	 * Moves the rig so the user's head is above `target` (feet at its height),
	 * facing `yaw` if given, otherwise keeping their current heading.
	 */
	placeUser(target, yaw) {
		const headLocal = new THREE.Vector3().setFromMatrixPosition(this.camera.matrix);
		const headYawLocal = yawOf(this.camera.matrix);
		const heading = yaw ?? (this.rig.rotation.y + headYawLocal);
		this.rig.rotation.set(0, heading - headYawLocal, 0);
		const off = new THREE.Vector3(headLocal.x, 0, headLocal.z).applyAxisAngle(UP, this.rig.rotation.y);
		this.rig.position.set(target.x - off.x, target.y, target.z - off.z);
		this.rig.updateMatrixWorld(true);
	}

	updateWalk() {
		for (const c of this.input.active()) {
			if (c.state.down.b) { this.enterDollhouse(); return; }
		}
	}

	// -----------------------------------------------------------------------

	update(dt) {
		if (!this.session || !this.model) return;
		this.input.update();
		if (this.mode === 'dollhouse') this.updateDollhouse(dt);
		else if (this.mode === 'walk') this.updateWalk(dt);
	}
}
