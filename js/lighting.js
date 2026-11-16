// Lights, time of day and shadows (SPEC.md, "Performance").
//
// One hemisphere light and one directional light (the sun, or the moon at
// night). The sun's direction comes from the home's compass (north direction
// and latitude) for a spring/autumn day (equinox), so morning light comes in
// through the east-facing windows.
//
// Shadows are optional and off by default. The scene only moves when the
// dollhouse is moved, so the shadow map is rendered once and again only
// when something changes (shadowMap.autoUpdate = false): at walking time it
// costs one texture lookup per pixel, not a second render of the house.

import * as THREE from 'three';

export const TIMES = ['morning', 'noon', 'sunset', 'night'];
const DEG = Math.PI / 180;
const SHADOW_SIZE = 2048;

// Colours and strengths per time of day. Noon matches the original look.
// sky/ground: hemisphere light; top/horizon: sky dome gradient (null = the home's sky colour).
const PRESETS = {
	morning: { hourAngle: -45 * DEG, sun: 0xffe7c8, sunI: 1.7, sky: 0xe6eefa, ground: 0xb2a898, hemiI: 2.0, top: 0x8db6e4, horizon: 0xf7eee0 },
	noon: { hourAngle: 0, sun: 0xffffff, sunI: 1.6, sky: 0xffffff, ground: 0xb4b0a8, hemiI: 2.2, top: null, horizon: 0xf5f7f9 },
	sunset: { elevation: 5 * DEG, sun: 0xff9b52, sunI: 2.2, sky: 0xffe6d2, ground: 0x9c8c84, hemiI: 1.75, top: 0x6b7fb8, horizon: 0xffb98c },
	// Night: a dim bluish moon and a soft warm fill, as if the lamps were on.
	night: { hourAngle: 0, elevation: 35 * DEG, sun: 0xb0c2ff, sunI: 0.4, sky: 0xfff0dc, ground: 0x4a4440, hemiI: 1.05, top: 0x070d1c, horizon: 0x1c2944 },
};

/**
 * Sun elevation and azimuth (radians; azimuth from north, clockwise) for a
 * latitude and solar hour angle (0 = solar noon, negative = morning).
 */
export function sunAngles(latitude, hourAngle, declination = 0) {
	const sinE = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
	const elevation = Math.asin(THREE.MathUtils.clamp(sinE, -1, 1));
	const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(declination) * Math.cos(latitude) - Math.sin(latitude) * Math.cos(hourAngle));
	return { elevation, azimuth: (azimuth + 2 * Math.PI) % (2 * Math.PI) };
}

/** Afternoon hour angle at which the sun is at `elevation` (or noon if it never gets that low). */
export function hourAngleAt(latitude, elevation, declination = 0) {
	const c = (Math.sin(elevation) - Math.sin(latitude) * Math.sin(declination)) / (Math.cos(latitude) * Math.cos(declination));
	return Math.acos(THREE.MathUtils.clamp(c, -1, 1));
}

/**
 * Unit vector towards the sun (or moon) in model space for a time of day.
 * Plan axes: x right, y down the page; in 3D, plan (x, y) is (x, z) and y is
 * up. compass.northDirection turns plan "up" clockwise to north.
 */
export function sunDirection(compass, time) {
	const p = PRESETS[time] || PRESETS.noon;
	const lat = compass?.latitude ?? Math.PI / 4;
	const hour = p.elevation !== undefined && p.hourAngle === undefined ? hourAngleAt(lat, p.elevation) : p.hourAngle;
	let { elevation, azimuth } = sunAngles(lat, hour);
	if (p.elevation !== undefined) elevation = p.elevation;
	const n = compass?.northDirection ?? 0;
	const north = new THREE.Vector3(Math.sin(n), 0, -Math.cos(n));
	const east = new THREE.Vector3(Math.cos(n), 0, Math.sin(n));
	return north.multiplyScalar(Math.cos(azimuth)).addScaledVector(east, Math.sin(azimuth))
		.multiplyScalar(Math.cos(elevation)).add(new THREE.Vector3(0, Math.sin(elevation), 0)).normalize();
}

