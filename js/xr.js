// XR session and modes (SPEC.md, "Experience and controls").
//
//   dollhouse  the home on a plinth in a gallery room (VR view) or floating
//              over passthrough (AR view): thumbstick rotate/zoom, grip to
//              move, laser + trigger to jump in at 1:1.
//   walk       the home at 1:1: left stick walks, right stick snap-turns,
//              right stick forward or a held trigger aims a teleport arc, a
//              held grip grabs the space so you can pull yourself along. In a one-level home
//              you stay on the floor and walk through furniture; with more
//              levels you can stand on anything, so stairs work. B or Y goes back.
//
// One session for both views: when the browser supports it, an
// immersive-ar session is used and "VR" simply draws an opaque world over
// the passthrough, so the menu can switch between them.
//
// Menu: a living orb floats over each hand. Point at it with the other hand
// and pull the trigger, touch it with the other hand, or press A / X, to open
// the menu (with a controls diagram) in front of you. It closes on a choice,
// on B / Y, or when you click anywhere else.
//
// Scene graph (owned by main.js):
//   scene
//   ├─ rig ─ camera, controllers, menu   moved to place the user
//   ├─ stage ─ gallery room, plinth      what Recentre moves
//   └─ anchor ─ centerer ─ model         anchor: dollhouse position/yaw/scale
//                                        centerer: puts the model's bottom-centre at the origin

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Panel, ControlsCard } from './panel.js';
import { XRInput, TeleportArc, yawOf } from './xr-input.js';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const PLINTH_HEIGHT = 0.6; // low table: you look down into the rooms
// The model rests a few millimetres above the plinth, never exactly on it:
// two surfaces at the same height fight for the same pixels ("z-fighting"),
// which showed as flickering polygon-shaped patches all over the floors.
const PLINTH_REST = PLINTH_HEIGHT + 0.004;
// Clip planes for the headset, set explicitly: left alone they come from how
// the 2D page framed the model, which can clip things held near the face.
const XR_NEAR = 0.05, XR_FAR = 300;
const PLINTH_MARGIN = 0.2; // table left around the model (it is ~1.2 m across)
const PLINTH_FRONT_GAP = 0.3; // from where you stand to the plinth's front edge
// VR dollhouse: you look down at it as a 2 m tall person would, whatever your
// own height, whether you sit or stand, and however the headset's floor level
// is set. The head's real height is measured on entry and on Recentre, and
// the view is raised by the difference (never lowered).
const DOLLHOUSE_PERSON = 2.0; // metres
const DOLLHOUSE_LIFT_START = 0.25; // used for the first frames, before the head height is known
const DOLLHOUSE_LIFT_MAX = 1.4; // (lying on the floor is not a case to support)
const DOLLHOUSE_SIZE = 1.2; // metres across
const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
const ROTATE_SPEED = 1.6; // rad/s at full stick
const ZOOM_SPEED = 1.2; // e-folds/s at full stick
const WALK_SPEED = 0.75; // m/s at full stick
const STEP = 0.6; // floor following: look this far above and below the feet
const FADE_OUT = 0.1, FADE_IN = 0.15; // teleport fade, seconds
const MENU_DISTANCE = 0.65, MENU_DROP = 0.1, MENU_LEFT = 0.1; // summoned menu, relative to the eyes (controls card to its left)
// In the dollhouse the menu opens off to the left and further away, so it
// never sits between you and the model (it used to appear right in front of
// the face on entry), and you can watch the model while changing a setting.
const MENU_DOLL_DISTANCE = 0.95, MENU_DOLL_SIDE = THREE.MathUtils.degToRad(34);
const TURNS = [15, 30, 45]; // snap turn options, degrees
const HEIGHTS = [0, 1.4, 1.7, 2.0]; // person height options, metres (0 = your own)
const EYE_BELOW_TOP = 0.11; // eyes are about this far below the top of the head
const ORB_TOUCH = 0.08, ORB_RELEASE = 0.14; // touching an orb with the other hand
const HINT = 'A / X, or an orb on your hands';
const FIGURE_HEIGHT = 1.75; // the scale figure beside the dollhouse, metres at the model's scale
const FIGURE_GAP = 0.45; // how far in front of the home it stands, metres at the model's scale
const KEYS = { turn: 'svr.snapAngle', height: 'svr.height', view: 'svr.view', figure: 'svr.figure' };

export class XRExperience {
	/**
	 * @param opts.renderer, opts.scene, opts.camera, opts.rig, opts.anchor, opts.centerer
	 * @param opts.lighting  Lighting (time of day, shadows): the menu changes it
	 * @param opts.depth     DepthShading (corner gradients, headset only): the menu switches it
	 * @param opts.onEnd()  called after the session ends (2D page restores its view)
	 */
	constructor({ renderer, scene, camera, rig, anchor, centerer, lighting, depth, onEnd }) {
		Object.assign(this, { renderer, scene, camera, rig, anchor, centerer, lighting, depth, onEnd });
		this.model = null; // { group, layers, bounds, observer, skyColor }
		this.session = null;
		this.sessionMode = null; // 'vr' | 'ar' (the session type)
		this.view = safeGet(KEYS.view) === 'ar' ? 'ar' : 'vr'; // what is shown (AR sessions only)
		this.mode = null; // 'dollhouse' | 'walk'
		this.plinthDistance = 1; // centre of the plinth in front of the user; set by buildPlinth()
		this.doll = { pos: new THREE.Vector3(0, PLINTH_REST, -this.plinthDistance), yaw: 0, zoom: 1 };
		this.lift = 0; // the rig's height above the floor the user stands on
		this.dollLift = DOLLHOUSE_LIFT_START; // VR dollhouse lift, from the measured head height
		this.grab = null; // dollhouse: grabbing the model
		this.tele = null; // teleport being aimed: { c, result }
		this.fade = null; // { t, action }
		this.snapReady = true;
		const turn = Number(safeGet(KEYS.turn));
		this.snapAngle = TURNS.includes(turn) ? turn : 30;
		const height = Number(safeGet(KEYS.height));
		this.personHeight = HEIGHTS.includes(height) ? height : 0;
		this.figureOn = safeGet(KEYS.figure) !== '0'; // scale figure beside the dollhouse
		this.maxStorey = null; // dollhouse: highest storey shown (null = all)
		this.menuShownOnce = false;
		this.pendingRecentre = false;
		this.raycaster = new THREE.Raycaster();
		this.raycaster.firstHitOnly = true;
		this.floorRay = new THREE.Raycaster(); // all hits, so the first upward face is found
		this.input = new XRInput(renderer, rig);
		this.input.setVisible(false);
		this.buildShowroom();
		this.buildWalkSky();
		this.buildMarker();
		this.figure = buildFigure();
		this.buildMenus();
		this.buildOrbs();
		this.buildFade();
		this.arc = new TeleportArc(scene);
	}

