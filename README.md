# makerworld-viewer

A better 3D viewer for [MakerWorld](https://makerworld.com). Click **Download STL/CAD Files** and a full viewer opens with every `.stl` / `.3mf` in the zip, ready to inspect.

**[📜 makerworld-viewer.user.js](./makerworld-viewer.user.js)**

## Why

MakerWorld's built-in preview has a fixed camera and hides the individual files. This replaces it with:

- **Free rotation** — true trackball, no locked axes
- **Screen-space pan** — model always follows the cursor on screen
- **Multi-file browser** — every file in the zip, with thumbnails
- **Zero extra clicks** — zip is grabbed in memory; you still get the file on disk

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Open **[makerworld-viewer.user.js](./makerworld-viewer.user.js)** and click **Raw**. Your manager will offer to install it.

`three.js` and `jszip` load automatically from jsDelivr.

## Usage

1. Open any model page on MakerWorld.
2. Click **Download STL/CAD Files**.
3. The viewer opens, the zip downloads normally, and a sidebar lists every file with a thumbnail.

You can also drop a `.zip` / `.stl` / `.3mf` onto the viewer, or press **Alt + Shift + V** to open it manually.

## Controls

| Action | Binding |
|---|---|
| Rotate | **Left-drag** |
| Pan | **Right-drag** |
| Zoom | **Middle-drag** / **wheel** |
| Select file | Click a sidebar row |
| Close | **Esc** |

## Notes

- Uses **`TrackballControls`** (not `OrbitControls`) — quaternion-based, no poles, no axis limits.
- Custom **screen-space pan** derived from `camera.matrixWorld`, applied after `controls.update()` each frame.

## Troubleshooting

- **Nothing happens on click** → DevTools console, filter `[MWCV]`. You should see a `◆ ... intercepted` line, then `handleZipUrl:` and `Fetched N bytes`.
- **Stuck on "Waiting for zip…"** → drag the downloaded `.zip` onto the viewer as a fallback.
- **Rotation locks** → you're on an old version; need **v1.5+**.

## License

Apache. Your contributions are welcome.
