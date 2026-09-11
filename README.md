# makerworld-viewer

A better 3D viewer for [MakerWorld](https://makerworld.com) — click **Download STL/CAD Files** and a full-featured viewer appears with every model in the zip, ready to inspect.

**[📜 userscript.js](./userscript.js)**

---

## Why

MakerWorld's built-in 3D preview is limited: fixed camera, no free rotation, no way to browse the individual STL/3MF files inside the download. This userscript replaces it with a proper desktop-class viewer:

- **True free rotation** — no locked axes, no gimbal poles (uses a virtual trackball, same math as Cura/Blender)
- **Screen-space pan** — dragging always moves the model parallel to your screen, never into/out of it
- **Multi-file browser** — every `.stl` and `.3mf` in the zip is listed with a live thumbnail; click any of them to load into the view
- **Zero extra clicks** — the zip is intercepted in memory the instant you click the download button; you still get the file on disk

---

## Install

1. Install a userscript manager:
   - [Violentmonkey](https://violentmonkey.github.io/) (recommended — used during development)
   - [Tampermonkey](https://www.tampermonkey.net/)
   - [Userscripts for Safari](https://apps.apple.com/app/userscripts/id1463298887)
2. Open **[userscript.js](./userscript.js)** and click **Raw** — your manager will offer to install it.
3. Confirm the install.

The script pulls in `three.js` and `jszip` from jsDelivr automatically — nothing else to configure.

---

## Usage

1. Go to any model page on MakerWorld.
2. Click **Download STL/CAD Files**.
3. The viewer opens automatically:
   - The zip is fetched in the background and you still get it in your downloads folder.
   - A sidebar lists every `.stl` / `.3mf` inside, each with a rendered thumbnail.
   - The first file is loaded into the main view.

You can also:

- **Drop a `.zip`, `.stl`, or `.3mf`** directly into the viewer window
- Press **Alt + Shift + V** to open the viewer manually (useful for testing)

---

## Controls

| Action | Binding |
|---|---|
| Rotate (free trackball) | **Left-drag** |
| Pan (screen-space) | **Right-drag** |
| Zoom | **Middle-drag** or **mouse wheel** |
| Select a file | Click a row in the left sidebar |
| Close viewer | **Esc** or the **Close** button |
| Re-save the zip | **Save .zip** button in the header |

---

## How it works

The trick is *not* to touch MakerWorld's own 3D viewer (which is minified and hard to hook). Instead:

1. **Intercept the download.** A `.zip` handed to the browser has to pass through one of a handful of choke points — `fetch`, `XMLHttpRequest`, `Blob` constructor, `URL.createObjectURL`, `Location.assign/replace/href`, `window.open`, `a.href` setter, `a.setAttribute`, `a.click()`, or a real click on `<a href="...zip">`. The script hooks **all nine**, so whichever one MakerWorld uses, we catch it.
2. **Fetch the zip ourselves** with the same URL (the DevTools copy of the request confirmed it's a plain CORS `fetch`), verify the magic bytes (`PK\x03\x04`), and hand it to our parser.
3. **Re-trigger the browser download** from a local blob, so your file still lands in `~/Downloads` as if nothing happened.
4. **Parse the zip** with [JSZip](https://stuk.github.io/jszip/) and list every `.stl` / `.3mf` inside.
5. **Pre-render a thumbnail** for each file using an offscreen WebGL context, then keep the parsed `Object3D` in memory.
6. **Render on demand** in the main scene with three.js + `TrackballControls`.

---

## Technical notes

### Why `TrackballControls` instead of `OrbitControls`

`OrbitControls` is fundamentally an **orbit camera**: its state is `(radius, theta, phi)` relative to a target, and every mouse delta becomes a spherical offset. That means:

- It can only yaw around the world Y-axis
- It can only pitch between the two poles
- Crossing a pole flips the azimuth

`TrackballControls` builds a **rotation matrix** from the drag points projected onto a virtual sphere, then applies it via quaternion. There is no axis it refuses to rotate around, which is why it's used by Blender, Cura, 3D Slicer, and most CAD tools.

### Why a custom pan

TrackballControls' built-in pan uses `camera.up` crossed with the eye vector. After free rotation, `camera.up` is tilted at arbitrary angles, so the pan direction drifts off the screen plane — in the worst case becoming aligned with the view axis (the model moves "into" and "out of" the screen).

Our replacement:

```
worldPerPixel = 2 * distance(camera, target) * tan(fov/2) / canvasHeight
right         = normalize(column 0 of camera.matrixWorld)
up            = normalize(column 1 of camera.matrixWorld)

offset = right * (-dx * worldPerPixel)
       + up    * (+dy * worldPerPixel)

camera.position += offset
controls.target += offset
```

Because `right` and `up` come from the camera's own world matrix — not the world axes — panning is always parallel to the screen, no matter how the view is oriented. Applying it *after* `controls.update()` each frame prevents TrackballControls from undoing it.

---

## Files

```
makerworld-viewer/
├── userscript.js     ← the whole thing; single file, no build step
└── README.md
```

---

## Troubleshooting

**Nothing happens when I click Download.**
Open the DevTools console and filter by `[MWCV]`. You should see a `◆ ... intercepted` line identifying which of the nine hooks caught the URL, followed by `handleZipUrl:` and `Fetched N bytes`. If none of those appear, the URL pattern isn't `.zip` — open an issue with the console output.

**Viewer opens but shows "Waiting for zip…" forever.**
The CORS fetch failed. Drag the downloaded `.zip` onto the viewer window as a fallback — the pipeline is identical from that point on.

**Thumbnails are blank / black.**
Your GPU may be blocking the second WebGL context used for thumbnails. The file rows still work — clicking still loads the model.

**Rotation locks after a bit.**
You're on an older version. Make sure you're on v1.5+ (`TrackballControls`, not `OrbitControls`).

---

## Requirements

- A browser with WebGL2 (any modern Firefox, Chrome, Edge, Safari)
- A userscript manager with `@require` support (Violentmonkey, Tampermonkey, Userscripts)

---

## License

MIT — do whatever you want with it.