	// -----------------------------------------------------------------------
	// Scene pieces
	// -----------------------------------------------------------------------

	buildShowroom() {
		// Outside the gallery: a soft gradient sky and a pale ground, seen
		// through the windows and the skylight.
		const room = new THREE.Group();
		room.name = 'showroom';
		const sky = new THREE.Mesh(gradientSphere(40, 0xb7cde0, 0xf5f7f9), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false }));
		this.showroomSky = sky;
		const ground = new THREE.Mesh(new THREE.CircleGeometry(39, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xdfe3dc }));
		ground.position.y = -0.02;
		room.add(sky, ground);
		room.visible = false;
		this.showroom = room;
		this.scene.add(room);

		// Stage: what Recentre moves, positioned relative to the user.
		this.stage = new THREE.Group();
		this.stage.name = 'stage';
		this.gallery = buildGallery();
		// Museum plinth: sized to the model in setModel(). It stays still and
		// the model turns on it.
		const pedestal = new THREE.Group();
		pedestal.name = 'plinth';
		this.pedestal = pedestal;
		this.plinthMaterials = {
			// (Drawn a touch further back in depth as well, so the model's floor always wins.)
			top: new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
			body: new THREE.MeshLambertMaterial({ color: 0xf2f1ee }),
			base: new THREE.MeshLambertMaterial({ color: 0x33383d }),
		};
		this.stage.add(this.gallery, pedestal);
		this.stage.visible = false;
		this.scene.add(this.stage);
		this.buildPlinth(1.2, 0.9);
	}

	/**
	 * A rectangular exhibition plinth for a model footprint of w x d metres:
	 * a thin white top slab, an off-white body, and a dark recessed base
	 * (shadow gap) so it seems to float just above the floor. The gallery
	 * room is centred on it.
	 */
	buildPlinth(w, d) {
		const SLAB = 0.03, GAP = 0.05, INSET = 0.025;
		const W = w + 2 * PLINTH_MARGIN, D = d + 2 * PLINTH_MARGIN, H = PLINTH_HEIGHT;
		this.plinthDistance = D / 2 + PLINTH_FRONT_GAP;
		this.plinthSize = { W, D };
		this.pedestal.position.set(0, 0, -this.plinthDistance);
		this.gallery.position.set(0, 0, -this.plinthDistance);
		const p = this.pedestal;
		for (const m of p.children) m.geometry.dispose();
		p.clear();
		const box = (bw, bh, bd, y, mat) => {
			const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
			m.position.y = y;
			m.castShadow = m.receiveShadow = true; // the model's shadow falls on the table
			p.add(m);
		};
		const M = this.plinthMaterials;
		box(W, SLAB, D, H - SLAB / 2, M.top);
		box(W - 0.01, H - SLAB - GAP, D - 0.01, GAP + (H - SLAB - GAP) / 2, M.body);
		box(W - 2 * INSET, GAP, D - 2 * INSET, GAP / 2, M.base);
	}

	/** Sky for walk mode in the VR view: follows the head, coloured in setModel(). */
	buildWalkSky() {
		this.walkSky = new THREE.Mesh(gradientSphere(200, 0xcce4fc, 0xffffff), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
		this.walkSky.renderOrder = -1;
		this.walkSky.visible = false;
		this.walkSky.name = 'walk-sky';
		this.camera.add(this.walkSky);
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

	/** One menu per mode, each with a controls card beside it; they live in the rig. */
	buildMenus() {
		const opts = (title) => ({ title, hint: HINT, width: 0.42, pxPerM: 1600, columns: 2 });
		this.menus = {
			dollhouse: new Panel([
				{ id: 'walk', label: 'Walk in' },
				{ id: 'recentre', label: 'Recentre' },
				{ id: 'light', label: 'Light: morning' },
				{ id: 'shadows', label: 'Shadows: off' },
				{ id: 'depth', label: 'Depth: off' },
				{ id: 'ceilings', label: 'Ceilings: on' },
				{ id: 'levels', label: 'Levels: all' },
				{ id: 'figure', label: 'Figure: on' },
				{ id: 'view', label: 'View: VR' },
				{ id: 'exit', label: 'Exit VR', primary: true },
			], opts('Dollhouse')),
			walk: new Panel([
				{ id: 'dollhouse', label: 'Dollhouse' },
				{ id: 'ceilings', label: 'Ceilings: on' },
				{ id: 'light', label: 'Light: morning' },
				{ id: 'shadows', label: 'Shadows: off' },
				{ id: 'depth', label: 'Depth: off' },
				{ id: 'turn', label: 'Turn: 30°' },
				{ id: 'height', label: 'Height: yours' },
				{ id: 'view', label: 'View: VR' },
				{ id: 'exit', label: 'Exit VR', primary: true },
			], opts('Walking')),
		};
		const either = (btn) => [
			{ kind: 'stick', key: 'Stick', text: '↔ rotate   ↕ zoom' },
			{ kind: 'trigger', key: 'Trigger', text: 'Jump in where you point' },
			{ kind: 'grip', key: 'Grip', text: 'Hold to move the model' },
			{ kind: 'button', key: btn[0], text: 'Menu' },
			{ kind: 'button', key: btn[1], text: 'Close the menu' },
			{ kind: 'orb', key: 'Orb', text: 'Point or touch: menu' },
		];
		// Horizon OS screenshot: hold the Meta button (right controller) and pull a trigger.
		const footer = { footer: { key: 'Screenshot', lines: [
			'Close this menu, then hold the Meta button',
			'(right hand) and pull a trigger.',
			'Pictures are in the headset\'s Files app.',
		] } };
		const cards = {
			dollhouse: new ControlsCard('Controls: dollhouse', { left: either('XY'), right: either('AB') }, footer),
			walk: new ControlsCard('Controls: walking', {
				left: [
					{ kind: 'stick', key: 'Stick', text: 'Walk where you look' },
					{ kind: 'trigger', key: 'Trigger', text: 'Hold, aim, release: teleport' },
					{ kind: 'grip', key: 'Grip', text: 'Hold and pull: move' },
					{ kind: 'button', key: 'X', text: 'Menu' },
					{ kind: 'button', key: 'Y', text: 'Back to the dollhouse' },
					{ kind: 'orb', key: 'Orb', text: 'Point or touch: menu' },
				],
				right: [
					{ kind: 'stick', key: 'Stick ↔', text: 'Turn' },
					{ kind: 'stick', key: 'Stick ↑', text: 'Aim, release: teleport' },
					{ kind: 'trigger', key: 'Trigger', text: 'Hold, aim, release: teleport' },
					{ kind: 'grip', key: 'Grip', text: 'Hold and pull: move' },
					{ kind: 'button', key: 'A', text: 'Menu' },
					{ kind: 'button', key: 'B', text: 'Back to the dollhouse' },
					{ kind: 'orb', key: 'Orb', text: 'Point or touch: menu' },
				],
			}, footer),
		};
		for (const [mode, p] of Object.entries(this.menus)) {
			p.mesh.visible = false;
			p.mesh.material.depthTest = false; // never hidden inside a wall
			const card = cards[mode];
			const mw = p.mesh.geometry.parameters.width, cw = card.mesh.geometry.parameters.width;
			// Card on the left of the menu, out of the main view, turned towards the user.
			card.mesh.position.set(-(mw / 2 + 0.03 + cw / 2 * Math.cos(0.4)), 0, cw / 2 * Math.sin(0.4));
			card.mesh.rotation.y = 0.4;
			p.mesh.add(card.mesh);
			p.card = card;
			this.rig.add(p.mesh);
		}
		this.menu = null; // the open Panel, or null
	}

	/** A living orb over each hand: point at it, or touch it, to open the menu. */
	buildOrbs() {
		this.orbs = [0, 1].map(() => makeOrb());
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

	/** model: { group, layers, bounds (Box3, model space, no ground), observer, skyColor, multiLevel } */
	setModel(model) {
		this.model = model;
		this._targets = null; // mesh sets for raycasts, rebuilt on demand
		this.maxStorey = null;
		this.centerer.add(...this.markers, this.figure);
		// The scale figure stands on the ground just in front of the home's
		// left corner, at the model's scale, so it turns and zooms with it.
		const b = model.bounds;
		this.figure.position.set(b.min.x + 0.6, b.min.y, b.max.z + FIGURE_GAP);
		this.figure.visible = false;
		const size = model.bounds.getSize(new THREE.Vector3());
		this.baseScale = DOLLHOUSE_SIZE / Math.max(size.x, size.z, 0.01);
		this.buildPlinth(size.x * this.baseScale, size.z * this.baseScale);
		// Everything casts and receives shadows (used only when shadows are on),
		// except the ground (nothing below it) and glass, so sun comes in
		// through the windows.
		for (const [name, layer] of Object.entries(model.layers)) {
			for (const m of layer.children) {
				const glass = [].concat(m.material).some((mat) => mat.transparent && mat.opacity < 0.9);
				m.castShadow = name !== 'ground' && !glass;
				m.receiveShadow = true;
			}
		}
		this.updateSky();
		this.updateLabels();
	}

	static async supported() {
		const xr = navigator.xr;
		if (!xr) return { vr: false, ar: false };
		const check = (m) => xr.isSessionSupported(m).catch(() => false);
		const [vr, ar] = await Promise.all([check('immersive-vr'), check('immersive-ar')]);
		return { vr, ar };
	}

	/** kind: 'ar' (both views, switchable in the menu) or 'vr' (VR only). */
	async start(kind) {
		if (!this.model || this.session || this.starting) return;
		this.starting = true;
		const init = { requiredFeatures: ['local-floor'], optionalFeatures: ['bounded-floor'] };
		let session;
		try {
			try {
				session = await navigator.xr.requestSession(kind === 'ar' ? 'immersive-ar' : 'immersive-vr', init);
			} catch (e) {
				// Passthrough refused or unavailable: plain VR still works.
				if (kind !== 'ar') throw e;
				kind = 'vr';
				session = await navigator.xr.requestSession('immersive-vr', init);
			}
		} finally {
			this.starting = false;
		}
		this.renderer.xr.setReferenceSpaceType('local-floor');
		this.renderer.xr.setFramebufferScaleFactor(1);
		await this.renderer.xr.setSession(session);
		this.renderer.xr.setFoveation(1);
		this.session = session;
		this.sessionMode = kind;
		this.depth?.setActive(true); // depth shading shows in the headset only
		this.saved = { background: this.scene.background };
		this.camera.near = XR_NEAR;
		this.camera.far = XR_FAR;
		this.camera.updateProjectionMatrix();
		this.scene.background = null; // the sky spheres draw the VR view; null shows passthrough
		session.addEventListener('end', () => this.handleEnd());
		// Holding the Meta button re-centres the headset: follow it.
		this.renderer.xr.getReferenceSpace()?.addEventListener?.('reset', () => {
			if (this.mode === 'dollhouse') this.pendingRecentre = true;
		});
		this.input.setVisible(true);
		this.stage.position.set(0, 0, 0);
		this.stage.rotation.set(0, 0, 0);
		this.updateLabels();
		this.resetDollhouse();
		this.dollLift = DOLLHOUSE_LIFT_START;
		this.enterDollhouse(false); // no head pose yet: measured below, with the first one
		// The floor origin is not necessarily where you stand (it can be
		// anywhere in your play area), so place the plinth in front of the
		// head as soon as the first head pose arrives.
		this.pendingRecentre = true;
	}

	end() { this.session?.end(); }

	handleEnd() {
		this.session = null;
		this.depth?.setActive(false);
		this.mode = null;
		this.grab = null;
		this.tele = null;
		this.fade = null;
		this.pendingRecentre = false;
		this.arc.hide();
		this.closeMenu();
		this.fadeMesh.visible = false;
		this.walkSky.visible = false;
		for (const o of this.orbs) { o.group.removeFromParent(); o.holder = null; }
		this.input.setVisible(false);
		this.showroom.visible = false;
		this.stage.visible = false;
		for (const m of this.markers) m.visible = false;
		this.figure.visible = false;
		this.applyStoreys(); // the 2D page shows every storey
		this.rig.position.set(0, 0, 0);
		this.rig.rotation.set(0, 0, 0);
		this.lift = 0;
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

	/** True when the opaque VR world is shown (always, in a VR-only session). */
	get vrView() { return this.sessionMode !== 'ar' || this.view === 'vr'; }

	/** Shows the VR world or the passthrough for the current mode. */
	applyView() {
		const vr = this.vrView;
		this.figure.visible = this.figureOn && this.mode === 'dollhouse';
		if (this.mode === 'dollhouse') {
			this.showroom.visible = vr;
			this.gallery.visible = vr;
			this.pedestal.visible = vr;
			this.walkSky.visible = false;
			this.model.layers.ground.visible = false;
			this.setLift(vr ? this.dollLift : 0);
		} else if (this.mode === 'walk') {
			this.showroom.visible = false;
			this.walkSky.visible = vr;
			this.model.layers.ground.visible = vr;
		}
	}

	/**
	 * Dollhouse level picker: shows the storeys up to `maxStorey` and takes the
	 * ceilings off the highest one shown, so you look straight into it. Walk
	 * mode and the 2D page always show every storey.
	 */
	applyStoreys() {
		if (!this.model) return;
		const count = this.model.storeys ?? 1;
		const max = this.maxStorey;
		const filtered = this.mode === 'dollhouse' && max !== null && max < count - 1;
		const groups = [...Object.entries(this.model.layers), ['lamps', this.model.lamps]];
		for (const [name, group] of groups) {
			for (const m of group?.children ?? []) {
				const s = m.userData.storey ?? 0;
				m.visible = !filtered || s < max || (s === max && name !== 'ceilings');
			}
		}
		this._targets = null; // hidden storeys cannot be pointed at
		this.lighting?.refresh(); // and cast no shadows
	}

	/**
	 * VR dollhouse: works out the lift that puts the eyes where a 2 m tall
	 * person's would be, from the head's real height above the floor.
	 * headLocal: the head pose in tracking space (camera.matrix, or the
	 * viewer pose).
	 */
	measureDollLift(headLocal) {
		const y = new THREE.Vector3().setFromMatrixPosition(headLocal).y;
		// (Ignore nonsense heights: no pose yet, or the 2D camera's position.)
		if (y > 0.3 && y < 2.5) this.dollLift = THREE.MathUtils.clamp(DOLLHOUSE_PERSON - EYE_BELOW_TOP - y, 0, DOLLHOUSE_LIFT_MAX);
		if (this.mode === 'dollhouse') this.setLift(this.vrView ? this.dollLift : 0);
	}

	/** Raises the rig by `lift` above the floor the user stands on. */
	setLift(lift) {
		this.rig.position.y += lift - this.lift;
		this.lift = lift;
		this.rig.updateMatrixWorld(true);
	}

	/** Walk mode: lift that puts the eyes at the chosen person height (0 = your own). */
	personLift() {
		if (!this.personHeight) return 0;
		const eye = new THREE.Vector3().setFromMatrixPosition(this.camera.matrix).y;
		return eye > 0.3 ? this.personHeight - EYE_BELOW_TOP - eye : 0;
	}

	// -----------------------------------------------------------------------
	// Menu and orbs
	// -----------------------------------------------------------------------

	updateLabels() {
		const on = this.model?.layers.ceilings.visible ?? true;
		const view = this.sessionMode === 'vr' ? 'View: VR only' : `View: ${this.view === 'vr' ? 'VR' : 'passthrough'}`;
		for (const p of Object.values(this.menus)) {
			p.setLabel('ceilings', `Ceilings: ${on ? 'on' : 'off'}`);
			p.setLabel('view', view);
		}
		this.menus.walk.setLabel('turn', `Turn: ${this.snapAngle}°`);
		if (this.lighting) {
			for (const p of Object.values(this.menus)) {
				p.setLabel('light', `Light: ${this.lighting.time}`);
				p.setLabel('shadows', `Shadows: ${this.lighting.shadows ? 'on' : 'off'}`);
				if (this.depth) p.setLabel('depth', `Depth: ${this.depth.label()}`);
			}
		}
		this.menus.walk.setLabel('height', `Height: ${this.personHeight ? `${this.personHeight.toFixed(1)} m` : 'yours'}`);
		const storeys = this.model?.storeys ?? 1;
		this.menus.dollhouse.setLabel('levels', storeys < 2 ? 'Levels: one' : this.maxStorey === null ? 'Levels: all' : `Levels: ${this.maxStorey + 1} of ${storeys}`, storeys < 2);
		this.menus.dollhouse.setLabel('figure', `Figure: ${this.figureOn ? 'on' : 'off'}`);
	}

	/**
	 * Opens this mode's menu facing the eyes (yaw only), with the controls card
	 * on its left: walking, in front of the head and a little to the left; in
	 * the dollhouse, well to the left and further away, clear of the model.
	 */
	openMenu(headMatrix = this.camera.matrix) {
		this.closeMenu();
		const panel = this.menus[this.mode];
		if (!panel) return;
		const head = new THREE.Vector3().setFromMatrixPosition(headMatrix);
		const yaw = yawOf(headMatrix);
		const doll = this.mode === 'dollhouse';
		const towards = yaw + (doll ? MENU_DOLL_SIDE : 0); // (a positive angle turns left)
		const dir = new THREE.Vector3(-Math.sin(towards), 0, -Math.cos(towards));
		const left = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
		panel.mesh.position.copy(head).addScaledVector(dir, doll ? MENU_DOLL_DISTANCE : MENU_DISTANCE).addScaledVector(left, doll ? 0 : MENU_LEFT);
		panel.mesh.position.y -= MENU_DROP;
		this.rig.updateMatrixWorld(true);
		panel.mesh.lookAt(this.rig.localToWorld(head.clone().setY(panel.mesh.position.y)));
		panel.setHover(null);
		panel.mesh.visible = true;
		this.menu = panel;
	}

	closeMenu() {
		if (this.menu) this.menu.mesh.visible = false;
		this.menu = null;
	}

	toggleMenu() { this.menu ? this.closeMenu() : this.openMenu(); }

	/** Puts an orb on each controller. */
	placeOrbs() {
		const active = this.input.active();
		this.orbs.forEach((o, i) => {
			const holder = active[i] ?? null;
			if (holder === o.holder) return;
			o.group.removeFromParent();
			if (holder) holder.grip.add(o.group);
			o.holder = holder;
		});
	}

	/**
	 * Laser vs. orbs and menu, for every controller; touching an orb with
	 * the other hand. Clicks are handled here. Returns the set of controllers
	 * whose laser is on the UI this frame (their trigger belongs to the UI),
	 * and the menu action to run, if any.
	 */
	pointUI() {
		const onUI = new Set();
		let hover = null, action = null, toggle = false, close = false;
		const hot = new Set();
		const active = this.input.active();
		for (const c of active) {
			this.input.setRaycaster(c, this.raycaster);
			const menuHit = this.menu ? this.raycaster.intersectObject(this.menu.mesh, false)[0] : null;
			let orbHit = null, orb = null;
			for (const o of this.orbs) {
				if (!o.holder || o.holder === c) continue;
				const h = this.raycaster.intersectObject(o.target, false)[0];
				if (h && (!orbHit || h.distance < orbHit.distance)) { orbHit = h; orb = o; }
			}
			if (menuHit) {
				onUI.add(c);
				this.input.showHit(c, menuHit.distance);
				const id = this.menu.hitTest(menuHit.uv);
				hover ||= id;
				if (c.state.down.trigger && id) action = id;
			} else if (orbHit) {
				onUI.add(c);
				hot.add(orb);
				this.input.showHit(c, orbHit.distance);
				if (c.state.down.trigger) toggle = true;
			} else if (this.menu && c.state.down.trigger) {
				// Clicking anywhere else closes the menu (and does nothing else).
				onUI.add(c);
				close = true;
			}
		}
		// Touch: the other hand's controller reaches into an orb.
		const p = new THREE.Vector3(), q = new THREE.Vector3();
		for (const o of this.orbs) {
			if (!o.holder) continue;
			o.group.getWorldPosition(p);
			let near = Infinity;
			for (const c of active) {
				if (c === o.holder) continue;
				this.input.pose(c, q);
				near = Math.min(near, q.distanceTo(p));
			}
			if (near < ORB_TOUCH && o.armed) { toggle = true; o.armed = false; }
			if (near > ORB_RELEASE) o.armed = true;
			if (near < ORB_RELEASE) hot.add(o);
		}
		this.menu?.setHover(hover);
		const t = performance.now() / 1000;
		for (const o of this.orbs) animateOrb(o, t, hot.has(o));
		if (toggle) this.toggleMenu();
		else if (close) this.closeMenu();
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
			case 'view':
				if (this.sessionMode !== 'ar') break;
				this.view = this.view === 'vr' ? 'ar' : 'vr';
				safeSet(KEYS.view, this.view);
				this.applyView();
				this.updateLabels();
				break;
			case 'turn':
				this.snapAngle = TURNS[(TURNS.indexOf(this.snapAngle) + 1) % TURNS.length];
				safeSet(KEYS.turn, String(this.snapAngle));
				this.updateLabels();
				break;
			case 'height':
				this.personHeight = HEIGHTS[(HEIGHTS.indexOf(this.personHeight) + 1) % HEIGHTS.length];
				safeSet(KEYS.height, String(this.personHeight));
				if (this.mode === 'walk') this.setLift(this.personLift());
				this.updateLabels();
				break;
			case 'levels': {
				// all -> lowest only -> lowest two -> ... -> all
				const count = this.model.storeys ?? 1;
				if (count < 2) break;
				const next = this.maxStorey === null ? 0 : this.maxStorey + 1;
				this.maxStorey = next >= count - 1 ? null : next;
				this.applyStoreys();
				this.updateLabels();
				break;
			}
			case 'figure':
				this.figureOn = !this.figureOn;
				safeSet(KEYS.figure, this.figureOn ? '1' : '0');
				this.applyView();
				this.updateLabels();
				break;
			case 'light': this.lighting?.nextTime(); this.updateLabels(); break;
			case 'shadows': this.lighting?.setShadows(!this.lighting.shadows); this.updateLabels(); break;
			case 'depth': this.depth?.setEnabled(!this.depth.enabled); this.updateLabels(); break;
			case 'recentre': this.closeMenu(); this.measureDollLift(this.camera.matrix); this.recentre(); break;
			case 'exit': this.closeMenu(); this.end(); break;
		}
	}

	/** Recolours the gallery sky and the walk-mode sky for the time of day. */
	updateSky() {
		const { top, horizon } = this.lighting?.skyColors() ?? { top: this.model?.skyColor ?? 0xcce4fc, horizon: 0xf5f7f9 };
		recolourSphere(this.showroomSky.geometry, 40, top, horizon);
		recolourSphere(this.walkSky.geometry, 200, top, horizon);
	}

	// -----------------------------------------------------------------------
	// Dollhouse
	// -----------------------------------------------------------------------

	resetDollhouse() {
		this.doll.pos.set(0, PLINTH_REST, -this.plinthDistance);
		this.doll.yaw = 0;
		this.doll.zoom = 1;
	}

	/** measure: take the head height now (false at session start, when there is no pose yet). */
	enterDollhouse(measure = true) {
		this.mode = 'dollhouse';
		this.tele = null;
		this.arc.hide();
		this.closeMenu();
		this.rig.position.set(0, 0, 0);
		this.rig.rotation.set(0, 0, 0);
		this.lift = 0;
		if (measure) this.measureDollLift(this.camera.matrix);
		this.stage.visible = true;
		for (const c of this.input.controllers) this.input.setLaser(c, true);
		this.applyView();
		this.applyStoreys();
		this.applyDollhouse();
	}

	applyDollhouse() {
		const p = this.stage.localToWorld(this.doll.pos.clone());
		this.anchor.position.copy(p);
		this.anchor.rotation.set(0, this.stage.rotation.y + this.doll.yaw, 0);
		this.anchor.scale.setScalar(this.baseScale * this.doll.zoom);
		this.anchor.updateMatrixWorld(true);
		this.lighting?.fit(); // the sun follows the model; shadows re-render
	}

	/** Moves the room, plinth and model in front of where the user now stands and looks. */
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

	/**
	 * Mesh sets: what the laser can hit, what counts as floor in the
	 * dollhouse, what the teleport arc hits, and what you can stand on in
	 * walk mode. One level: you stand on room floors and the ground only,
	 * and the arc flies through furniture to the floor. More than one level
	 * (or no rooms, as in OBJ and GLB files): you can stand on anything but
	 * walls, so stairs work. Walls always stop the arc.
	 */
	targets() {
		// Built once per model: this is asked for several times every frame.
		if (this._targets) return this._targets;
		// Only what is shown: storeys hidden by the level picker are left out.
		const shown = (name) => (this.model.layers[name]?.children ?? []).filter((m) => m.visible);
		const L = { main: shown('main'), walls: shown('walls'), floors: shown('floors'), ground: shown('ground') };
		const walls = L.walls;
		const anywhere = this.model.multiLevel || L.floors.length === 0;
		const walkable = [...L.floors, ...L.ground, ...(anywhere ? L.main : [])];
		this._targets = {
			pointable: [...L.main, ...walls, ...L.floors],
			floors: [...L.floors, ...L.ground],
			solid: [...walls, ...walkable],
			walkable: new Set(walkable),
			walkableList: walkable,
		};
		return this._targets;
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

		// A controller that drops out mid-grab (battery, tracking) lets go.
		if (this.grab && (!this.grab.c.source || !this.grab.c.state.grip)) this.grab = null;
		if (this.grab) {
			const p = new THREE.Vector3();
			const yaw = this.input.pose(this.grab.c, p);
			const dy = yaw - this.grab.yaw0;
			const off = this.grab.aPos0.clone().sub(this.grab.p0).applyAxisAngle(UP, dy);
			const world = p.add(off);
			this.doll.pos.copy(this.stage.worldToLocal(world));
			this.doll.yaw = this.grab.aYaw0 + dy - this.stage.rotation.y;
			// Never push it into the plinth (or, off the plinth, below the floor).
			const { W, D } = this.plinthSize;
			const onPlinth = this.vrView && Math.abs(this.doll.pos.x) < W / 2 && Math.abs(this.doll.pos.z + this.plinthDistance) < D / 2;
			this.doll.pos.y = Math.max(this.doll.pos.y, onPlinth ? PLINTH_REST : 0);
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
		this.lighting?.fit();
	}

	/** Enters 1:1 standing at a model-space floor point, optionally facing `yaw`. */
	walkAt(modelPt, yaw) {
		this.mode = 'walk';
		this.grab = null;
		this.tele = null;
		this.closeMenu();
		for (const m of this.markers) m.visible = false;
		this.stage.visible = false;
		for (const c of this.input.controllers) { this.input.showHit(c, null); this.input.setLaser(c, false); c.pull = null; }
		this.applyView();
		this.applyStoreys();
		this.setWalkTransform();
		this.lift = this.personLift();
		const target = this.centerer.localToWorld(modelPt.clone());
		this.placeUser(target, yaw);
	}

	/**
	 * Moves the rig so the user's head is above `target` (feet at its height,
	 * plus the person-height lift), facing `yaw` if given, otherwise keeping
	 * their current heading.
	 */
	placeUser(target, yaw) {
		const headLocal = new THREE.Vector3().setFromMatrixPosition(this.camera.matrix);
		const headYawLocal = yawOf(this.camera.matrix);
		const heading = yaw ?? (this.rig.rotation.y + headYawLocal);
		this.rig.rotation.set(0, heading - headYawLocal, 0);
		const off = new THREE.Vector3(headLocal.x, 0, headLocal.z).applyAxisAngle(UP, this.rig.rotation.y);
		this.rig.position.set(target.x - off.x, target.y + this.lift, target.z - off.z);
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

	/** First solid hit between two world points, with its world normal; valid only on walkable floors. */
	hitSegment(a, b, t) {
		const dir = b.clone().sub(a);
		const len = dir.length();
		if (len < 1e-6) return null;
		this.raycaster.set(a, dir.divideScalar(len));
		this.raycaster.far = len;
		const h = this.raycaster.intersectObjects(t.solid, false)[0];
		if (!h) return null;
		const normal = worldNormal(h);
		if (normal.dot(dir) > 0) normal.negate(); // the side the arc came from
		return { point: h.point, normal, valid: normal.y > 0.7 && t.walkable.has(h.object) };
	}

	/**
	 * Floor following: cast down from STEP above the feet; adopt a walkable
	 * surface (see targets()) within ±STEP, which handles stairs and levels.
	 * Walls don't block movement.
	 */
	followFloor(dt) {
		const head = this.headWorld();
		const feet = this.rig.position.y - this.lift;
		this.floorRay.set(new THREE.Vector3(head.x, feet + STEP, head.z), DOWN);
		this.floorRay.far = 2 * STEP;
		const hits = this.floorRay.intersectObjects(this.targets().walkableList, false);
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
		// Lasers only show while the menu is open or one points at an orb.
		for (const c of this.input.active()) {
			const show = !!this.menu || onUI.has(c);
			this.input.setLaser(c, show);
			if (!show) this.input.showHit(c, null);
		}

		const left = this.input.hands.left, right = this.input.hands.right;
		const t = this.targets();

		// Teleport: push the right stick forward, or hold a trigger, and aim;
		// release to go.
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
			if (!c.source || (via === 'stick' ? c.state.stick.length() < 0.3 : !c.state.trigger)) {
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
				this.tele.result = this.arc.update(origin, dir, (a, b) => this.hitSegment(a, b, t));
			}
		}

		// Right stick left/right: snap turn (re-arms when the stick centres).
		if (right && !(this.tele?.c === right && this.tele.via === 'stick')) {
			const x = right.state.stick.x;
			if (this.snapReady && Math.abs(x) > 0.7 && Math.abs(x) > Math.abs(right.state.stick.y)) {
				this.turn(-Math.sign(x) * THREE.MathUtils.degToRad(this.snapAngle));
				this.snapReady = false;
			} else if (Math.abs(x) < 0.3) {
				this.snapReady = true;
			}
		}

		// Grips: grab the space and pull yourself along (horizontally; the
		// floor following keeps you on the floor).
		const pull = new THREE.Vector3();
		let pulling = 0;
		for (const c of this.input.active()) {
			if (c.state.down.grip && !this.menu) c.pull = c.grip.position.clone();
			if (!c.state.grip) c.pull = null;
			if (c.pull) {
				pull.add(c.pull.clone().sub(c.grip.position));
				c.pull.copy(c.grip.position);
				pulling++;
			}
		}
		if (pulling && !this.fade) {
			pull.divideScalar(pulling).setY(0).applyAxisAngle(UP, this.rig.rotation.y);
			this.rig.position.add(pull);
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
		this.placeOrbs();
		if (this.pendingRecentre && this.mode === 'dollhouse') {
			const head = this.viewerMatrix();
			if (head) {
				this.pendingRecentre = false;
				this.measureDollLift(head); // the tall view, from where the head really is
				this.recentre(head.clone().premultiply(this.rig.matrix));
				// Open the menu once per visit so it gets discovered.
				if (!this.menuShownOnce) { this.menuShownOnce = true; this.openMenu(head); }
			}
		}
		if (this.mode === 'dollhouse') this.updateDollhouse(dt);
		else if (this.mode === 'walk') this.updateWalk(dt);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A ray hit's face normal in world space. */
function worldNormal(hit) {
	if (!hit.face) return new THREE.Vector3(0, 1, 0);
	return hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
}

/** Inside-out sphere with a vertical colour gradient (horizon -> top). */
function gradientSphere(r, top, horizon) {
	const g = new THREE.SphereGeometry(r, 32, 16);
	recolourSphere(g, r, top, horizon);
	return g;
}

function recolourSphere(g, r, top, horizon) {
	const t0 = new THREE.Color(top), h0 = new THREE.Color(horizon);
	const pos = g.attributes.position;
	const colors = new Float32Array(pos.count * 3);
	const c = new THREE.Color();
	for (let i = 0; i < pos.count; i++) {
		const t = Math.max(0, pos.getY(i) / r);
		c.copy(h0).lerp(t0, Math.pow(t, 0.7)).toArray(colors, i * 3);
	}
	g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Orb: a glowing core inside a faceted amber crystal, circled by two thin
 * rings. animateOrb() makes it breathe, turn and shimmer.
 */
function makeOrb() {
	const group = new THREE.Group();
	group.name = 'menu-orb';
	const core = new THREE.Mesh(new THREE.SphereGeometry(0.011, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff1d6 }));
	const shellMat = new THREE.MeshLambertMaterial({ color: 0xe99a45, emissive: 0x8a3f0c, flatShading: true, transparent: true, opacity: 0.78, depthWrite: false });
	const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.024, 0), shellMat);
	const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd7a3, transparent: true, opacity: 0.9 });
	const ring1 = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.0018, 6, 48), ringMat);
	const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.031, 0.0016, 6, 48), ringMat);
	// Larger invisible target so the orb is easy to hit with the laser.
	const target = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
	const body = new THREE.Group();
	body.add(core, shell, ring1, ring2);
	group.add(body, target);
	group.position.set(0, 0.07, 0.075); // above the back of the hand, toward the wrist
	return { group, body, core, shell, shellMat, ring1, ring2, ringMat, target, holder: null, armed: true, glow: 0, phase: Math.random() * 10 };
}

