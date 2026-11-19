// Links to models: what may be downloaded, and the Dropbox rewrite.
// Pure functions (no DOM), so they run in Node tests.

/**
 * Rewrites Dropbox shared links to a direct, CORS-enabled download URL:
 * www.dropbox.com -> dl.dropboxusercontent.com, force dl=1, keep rlkey.
 * This is an unofficial workaround (SPEC.md); failures are reported politely.
 */
export function directLink(url) {
	let u;
	try { u = new URL(url.trim()); } catch { return url.trim(); }
	if (/(^|\.)dropbox\.com$/i.test(u.hostname)) {
		u.hostname = 'dl.dropboxusercontent.com';
		u.searchParams.delete('raw');
		u.searchParams.set('dl', '1');
	}
	return u.toString();
}

/**
 * Checks a link before anything is downloaded.
 * Allowed: https links, and links on this site itself (the page's own
 * samples; http://localhost while developing). Everything else (http to
 * other sites, javascript:, data:, file: ...) is refused.
 *
 * @param url   what the user pasted, or the ?model= parameter
 * @param base  the page address (location.href)
 * @returns { ok, url (absolute), sameOrigin, host } or { ok: false, error }
 */
export function checkLink(url, base) {
	let u, b;
	try { b = new URL(base); u = new URL(directLink(url), b); } catch { return { ok: false, error: 'That is not a valid link.' }; }
	const sameOrigin = u.origin === b.origin && /^https?:$/.test(u.protocol);
	if (u.protocol !== 'https:' && !sameOrigin) return { ok: false, error: 'Only https:// links can be opened.' };
	return { ok: true, url: u.toString(), sameOrigin, host: u.host };
}

/** A readable file name from a link's path (never throws on odd encoding). */
export function fileNameOf(url) {
	let last = 'model';
	try { last = new URL(url).pathname.split('/').pop() || 'model'; } catch { /* keep the default */ }
	try { return decodeURIComponent(last); } catch { return last; }
}

/**
 * The address that sends this viewer to the user's Quest: Meta's "Web
 * Launch" page (https://developers.meta.com/horizon/documentation/web/web-launch/),
 * which opens an https page in the headset's browser. With `link`, the viewer
 * opens there with that model link filled in (as ?model=), so nothing has to
 * be typed in the headset.
 *
 * @param pageUrl  this page's address (location.href)
 * @param link     a model link as the user pasted it, or '' to send the viewer alone
 * @returns the address to open on the computer or phone, or null if this page
 *          is not served over https (Web Launch only accepts https pages)
 */
export function sendToQuestUrl(pageUrl, link = '') {
	let page;
	try { page = new URL(pageUrl); } catch { return null; }
	if (page.protocol !== 'https:') return null;
	page.search = '';
	page.hash = '';
	if (link) page.searchParams.set('model', link);
	const launch = new URL('https://www.oculus.com/open_url/');
	launch.searchParams.set('url', page.toString());
	return launch.toString();
}
