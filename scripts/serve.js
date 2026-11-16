// Tiny static file server for local testing on the Mac:  npm run serve
// (WebXR on the Quest needs HTTPS, so use the GitHub Pages URL there.)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 8123);
const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
	'.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
	'.sh3d': 'application/octet-stream', '.zip': 'application/zip', '.glb': 'model/gltf-binary', '.obj': 'text/plain',
};

export function startServer(p = port) {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://localhost');
		let file;
		try { file = path.join(root, decodeURIComponent(url.pathname)); } catch { res.writeHead(400).end(); return; }
		// Only files inside the project folder (not a sibling whose name starts the same).
		if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
		if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
		fs.readFile(file, (err, data) => {
			if (err) { res.writeHead(404).end('Not found'); return; }
			res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
			res.end(data);
		});
	});
	return new Promise((resolve) => server.listen(p, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await startServer();
	console.log(`Serving ${root} at http://localhost:${port}/`);
}