const ORB_AMBER = new THREE.Color(0xe99a45), ORB_BLUE = new THREE.Color(0x4d8dff);
const ORB_EMBER = new THREE.Color(0x8a3f0c), ORB_EMBER_BLUE = new THREE.Color(0x173f8a);

function animateOrb(o, time, hot) {
	const t = time + o.phase;
	o.glow += ((hot ? 1 : 0) - o.glow) * 0.2;
	// Breathing: two slow waves, so it never looks mechanical.
	const breathe = 1 + 0.1 * Math.sin(t * 2.1) + 0.04 * Math.sin(t * 5.3);
	o.body.scale.setScalar(breathe * (1 + 0.4 * o.glow));
	o.shell.rotation.set(t * 0.5, t * 0.8, 0);
	o.ring1.rotation.set(Math.PI / 2 + 0.5 * Math.sin(t * 0.7), t * 1.3, 0);
	o.ring2.rotation.set(0.6 * Math.sin(t * 0.9), -t * 1.1, Math.PI / 3);
	o.shellMat.color.copy(ORB_AMBER).lerp(ORB_BLUE, o.glow);
	o.shellMat.emissive.copy(ORB_EMBER).lerp(ORB_EMBER_BLUE, o.glow).multiplyScalar(0.8 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3.2)));
	o.ringMat.opacity = 0.6 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2.6));
}