export class Lighting {
	constructor(scene, renderer) {
		this.scene = scene;
		this.renderer = renderer;
		this.hemi = new THREE.HemisphereLight(0xffffff, 0xb4b0a8, 2.2);
		this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
		this.sun.target = new THREE.Object3D();
		this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
		scene.add(this.hemi, this.sun, this.sun.target);
		renderer.shadowMap.type = THREE.PCFShadowMap;
		renderer.shadowMap.autoUpdate = false; // rendered on demand: see fit()
		this.time = 'noon';
		this.shadows = false;
		this.compass = null;
		this.homeSky = 0xcce4fc;
		this.subject = null; // { object, box }: what the sun follows and the shadow covers
		this.onChange = null;
	}

	/** The home's compass and sky colour. */
	setHome({ compass, skyColor }) {
		this.compass = compass || null;
		this.homeSky = skyColor ?? 0xcce4fc;
		this.apply();
	}

	/** What to light: an object and a box in its local space (the model bounds). */
	setSubject(object, box) {
		this.subject = object && box ? { object, box } : null;
		this.fit();
	}

	setTime(time) {
		if (!PRESETS[time]) return;
		this.time = time;
		this.apply();
	}

	nextTime() { this.setTime(TIMES[(TIMES.indexOf(this.time) + 1) % TIMES.length]); }

	setShadows(on) {
		on = !!on;
		if (on === this.shadows) return;
		this.shadows = on;
		this.renderer.shadowMap.enabled = on;
		this.sun.castShadow = on;
		// Materials compile differently with shadows: rebuild them once.
		this.scene.traverse((o) => {
			for (const m of [].concat(o.material || [])) m.needsUpdate = true;
		});
		this.apply();
	}

	apply() {
		const p = PRESETS[this.time];
		this.hemi.color.set(p.sky);
		this.hemi.groundColor.set(p.ground);
		// With shadows on, less fill light and more sun, so the shadows read.
		this.hemi.intensity = p.hemiI * (this.shadows ? 0.9 : 1);
		this.sun.color.set(p.sun);
		this.sun.intensity = p.sunI * (this.shadows ? 1.6 : 1);
		this.fit();
		this.onChange?.();
	}

	/** Sky gradient for the current time: { top, horizon } colours. */
	skyColors() {
		const p = PRESETS[this.time];
		return { top: p.top ?? this.homeSky, horizon: p.horizon };
	}

	/** Plain background colour for the 2D view. */
	background() {
		const p = PRESETS[this.time];
		return new THREE.Color(p.top ?? this.homeSky).lerp(new THREE.Color(p.horizon), { noon: 0, morning: 0.35, sunset: 0.6, night: 0.2 }[this.time]);
	}

	/**
	 * Points the sun at the subject from the time-of-day direction (turning
	 * with the model, so the light keeps coming through the same windows),
	 * fits the shadow camera around it, and asks for one shadow render.
	 * Call whenever the model is moved, turned or scaled.
	 */
	fit() {
		const s = this.subject;
		if (!s) return;
		s.object.updateMatrixWorld(true);
		// Nothing moved and nothing changed: keep the current shadow map.
		const key = `${this.time}|${this.shadows}|${s.object.matrixWorld.elements.join(',')}|${s.box.min.toArray()}|${s.box.max.toArray()}`;
		if (key === this._lastFit) return;
		this._lastFit = key;
		const sphere = s.box.clone().applyMatrix4(s.object.matrixWorld).getBoundingSphere(new THREE.Sphere());
		const r = Math.max(sphere.radius * 1.3, 0.05);
		const dir = sunDirection(this.compass, this.time).transformDirection(s.object.matrixWorld);
		this.sun.target.position.copy(sphere.center);
		this.sun.position.copy(sphere.center).addScaledVector(dir, r * 3);
		this.sun.target.updateMatrixWorld();
		this.sun.updateMatrixWorld();
		const cam = this.sun.shadow.camera;
		cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
		cam.near = r * 0.5; cam.far = r * 5;
		cam.updateProjectionMatrix();
		const texel = (2 * r) / SHADOW_SIZE;
		this.sun.shadow.normalBias = texel * 1.5; // world units: grows with the subject
		this.sun.shadow.bias = -0.0002;
		this.renderer.shadowMap.needsUpdate = true;
	}
}
