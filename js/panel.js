// Floating VR menu drawn on a canvas texture and clicked with the controller
// laser. Buttons are stacked vertically; hitTest() maps a ray hit (UV) to a
// button id.

import * as THREE from 'three';

const PX_PER_M = 1024; // canvas pixels per metre of panel
const PAD = 24, GAP = 16, BTN_H = 96, TITLE_H = 72, HINT_H = 56;

export class Panel {
	/**
	 * @param items  [{ id, label }]
	 * @param opts   { title, hint (small text under the buttons), width (m), pxPerM (canvas pixels per metre), columns }
	 */
	constructor(items, { title = '', hint = '', width = 0.36, pxPerM = PX_PER_M, columns = 1 } = {}) {
		this.items = items.map((i) => ({ ...i }));
		this.columns = columns;
		this.title = title;
		this.hint = hint;
		this.hover = null;
		const wPx = Math.round(width * pxPerM);
		const rows = Math.ceil(items.length / columns);
		const hPx = PAD * 2 + (title ? TITLE_H : 0) + rows * BTN_H + (rows - 1) * GAP + (hint ? HINT_H : 0);
		this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
		if (this.canvas) { this.canvas.width = wPx; this.canvas.height = hPx; }
		this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
		if (this.texture) { this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.anisotropy = 4; }
		const geo = new THREE.PlaneGeometry(width, hPx / pxPerM);
		const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false });
		this.mesh = new THREE.Mesh(geo, mat);
		this.mesh.name = 'panel';
		this.mesh.renderOrder = 10;
		this.size = { w: wPx, h: hPx };
		this.draw();
	}

	/** Button rectangles in canvas pixels. */
	rects() {
		const top = PAD + (this.title ? TITLE_H : 0);
		const c = this.columns;
		const w = (this.size.w - 2 * PAD - (c - 1) * GAP) / c;
		return this.items.map((it, i) => ({
			id: it.id, x: PAD + (i % c) * (w + GAP), y: top + Math.floor(i / c) * (BTN_H + GAP), w, h: BTN_H,
		}));
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
			let px = 40; // shrink long labels to fit
			do ctx.font = `500 ${px}px -apple-system, "Segoe UI", Roboto, sans-serif`;
			while (ctx.measureText(it.label).width > r.w - 32 && --px > 24);
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

// ---------------------------------------------------------------------------
// Controls card: a drawing of the two Quest controllers (top view) with what
// each stick, trigger, grip and button does in the current mode. Shown beside
// the menu.
// ---------------------------------------------------------------------------

const CARD_W = 1200, CARD_H = 1140; // canvas pixels (room for 7 rows)
const FOOTER_H = 190; // extra height for the footer tip (screenshot reminder)
const FONT = '-apple-system, "Segoe UI", Roboto, sans-serif';
const BADGE = {
	stick: { fill: '#5d6873', text: '#fff' },
	shot: { fill: '#7a4fd0', text: '#fff' },
	trigger: { fill: '#3d6fd8', text: '#fff' },
	grip: { fill: '#2f9e6a', text: '#fff' },
	button: { fill: '#1d2329', text: '#fff' },
	orb: { fill: '#d9822b', text: '#fff' },
};

export class ControlsCard {
	/**
	 * @param title  e.g. 'Controls: dollhouse'
	 * @param hands  { left: [{ kind, key, text }], right: [...] }
	 *               kind: stick | trigger | grip | button | orb; key: badge text
	 * @param footer { key, lines: [text, text] }: a full-width tip under both hands
	 */
	constructor(title, hands, { width = 0.46, footer = null } = {}) {
		this.title = title;
		this.hands = hands;
		this.footer = footer;
		const w = CARD_W, h = CARD_H + (footer ? FOOTER_H : 0), height = width * h / w;
		this.size = { w, h };
		this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
		if (this.canvas) { this.canvas.width = w; this.canvas.height = h; }
		this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
		if (this.texture) { this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.anisotropy = 4; }
		this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height),
			new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthTest: false }));
		this.mesh.name = 'controls-card';
		this.mesh.renderOrder = 10;
		this.draw();
	}

	draw() {
		if (!this.canvas) return;
		const ctx = this.canvas.getContext('2d');
		const { w, h } = this.size;
		ctx.clearRect(0, 0, w, h);
		roundRect(ctx, 0, 0, w, h, 48);
		ctx.fillStyle = 'rgba(255,255,255,0.95)';
		ctx.fill();
		ctx.textBaseline = 'middle';
		ctx.fillStyle = '#1d2329';
		ctx.font = `600 52px ${FONT}`;
		ctx.fillText(this.title, 48, 70);
		const half = w / 2;
		this.drawHand(ctx, 'left', 0, half);
		this.drawHand(ctx, 'right', half, half);
		// Divider
		ctx.strokeStyle = '#e3e7eb';
		ctx.lineWidth = 3;
		ctx.beginPath(); ctx.moveTo(half, 130); ctx.lineTo(half, CARD_H - 40); ctx.stroke();
		if (this.footer) this.drawFooter(ctx, CARD_H, w);
		this.texture.needsUpdate = true;
	}

	/** Full-width tip under both hands: a badge and up to two lines of text. */
	drawFooter(ctx, y0, w) {
		const { key, lines } = this.footer;
		ctx.strokeStyle = '#e3e7eb';
		ctx.lineWidth = 3;
		ctx.beginPath(); ctx.moveTo(44, y0 - 10); ctx.lineTo(w - 44, y0 - 10); ctx.stroke();
		const b = BADGE.shot, cy = y0 + FOOTER_H / 2 - 25;
		ctx.font = `700 28px ${FONT}`;
		const bw = Math.max(64, ctx.measureText(key).width + 32);
		roundRect(ctx, 44, cy - 26, bw, 52, 14);
		ctx.fillStyle = b.fill; ctx.fill();
		ctx.fillStyle = b.text;
		ctx.textAlign = 'center';
		ctx.fillText(key, 44 + bw / 2, cy + 1);
		ctx.textAlign = 'left';
		const x = 44 + bw + 20, max = w - x - 44;
		let px = 34;
		do ctx.font = `400 ${px}px ${FONT}`;
		while (lines.some((t) => ctx.measureText(t).width > max) && --px > 20);
		ctx.fillStyle = '#1d2329';
		lines.forEach((t, i) => ctx.fillText(t, x, cy + (i - (lines.length - 1) / 2) * (px + 12) + 1));
	}

	drawHand(ctx, side, x0, width) {
		const rows = this.hands[side] || [];
		const cx = x0 + width / 2, top = 130;
		const isLeft = side === 'left';
		const btn = isLeft ? ['X', 'Y'] : ['A', 'B'];

		// Controller, top view: tracking ring, handle, face with stick and buttons.
		ctx.save();
		ctx.translate(cx, top + 150);
		ctx.lineWidth = 10;
		ctx.strokeStyle = '#2b3036';
		ctx.beginPath(); ctx.arc(isLeft ? -40 : 40, -40, 105, 0, Math.PI * 2); ctx.stroke(); // ring
		ctx.fillStyle = '#2b3036';
		roundRect(ctx, -70, -60, 140, 230, 60); ctx.fill(); // body
		// Trigger (front) and grip (inner side) tabs
		ctx.fillStyle = BADGE.trigger.fill;
		roundRect(ctx, -34, -96, 68, 30, 12); ctx.fill();
		ctx.fillStyle = BADGE.grip.fill;
		roundRect(ctx, isLeft ? 64 : -84, 30, 20, 100, 8); ctx.fill();
		// Stick and buttons
		ctx.fillStyle = '#8a949e';
		ctx.beginPath(); ctx.arc(isLeft ? 18 : -18, -10, 30, 0, Math.PI * 2); ctx.fill();
		ctx.fillStyle = '#5d6873';
		ctx.beginPath(); ctx.arc(isLeft ? 18 : -18, -10, 16, 0, Math.PI * 2); ctx.fill();
		ctx.font = `700 28px ${FONT}`;
		ctx.textAlign = 'center';
		const bx = isLeft ? -22 : 22;
		for (const [i, k] of btn.entries()) {
			const by = 60 + i * 56;
			ctx.fillStyle = '#e8ecef';
			ctx.beginPath(); ctx.arc(bx + (isLeft ? -6 : 6) * i, by, 22, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = '#1d2329';
			ctx.fillText(k, bx + (isLeft ? -6 : 6) * i, by + 1);
		}
		// Orb above the back of the hand
		ctx.fillStyle = BADGE.orb.fill;
		ctx.beginPath(); ctx.arc(0, 200, 16, 0, Math.PI * 2); ctx.fill();
		ctx.restore();

		ctx.textAlign = 'left';
		ctx.fillStyle = '#5d6873';
		ctx.font = `600 34px ${FONT}`;
		ctx.textAlign = 'center';
		ctx.fillText(isLeft ? 'Left hand' : 'Right hand', cx, top + 395);
		ctx.textAlign = 'left';

		// Rows: coloured badge + what it does.
		let y = top + 470;
		for (const r of rows) {
			const b = BADGE[r.kind] || BADGE.button;
			ctx.font = `700 28px ${FONT}`;
			const bw = Math.max(64, ctx.measureText(r.key).width + 32);
			roundRect(ctx, x0 + 44, y - 26, bw, 52, 14);
			ctx.fillStyle = b.fill; ctx.fill();
			ctx.fillStyle = b.text;
			ctx.textAlign = 'center';
			ctx.fillText(r.key, x0 + 44 + bw / 2, y + 1);
			ctx.textAlign = 'left';
			ctx.fillStyle = '#1d2329';
			let px = 34;
			do ctx.font = `400 ${px}px ${FONT}`;
			while (ctx.measureText(r.text).width > width - bw - 90 && --px > 22);
			ctx.fillText(r.text, x0 + 44 + bw + 20, y + 1);
			y += 68;
		}
	}
}