/**
 * Gallery room around the plinth (VR dollhouse): dark oak floor with a pale
 * rug, warm white walls with a dark skirting, a charcoal feature wall, tall
 * windows on both sides, a skylight, and four large abstract canvases.
 * Untextured parts are merged by material to keep draw calls low.
 */
function buildGallery() {
	const g = new THREE.Group();
	g.name = 'gallery';
	const W = 12, D = 12, H = 4.2, T = 0.25; // inner size, wall thickness
	const mats = {
		wall: new THREE.MeshLambertMaterial({ color: 0xefece6 }),
		feature: new THREE.MeshLambertMaterial({ color: 0x3a3f45 }),
		dark: new THREE.MeshLambertMaterial({ color: 0x2b2f33 }),
		ceiling: new THREE.MeshLambertMaterial({ color: 0xf7f6f3 }),
		rug: new THREE.MeshLambertMaterial({ color: 0xb9b2a6 }), // mid tone, so the white plinth stands out
	};
	const parts = new Map(); // material -> geometries
	const box = (mat, w, h, d, x, y, z) => {
		const geo = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
		if (!parts.has(mat)) parts.set(mat, []);
		parts.get(mat).push(geo);
	};

	// Floor: dark oak planks; a pale rug under the plinth.
	const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: plankTexture() }));
	floor.receiveShadow = true;
	g.add(floor);
	box(mats.rug, 5, 0.01, 4.2, 0, 0.005, 0.2);

	// Front (far) wall: charcoal feature wall. Back wall: warm white.
	box(mats.feature, W + 2 * T, H, T, 0, H / 2, -D / 2 - T / 2);
	box(mats.wall, W + 2 * T, H, T, 0, H / 2, D / 2 + T / 2);
	box(mats.dark, W, 0.12, 0.02, 0, 0.06, D / 2 - 0.01); // skirting

	// Side walls with two tall windows each (2.6 m wide, 3 m high, sill 0.5 m).
	const WIN_W = 2.6, WIN_H = 3, SILL = 0.5, centres = [-2.4, 2.4];
	for (const side of [-1, 1]) {
		const x = side * (W / 2 + T / 2);
		const spans = [[-D / 2, centres[0] - WIN_W / 2], [centres[0] + WIN_W / 2, centres[1] - WIN_W / 2], [centres[1] + WIN_W / 2, D / 2]];
		for (const [z0, z1] of spans) box(mats.wall, T, H, z1 - z0, x, H / 2, (z0 + z1) / 2);
		for (const zc of centres) {
			box(mats.wall, T, SILL, WIN_W, x, SILL / 2, zc); // below
			box(mats.wall, T, H - SILL - WIN_H, WIN_W, x, SILL + WIN_H + (H - SILL - WIN_H) / 2, zc); // above
			// Slim dark frame, a mullion and a transom
			const fx = side * (W / 2 + 0.02), F = 0.06;
			box(mats.dark, 0.08, F, WIN_W, fx, SILL + F / 2, zc);
			box(mats.dark, 0.08, F, WIN_W, fx, SILL + WIN_H - F / 2, zc);
			box(mats.dark, 0.08, WIN_H, F, fx, SILL + WIN_H / 2, zc - WIN_W / 2 + F / 2);
			box(mats.dark, 0.08, WIN_H, F, fx, SILL + WIN_H / 2, zc + WIN_W / 2 - F / 2);
			box(mats.dark, 0.06, WIN_H, 0.04, fx, SILL + WIN_H / 2, zc);
			box(mats.dark, 0.06, 0.04, WIN_W, fx, SILL + 2.2, zc);
		}
		for (const [z0, z1] of spans) box(mats.dark, 0.02, 0.12, z1 - z0, side * (W / 2 - 0.01), 0.06, (z0 + z1) / 2); // skirting
	}

	// Ceiling with a 5 x 5 m skylight in the middle.
	const S = 5, CT = 0.15;
	box(mats.ceiling, W, CT, (D - S) / 2, 0, H + CT / 2, -(S + (D - S) / 2) / 2);
	box(mats.ceiling, W, CT, (D - S) / 2, 0, H + CT / 2, (S + (D - S) / 2) / 2);
	box(mats.ceiling, (W - S) / 2, CT, S, -(S + (W - S) / 2) / 2, H + CT / 2, 0);
	box(mats.ceiling, (W - S) / 2, CT, S, (S + (W - S) / 2) / 2, H + CT / 2, 0);

	for (const [mat, geoms] of parts) {
		const m = new THREE.Mesh(mergeGeometries(geoms), mat);
		m.receiveShadow = true;
		g.add(m);
		for (const geo of geoms) geo.dispose();
	}

	// Canvases: big one on the feature wall, one behind you, one on each side.
	const canvas = (w, h, seed, x, y, z, ry) => {
		const c = new THREE.Group();
		const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, h + 0.08, 0.05), mats.dark);
		const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ map: artTexture(seed, w / h) }));
		art.position.z = 0.031; // clear of the frame's front face (0.025), or the two flicker from afar
		c.add(frame, art);
		c.position.set(x, y, z);
		c.rotation.y = ry;
		g.add(c);
	};
	canvas(3.6, 2.2, 1, 0, 2.3, -D / 2 + 0.03, 0);
	canvas(3.0, 1.9, 2, 0, 2.1, D / 2 - 0.03, Math.PI);
	canvas(1.3, 1.9, 3, -W / 2 + 0.03, 2.0, 0, Math.PI / 2);
	canvas(1.3, 1.9, 4, W / 2 - 0.03, 2.0, 0, -Math.PI / 2);
	return g;
}

