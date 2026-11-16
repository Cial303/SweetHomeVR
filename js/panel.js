// Floating VR menu drawn on a canvas texture and clicked with the controller
// laser. Buttons are stacked vertically; hitTest() maps a ray hit (UV) to a
// button id.

import * as THREE from 'three';

const PX_PER_M = 1024; // canvas pixels per metre of panel
const PAD = 24, GAP = 16, BTN_H = 96, TITLE_H = 72, HINT_H = 56;

export class Panel {
	/**
	 * @param items  [{ id, label }]
	 * @param opts   { title, hint (small text under the buttons), width (m) }
	 */
	constructor(items, { title = '', hint = '', width = 0.36 } = {}) {
		this.items = items.map((i) => ({ ...i }));
		this.title = title;
		this.hint = hint;
		this.hover = null;
		const wPx = Math.round(width * PX_PER_M);
		const hPx = PAD * 2 + (title ? TITLE_H : 0) + items.length * BTN_H + (items.length - 1) * GAP + (hint ? HINT_H : 0);
		this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
		if (this.canvas) { this.canvas.width = wPx; this.canvas.height = hPx; }
		this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
		if (this.texture) { this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.anisotropy = 4; }
		const geo = new THREE.PlaneGeometry(width, hPx / PX_PER_M);
		const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false });
		this.mesh = new THREE.Mesh(geo, mat);
		this.mesh.name = 'panel';
		this.mesh.renderOrder = 10;
		this.size = { w: wPx, h: hPx };
		this.draw();
	}

	/** Button rectangles in canvas pixels. */
	rects() {
		let y = PAD + (this.title ? TITLE_H : 0);
		return this.items.map((it) => {
			const r = { id: it.id, x: PAD, y, w: this.size.w - 2 * PAD, h: BTN_H };
			y += BTN_H + GAP;
			return r;
		});
	}

	draw() {
		if (!this.canvas) return;
		const ctx = this.canvas.getContext('2d');
		const { w, h } = this.size;
		ctx.clearRect(0, 0, w, h);
		roundRect(ctx, 0, 0, w, h, 36);
		ctx.fillStyle = 'rgba(255,255,255,0.94)';
		ctx.fill();
		ctx.textBaseline = 'middle';
		if (this.title) {
			ctx.fillStyle = '#1d2329';
			ctx.font = '600 40px -apple-system, "Segoe UI", Roboto, sans-serif';
			ctx.fillText(this.title, PAD + 8, PAD + TITLE_H / 2 - 4);
		}
		for (const r of this.rects()) {
			const it = this.items.find((i) => i.id === r.id);
			const hot = this.hover === r.id;
			roundRect(ctx, r.x, r.y, r.w, r.h, 20);
			ctx.fillStyle = hot ? '#d9822b' : '#eef1f4';
			ctx.fill();
			ctx.fillStyle = hot ? '#ffffff' : '#1d2329';
			ctx.font = '500 40px -apple-system, "Segoe UI", Roboto, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(it.label, r.x + r.w / 2, r.y + r.h / 2 + 2);
			ctx.textAlign = 'left';
		}
		if (this.hint) {
			ctx.fillStyle = '#5d6873';
			let px = 30; // shrink to fit the width
			do ctx.font = `400 ${px}px -apple-system, "Segoe UI", Roboto, sans-serif`;
			while (ctx.measureText(this.hint).width > w - 2 * PAD && --px > 16);
			ctx.textAlign = 'center';
			ctx.fillText(this.hint, w / 2, h - PAD - HINT_H / 2 + 8);
			ctx.textAlign = 'left';
		}
		this.texture.needsUpdate = true;
	}

	/** Button id under a ray hit's UV coordinates, or null. */
	hitTest(uv) {
		if (!uv) return null;
		const x = uv.x * this.size.w, y = (1 - uv.y) * this.size.h;
		const r = this.rects().find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
		return r ? r.id : null;
	}

	setHover(id) {
		if (id === this.hover) return;
		this.hover = id;
		this.draw();
	}

	setLabel(id, label) {
		const it = this.items.find((i) => i.id === id);
		if (it && it.label !== label) { it.label = label; this.draw(); }
	}
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}
