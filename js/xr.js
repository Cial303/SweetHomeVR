// XR session and modes (SPEC.md, "Experience and controls").
//
//   dollhouse  the home on a plinth (VR showroom) or floating (AR):
//              thumbstick rotate/zoom, grip to move, laser + trigger to jump
//              in at 1:1.
//   walk       the home at 1:1: left stick walks, right stick snap-turns,
//              right stick forward or a held trigger aims a teleport arc,
//              the floor is followed (stairs, levels). B or Y goes back.
//
// Menu: an orb floats over the left hand. Point at it and pull the trigger,
// or press A / X, to open the menu in front of you; it closes on a choice,
// on B / Y, or when you click anywhere else.
//
// Scene graph (owned by main.js):
//   scene
//   ├─ rig ─ camera, controllers, menu   moved to place the user in walk mode
//   └─ anchor ─ centerer ─ model         anchor: dollhouse position/yaw/scale
//                                        centerer: puts the model's bottom-centre at the origin

import * as THREE from 'three';
import { Panel } from './panel.js';
import { XRInput, TeleportArc, yawOf } from './xr-input.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const PLINTH_HEIGHT = 0.75; // table height: you look down onto the model
const PLINTH_MARGIN = 0.4; // table left around the model (it is ~1.2 m across)
const PLINTH_FRONT_GAP = 0.35; // from where you stand to the plinth's front edge
const DOLLHOUSE_SIZE = 1.2; // metres across
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const ROTATE_SPEED = 1.6; // rad/s at full stick
const ZOOM_SPEED = 1.2; // e-folds/s at full stick
const WALK_SPEED = 1.5; // m/s at full stick
const STEP = 0.6; // floor following: look this far above and below the feet
const FADE_OUT = 0.1, FADE_IN = 0.15; // teleport fade, seconds
const MENU_DISTANCE = 0.65, MENU_DROP = 0.08; // summoned menu: in front of, just below the eyes (above the dollhouse)
const SNAP_KEY = 'svr.snapAngle';
const HINT = 'A / X or the left-hand orb';

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
		this.plinthDistance = 1; // centre of the plinth in front of the user; set by buildPlinth()
		this.doll = { pos: new THREE.Vector3(0, PLINTH_HEIGHT, -this.plinthDistance), yaw: 0, zoom: 1 };
		this.grab = null;
		this.tele = null; // teleport being aimed: { c, via: 'stick' | 'trigger', result }
		this.fade = null; // { t, action }
		this.snapReady = true;
		this.snapAngle = Number(safeGet(SNAP_KEY)) === 45 ? 45 : 30;
		this.menuShownOnce = false;
		this.pendingRecentre = false;
		this.raycaster = new THREE.Raycaster();
		this.raycaster.firstHitOnly = true;
		this.floorRay = new THREE.Raycaster(); // all hits, so the first upward face is found
		this.input = new XRInput(renderer, rig);
		this.input.setVisible(false);
		this.buildShowroom();
		this.buildMarker();
		this.buildMenus();
		this.buildOrb();
		this.buildFade();
		this.arc = new TeleportArc(scene);
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

		// Stage: what Recentre moves, positioned relative to the user.
		this.stage = new THREE.Group();
		this.stage.name = 'stage';
		// Museum plinth: sized to the model in setModel(). It stays still and
		// the model turns on it; the 40 cm margin keeps it on the table.
		const pedestal = new THREE.Group();
		pedestal.name = 'plinth';
		this.pedestal = pedestal;
		this.plinthMaterials = {
			top: new THREE.MeshLambertMaterial({ color: 0xffffff }),
			body: new THREE.MeshLambertMaterial({ color: 0xf2f1ee }),
			base: new THREE.MeshLambertMaterial({ color: 0x33383d }),
		};
		this.stage.add(pedestal);
		this.stage.visible = false;
		this.scene.add(this.stage);
		this.buildPlinth(1.2, 0.9);
	}

	/**
	 * A rectangular exhibition plinth for a model footprint of w x d metres:
	 * a thin white top slab, an off-white body, and a dark recessed base
	 * (shadow gap) so it seems to float just above the floor.
	 */
	buildPlinth(w, d) {
		const SLAB = 0.03, GAP = 0.05, INSET = 0.025;
		const W = w + 2 * PLINTH_MARGIN, D = d + 2 * PLINTH_MARGIN, H = PLINTH_HEIGHT;
		this.plinthDistance = D / 2 + PLINTH_FRONT_GAP;
		this.pedestal.position.set(0, 0, -this.plinthDistance);
		const p = this.pedestal;
		for (const m of p.children) m.geometry.dispose();
		p.clear();
		const box = (bw, bh, bd, y, mat) => {
			const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
			m.position.y = y;
			p.add(m);
		};
		const M = this.plinthMaterials;
		box(W, SLAB, D, H - SLAB / 2, M.top);
		box(W - 0.01, H - SLAB - GAP, D - 0.01, GAP + (H - SLAB - GAP) / 2, M.body);
		box(W - 2 * INSET, GAP, D - 2 * INSET, GAP / 2, M.base);
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

	/** One menu per mode; they live in the rig so they travel with the user. */
	buildMenus() {
		this.menus = {
			dollhouse: new Panel([
				{ id: 'walk', label: 'Walk in' },
				{ id: 'ceilings', label: 'Ceilings: on' },
				{ id: 'recentre', label: 'Recentre' },
				{ id: 'exit', label: 'Exit VR' },
			], { title: 'Dollhouse', hint: HINT }),
			walk: new Panel([
				{ id: 'dollhouse', label: 'Dollhouse' },
				{ id: 'ceilings', label: 'Ceilings: on' },
				{ id: 'snap', label: `Turn: ${this.snapAngle}°` },
				{ id: 'exit', label: 'Exit VR' },
			], { title: 'Walking', hint: HINT }),
		};
		for (const p of Object.values(this.menus)) {
			p.mesh.visible = false;
			p.mesh.material.depthTest = false; // never hidden inside a wall
			this.rig.add(p.mesh);
		}
		this.menu = null; // the open Panel, or null
	}

	/** Small glowing orb over the left hand: point and click to open the menu. */
	buildOrb() {
		const orb = new THREE.Group();
		orb.name = 'menu-orb';
		this.orbMat = new THREE.MeshBasicMaterial({ color: 0xd9822b });
		const core = new THREE.Mesh(new THREE.SphereGeometry(0.018, 20, 14), this.orbMat);
		const halo = new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
		// Larger invisible target so the orb is easy to hit with the laser.
		this.orbTarget = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
		orb.add(core, halo, this.orbTarget);
		orb.position.set(0, 0.055, 0.06); // above the back of the hand, toward the wrist
		this.orb = orb;
		this.orbHolder = null;
	}

	/** Black sphere around the head for the teleport fade. */
	buildFade() {
		this.fadeMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 8), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
		this.fadeMesh.renderOrder = 1000;
		this.fadeMesh.visible = false;
		this.fadeMesh.name = 'fade';
		this.camera.add(this.fadeMesh);
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
		this.buildPlinth(size.x * this.baseScale, size.z * this.baseScale);
		this.updateLabels();
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
		// Holding the Meta button re-centres the headset: follow it.
		this.renderer.xr.getReferenceSpace()?.addEventListener?.('reset', () => {
			if (this.mode === 'dollhouse') this.pendingRecentre = true;
		});
		this.input.setVisible(true);
		this.stage.position.set(0, 0, 0);
		this.stage.rotation.set(0, 0, 0);
		this.resetDollhouse();
		this.enterDollhouse();
		// The floor origin is not necessarily where you stand (it can be
		// anywhere in your play area), so place the plinth in front of the
		// head as soon as the first head pose arrives.
		this.pendingRecentre = true;
	}

	end() { this.session?.end(); }

	handleEnd() {
		this.session = null;
		this.mode = null;
		this.grab = null;
		this.tele = null;
		this.fade = null;
		this.pendingRecentre = false;
		this.arc.hide();
		this.closeMenu();
		this.fadeMesh.visible = false;
		this.orb.removeFromParent();
		this.orbHolder = null;
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

	/** The head pose for this frame (rig space), straight from WebXR. */
	viewerMatrix() {
		const frame = this.renderer.xr.getFrame?.();
		const space = this.renderer.xr.getReferenceSpace();
		const pose = frame && space ? frame.getViewerPose(space) : null;
		return pose ? new THREE.Matrix4().fromArray(pose.transform.matrix) : null;
	}

	// -----------------------------------------------------------------------
	// Menu and orb
	// -----------------------------------------------------------------------

	updateLabels() {
		const on = this.model?.layers.ceilings.visible ?? true;
		for (const p of Object.values(this.menus)) p.setLabel('ceilings', `Ceilings: ${on ? 'on' : 'off'}`);
		this.menus.walk.setLabel('snap', `Turn: ${this.snapAngle}°`);
	}

	/** Opens this mode's menu in front of the head (yaw only, tilted to face the eyes). */
	openMenu(headMatrix = this.camera.matrix) {
		this.closeMenu();
		const panel = this.menus[this.mode];
		if (!panel) return;
		const head = new THREE.Vector3().setFromMatrixPosition(headMatrix);
		const yaw = yawOf(headMatrix);
		const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
		panel.mesh.position.copy(head).addScaledVector(fwd, MENU_DISTANCE);
		panel.mesh.position.y -= MENU_DROP;
		this.rig.updateMatrixWorld(true);
		panel.mesh.lookAt(this.rig.localToWorld(head.clone()));
		panel.setHover(null);
		panel.mesh.visible = true;
		this.menu = panel;
	}

	closeMenu() {
		if (this.menu) this.menu.mesh.visible = false;
		this.menu = null;
	}

	toggleMenu() { this.menu ? this.closeMenu() : this.openMenu(); }

	/** Puts the orb on the left controller (or the only one there is). */
	placeOrb() {
		const active = this.input.active();
		const holder = this.input.hands.left?.isController ? this.input.hands.left : active[0] ?? null;
		if (holder === this.orbHolder) return;
		this.orb.removeFromParent();
		if (holder) holder.grip.add(this.orb);
		this.orbHolder = holder;
	}

	/**
	 * Laser vs. orb and menu, for every controller. Clicks are handled here.
	 * Returns the set of controllers whose laser is on the UI this frame (their
	 * trigger belongs to the UI), and the menu action to run, if any.
	 */
	pointUI() {
		const onUI = new Set();
		let hover = null, action = null, orbHot = false, closeIt = false;
		for (const c of this.input.active()) {
			this.input.setRaycaster(c, this.raycaster);
			const menuHit = this.menu ? this.raycaster.intersectObject(this.menu.mesh, false)[0] : null;
			const orbHit = c !== this.orbHolder && this.orb.parent ? this.raycaster.intersectObject(this.orbTarget, false)[0] : null;
			if (menuHit) {
				onUI.add(c);
				this.input.showHit(c, menuHit.distance);
				const id = this.menu.hitTest(menuHit.uv);
				hover ||= id;
				if (c.state.down.trigger && id) action = id;
			} else if (orbHit) {
				onUI.add(c);
				orbHot = true;
				this.input.showHit(c, orbHit.distance);
				if (c.state.down.trigger) closeIt = 'toggle';
			} else if (this.menu && c.state.down.trigger) {
				// Clicking anywhere else closes the menu (and does nothing else).
				onUI.add(c);
				closeIt = true;
			}
		}
		this.menu?.setHover(hover);
		const s = orbHot ? 1.35 : 1 + 0.06 * Math.sin(performance.now() / 300);
		this.orb.scale.setScalar(s);
		this.orbMat.color.set(orbHot ? 0x3d8bfd : 0xd9822b);
		if (closeIt === 'toggle') this.toggleMenu();
		else if (closeIt) this.closeMenu();
		return { onUI, action };
	}

	/** A / X toggles the menu; B / Y closes it. Returns true if a button was used. */
	menuButtons() {
		for (const c of this.input.active()) {
			if (c.state.down.a) { this.toggleMenu(); return true; }
			if (c.state.down.b && this.menu) { this.closeMenu(); return true; }
		}
		return false;
	}

	menuAction(id) {
		switch (id) {
			case 'walk': this.closeMenu(); this.walkIn(); break;
			case 'dollhouse': this.closeMenu(); this.enterDollhouse(); break;
			case 'ceilings': this.toggleCeilings(); break;
			case 'snap':
				this.snapAngle = this.snapAngle === 30 ? 45 : 30;
				safeSet(SNAP_KEY, String(this.snapAngle));
				this.updateLabels();
				break;
			case 'recentre': this.closeMenu(); this.recentre(); break;
			case 'exit': this.closeMenu(); this.end(); break;
		}
	}

	// -----------------------------------------------------------------------
	// Dollhouse
	// -----------------------------------------------------------------------

	resetDollhouse() {
		this.doll.pos.set(0, PLINTH_HEIGHT, -this.plinthDistance);
		this.doll.yaw = 0;
		this.doll.zoom = 1;
	}

	enterDollhouse() {
		this.mode = 'dollhouse';
		this.tele = null;
		this.arc.hide();
		this.closeMenu();
		this.rig.position.set(0, 0, 0);
		this.rig.rotation.set(0, 0, 0);
		this.rig.updateMatrixWorld(true);
		const vr = this.sessionMode === 'vr';
		this.showroom.visible = vr;
		this.pedestal.visible = vr;
		this.stage.visible = true;
		this.scene.background = null; // VR: the showroom sky sphere; AR: passthrough
		this.model.layers.ground.visible = false;
		for (const c of this.input.controllers) this.input.setLaser(c, true);
		this.applyDollhouse();
	}

	applyDollhouse() {
		const p = this.stage.localToWorld(this.doll.pos.clone());
		this.anchor.position.copy(p);
		this.anchor.rotation.set(0, this.stage.rotation.y + this.doll.yaw, 0);
		this.anchor.scale.setScalar(this.baseScale * this.doll.zoom);
		this.anchor.updateMatrixWorld(true);
	}

	/** Moves the plinth and model in front of where the user now stands and looks. */
	recentre(headMatrix = this.camera.matrixWorld) {
		const head = new THREE.Vector3().setFromMatrixPosition(headMatrix);
		const yaw = yawOf(headMatrix);
		this.stage.position.set(head.x, 0, head.z);
		this.stage.rotation.set(0, yaw, 0);
		this.stage.updateMatrixWorld(true);
		this.resetDollhouse();
		this.applyDollhouse();
	}

	toggleCeilings() {
		const c = this.model.layers.ceilings;
		c.visible = !c.visible;
		this.updateLabels();
	}

	/** Meshes the laser can hit, meshes that count as floor, and what the teleport arc lands on. */
	targets() {
		const L = this.model.layers;
		return {
			pointable: [...L.main.children, ...L.floors.children],
			floors: [...L.floors.children, ...L.ground.children],
			solid: [...L.main.children, ...L.floors.children, ...L.ground.children],
		};
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
		const h = hits.find((x) => !x.face || worldNormal(x).y > 0.7);
		return h ? h.point : null;
	}

	updateDollhouse(dt) {
		if (this.menuButtons()) return;
		const { onUI, action } = this.pointUI();
		const { pointable } = this.targets();
		let jumpTo = null;
		const markers = [];
		for (const c of this.input.active()) {
			if (!onUI.has(c)) {
				this.input.setRaycaster(c, this.raycaster);
				const modelHit = this.raycaster.intersectObjects(pointable, false)[0];
				if (modelHit) {
					this.input.showHit(c, modelHit.distance);
					const floor = this.findFloor(modelHit.point, 0.01);
					if (floor) {
						markers[c.index] = floor;
						if (c.state.down.trigger) jumpTo = floor;
					}
				} else {
					this.input.showHit(c, null);
				}
			}

			// Grip: grab and move the model, keeping it upright (yaw only).
			if (c.state.down.grip && !this.grab) {
				const p = new THREE.Vector3();
				const yaw = this.input.pose(c, p);
				this.grab = { c, p0: p, yaw0: yaw, aPos0: this.anchor.position.clone(), aYaw0: this.anchor.rotation.y };
			}
			if (this.grab?.c === c && c.state.up.grip) this.grab = null;
		}

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
		this.tele = null;
		this.closeMenu();
		for (const m of this.markers) m.visible = false;
		this.showroom.visible = false;
		this.stage.visible = false;
		for (const c of this.input.controllers) { this.input.showHit(c, null); this.input.setLaser(c, false); }
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

	/** Head position in the world (from the rig and this frame's head pose). */
	headWorld() {
		this.rig.updateMatrixWorld(true);
		return new THREE.Vector3().setFromMatrixPosition(this.camera.matrix).applyMatrix4(this.rig.matrixWorld);
	}

	/** Turns the user by `angle` (radians, + = left) about their head. */
	turn(angle) {
		const before = this.headWorld();
		this.rig.rotation.y += angle;
		const after = this.headWorld();
		this.rig.position.x += before.x - after.x;
		this.rig.position.z += before.z - after.z;
		this.rig.updateMatrixWorld(true);
	}

	/** First solid hit between two world points, with its world normal. */
	hitSegment(a, b) {
		const dir = b.clone().sub(a);
		const len = dir.length();
		if (len < 1e-6) return null;
		this.raycaster.set(a, dir.divideScalar(len));
		this.raycaster.far = len;
		const h = this.raycaster.intersectObjects(this.targets().solid, false)[0];
		if (!h) return null;
		const normal = worldNormal(h);
		if (normal.dot(dir) > 0) normal.negate(); // the side the arc came from
		return { point: h.point, normal };
	}

	/**
	 * Floor following: cast down from STEP above the feet; adopt a floor
	 * within ±STEP (stairs, level changes). Walls don't block movement.
	 */
	followFloor(dt) {
		const head = this.headWorld();
		const feet = this.rig.position.y;
		this.floorRay.set(new THREE.Vector3(head.x, feet + STEP, head.z), DOWN);
		this.floorRay.far = 2 * STEP;
		const hits = this.floorRay.intersectObjects(this.targets().solid, false);
		const h = hits.find((x) => worldNormal(x).y > 0.7);
		if (!h) return;
		const k = Math.min(1, dt * 12); // a quick ease, so steps don't jolt
		this.rig.position.y += (h.point.y - feet) * k;
		this.rig.updateMatrixWorld(true);
	}

	/** Advances the teleport fade; the move happens while the view is black. */
	runFade(dt) {
		const f = this.fade;
		if (!f) return;
		f.t += dt;
		const m = this.fadeMesh.material;
		if (f.t < FADE_OUT) {
			m.opacity = f.t / FADE_OUT;
		} else {
			if (f.action) { f.action(); f.action = null; }
			m.opacity = Math.max(0, 1 - (f.t - FADE_OUT) / FADE_IN);
			if (f.t >= FADE_OUT + FADE_IN) { this.fade = null; m.opacity = 0; }
		}
		this.fadeMesh.visible = m.opacity > 0;
	}

	updateWalk(dt) {
		this.runFade(dt);
		for (const c of this.input.active()) {
			if (c.state.down.b && !this.menu) { this.enterDollhouse(); return; }
		}
		if (this.menuButtons()) { this.tele = null; this.arc.hide(); }
		const { onUI, action } = this.pointUI();
		if (action) {
			this.menuAction(action);
			if (this.mode !== 'walk' || !this.session) return;
		}
		// Lasers only show while the menu is open or one points at the orb.
		for (const c of this.input.active()) {
			const show = !!this.menu || onUI.has(c);
			this.input.setLaser(c, show);
			if (!show) this.input.showHit(c, null);
		}

		const left = this.input.hands.left, right = this.input.hands.right;

		// Teleport: right stick forward, or hold a trigger. Release to go.
		if (!this.tele && !this.menu && !this.fade) {
			const rs = right?.state.stick;
			if (rs && rs.y < -0.6 && Math.abs(rs.y) > Math.abs(rs.x)) this.tele = { c: right, via: 'stick' };
			else {
				const c = this.input.active().find((c) => c.state.down.trigger && !onUI.has(c));
				if (c) this.tele = { c, via: 'trigger' };
			}
		}
		if (this.tele) {
			const { c, via } = this.tele;
			const released = !c.source || (via === 'stick' ? c.state.stick.length() < 0.3 : !c.state.trigger);
			if (released) {
				const r = this.tele.result;
				this.tele = null;
				this.arc.hide();
				if (r?.valid) {
					const target = r.point;
					this.fade = { t: 0, action: () => this.placeUser(target, null) };
				}
			} else {
				c.ray.updateMatrixWorld(true);
				const origin = new THREE.Vector3().setFromMatrixPosition(c.ray.matrixWorld);
				const dir = new THREE.Vector3(0, 0, -1).transformDirection(c.ray.matrixWorld);
				this.tele.result = this.arc.update(origin, dir, (a, b) => this.hitSegment(a, b));
			}
		}

		// Right stick left/right: snap turn (re-arms when the stick centres).
		if (right && this.tele?.c !== right) {
			const x = right.state.stick.x;
			if (this.snapReady && Math.abs(x) > 0.7 && Math.abs(x) > Math.abs(right.state.stick.y)) {
				this.turn(-Math.sign(x) * THREE.MathUtils.degToRad(this.snapAngle));
				this.snapReady = false;
			} else if (Math.abs(x) < 0.3) {
				this.snapReady = true;
			}
		}

		// Left stick: smooth locomotion relative to where the head looks.
		const ls = left?.state.stick;
		if (ls && (ls.x || ls.y) && !this.fade) {
			this.rig.updateMatrixWorld(true);
			const m = this.camera.matrix.clone().premultiply(this.rig.matrixWorld);
			const yaw = yawOf(m);
			const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
			const rightDir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
			const move = fwd.multiplyScalar(-ls.y).addScaledVector(rightDir, ls.x);
			if (move.lengthSq() > 1) move.normalize();
			this.rig.position.addScaledVector(move, WALK_SPEED * dt);
		}

		if (!this.fade) this.followFloor(dt);
	}

	// -----------------------------------------------------------------------

	update(dt) {
		if (!this.session || !this.model) return;
		this.input.update();
		this.placeOrb();
		if (this.pendingRecentre && this.mode === 'dollhouse') {
			const head = this.viewerMatrix();
			if (head) {
				this.pendingRecentre = false;
				this.recentre(head);
				// Open the menu once per visit so it gets discovered.
				if (!this.menuShownOnce) { this.menuShownOnce = true; this.openMenu(head); }
			}
		}
		if (this.mode === 'dollhouse') this.updateDollhouse(dt);
		else if (this.mode === 'walk') this.updateWalk(dt);
	}
}

/** A ray hit's face normal in world space. */
function worldNormal(hit) {
	if (!hit.face) return new THREE.Vector3(0, 1, 0);
	return hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