/**
 * Scale figure: a plain standing mannequin, 1.75 m tall, like the little
 * people in architects' models. One merged mesh, so one draw call.
 */
function buildFigure() {
	const H = FIGURE_HEIGHT / 1.735; // the parts below add up to 1.735
	const parts = [];
	const add = (geo, x, y, z, rz = 0, sz = 1) => parts.push(geo.scale(1, 1, sz).rotateZ(rz).translate(x, y, z));
	add(new THREE.SphereGeometry(0.105, 16, 12), 0, 1.63, 0); // head
	add(new THREE.CylinderGeometry(0.045, 0.05, 0.1, 10), 0, 1.5, 0); // neck
	add(new THREE.CylinderGeometry(0.19, 0.145, 0.52, 14), 0, 1.2, 0, 0, 0.6); // torso
	add(new THREE.CylinderGeometry(0.15, 0.16, 0.18, 14), 0, 0.87, 0, 0, 0.65); // hips
	for (const s of [-1, 1]) {
		add(new THREE.SphereGeometry(0.062, 10, 8), s * 0.2, 1.42, 0); // shoulder
		add(new THREE.CylinderGeometry(0.048, 0.034, 0.62, 10), s * 0.235, 1.12, 0, s * 0.07); // arm
		add(new THREE.CylinderGeometry(0.078, 0.05, 0.8, 10), s * 0.085, 0.4, 0); // leg
		add(new THREE.BoxGeometry(0.09, 0.06, 0.24), s * 0.085, 0.03, 0.045); // foot
	}
	const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
	for (const g of parts) g.dispose();
	geo.scale(H, H, H);
	const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x5b6672 }));
	mesh.name = 'scale-figure';
	mesh.castShadow = mesh.receiveShadow = true;
	mesh.visible = false;
	return mesh;
}

