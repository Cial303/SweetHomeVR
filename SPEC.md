# Sweet Home VR: prompt for Claude Code

Paste everything below the line into Claude Code, running in an empty folder on the Mac (e.g. `~/Projects/SweetHomeVR`). Work in Plan mode first and approve the plan before any code is written.

---

## Goal

Build **Sweet Home VR**, a simple VR viewer for Meta Quest that opens **Sweet Home 3D (.sh3d)** files directly, with no conversion step. It should also open OBJ (plain, or zipped with MTL and textures) and GLB. It replaces the discontinued SketchUp Viewer for Quest for one job only: looking at a home model as a dollhouse, then walking through it at real 1:1 scale.

Headsets (decided with the user): Quest 3 / 3S is the main target; Quest 2 and Quest Pro are fully supported and set the performance floor; Quest 1 is best effort (see phase 9 under "Working style").

Out of scope: editing the model, collaboration, accounts and scenes. Measuring and drawing are in scope (phase 17), but nothing they make is saved: a measurement or a drawing lasts until you leave the home, and the Photo button keeps it in a picture.

## Platform decision (already made; don't revisit)

- **WebXR web app** running in the **Meta Quest Browser**, built with **three.js**. Don't build a native Unity or Android app: no developer mode, no sideloading. The same web app may later also be packaged as an installable app (a PWA) without a rewrite, so keep it portable: the file readers and geometry code stay free of the page (`sh3d.js` already runs in Node), and browser-specific code (file picking, storage, saving, downloads, pairing) stays in few, clearly named modules.
- Plain ES modules and an import map, with **no build step**. Vendor every dependency into `/vendor` (three.js core plus the addons used, `fflate` for unzipping, `three-mesh-bvh` for fast raycasting) so nothing loads from a CDN at runtime.
- WebXR needs a **secure context (HTTPS)**. Host on **GitHub Pages**. Create the repo and enable Pages with `gh`, after asking me for the repo name. A plain `http://192.168.x.x` server on the Mac will **not** run WebXR on the Quest.
- The same URL must work on the Mac's desktop Chrome or Safari as a 2D preview (orbit-controlled dollhouse), so I can check that a file parses before putting the headset on.

## Getting files onto the Quest (decided)

