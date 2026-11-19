// Links to models: what may be downloaded, and how share links from storage
// services become downloads. Pure functions (no DOM), so they run in Node tests.
//
// A web page can only download a file from another site if that site allows
// it (CORS). Each service is different (SPEC.md, "Links from storage services"):
//   Dropbox       share link -> dl.dropboxusercontent.com (allowed)
//   Google Drive  share link -> Google's Drive API, with the site's Google API
//                 key (config.js): resolveGoogleDrive(). Google refuses its
//                 plain download address to other websites.
//   OneDrive      share link -> Microsoft's anonymous share API, which gives a
//                 short-lived download address (allowed): resolveOneDrive()
//   GitHub        file page  -> raw.githubusercontent.com (allowed)
//   any other https link that allows it works as it is.
// Services that never allow it (OneDrive for work, iCloud, Box, WeTransfer,
// MEGA) are recognised, so the message can say what to do instead.
// These rewrites are unofficial; failures are reported politely.

const hostIs = (u, ...domains) => domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));

/** Services whose links cannot be downloaded by another site, with the service's name. */
const BLOCKED = [
	[['sharepoint.com'], 'OneDrive for work or school'],
	[['icloud.com'], 'iCloud Drive'],
	[['box.com', 'box.net'], 'Box'],
	[['wetransfer.com', 'we.tl'], 'WeTransfer'],
	[['mega.nz', 'mega.io'], 'MEGA'],
];