/** Dark oak planks, drawn once on a canvas (2 m tile, 25 cm planks). */
function plankTexture() {
	if (typeof document === 'undefined') return null;
	const c = document.createElement('canvas');
	c.width = c.height = 1024;
	const ctx = c.getContext('2d');
	const rnd = seeded(7);
	const PW = 128;
	for (let col = 0; col < 8; col++) {
		let y = -rnd() * 600;
		while (y < 1024) {
			const len = 400 + rnd() * 500;
			const l = 34 + rnd() * 10, s = 22 + rnd() * 8;
			ctx.fillStyle = `hsl(28, ${s}%, ${l}%)`;
			ctx.fillRect(col * PW, y, PW, len);
			// Grain
			ctx.strokeStyle = 'rgba(30, 18, 8, 0.12)';
			ctx.lineWidth = 2;
			for (let k = 0; k < 6; k++) {
				const gx = col * PW + 10 + rnd() * (PW - 20);
				ctx.beginPath(); ctx.moveTo(gx, y); ctx.bezierCurveTo(gx + 6, y + len / 3, gx - 6, y + 2 * len / 3, gx, y + len); ctx.stroke();
			}
			ctx.fillStyle = 'rgba(20, 12, 6, 0.6)';
			ctx.fillRect(col * PW, y, PW, 3); // plank end
			y += len;
		}
		ctx.fillStyle = 'rgba(20, 12, 6, 0.6)';
		ctx.fillRect(col * PW, 0, 3, 1024); // seam
	}
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(6, 6);
	tex.anisotropy = 4;
	return tex;
}

