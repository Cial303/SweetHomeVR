// Downloads the public Sweet Home 3D example homes into tests/fixtures/.
// They are not committed (see .gitignore). Personal files go in
// tests/fixtures/private/, which is also ignored.

import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../tests/fixtures');
const FILES = ['userGuideExample.sh3d', 'SweetHome3DExample.sh3d'];

fs.mkdirSync(dir, { recursive: true });
for (const name of FILES) {
	const dst = path.join(dir, name);
	if (fs.existsSync(dst)) { console.log('have', name); continue; }
	const res = await fetch(`https://www.sweethome3d.com/examples/${name}`);
	if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
	fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
	console.log('downloaded', name);
}
