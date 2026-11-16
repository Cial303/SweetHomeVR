// App configuration. Safe to commit: the Dropbox app key is public by design
// (the Chooser runs in the browser). Never put the Dropbox app *secret* here.
export const CONFIG = {
	// Filled in during phase 4 (Dropbox Chooser).
	dropboxAppKey: '',

	// Warn (but still load) above this many triangles; Quest 2 is a phone GPU.
	triangleWarning: 1_500_000,

	// Largest file a link may download, in MB (a wrong or hostile link must
	// not be able to fill the headset's memory).
	maxDownloadMB: 500,

	// Textures larger than this (pixels on the longer side) are shrunk after
	// loading: a few 4K images are enough to exhaust a Quest 2's memory.
	maxTextureSize: 2048,

	// Default unit for OBJ files without a unit override ('auto' | 'cm' | 'm' | 'mm' | 'in').
	defaultObjUnits: 'auto',
};