/** Original abstract painting: soft colour fields, a disc, or bands. */
function artTexture(seed, aspect) {
	if (typeof document === 'undefined') return null;
	const c = document.createElement('canvas');
	c.width = 1024;
	c.height = Math.round(1024 / aspect);
	const ctx = c.getContext('2d');
	const { width: w, height: h } = c;
	const rnd = seeded(seed * 97);
	const palettes = [
		['#efe6d8', '#c65d3b', '#e9b44c', '#1f4e5f'],
		['#e9e4da', '#2e5e4e', '#d9c8a9', '#a33b2a'],
		['#f1ece4', '#3d5a80', '#98c1d9', '#ee6c4d'],
		['#ece6dc', '#6b4e71', '#f2d0a4', '#3a7d44'],
	];
	const [bg, a, b, d] = palettes[seed % palettes.length];
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);
	const soft = (x, y, rw, rh, col) => { ctx.filter = 'blur(6px)'; ctx.fillStyle = col; ctx.fillRect(x, y, rw, rh); ctx.filter = 'none'; };
	const style = seed % 3;
	if (style === 0) { // stacked colour fields
		soft(w * 0.08, h * 0.08, w * 0.84, h * 0.45, a);
		soft(w * 0.08, h * 0.58, w * 0.84, h * 0.22, b);
		soft(w * 0.08, h * 0.84, w * 0.84, h * 0.08, d);
	} else if (style === 1) { // disc over a horizon band
		soft(0, h * (0.55 + rnd() * 0.1), w, h, d);
		ctx.fillStyle = a;
		ctx.beginPath(); ctx.arc(w * (0.35 + rnd() * 0.3), h * 0.42, Math.min(w, h) * 0.24, 0, Math.PI * 2); ctx.fill();
		ctx.strokeStyle = b; ctx.lineWidth = 14;
		ctx.beginPath(); ctx.arc(w * 0.5, h * 1.2, w * 0.7, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
	} else { // diagonal bands
		ctx.save();
		ctx.translate(w / 2, h / 2); ctx.rotate(-0.5);
		const cols = [a, b, d, b, a];
		for (let i = 0; i < 5; i++) { ctx.fillStyle = cols[i]; ctx.fillRect(-w, -h * 0.6 + i * h * 0.26, w * 2, h * 0.16); }
		ctx.restore();
	}
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 4;
	return tex;
}

/** Small seeded random generator, so the room looks the same every time. */
function seeded(s) {
	let x = s >>> 0 || 1;
	return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
