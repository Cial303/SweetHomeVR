// Module resolve hook mirroring the import map in index.html.
const vendor = new URL('../vendor/', import.meta.url);
const MAP = {
	'three': 'three/three.module.js',
	'three-mesh-bvh': 'three-mesh-bvh/index.module.js',
	'fflate': 'fflate/fflate.module.js',
};

export async function resolve(specifier, context, next) {
	if (MAP[specifier]) return { url: new URL(MAP[specifier], vendor).href, shortCircuit: true };
	if (specifier.startsWith('three/addons/')) return { url: new URL(`three/addons/${specifier.slice(13)}`, vendor).href, shortCircuit: true };
	return next(specifier, context);
}