1. **Primary: Dropbox.** I save the .sh3d into Dropbox on the Mac.
   - **"Open from Dropbox" button** using the official **Dropbox Chooser** with `linkType: "direct"`. Direct links are CORS-enabled, so the app can `fetch()` them. The app key goes in `config.js`; walk me through registering a Dropbox app and adding the GitHub Pages domain.
   - **"Open from link"** field for pasted Dropbox shared links. Rewrite `www.dropbox.com` to `dl.dropboxusercontent.com` and force `dl=1`, keeping `rlkey`. This workaround is unofficial, so handle failure gracefully. Checked on the Quest 2: a Dropbox link pasted from WhatsApp opens fine, so the Chooser stays optional (hidden while `config.js` has no app key).
   - **Links from storage services** (asked for by Quest 3 testers; `js/links.js`). The browser can only download a file from another site when that site allows it (CORS), so each service needs its own route. All of them are unofficial except the Drive API, and every failure gets a plain message:
     - **Google Drive:** go through the official Drive API v3 (`files/{id}?alt=media&key=…`), with a browser API key set in `config.js` as `googleApiKey`. The key is limited to the Drive API and to the site's address, so the request sends the page's origin as referrer (`strict-origin`); every other request sends none. Google refuses its plain download address (`drive.usercontent.google.com`) to other websites: it answers 403 whenever the request carries `Sec-Fetch-Site: cross-site`. Older links pass their `resourcekey` in the `X-Goog-Drive-Resource-Keys` header. Without a key, Drive links explain the other ways in.
     - **OneDrive (personal):** the share id is `u!` plus the base64url of the share link (or the `redeem` value of an expanded link). Get an anonymous guest token from `api-badgerp.svc.ms`, the same step OneDrive's own web page takes for visitors who aren't signed in. Then read `my.microsoftpersonalcontent.com/_api/v2.0/shares/{id}/driveitem` and download its short-lived `@content.downloadUrl`. Both hosts allow other websites. No account is involved, and only the share link is sent.
     - **GitHub:** rewrite `github.com/…/blob/…` to `raw.githubusercontent.com`.
     - **Never possible from a web page:** OneDrive for work or school (SharePoint), iCloud Drive, Box, WeTransfer and MEGA. Recognise them and say so straight away. Folder links of every service get a "share the file itself" message. A sign-in page that arrives instead of a file (a link that isn't public) is detected and explained.
     - **The way round for any link that can't be opened:** on the headset, download the file in a browser tab and use Open file. On a computer, open the file and use Send to my Quest.
2. **Fallback: device file picker** (`<input type="file">`) for files already in the Quest's Downloads folder (e.g. downloaded from dropbox.com in the Quest Browser).
   - **Known Quest Browser bug:** files with uncommon extensions picked through `<input type=file>` can fail with `ERR_ACCESS_DENIED` when read through a blob URL. Read the file with `await file.arrayBuffer()` straight away and never create a blob URL from the picked `File`. If reading still fails, show: "Quest Browser blocked this file type. Rename it to .zip and try again". Accept `.zip` everywhere `.sh3d` is accepted, since a .sh3d is a zip.
   - Don't set a restrictive `accept` attribute.
3. **Recent models:** cache the last 5 loaded files (bytes, name, date) in IndexedDB, so reopening a model is one tap.
4. No Mac companion app. AirDrop can't target a Quest, and Android File Transfer is no longer maintained.

## SH3D format: implement from this spec

A `.sh3d` file is a ZIP archive. Since Sweet Home 3D 5.3 it contains a **`Home.xml`** entry, which is the only part to parse. Ignore the Java-serialised `Home` entry. If `Home.xml` is missing, say: "Re-save this file in Sweet Home 3D 5.3 or later."

All lengths are in **centimetres** and all angles in **radians**. Plan coordinates are x right and y down. Build 3D in cm as (x, elevation, planY), then scale the root by 0.01 to get metres. This is the same axis mapping Sweet Home 3D uses internally (Java3D, y up).

**Content references.** Attributes `model`, `icon` and `image` name ZIP entries, either a single entry like `"4"` or a folder entry like `"4/model.obj"` with its `.mtl` and textures beside it. Detect a model's format by magic bytes, not by name:
- `PK` = nested zip (unzip it and find the .obj, .dae, .3ds or .glb inside)
- `glTF` = GLB
- `<?xml` containing COLLADA = DAE
- `0x4D4D` = 3DS
- otherwise OBJ text

Resolve MTL and texture paths relative to the model's folder through a `LoadingManager.setURLModifier` that serves in-memory blobs. If a model is missing or broken, draw a unit box in its place.

**Elements to read:** `home` (has `wallHeight`), `environment` (`groundColor`, `skyColor`), `observerCamera`, `level`, `pieceOfFurniture`, `doorOrWindow`, `furnitureGroup` (recurse; children hold absolute coordinates), `light` (render as furniture and ignore the light sources), `wall`, `room` (with `point` children), `texture`, and `material`. Ignore labels, dimension lines, polylines and the compass.

**Visibility:**
- Skip items whose `visible="false"`.
- Skip items on a level whose `viewable="false"`.
- Colours are ARGB hex strings, e.g. `FF808080`.

**Furniture placement.** Copy this exactly; it is Sweet Home 3D's own `ModelManager` logic.

1. Normalise the model:
   1. Translate the model's bounding-box centre to the origin.
   2. If `modelRotation` (9 floats, row-major 3×3) isn't identity, apply it. Then, when `modelCenteredAtOrigin` is true (the default), re-centre on the rotated bounding box.
   3. Scale non-uniformly so the bounding box becomes 1×1×1.
2. Scale to (`width` × (−1 if `modelMirrored`), `height`, `depth`).
3. If `pitch` or `roll` is non-zero, pre-multiply by `rotZ(−roll) · rotX(−pitch)` and re-centre. The effective height is then the rotated bounding-box height.
4. Rotate by `rotY(−angle)`.
5. Translate to (`x`, `elevation` + effectiveHeight/2 + levelElevation, `y`). The `elevation` attribute is relative to the piece's level.

**Furniture colours and materials:**
- A piece `color` overrides the diffuse colour of all its materials.
- `<material name=… color=…>` children override only the material with that name.
- If `modelFlags & 1`, use `DoubleSide`; otherwise `FrontSide`.

**Walls:**
- Bottom = `level.elevation − level.floorThickness`, except on the lowest level, where the bottom is `level.elevation`.
- Top = `level.elevation + height`. If `height` is absent, use `home.wallHeight`. Walls can slope through `heightAtEnd`.
- Thickness is centred on the start→end line. With `a = atan2(yEnd−yStart, xEnd−xStart)`, the **left** side is offset by `(sin a, −cos a)·t/2`.
- Apply `leftSideColor`/`leftSideTexture` and `rightSideColor`/`rightSideTexture` per face, and `topColor` to the top.
- Texture `width`/`height` are the tile size in cm, so UVs in cm with repeat = 1/size.
- Joins: where `wallAtStart`/`wallAtEnd` is set, extend the wall by thickness/2 − 1 mm. Proper mitring can come later.
- Round walls (`arcExtent` ≠ 0): approximate with about 12 straight segments. Circle centre: `d = −tan(θ)·chord/2`, with `θ = (π − arcExtent)/2`, or `−(π + arcExtent)/2` if |arcExtent| > π. The centre is the chord midpoint + d·(cos φ, sin φ), with `φ = atan2(xStart − xEnd, yEnd − yStart)`.

**Door and window openings.** Cut a rectangular hole wherever a `doorOrWindow` is roughly parallel to a wall and its centre lies within thickness/2 + depth/2 of the wall axis.
- The opening covers a fraction of the piece: horizontally from `wallLeft·width` to `(wallLeft + wallWidth)·width` across the piece's width; vertically from the top down, starting `wallTop·height` below the piece top and spanning `wallHeight·height`.
- Defaults: wallLeft 0, wallWidth 1, wallTop 0, wallHeight 1.
- Project the opening onto the wall axis to get [u0, u1].
- Build each wall as rectangular prism cells: sweep along u and subtract the opening intervals. This gives reveals for free and avoids hole-touching-edge triangulation failures.
- Ignore `cutOutShape` (arched openings) for now.

**Rooms:**
- Floor polygon at the level elevation (or 0 without levels), one-sided facing up, using `floorColor`/`floorTexture`.
- Ceiling at `level.elevation + level.height` (or `home.wallHeight`), one-sided facing **down**, so the dollhouse can be seen into from above.
- Respect `floorVisible` and `ceilingVisible`.

**Ground:** a rectangle 3 m larger than the model on every side, at −0.5 cm, in `groundColor`.

**Start point:** `observerCamera` x and y give the default walk-in position. The facing yaw in three.js is `π − yaw`.

## Other formats

- **OBJ:** a single `.obj`, multiple picked files, or a `.zip` holding obj, mtl and textures. Units default to Auto (largest dimension > 100 → cm, otherwise m), with a cm / m / mm / in override. Sweet Home 3D's own OBJ export is in cm.
- **GLB/glTF:** metres. Compressed files open too (phase 15, added at the user's request): **Draco** and **meshopt** geometry are decoded by three.js's own decoders, vendored and loaded only when a file declares the extension (`gltfExtensions` in `js/formats.js`; Draco runs in two workers, meshopt on the page). **KTX2** (Basis Universal) textures can't be decoded under the security policy: the transcoder three.js ships builds functions from strings at run time (Emscripten's embind), which needs `unsafe-eval`. So the loader uses each texture's ordinary fallback image when the file has one; a file that requires KTX2 opens with plain surfaces in its own colours, and the status line says its KTX2 textures can't be shown yet. Real KTX2 support would need a transcoder built without run-time code generation, or one running in a worker served as its own file (decision for the user).

## Performance (Quest 2 is a phone GPU)

- After loading, bake world transforms and **merge geometry by material** (`BufferGeometryUtils.mergeGeometries`), deduplicating materials by colour, map and opacity. Aim for under 150 draw calls.
- Build a `three-mesh-bvh` bounds tree on the merged meshes; all raycasts (pointer, teleport, floor-following) must use it.
- Use `MeshLambertMaterial`, or Phong only where a model specifies shininess. One hemisphere light and one directional light. Use foveation (`renderer.xr.setFoveation(1)`) and a framebuffer scale of 1.
- **Time of day** (added at the user's request): Morning (the default, on the page and in the headset), Noon, Sunset, Night, in the VR menu and the 2D page's Display section (with Shadows as a switch), remembered. At sunset and night the bulbs of the home's light pieces (`lightSource` elements) are drawn as glowing spheres with soft halos; no real light sources are added. The sun direction comes from the home's compass (north direction and latitude, radians in Home.xml) on an equinox day: morning = solar 9:00, noon = solar noon, sunset = sun 5° above the horizon, night = a dim moon with a warm fill as if lamps were on. The sun turns with the dollhouse, so light always enters through the same windows. Noon without shadows keeps the original look. Skies (gallery, walk mode, 2D background) follow the time.
- **Shadows** (optional, off by default; added at the user's request, replacing "no shadows"): one 2048 shadow map from the sun, rendered only when something changes (`shadowMap.autoUpdate = false`): loading, changing the time, or moving, turning or scaling the dollhouse. Walking costs only the shadow lookup. Glass (transparent, opacity < 0.9) does not cast, so sun comes in through windows; ceilings do, so with ceilings on, rooms are lit by the sun only through windows. With shadows on, the fill light is 0.9× and the sun 1.6×, so shadows read.
- **Anti-aliasing:** MSAA on the XR framebuffer (`antialias: true`). No post-process or temporal anti-aliasing: the user found that it flickered in SketchUp Viewer. Texture shimmer is reduced with mipmaps and 8× anisotropic filtering instead.
- Show the triangle and draw-call count on the 2D page. If the model exceeds about 1.5 M triangles, warn but still load.

- **Depth shading** (added at the user's request, after SketchUp Viewer's ambient occlusion; headset only, off by default, remembered): white walls lose their edges when lit evenly. `js/depth.js` adds, with one multiply in the Lambert/Phong shader and one shared on/off uniform (no recompiling, no post-process pass, nothing that can flicker):
  - a side-light term from the model-space normal, so faces pointing different ways always differ slightly;
  - a per-vertex factor baked once per model: walls, floors and ceilings are cut along a regular 30 cm grid (convex cells, fan-triangulated, so gradients are even along every edge), then 32 short rays (0.6 m) per vertex against one BVH of the whole model except glass. Furniture blocks rays but is not baked itself (tried: three times the preparation time for a barely visible gain).
  - The bake runs in slices from the render loop (12 ms per frame on the page, 4 ms in the headset) and shows a percentage. Measured on the Mac: about 2 s for a 76,000-triangle flat, adding about 30,000 triangles.
  - Switches: the page's bottom bar and **Depth** in both headset menus.

## Safety (added in the pre-release audit)

A model file and a pasted link are untrusted input: the viewer will be shared, and people will open files from forums.

- **No outside requests from a model.** The loaders' URL modifier (`EntryStore`) serves only the file's own entries (`mem:`), embedded `data:` URIs and `blob:` URLs made from the file's bytes. Any other URL written in an MTL, glTF, COLLADA or 3DS file is replaced by a white pixel and counted; the status line reports how many were ignored.
- **Archive limits.** Before unpacking, the declared sizes are summed: over 1 GB or 50,000 entries (including nested model archives, which share one budget) the file is refused with a clear message.
- **Links.** `js/links.js`: only `https:` (or same-origin) links are downloaded, with a 500 MB cap, `credentials: 'omit'` and no referrer. `?model=` opens by itself only for a same-origin address; a link to another site is placed in the link field and waits for a click.
- **Page.** Content Security Policy in `index.html` (`default-src 'none'`, scripts from `'self'` plus the import map's hash, `'wasm-unsafe-eval'` for the vendored glTF decoders (WebAssembly only, never JavaScript `eval`), workers only from `blob:` URLs (three.js builds the Draco workers from the vendored decoder), connections to `https:` only), `referrer` set to `no-referrer`, and no HTML is ever built from file names or file content.
- **Parser.** Number attributes that are missing, NaN or infinite fall back to their defaults; impossible character references are left as written.
- **Memory.** Textures above `CONFIG.maxTextureSize` (2048) are shrunk after loading. Once the textures have loaded, the unpacked files and their blob URLs are freed.
- Accepted limits: a hostile file can still make the tab slow or crash it (huge geometry, a slow regular expression in Home.xml, an image that decodes to a huge bitmap). GitHub Pages cannot send headers, so framing by another site cannot be forbidden (`frame-ancestors`).

## Experience and controls

**2D page (home screen)**
- Title: "Sweet Home VR".
- Buttons: Open from Dropbox, Open from link, Open file, plus the Recent list.
- Live orbit preview of the dollhouse.
- One **Enter VR** button, shown only if `navigator.xr.isSessionSupported` says so (changed at the user's request from separate VR and AR buttons). When `immersive-ar` is supported the session is an AR session and the in-headset menu switches between the VR view (an opaque world drawn over the passthrough) and the passthrough view (greyscale on Quest 2); otherwise it is an `immersive-vr` session, VR only. Checked on the Quest 2: the Guardian boundary still appears in the VR view of an AR session.
- Use `local-floor` reference space.

**XR dollhouse mode** (on entering XR, like SketchUp Viewer's tabletop view)
- VR view: a gallery room (changed at the user's request from the plain showroom): dark oak floor with a pale rug, warm white walls with dark skirting, a charcoal feature wall, tall windows on both sides, a skylight, and large abstract canvases, under a soft gradient sky. A rectangular museum plinth 0.6 m high with 20 cm of table around the model, its front edge 30 cm in front of the user. The model rests 4 mm above the plinth top, never exactly on it, and the plinth top is drawn with a small depth offset: at the same height the floors and the plinth flickered through each other on the headset (z-fighting). The headset's clip planes are set explicitly (5 cm to 300 m). You look down at it as a 2 m tall person would (eyes at 1.89 m), so it is easy to look and point into the rooms: the head's real height is measured on entry, on Recentre and when coming back from walking, and the view is raised by the difference, so it is the same sitting or standing and whatever the headset's floor level is (changed at the user's request: a fixed 25 cm raise only worked when standing). Passthrough view: no room, no plinth, no lift; the model floats at the same spot.
- On entering XR (and when the headset is re-centred), the room and plinth are placed in front of where the user stands and looks, not at the floor origin.
- The model is scaled to fit about 1.2 m across and sits on the plinth; it turns on the plinth, which stays still.
- Thumbstick left/right rotates the model; up/down zooms it (×0.5 to ×4).
- Grip plus moving the controller grabs and moves the model, keeping it upright (yaw only). It can be lifted but never pushed into the plinth (or, off the plinth, below the floor).
- Each controller shows a laser ray. Pointing at the model shows a small person-height marker where the floor is; **trigger** enters 1:1 standing at that spot. Find the floor by casting downwards in model space and taking the first upward-facing hit.
- Menu (canvas texture, laser-clickable), summoned rather than always visible (changed at the user's request; SketchUp's fixed waist bar got in the way): a living orb (glowing core in a faceted crystal with two orbiting rings; it breathes, turns, and glows blue when approached) sits on each wrist (moved there at the user's request: "touch your wrist"; both wrists for now). Pointing at one with the other hand's laser and pulling the trigger, touching it with the other controller, or pressing **A or X**, opens the menu (walking: in front of the head; in the dollhouse: 34° to the left and 0.95 m away, so it never sits between the user and the model, changed at the user's request), with a controls card to its left, out of the main view (a drawing of both controllers and what each stick, trigger, grip and button does in this mode, and at the bottom a pointer to the Photo button). It closes on a choice, on B/Y, or on a click elsewhere. It no longer opens by itself (changed at the user's request): on every entry a **welcome card** floats above the back half of the plinth, 0.3 m over the model's top, turned to face you and drawn over everything, saying "Touch a wrist with the other hand: menu", "Point at the home and pull: step inside", and that A / X or pointing at an orb also work; it goes once the menu is first opened. The menu is a settings list (redesigned at the user's request; it was two columns of buttons that cycled through values), 0.62 m wide: each row holds one or two cells with a label on the left and a control on the right. On/off settings are **switches** (the whole cell is the target); settings with a few values are a row of **options**, every one visible and the current one filled blue (one click; more than six options become a ‹ value › stepper); a list that can be long is a **dropdown** (added at the user's request for Levels, as homes can have many storeys: a click opens the list over the dimmed panel, a click on an option picks it, a click elsewhere on the panel closes it; rows shrink so a long list still fits); See-through is a **slider** (trigger on the track, drag while held); actions are **buttons**. A setting that does not apply is greyed out with a short note. **Exit VR** is always last, on its own full-width row, taller and solid orange. Dollhouse items: **Walk in**, **Recentre** and **Photo** (buttons), **Time of day** (options), **Shadows** and **Depth**, **Ceilings** and **Figure** (switches), **See-through** (slider), **Levels** (dropdown: "All levels (N)", then "Up to <level name>" from the top storey down, named as in Sweet Home 3D (levels sharing an elevation joined with " / "), else "Up to level k"; several storeys only, with the ceilings off the top one shown; greyed out "One level" in a one-storey home), **View** (VR / Passthrough; greyed out "VR only" in a VR session), **Exit VR**.
- **See-through** (added at the user's request: "a glass house"; headset only, both menus, remembered, off by default): fades walls and furniture (walls and main layers) to `1 − 0.85 × slider` of their own opacity, in 5% steps; floors, ceilings and the ground are untouched. Faded materials are transparent without depth writing, so everything behind shows; a material shared with a floor or ceiling is copied first (keeping the depth shading hook). Faded meshes cast no shadows, like glass; the depth shading bake uses the model's own opacity. The 2D page always shows the model as modelled. `js/walls.js`.
- Scale figure (added at the user's request, after SketchUp Viewer): a plain grey mannequin, 1.75 m at the model's scale, on the ground by the home's front-left corner. It turns and zooms with the model, shows in the dollhouse (VR and passthrough) and hides while walking.

**XR 1:1 walk mode**
- The model is at real scale. Move a rig `Group` that contains the camera and controllers.
- Left stick: smooth locomotion relative to head direction, about 0.75 m/s (halved at the user's request).
- Right stick left/right: snap turn 15°, 30° or 45° (menu option, remembered; 30° by default).
- Right stick forward, or holding either trigger: show a **parabolic teleport arc** with a landing ring. It never rises more than 1.85 m above the feet (added at the user's request: aimed upwards it used to hit the wall over a doorway), so it passes through doorways; aiming higher than that allows keeps the steepest launch that fits, the longest jump (about 5.5 m). Walls always stop it (red). It is valid (blue) on a walkable surface (see below) with normal.y > 0.7. In a one-level home it passes through furniture to the floor. Release to teleport, with a short fade.
- Holding either **grip** (the button on the side of the handle) grabs the space: moving the hand pulls the user along horizontally (added at the user's request). Both hands average.
- **Solid walls** (switch in the walk menu, added at the user's request, off by default, remembered): walls stop the body however it moves (stick, grip pull, or walking for real in the room: the rig is shifted back by the difference). Only walls (decided with the user): furniture, doors and windows stay walk-through, so doorways and stairs keep working. The body is a column of spheres, radius 0.2 m, from 0.4 m above the feet up to the eyes; each is pushed sideways out of the nearest wall (`closestPointToPoint` on the walls' BVH), so you slide along walls; moves are taken in steps of at most 0.1 m so nothing tunnels through a thin wall. After a teleport the body is only pushed out, never swept from the old spot. Greyed out "No walls" for OBJ and GLB files. `js/walls.js`.
- Floor following: each frame, cast down from 0.6 m above the feet. If a walkable surface is within ±0.6 m, adopt its height. Walls block movement only with Solid walls on. Walkable (decided with the user):
  - **One level** (one distinct level elevation, or no levels): room floors and the ground only. You stay on the floor and walk through beds, tables and sofas.
  - **More than one level:** anything except walls, doors and windows (doorOrWindow pieces, merged apart and marked `userData.opening`, so the arc passes through doorways), so staircases (which are furniture) work, at the cost of stepping onto low furniture.
  - Models without rooms (OBJ, GLB): anything except walls.
- Person height: menu option Yours / 1.4 / 1.7 / 2.0 m (remembered). For a set height the rig is raised or lowered so the eyes are 11 cm below that height, measured when you enter walk mode or change the option.
- **B or Y:** back to dollhouse (or closes the menu if it is open).
- **A or X** (or an orb): toggle a menu 0.75 m in front of the head (same design as the dollhouse menu) with Time of day, Shadows and Depth, Ceilings and Solid walls, See-through, Turn (15° / 30° / 45°), Height (Yours / 1.4 / 1.7 / 2.0 m), View, and on the tall bottom row **Photo**, then the two ways out side by side (at the user's request), **Back to the dollhouse** (white) and **Exit VR** (orange).
- **Photo** (added at the user's request; both menus): the Quest's own screenshot (hold the Meta button, pull a trigger) also sends that trigger pull to the page, which jumps you (teleport, or "step inside"); a page cannot see the Meta button, so it cannot tell them apart. The button closes the menu and, the next frame, renders the view once more from the head (roll removed, so the horizon is level; 1920 × 1080, 60° vertical field of view, 4× MSAA) without the menu, lasers, controllers, orbs, arc, markers or welcome card, into a half-float image, converts it to sRGB in a second pass, reads it back and saves it as a JPEG download named "Sweet Home VR <date> <time>.jpg". On the Quest it lands in the Files app, Downloads: a web page cannot write into the headset's screenshot gallery. A short white flash and a note in front of you ("Photo saved", or that it failed) confirm it. In the passthrough view the background is black (a page cannot read the cameras). `js/photo.js`. Lasers are hidden while walking, except while the menu is open or a laser points at an orb.

## Project layout

```
index.html        2D UI and import map
config.js         Dropbox app key, defaults
js/main.js        app state machine (home / dollhouse / walk), renderer, XR session
js/sh3d.js        SH3D parser and scene builder (pure functions, unit-testable)
js/formats.js     OBJ / zip / GLB / DAE / 3DS loading and unit detection
js/optimise.js    merge-by-material and BVH
js/xr-input.js    controllers, rays, thumbsticks, teleport arc, snap turn
js/panel.js       canvas-texture VR menu
js/storage.js     IndexedDB recent files
vendor/…          three.js, addons, fflate, three-mesh-bvh, with licences
tests/            Node tests for sh3d.js against fixture files
README.md         how to host, use and update
```

## Testing (do this; don't skip)

1. Download real fixtures into `tests/fixtures/`: e.g. `userGuideExample.sh3d` and `SweetHome3DExample.sh3d` from `https://www.sweethome3d.com/examples/`, plus my own home file. I'll tell you its path.
2. Node tests for the parser: counts of walls, rooms, pieces and openings; no NaN in any matrix; furniture lies inside the wall bounding box.
3. Use Playwright with headless Chromium to load each fixture in the 2D preview and save screenshots of the dollhouse from four angles. Review the screenshots yourself against what Sweet Home 3D shows and fix what looks wrong: furniture orientation, mirrored items, door and window holes, floor and ceiling heights.
4. Add a desktop WebXR emulation path (Immersive Web Emulator or a mock `navigator.xr`) only if it is cheap; otherwise give me a short on-headset test checklist.
5. Deploy to GitHub Pages and give me the URL to bookmark in the Quest Browser.

## Working style

- Plan first, then build in phases, committing after each:
  1. Parser and 2D preview
  2. XR dollhouse
  3. Walk mode
  4. Dropbox and recents
  5. Performance pass and refinements. Requested by the user so far:
     - In the VR menu or controls card, a reminder of how to take a screenshot of the view (dollhouse, walk, VR or passthrough) with the Quest's own (Horizon OS) screenshot feature. Done: a footer on the controls card. Later replaced by the menu's Photo button (the Quest's screenshot gesture also jumped you).
  7. Enhancements after the audit (done):
     - Offline use and clean updates: `sw.js`, network-first with revalidation, cache fallback; no file list to maintain.
     - Shared vertices: merged meshes are indexed (`mergeVertices`).
     - Storeys: geometry is merged per storey (distinct level elevations) so the dollhouse level picker can hide upper storeys.
     - Lamps glow at sunset and night.
     - "Try the example home": `examples/example-home.sh3d`, generated by `scripts/make-example.js` from original box furniture. The official Sweet Home 3D examples state no licence allowing redistribution and their server sends no CORS headers, so they are neither copied nor linked.
     - 2D page: a Display section (Light, Shadows switch) apart from the file buttons; morning is the default light.
  8. Page layout (changed at the user's request: the panel had grown so long that Enter VR needed scrolling): a files card at the top left (Open file, link field, example, status, Recent, File options); a display card at the top right (changed again at the user's request: a bottom bar left Enter VR in a far corner, easy to miss) with "Time of day" (four buttons), "Shadows" (Shadows and Depth shading switches) and a large Enter VR button; the model's details at the bottom right. On narrow windows the display card sits at the bottom so Enter VR stays on screen. Recent rows are a grid so their icon buttons cannot overflow. Files can be dropped on the page.
  10. Welcome notes (added at the user's request: the empty page gave no hint where to start): while no model is open, two handwritten-style notes with sketched arrows: "1 Manage the files" (renamed at the user's request from "Start here", so the page does not say "start" twice next to "Drop a file here to start"; with the file formats, which moved here from the files card) under the files card and "2 Set the mood" under the display card, plus one line saying the home never leaves the device. The handwriting is Kalam (SIL Open Font Licence), vendored as two small woff2 files so the notes look the same on every device, with `font-src 'self'` in the Content Security Policy. If a card leaves no room beneath it they sit between the cards; on narrow windows, in the gap between the stacked cards. The link button is labelled **Load**, and **Try the example home** is an outline button.
  11. Getting a link into the headset without typing (added at the user's request; a PIN or QR pairing was considered): **Send to my Quest** on computers and phones opens Meta's Web Launch page (`https://www.oculus.com/open_url/?url=`) with this viewer's address and the pasted link as `?model=`; on the headset the link arrives filled in and waits for Load, like any cross-site `?model=`. What is sent is the open model's own link (from a link, from Recent, or the example), else the link in the link box; a model opened from a local file cannot be sent, and the line under the button says so. No server of ours. A model opened from a file on the computer is sent directly (added at the user's request): Web Launch carries `?pair=<random name>` (`svr-` + 26 base-32 characters, 130 bits) instead of a link; the computer waits under that name on PeerJS's public server (`config.js`, `connect-src wss://0.peerjs.com`; PeerJS vendored, loaded only when used); the headset shows **Receive** and connects only when pressed; the file crosses an encrypted WebRTC data channel in 16 KB pieces (`js/transfer.js`: announced names and sizes checked, 500 MB cap, exact byte count). The computer accepts one connection, then leaves the pairing server; while both pages stay open, every model opened on the computer is sent too. Received models are saved in Recent ("From computer"); one that arrives during VR opens on leaving it. Not built: a typed PIN and QR scanning by the headset (web pages cannot rely on the Quest's cameras).
  12. Drag and drop (computers): files dropped anywhere on the page open; a "Drop to open" frame shows while dragging; a dropped link goes into the link box and waits for Load. The welcome notes say "Drop a file here to start" on computers only.
  13. VR settings (added at the user's request): Solid walls, See-through, and the settings-list menu (see "Experience and controls").
  14. Onboarding and pictures (added at the user's request): a welcome card above the dollhouse instead of the menu opening by itself, the orbs on the wrists, a Levels dropdown with the level names, and a Photo button (see "Experience and controls").
  15. Compressed GLB (added at the user's request: many SketchUp, Rhino and Blender exports use it): see "Other formats".
  16. Planned: open and switch models from inside VR (Recent, the example, received files), so nobody has to leave VR for another model. The 2D page stays the place to manage files.
  17. Planned, decided with the user: **three hand-held tools** in both modes: a **street camera**, a **laser distance meter** and a **marker**. The look and feel follow the Meta Quest app BRINK Traveler (the user's reference: a watch-like menu on one wrist, tools you pick up with the other hand). Sides are the user's choice: by default the fan floats over the **left** hand and the tools are taken and used with the **right** hand; **Tool fan** in the headset menu (both modes, remembered) switches it to *Right hand*, which mirrors everything below. Their use case: a table looks too long; measure it (1.60 m), the size stays, write "shorter" next to it, take a photo.
      - **The tool fan:** the three tools, small 3D models about 9 cm long, float in an arc about 15 cm above the left controller, gently bobbing. It fades in when the left hand is raised in front of you and you look at it, and fades out otherwise, so it never clutters the view. So that nobody misses it, on the first entry of each visit it shows itself for a few seconds with a pulse while the welcome card mentions it. It stays clear of the left-wrist orb, so touching one never triggers the other.
      - **Taking a tool (decided with the user):** reach over with the right controller. The tool you touch glows; squeeze the right grip and it sits in the right hand. A squeeze that takes a tool doesn't grab the model or the space. Taking another tool the same way swaps them (the held one flies back to its place in the fan). Squeezing the right grip away from the fan puts the held tool back; while a tool is held, the left grip alone grabs the model or the space.
      - **While a tool is in the right hand:** the right trigger uses the tool and the right laser is hidden (the meter has its own). **A** becomes the tool's second action (below); **X** and the wrist orbs still open the menu. The left trigger and both sticks keep their usual jobs (teleport, step inside, move, turn), so no tool ever makes you jump. With the fan on the right hand, the same holds mirrored: the left trigger uses the tool, **Y** is its second action, **A** opens the menu, and the right trigger teleports and steps inside.
      - **Street camera:** a classic rangefinder street camera, a 35 mm film-era design in black with a silver top plate, round lens with a focus ring, viewfinder window, shutter button and dial. No maker's name, logo or red dot (trademarks). The back is a live viewfinder screen showing what the lens sees, rendered small (about 360 × 240) and only a few times a second on Quest 2 (more on Quest 3), and not at all when the screen faces away from you. Trigger = shutter: a short flash on the screen, and the photo is saved like the menu's Photo (`js/photo.js`), but from the camera's position and lens: 3:2 (1920 × 1280), a 35 mm lens by default, the horizon levelled when the camera is held within a few degrees of level. A (Y when mirrored) = next lens (28 / 35 / 50 mm), shown on the screen. Photos include measurements and drawings, and never the tool fan, the held tools, the menu, lasers or controllers. The menu's Photo button stays, for a quick picture of exactly what you see.
      - **Laser distance meter:** a small handheld meter (graphite body with the app's orange accent) with a red laser beam and dot where it hits (BVH raycasts). Its little screen always shows the distance from the meter to the dot, so pointing at a wall tells you how far it is. Trigger on one point, then on another: a line between them with a label of its real length ("1.60 m"; in the dollhouse divided by its scale), the label turned towards you. Lines within about 3° of vertical or level snap straight, with a small mark. Several at once. A = undo the last; hold A for a second = clear all (Y when mirrored). Laser points work across whole rooms and from floor to ceiling, which a tape-measure metaphor can't.
      - **Marker:** a thick felt-tip marker; its cap shows the current colour. Hold the trigger to draw a stroke in the air from its tip. Press the stick of the hand holding it to change colour (red, blue, black, white). A = undo the last stroke; hold A = clear all.
      - **Feel (the user: BRINK's UI is "powerful and very, very fun to use"; engaging matters as much as working):** every action answers with motion, touch and sound.
        - Motion: tools spring into the hand with a small overshoot and fly back to the fan along an arc; the touched tool lifts and glows; the fan bobs and turns slightly towards you.
        - Touch: controller vibration (WebXR `hapticActuators`) as a light tick when touching a tool, a firm click when taking or returning it, the shutter, each measuring point, and a faint buzz while the marker draws.
        - Sound: short sounds synthesised with Web Audio (no sound files, nothing downloaded): a mechanical shutter, a meter beep, a soft marker squeak, a whoosh when a tool returns. A **Sounds** switch in the menu (on by default, remembered).
        - Feedback you can see: after a shot, a small print of the photo pops out of the camera, floats for a moment and drifts into the fan's camera, so you know it was saved. The meter's digits roll to the new length. A fresh measurement line draws itself from the first point to the second.
      - Measurements and strokes belong to the home: they move with the dollhouse and stay put while walking.
      - **Nothing is saved:** tools go back to the fan, and measurements and drawings are cleared, on leaving VR or opening another model. Photos keep them.
      - The welcome card and the controls card explain the fan ("Look at your left hand: camera, meter, marker. Take one with your right hand.", mirrored when switched). Controllers only for now; hand tracking (BRINK's picture-frame gesture) later.
      - Performance: each tool is a few hundred triangles built from three.js primitives, merged per tool; the viewfinder is the one extra render, throttled as above.
      - No object identity is needed (decided with the user): measuring works on surface points, not on "this wall" or "this sofa".
  18. Planned: split `xr.js` into modes, tools and menus before the tools are added.
  9. Headsets (updated with the user): Quest 3 / 3S is the main target, so every feature is designed and checked for it first. Quest 2 and Quest Pro are fully supported and their budget (draw calls, triangles) is the floor for every feature. Quest 1 is best effort: its browser no longer updates and Meta no longer accepts Quest 1 apps, so no feature waits for it, but avoid very new browser features where an older way exists; drop it only if something important can't work there. Built and tested on Quest 2. `XR_DEVICE=metaQuest3 | oculusQuest1 | metaQuestPro npm run xr-test` runs the scripted session with those controller layouts (all pass); every headset change runs the default (Quest 2) and Quest 3. Real Quest 3 and Quest 1 devices are untested.
  6. Pre-release audit (done): safety (see "Safety"), bugs, and performance: the 2D page redraws only when something changes (2 frames a second when idle), raycast target lists are cached per model, the lighting change check allocates nothing, and loading pauses between furniture models so progress is painted.
- Keep the code plain and commented. No frameworks beyond three.js.
- When unsure about a Sweet Home 3D detail, check the official source (`HomeXMLExporter`, `ModelManager`, `Wall3D`, `Room3D` in the Sweet Home 3D sources) rather than guessing.
