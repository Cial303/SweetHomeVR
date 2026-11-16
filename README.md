# Sweet Home VR

A WebXR viewer for [Sweet Home 3D](https://www.sweethome3d.com/) homes on Meta Quest. Open a `.sh3d` file directly (no export step), look at it as a dollhouse, then walk through it at real scale. It also opens OBJ (plain, or zipped with MTL and textures) and GLB.

It runs in the Meta Quest Browser: no app store, no developer mode, no sideloading. The same page works on a desktop browser as a 2D preview, so you can check a file before putting the headset on.

> Status: **phase 3 of 5**: 2D preview, the VR/AR dollhouse, and walking through the home at 1:1. Final polish and performance work are next (see [SPEC.md](SPEC.md)).

## Using it

1. Open the app's URL (GitHub Pages) in a browser.
2. **Open from Dropbox** (browse your Dropbox and tap the file), **Open file**, or paste a link (e.g. a Dropbox shared link) and press **Open from link**.
3. Drag to orbit, scroll or pinch to zoom, right-drag to pan.
4. Next time, tap the model under **Recent**: the last 5 models are kept in the browser, so reopening one needs no download. For a model opened from a link, **↻** downloads the latest version from the same link (handy after editing the home on the Mac). The last link you used is also remembered in the link box.

**Tip for Dropbox links:** a Dropbox shared link stays the same when you overwrite the file with the same name. Save your home under a fixed name (e.g. `My home.sh3d`), share it once, and on the Quest you only ever type that link once; after that use **↻**.

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

**Menu:** a glowing orb floats over each hand. Point at one with the other hand and pull the trigger, touch it with the other controller, or press **A** or **X**: the menu opens in front of you, with a drawing of the controllers and what each button does. **B** / **Y** or a click elsewhere closes it. It opens by itself the first time.

**Dollhouse**
- The home stands on a low museum plinth in a gallery room. You see it as if you were about 2 m tall, so it's easy to look into the rooms.
- **Thumbstick** left/right rotates it; up/down zooms it (½× to 4×).
- **Grip** and move your hand to pick it up and move it.
- Point the **laser** at it: an orange figure shows where you'd stand. **Trigger** takes you there at real size.
- Menu: **Walk in** (at Sweet Home 3D's virtual visitor position), **Ceilings on/off**, **View: VR / passthrough**, **Recentre**, **Exit VR**.

**Inside, at 1:1**
- **Left stick** walks where you look. Walls don't stop you. In a one-level home you stay on the floor and walk through furniture; in a home with several levels you can step onto anything, so stairs work.
- **Hold a trigger** and move your hand to pull yourself along, as if grabbing the room.
- **Right stick** left/right turns in steps (15°, 30° or 45°, set in the menu).
- **Right stick forward** and aim: a blue ring shows where you'll land (red on a wall). Let go to jump there.
- **B** or **Y** goes back to the dollhouse.
- Menu: **Dollhouse**, **Ceilings on/off**, **View**, **Turn**, **Height** (yours, 1.4, 1.7 or 2.0 m), **Exit VR**.

## What gets shown from a Sweet Home 3D file

Walls (including sloping and round walls, colours and textures per side), door and window openings, room floors and ceilings, furniture (including groups, mirrored and rotated pieces, colours and per-material colours), lights (as furniture), the ground and sky colours. Hidden items and hidden levels are skipped. Labels, dimensions, polylines and the compass are ignored.

## Hosting

The site is plain static files with no build step: GitHub Pages serves the repository root. WebXR only works over HTTPS, so on the Quest use the GitHub Pages URL, not a local `http://` address.

### Dropbox Chooser (for your own copy)

The **Open from Dropbox** button uses Dropbox's official [Chooser](https://www.dropbox.com/developers/chooser). If you host your own copy, register your own key:

1. At [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) choose **Create app**, *Scoped access*, *App folder*, and a unique name.
2. In the app's **Settings**, add your site's domain (e.g. `yourname.github.io`) under **Chooser / Saver / Embedder domains**.
3. Put the **App key** (not the secret) in `config.js` as `dropboxAppKey`.

Without a key the button is simply hidden. The Chooser script is the only file loaded from another site (dropbox.com), and only when a key is set.

## Development

Requires Node 24 (`nvm use`). The app itself has no dependencies to install; `npm install` only fetches the dev tools.

```bash
npm install            # dev tools (Playwright) and the libraries to vendor
npm run vendor         # copy three.js, three-mesh-bvh and fflate into vendor/
npm run fixtures       # download the public Sweet Home 3D example homes
npm test               # parser tests (Node)
npx playwright install chromium
npm run shots          # screenshots of each fixture into test-output/
npm run xr-test        # scripted VR session on an emulated Quest 2 (Meta's IWER)
npm run serve          # http://localhost:8123/
```

Put your own test homes in `tests/fixtures/private/` (ignored by git). Open a model directly with `http://localhost:8123/?model=tests/fixtures/userGuideExample.sh3d`.

### Layout

```
index.html        2D UI and import map
config.js         Dropbox app key, defaults
js/main.js        2D page, renderer, loading, UI
js/xr.js          VR/AR session: gallery and dollhouse, walk mode, menu orbs
js/xr-input.js    controllers, lasers, buttons, thumbsticks, teleport arc
js/panel.js       canvas-texture VR menu and controls card
js/optimise.js    merge geometry by material, BVH for raycasts
js/storage.js     recent models (IndexedDB)
js/sh3d.js        SH3D parser and scene builder (no DOM; Node-testable)
js/formats.js     zip / OBJ / GLB / DAE / 3DS loading, unit detection
vendor/           three.js, three-mesh-bvh, fflate (with licences)
scripts/          vendoring, fixtures, local server, screenshots
tests/            Node tests
```

### Updating three.js

Change the versions in `package.json`, then `npm install && npm run vendor`, run the tests and screenshots, and commit `vendor/`.

## Credits

- This project: MIT licence (see [LICENSE](LICENSE)).
- [three.js](https://threejs.org/) (MIT), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT), [fflate](https://github.com/101arrowz/fflate) (MIT).
- Sweet Home 3D by Emmanuel Puybaret / Space Mushrooms. This project reads its file format; it contains no Sweet Home 3D code.
