# Sweet Home VR

A WebXR viewer for [Sweet Home 3D](https://www.sweethome3d.com/) homes on Meta Quest. Open a `.sh3d` file directly (no export step), look at it as a dollhouse, then walk through it at real scale. It also opens OBJ (plain, or zipped with MTL and textures) and GLB.

**Try it: [marcalprats.github.io/SweetHomeVR](https://marcalprats.github.io/SweetHomeVR/)** (press *Try the example home* if you have no file to hand).

It runs in the Meta Quest Browser: no app store, no developer mode, no sideloading. The same page works on a desktop browser as a 2D preview, so you can check a file before putting the headset on.

| On the page | Dollhouse, in the headset | Walking inside |
| --- | --- | --- |
| ![The page with the example home](docs/page.jpg) | ![The dollhouse on its plinth with the menu open](docs/dollhouse.jpg) | ![Inside the example home's living room](docs/walk.jpg) |

(Pictures: the example home that ships with the project. The headset views are from an emulated Quest 2.)

> Status: all planned work is done (see [SPEC.md](SPEC.md)): 2D preview, the VR/AR dollhouse, walking at 1:1, time of day, shadows and depth shading, a safety audit, and offline use. Tested on a real Quest 2 only.

## Using it

1. Open the app's URL (GitHub Pages) in a browser.
2. **Open file**, drop a file anywhere on the page (on a computer), or paste a share link (Dropbox, Google Drive, OneDrive, GitHub; see [Links](#links-from-storage-services)) and press **Load**. No file to hand? **Try the example home**, a small two-storey house made for this viewer. The model's details show at the bottom right.
3. In the card at the top right, choose the **Time of day** (morning by default, noon, sunset or night), switch **Shadows** and **Depth shading** on or off, and press the big **Enter VR** button. The files card at the top left can be hidden with **–**.
4. Drag to orbit, scroll or pinch to zoom, right-drag to pan.
5. Next time, tap the model under **Recent**: the last 5 models are kept in the browser, so reopening one needs no download. For a model opened from a link, **↻** downloads the latest version from the same link (handy after editing the home on the Mac). The last link you used is also remembered in the link box.

**No typing in the headset:** open the model on a computer (a file, a dropped file or a link) and press **Send to my Quest**. Meta's "Open in VR" page opens (you need to be signed in to your Meta account, with the headset on and online); pick your headset, and the viewer opens there.

- **A model from a link** (Dropbox, the example): the link arrives filled in; press **Load**.
- **A file from the computer**: press **Receive** in the headset. The file goes straight from the computer to the headset, and while the computer's page stays open, every model you open on it goes to the headset too. **Unlink** on either side ends it. A model that arrives while you are in VR opens when you leave it.

The line under the button always says what will be sent.

### Links from storage services

Share the **file** (not its folder) with **"Anyone with the link"**, copy the link, and paste it:

| Service | Works? |
| --- | --- |
| Dropbox | Yes. |
| Google Drive | Yes. (A copy of the viewer on another address needs its own Google API key, below.) |
| OneDrive (personal) | Yes. |
| GitHub (a file page, or a raw link) | Yes. |
| Any other https address of the file | If that site lets other websites download it. |
| OneDrive for work or school, iCloud Drive, Box, WeTransfer, MEGA | No: these never let another website download a file. |

When a link can't be opened, the viewer says why and what to do instead. On the headset: open the link in a browser tab, download the file, then **Open file** and pick it from Downloads. On a computer: open the file and press **Send to my Quest**.

The OneDrive route uses the same anonymous steps as OneDrive's own page for visitors who aren't signed in. It isn't an official API and could change. The Dropbox link rewrite is unofficial too.

**Tip for Dropbox links:** a Dropbox shared link stays the same when you overwrite the file with the same name. Save your home under a fixed name (e.g. `My home.sh3d`), share it once, and on the Quest you only ever type that link once; after that use **↻**. Google Drive keeps the link too, if you replace the file with **Manage versions → Upload new version**.

#### Google Drive links: the API key (once per site)

Google only gives shared files to other websites through its Drive API, which needs a browser API key. The key is public by design, like the Dropbox app key, and it's free (no billing account).

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (any name).
2. **APIs & Services → Library**: find **Google Drive API** and press **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Edit the key:
   - **Application restrictions → Websites**: add your site, e.g. `https://marcalprats.github.io/*`. Add `http://localhost:*/*` too, to test locally.
   - **API restrictions → Restrict key → Google Drive API** only.
   - Save.
5. Put the key in `config.js` as `googleApiKey`, then commit and push.

Forks need their own key, restricted to their own address.

Supported files:

| Format | Notes |
| --- | --- |
| `.sh3d` | Saved with Sweet Home 3D 5.3 or later (the file must contain `Home.xml`). Re-save older files. |
| `.zip` | A renamed `.sh3d`, or a zip holding an OBJ/GLB/DAE/3DS model with its textures. |
| `.obj` | Pick the `.obj`, `.mtl` and texture files together. Units: Auto (largest size > 100 means cm), or choose cm / m / mm / in. |
| `.glb` / `.gltf` | Metres. |

**Quest Browser tip:** if picking a `.sh3d` file fails with "Quest Browser blocked this file type", rename it to `.zip`.

**Copying files from a Mac to the Quest by cable:** Android File Transfer is no longer maintained; the free [OpenMTP](https://openmtp.ganeshrvel.com/) works with a Quest 2. Connect the headset by USB-C, accept "Allow access to data" inside the headset, and drag the `.sh3d` into any folder (e.g. a new `Sweet Home VR` folder). Then use **Open file** in the Quest Browser.

## In the headset

Press **Enter VR** once a model is open. In the headset, the menu switches between VR and passthrough.

**Menu:** a glowing orb floats over each hand. Point at one with the other hand and pull the trigger, touch it with the other controller, or press **A** or **X**: the menu opens with a drawing of the controllers and what each button does. In the dollhouse it opens to your left, clear of the model; while walking, in front of you. **B** / **Y** or a click elsewhere closes it. It opens by itself the first time.

The menu is a list of settings: **switches** for what is on or off (Shadows, Depth, Ceilings, Figure, Solid walls), a row of **options** with the current one in blue where there are a few to choose from (Time of day, Turn, Height, Up to level, View: one click, nothing to open), a **slider** for See-through (pull the trigger on it and drag), and **buttons** for actions (Walk in, Recentre, Back to the dollhouse, Exit VR). Settings are remembered.

**Dollhouse**
- The home stands on a low museum plinth in a gallery room. You look down at it as a 2 m tall person would, whether you sit or stand, so it's easy to look into the rooms. If you change position, **Recentre** measures your height again.
- **Thumbstick** left/right rotates it; up/down zooms it (½× to 4×).
- Point the **laser** at it: an orange figure shows where you'd stand. **Trigger** takes you there at real size.
- **Grip** and move your hand to lift it or move it; it never sinks into the plinth.
- A small grey **scale figure** (1.75 m at the model's scale) stands by the home's front corner, like the little people in architects' models, so you can judge its size.
- Menu: **Walk in** (at Sweet Home 3D's virtual visitor position), **Recentre**, **Time of day** (morning, noon, sunset, night), **Shadows**, **Depth**, **Ceilings**, **Figure**, **See-through**, **Up to level** (in a home with several storeys: show only the lower ones, with the ceilings off the top one shown), **View** (VR or passthrough), **Exit VR**.

**Inside, at 1:1**
- **Left stick** walks where you look. In a one-level home you stay on the floor and walk through furniture; in a home with several levels you can step onto anything, so stairs work.
- **Solid walls** (menu, off by default): walls stop you, whether you use the stick, pull yourself along or walk for real in your room, and you slide along them. Only walls: furniture, doors and windows stay walk-through, so doorways and stairs work. (OBJ and GLB files have no separate walls, so the switch is greyed out for them.)
- **Hold a grip** (the button on the side of the handle) and move your hand to pull yourself along, as if grabbing the room.
- **Right stick** left/right turns in steps (15°, 30° or 45°, set in the menu).
- **Right stick forward**, or **hold a trigger**, and aim: a blue ring shows where you'll land (red on a wall). Let go to jump there.
- **B** or **Y** goes back to the dollhouse.
- Menu: **Time of day**, **Shadows**, **Depth**, **Ceilings**, **Solid walls**, **See-through**, **Turn**, **Height** (yours, 1.4, 1.7 or 2.0 m), **View**, and at the bottom **Back to the dollhouse** next to **Exit VR**.

**See-through** (headset only, both menus): a slider that fades walls and furniture, up to a glass house where only 15% of them is left, so you can see into every room at once. Floors and ceilings stay as they are. Faded walls and furniture cast no shadows, like glass. The 2D page always shows the home as modelled.

**Light and shadows:** the sun comes from the right direction for your home, using the compass in the Sweet Home 3D file. Shadows are off by default; when on, they are computed once (not every frame), so walking stays smooth. With ceilings on, sunlight only enters through the windows; turn ceilings off to let it in from above. At sunset and at night the home's lamps glow. The same settings are in the card at the top right of the 2D page; the light starts as morning.

**Depth shading** (headset only, off by default): soft dark gradients where walls, floors and ceilings meet and where furniture touches them, and a slightly different brightness for faces pointing different ways, so white walls don't melt into each other. Switch it on in the page's top-right card or with **Depth** in the headset menu. It is prepared once per model in the background (a few seconds; the menu shows a percentage) and costs nothing per frame afterwards.

## Which headsets

Built for and tested on a **Meta Quest 2**. It uses only standard WebXR, so:

- **Quest 3, 3S and Pro** should work as they are, with colour passthrough and more speed. The scripted test passes with their emulated controller layouts, but nobody has tried the real devices yet.
- **Quest 1** may work in VR only (it has no passthrough for web pages) with small homes: its processor is much slower, and Meta no longer updates its browser. Untested.
- Other WebXR headsets with two controllers that have a thumbstick, trigger, grip and two buttons should also work; hand tracking alone is not supported.

## What gets shown from a Sweet Home 3D file

Walls (including sloping and round walls, colours and textures per side), door and window openings, room floors and ceilings, furniture (including groups, mirrored and rotated pieces, colours and per-material colours), lights (as furniture), the ground and sky colours. Hidden items and hidden levels are skipped. Labels, dimensions, polylines and the compass are ignored.

## Hosting

The site is plain static files with no build step: GitHub Pages serves the repository root. WebXR only works over HTTPS, so on the Quest use the GitHub Pages URL, not a local `http://` address.

### Dropbox Chooser (for your own copy)

The **Open from Dropbox** button uses Dropbox's official [Chooser](https://www.dropbox.com/developers/chooser). If you host your own copy, register your own key:

1. At [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) choose **Create app**, *Scoped access*, *App folder*, and a unique name.
2. In the app's **Settings**, add your site's domain (e.g. `yourname.github.io`) under **Chooser / Saver / Embedder domains**.
3. Put the **App key** (not the secret) in `config.js` as `dropboxAppKey`.

4. In `index.html`, add `https://www.dropbox.com` to `script-src` in the Content Security Policy, and add `frame-src https://www.dropbox.com`. Without this the page refuses to load Dropbox's script.

Without a key the button is simply hidden. The Chooser script is the only file loaded from another site (dropbox.com), and only when a key is set.

## Safety and privacy

- **Your home stays on your device.** Models are read in the browser. Nothing is uploaded, and there is no analytics or tracking. Recent models are kept in the browser's own storage (IndexedDB) on that device; remove them with the × beside each one.
- **Opening a model cannot contact other websites.** A model file can contain links to images on other servers. They are never followed (the status line says how many were ignored), so a file cannot be used to see who opens it.
- **Send to my Quest.** This uses Meta's [Web Launch](https://developers.meta.com/horizon/documentation/web/web-launch/): the viewer's address is handed to Meta's page so it can open on your headset, with the model's link or, for a file, a random one-time pairing name. Nothing is sent unless you press the button.
- **Sending a file to the headset.** The two devices are introduced by [PeerJS](https://peerjs.com/)'s free public server (set in `config.js`), which sees only the pairing name and connection details. The file then goes directly between them over an encrypted WebRTC connection; if your network blocks a direct path, PeerJS's relay passes the encrypted bytes along without being able to read them. The headset connects only after you press **Receive**, accepts at most 500 MB, and opens what arrives with the same checks as any file. The pairing name works once, for 10 minutes. The page contacts PeerJS only when you use this.
- **Links.** Only `https://` links are downloaded, up to 500 MB, without cookies or a referrer. Two services need one extra request first. For a OneDrive link, Microsoft's share API is asked for the file's download address. For a Google Drive link, Google's Drive API is asked, with the site's API key, and the site's address (not the page's full address) is sent so Google can check the key. A `?model=` address that points to another site is not opened automatically: it is put in the link box and waits for you to press **Load**.
- **Oversized files.** Archives that would unpack to more than 1 GB or 50,000 files are refused before unpacking, and textures above 2048 pixels are shrunk to fit a Quest 2's memory. The limits are in `config.js` and `js/formats.js`.
- **The page only runs its own code.** A Content Security Policy in `index.html` allows scripts from this site only, with the import map pinned by its hash. All libraries are vendored; nothing loads from a CDN. If you edit the import map, `npm test` tells you the new hash.
- **Offline.** After the first visit the app's own files are kept by a service worker (`sw.js`), so the page opens without internet and your Recent models still load. Online, it always asks the server for the current files.
- **What it cannot prevent.** A deliberately broken or enormous model can still make the browser tab slow or crash, as with any 3D viewer. It cannot reach your files, your account or other sites.

## Feedback

Problems and ideas are welcome as [issues](https://github.com/marcalprats/SweetHomeVR/issues). It helps to say:

- the headset and its browser version (or the desktop browser);
- what you did and what you expected;
- the numbers the page shows at the bottom right for the model (triangles, draw calls, walls, pieces);
- the file itself, if you are happy to share it. Homes are personal, so a small file that shows the same problem is just as good.

Things nobody has been able to check yet: a real Quest 3, 3S, Pro or Quest 1, Safari, very large homes (over a million triangles), and files written by old or unusual Sweet Home 3D versions.

## Development

The app is plain ES modules served as static files: there is no build step and nothing to install to run it. Clone it and the Node tests already work (Node 24; `nvm use` picks it up):

```bash
git clone https://github.com/marcalprats/SweetHomeVR.git
cd SweetHomeVR
npm test               # parser, lighting, depth-shading and safety tests: no install, no downloads
npm run serve          # the app at http://localhost:8123/ (2D preview; WebXR on a headset needs https)
```

The browser-driven checks need the dev tools (Playwright and Meta's IWER headset emulator):

```bash
npm install            # dev tools only; the app never needs it
npx playwright install chromium
npm run shots          # screenshots of each test home into test-output/
npm run xr-test        # a scripted VR session on an emulated Quest 2: 61 checks and screenshots
XR_DEVICE=metaQuest3 npm run xr-test   # or oculusQuest1, metaQuestPro: their controller layouts
```

Optional extras:

```bash
npm run fixtures       # download two public Sweet Home 3D example homes as more test files
npm run example        # rebuild examples/example-home.sh3d (after editing scripts/make-example.js)
npm run vendor         # copy three.js, three-mesh-bvh, fflate and the font into vendor/ (after changing versions)
```

Every test runs on the example home in `examples/`. Downloaded fixtures and your own homes in `tests/fixtures/private/` (ignored by git) are picked up as well when present. Open a model directly with `http://localhost:8123/?model=examples/example-home.sh3d`.

To test on a headset, fork the repository and enable GitHub Pages on your fork (Settings, Pages, deploy from the `main` branch): WebXR needs https, and Pages gives you that with no setup.

Where to start reading: [SPEC.md](SPEC.md) is the brief the project was built from and records every decision and why; [CLAUDE.md](CLAUDE.md) holds the hard constraints and working rules. The project was written with [Claude Code](https://claude.com/claude-code), directed and tested on the headset by its owner; both files are what the assistant works from.

### Layout

```
index.html        2D UI and import map
config.js         Dropbox app key, Google API key, defaults
js/main.js        2D page, renderer, loading, UI
js/xr.js          VR/AR session: gallery and dollhouse, walk mode, menu orbs
js/xr-input.js    controllers, lasers, buttons, thumbsticks, teleport arc
js/panel.js       canvas-texture VR menu (switches, options, slider, buttons) and controls card
js/walls.js       solid walls while walking and see-through walls and furniture (headset only)
js/lighting.js    time of day (sun from the home's compass) and shadows
js/depth.js       depth shading for the headset: corner gradients baked per vertex
js/optimise.js    merge geometry by material, BVH for raycasts
js/storage.js     recent models (IndexedDB)
js/links.js       which links may be downloaded; Dropbox, Google Drive, OneDrive, GitHub links; Send to my Quest address (no DOM)
js/transfer.js    sending a file to the headset: the protocol and its checks (no DOM)
js/pairing.js     the direct computer-to-headset link (PeerJS)
js/sh3d.js        SH3D parser and scene builder (no DOM; Node-testable)
js/formats.js     zip / OBJ / GLB / DAE / 3DS loading, unit detection
sw.js             service worker: offline use, and no mix of old and new files after an update
examples/         the generated example home (original content, made by scripts/make-example.js)
vendor/           three.js, three-mesh-bvh, fflate, PeerJS and the Kalam font (with licences)
scripts/          vendoring, fixtures, example home, local server, screenshots, emulated headset test
tests/            Node tests
docs/             pictures for this README
```

### Updating three.js

Change the versions in `package.json`, then `npm install && npm run vendor`, run the tests and screenshots, and commit `vendor/`.

## Credits

- This project: MIT licence (see [LICENSE](LICENSE)).
- [three.js](https://threejs.org/) (MIT), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT), [fflate](https://github.com/101arrowz/fflate) (MIT).
- [PeerJS](https://peerjs.com/) (MIT) for the computer-to-headset link.
- The handwriting on the welcome notes is [Kalam](https://fonts.google.com/specimen/Kalam) by Indian Type Foundry (SIL Open Font Licence 1.1; licence in `vendor/kalam/`).
- Sweet Home 3D by Emmanuel Puybaret / Space Mushrooms. This project reads its file format; it contains no Sweet Home 3D code.