/** UTF-8 text to unpadded base64url (Node and browsers alike). */
function base64url(text) {
	let bin = '';
	for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Recognises a share link and says how to download it.
 * @returns { url, service, googleDrive?, oneDrive?, problem?, blocked? }
 *   url          the address to download (unchanged if nothing applies)
 *   service      'Dropbox' | 'Google Drive' | 'OneDrive' | 'GitHub' | another
 *                known service | '' (any other site)
 *   googleDrive  { id, resourceKey? } for resolveGoogleDrive() (the url is
 *                not downloadable as is)
 *   oneDrive     a share id for resolveOneDrive() (likewise)
 *   problem   why this link cannot be opened (a folder, a blocked service)
 *   blocked   the service never allows it (the user needs another way)
 */
export function shareLink(url) {
	const text = String(url).trim();
	let u;
	try { u = new URL(text); } catch { return { url: text, service: '' }; }
	const path = u.pathname;

	if (hostIs(u, 'dropbox.com')) {
		// www.dropbox.com -> dl.dropboxusercontent.com, force dl=1, keep rlkey.
		if (/^\/(scl\/fo|sh)\//.test(path)) return { url: text, service: 'Dropbox', problem: 'That is a Dropbox folder. Share the model file itself.' };
		u.hostname = 'dl.dropboxusercontent.com';
		u.searchParams.delete('raw');
		u.searchParams.set('dl', '1');
		return { url: u.toString(), service: 'Dropbox' };
	}

	if (hostIs(u, 'drive.google.com', 'docs.google.com', 'drive.usercontent.google.com')) {
		if (/\/folders\//.test(path)) return { url: text, service: 'Google Drive', problem: 'That is a Google Drive folder. Share the model file itself.' };
		const id = path.match(/\/file\/(?:u\/\d+\/)?d\/([-\w]+)/)?.[1] || u.searchParams.get('id');
		if (!id || !/^[-\w]+$/.test(id)) return { url: text, service: 'Google Drive', problem: 'That Google Drive link is not a file. Share the model file itself (Share → Copy link).' };
		const resourceKey = u.searchParams.get('resourcekey'); // older shared files need it
		return { url: text, service: 'Google Drive', googleDrive: { id, ...(resourceKey && /^[-\w]+$/.test(resourceKey) && { resourceKey }) } };
	}

	if (hostIs(u, '1drv.ms', 'onedrive.live.com')) {
		if (/^\/f\//.test(path) && u.hostname === '1drv.ms') return { url: text, service: 'OneDrive', problem: 'That is a OneDrive folder. Share the model file itself.' };
		// The share id is the share link itself, encoded. A link opened in the
		// browser and copied from the address bar carries it as "redeem".
		const redeem = u.searchParams.get('redeem');
		const id = redeem ? redeem.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : base64url(text);
		if (!/^[-\w]+$/.test(id)) return { url: text, service: 'OneDrive', problem: 'That OneDrive link is not a shared file. Use Share → Copy link.' };
		return { url: text, service: 'OneDrive', oneDrive: `u!${id}` };
	}

	if (u.hostname === 'github.com') {
		// github.com/owner/repo/blob/branch/path -> raw.githubusercontent.com/owner/repo/branch/path
		const m = path.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
		if (m) return { url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`, service: 'GitHub' };
		return { url: text, service: 'GitHub' };
	}

	for (const [domains, service] of BLOCKED) {
		if (hostIs(u, ...domains)) return { url: text, service, blocked: true, problem: `${service} does not let other websites download its files.` };
	}
	return { url: text, service: '' };
}

/** The download address of a link (share links rewritten; see shareLink). */
export function directLink(url) { return shareLink(url).url; }

// OneDrive (personal accounts). Since 2025 these files sit behind Microsoft's
// SharePoint-based API, which serves shared files to anonymous visitors once
// they hold a guest token: the same steps the OneDrive web page takes when
// someone opens a shared link without signing in. No account is involved and
// nothing but the share link is sent. Unofficial, so it may change.
export const ONEDRIVE_TOKEN_URL = 'https://api-badgerp.svc.ms/v1.0/token';
export const ONEDRIVE_SHARES_URL = 'https://my.microsoftpersonalcontent.com/_api/v2.0/shares/';
const ONEDRIVE_WEB_APP = { id: '1141147648', uuid: '5cbed6ac-a083-4e14-b191-b4ba07653de2' };

/** A message for the user (shown as it is). */
export class LinkError extends Error {}

/**
 * Turns a OneDrive share id (from shareLink) into a download address.
 * @param shareId  'u!…'
 * @param fetchFn  fetch (passed in so the tests can fake it)
 * @returns { url, name, size }
 */
export async function resolveOneDrive(shareId, fetchFn = fetch) {
	const quiet = { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };
	let res = await fetchFn(ONEDRIVE_TOKEN_URL, {
		...quiet,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', AppId: ONEDRIVE_WEB_APP.id },
		body: JSON.stringify({ appId: ONEDRIVE_WEB_APP.uuid }),
	});
	const token = res.ok ? (await res.json().catch(() => null))?.token : null;
	if (typeof token !== 'string' || !token) throw new LinkError('OneDrive did not answer. Try again in a moment.');

	res = await fetchFn(`${ONEDRIVE_SHARES_URL}${encodeURIComponent(shareId).replace(/%21/g, '!')}/driveitem`, {
		...quiet,
		headers: { Authorization: `Badger ${token}`, Prefer: 'autoredeem' },
	});
	if (!res.ok) {
		throw new LinkError([400, 401, 403, 404].includes(res.status) // (400: a link OneDrive does not know)
			? 'OneDrive would not share that file. In OneDrive, use Share and set it to “Anyone with the link”, then copy the link again.'
			: `OneDrive did not answer (HTTP ${res.status}). Try again in a moment.`);
	}
	const item = await res.json().catch(() => null);
	if (item?.folder) throw new LinkError('That is a OneDrive folder. Share the model file itself.');
	const url = item?.['@content.downloadUrl'];
	let ok = false;
	try { ok = typeof url === 'string' && new URL(url).protocol === 'https:'; } catch { /* not a link */ }
	if (!ok) throw new LinkError('OneDrive did not give a download for that link.');
	return { url, name: typeof item.name === 'string' && item.name ? item.name.slice(0, 255) : 'OneDrive file', size: Number.isSafeInteger(item.size) ? item.size : 0 };
}

// Google Drive: the Drive API serves files shared with "Anyone with the link"
// to any website that holds an API key (https://developers.google.com/drive/api/guides/manage-downloads).
// The key is public by design (like Dropbox's app key): in Google Cloud it is
// limited to the Drive API and to this site's address, which Google checks
// from the Referer header, so only the page's origin is sent as referrer.
export const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3/files/';

/**
 * Turns a Google Drive file (from shareLink) into a download.
 * @param file     { id, resourceKey? }
 * @param apiKey   CONFIG.googleApiKey
 * @param fetchFn  fetch (passed in so the tests can fake it)
 * @returns { url, name, size, init } (init: the fetch options the download needs)
 */
export async function resolveGoogleDrive(file, apiKey, fetchFn = fetch) {
	const init = {
		credentials: 'omit',
		referrerPolicy: 'strict-origin', // the key is limited to this site: Google checks the origin
		cache: 'no-store',
		headers: file.resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${file.id}/${file.resourceKey}` } : {},
	};
	const at = (query) => `${GOOGLE_DRIVE_API}${encodeURIComponent(file.id)}?${new URLSearchParams({ ...query, supportsAllDrives: 'true', key: apiKey })}`;
	const res = await fetchFn(at({ fields: 'name,size,mimeType' }), init);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
		if (res.status === 404) throw new LinkError('Google Drive would not share that file. In Google Drive, use Share and set General access to “Anyone with the link”, then copy the link again.');
		if (/keyInvalid|API_KEY|referer|forbidden|accessNotConfigured|PERMISSION_DENIED/i.test(reason) || res.status === 400) {
			throw new LinkError('This copy of the viewer is not set up for Google Drive (its Google API key is missing or not allowed here).');
		}
		throw new LinkError(`Google Drive did not answer (HTTP ${res.status}). Try again in a moment.`);
	}
	const meta = await res.json().catch(() => null);
	const mime = typeof meta?.mimeType === 'string' ? meta.mimeType : '';
	if (mime === 'application/vnd.google-apps.folder') throw new LinkError('That is a Google Drive folder. Share the model file itself.');
	if (mime.startsWith('application/vnd.google-apps.')) throw new LinkError('That Google Drive link is a Google document, not a model file.');
	const size = Number(meta?.size);
	return {
		url: at({ alt: 'media' }),
		name: typeof meta?.name === 'string' && meta.name ? meta.name.slice(0, 255) : 'Google Drive file',
		size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
		init,
	};
}

/** True when downloaded bytes are a web page (a sign-in or warning page) rather than a file. */
export function looksLikeWebPage(bytes) {
	const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
	return head.startsWith('<!doctype html') || head.startsWith('<html') || (head.startsWith('<') && head.includes('<head'));
}

/**
 * Checks a link before anything is downloaded.
 * Allowed: https links, and links on this site itself (the page's own
 * samples; http://localhost while developing). Everything else (http to
 * other sites, javascript:, data:, file: ...) is refused.
 *
 * @param url   what the user pasted, or the ?model= parameter
 * @param base  the page address (location.href)
 * @returns { ok, url (absolute), sameOrigin, host, service, oneDrive?, problem? }
 *          or { ok: false, error }
 */
export function checkLink(url, base) {
	let u, b, share;
	try { b = new URL(base); share = shareLink(url); u = new URL(share.url, b); } catch { return { ok: false, error: 'That is not a valid link.' }; }
	const sameOrigin = u.origin === b.origin && /^https?:$/.test(u.protocol);
	if (u.protocol !== 'https:' && !sameOrigin) return { ok: false, error: 'Only https:// links can be opened.' };
	const out = { ok: true, url: u.toString(), sameOrigin, host: u.host, service: share.service };
	if (share.googleDrive) out.googleDrive = share.googleDrive;
	if (share.oneDrive) out.oneDrive = share.oneDrive;
	if (share.problem) out.problem = share.problem;
	if (share.blocked) out.blocked = true;
	return out;
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
 * @param what     a model link (string), or { model: link } or { pair: pairing
 *                 name } (a file on this computer, sent over a direct link: pairing.js);
 *                 nothing to send the viewer alone
 * @returns the address to open on the computer or phone, or null if this page
 *          is not served over https (Web Launch only accepts https pages)
 */
export function sendToQuestUrl(pageUrl, what = '') {
	const { model = '', pair = '' } = typeof what === 'string' ? { model: what } : what;
	let page;
	try { page = new URL(pageUrl); } catch { return null; }
	if (page.protocol !== 'https:') return null;
	page.search = '';
	page.hash = '';
	if (model) page.searchParams.set('model', model);
	if (pair) page.searchParams.set('pair', pair);
	const launch = new URL('https://www.oculus.com/open_url/');
	launch.searchParams.set('url', page.toString());
	return launch.toString();
}
