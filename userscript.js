// ==UserScript==
// @name         MakerWorld Custom 3D Viewer (Cura-style)
// @namespace    https://github.com/animaone/makerworld-viewer
// @version      0.0.1
// @description  Hook "Download STL/CAD Files" → free-rotation viewer with screen-space pan
// @match        *://makerworld.com/*
// @match        *://*.makerworld.com/*
// @grant        none
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/three@0.137.0/build/three.min.js
// @require      https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/controls/TrackballControls.js
// @require      https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/loaders/STLLoader.js
// @require      https://cdn.jsdelivr.net/npm/three@0.137.0/examples/js/loaders/3MFLoader.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function () {
    'use strict';

    const TAG  = '[MWCV]';
    const log  = (...a) => console.log ('%c' + TAG, 'color:#0af;font-weight:bold', ...a);
    const ok   = (...a) => console.log ('%c' + TAG + ' ✓', 'color:#0c0;font-weight:bold', ...a);
    const warn = (...a) => console.warn('%c' + TAG, 'color:#f80;font-weight:bold', ...a);

    log('init. three?', typeof THREE, '| JSZip?', typeof JSZip);

    /* ================================================================ *
     * 0. Helpers                                                        *
     * ================================================================ */

    const ZIP_RE = /\.zip(\?|#|$)/i;
    const ZIP_HOST_RE = /(^|\.)(makerworld\.com|bblmw\.com)$/i;

    function looksLikeZip(buf) {
        if (!buf || buf.byteLength < 4) return false;
        const u = new Uint8Array(buf, 0, 4);
        return u[0] === 0x50 && u[1] === 0x4B &&
              ((u[2] === 0x03 && u[3] === 0x04) ||
               (u[2] === 0x05 && u[3] === 0x06) ||
               (u[2] === 0x07 && u[3] === 0x08));
    }
    function isZipUrl(url) {
        if (!url) return false;
        try {
            const u = new URL(url, location.href);
            return ZIP_RE.test(u.pathname) && ZIP_HOST_RE.test(u.hostname);
        } catch (e) { return ZIP_RE.test(url); }
    }

    /* ================================================================ *
     * 1. Zip registry                                                   *
     * ================================================================ */

    const zipBuffers = [];
    const seenRefs = new WeakSet();
    const seenUrls = new Set();
    let sniffCount = 0;
    let currentZipUrl = null;
    let __bypassClick = false;

    function pushZip(buf, url) {
        if (!buf || buf.byteLength < 100) return;
        if (!looksLikeZip(buf)) { log('not a zip (magic mismatch):', url); return; }
        if (seenRefs.has(buf)) return;
        seenRefs.add(buf);
        zipBuffers.push({ buf, url, when: Date.now() });
        ok('Cached zip buffer', `(${buf.byteLength.toLocaleString()} bytes)`, 'from', url);
        onZipArrived(buf);
    }

    /* ================================================================ *
     * 2. Fetch/XHR/Blob/createObjectURL sniffing                        *
     * ================================================================ */

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string'
            ? args[0]
            : (args[0] && args[0].url) || '';
        const resp = await origFetch.apply(this, args);
        sniffFetchResponse(resp, url).catch(() => {});
        return resp;
    };

    async function sniffFetchResponse(resp, url) {
        if (!resp || !resp.ok) return;
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        const clStr = resp.headers.get('content-length');
        if (clStr && parseInt(clStr, 10) < 1000) return;
        let head;
        try {
            const clone = resp.clone();
            if (!clone.body) return;
            const reader = clone.body.getReader();
            const { value } = await reader.read();
            head = value;
            try { await reader.cancel(); } catch (e) {}
        } catch (e) { return; }
        sniffCount++;
        if (!head || head.byteLength < 4) return;
        if (looksLikeZip(head.buffer ? head.buffer.slice(head.byteOffset, head.byteOffset + 4) : head)) {
            log('◆ ZIP magic in fetch response:', url);
            try {
                const full = await resp.clone().arrayBuffer();
                pushZip(full, url);
            } catch (e) { warn('full read failed:', e); }
        }
    }

    const OrigXHR = window.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        const origOpen = xhr.open;
        let url = '';
        xhr.open = function (m, u, ...rest) { url = u; return origOpen.call(this, m, u, ...rest); };
        xhr.addEventListener('load', () => {
            try {
                const r = xhr.response;
                if (r instanceof ArrayBuffer) {
                    if (r.byteLength > 4 && looksLikeZip(r)) {
                        log('◆ ZIP magic in XHR ArrayBuffer:', url);
                        pushZip(r, url);
                    }
                } else if (r instanceof Blob && r.size > 1000) {
                    r.slice(0, 4).arrayBuffer().then(h => {
                        if (looksLikeZip(h)) {
                            log('◆ ZIP magic in XHR Blob:', url);
                            r.arrayBuffer().then(b => pushZip(b, url)).catch(() => {});
                        }
                    }).catch(() => {});
                }
            } catch (e) {}
        });
        return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    Object.setPrototypeOf(PatchedXHR, OrigXHR);
    window.XMLHttpRequest = PatchedXHR;

    const OrigBlob = window.Blob;
    function PatchedBlob(...args) {
        const blob = new OrigBlob(...args);
        try {
            if (blob && blob.size >= 1000) {
                blob.slice(0, 4).arrayBuffer().then(h => {
                    if (looksLikeZip(h)) {
                        log('◆ ZIP magic in Blob ctor. size =', blob.size);
                        blob.arrayBuffer().then(buf => pushZip(buf, 'Blob(ctor)')).catch(() => {});
                    }
                }).catch(() => {});
            }
        } catch (e) {}
        return blob;
    }
    PatchedBlob.prototype = OrigBlob.prototype;
    Object.setPrototypeOf(PatchedBlob, OrigBlob);
    window.Blob = PatchedBlob;

    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
        const url = origCreateObjectURL.call(this, blob);
        try {
            if (blob && blob instanceof OrigBlob && blob.size >= 1000) {
                blob.slice(0, 4).arrayBuffer().then(h => {
                    if (looksLikeZip(h)) {
                        log('◆ ZIP magic in createObjectURL. size =', blob.size);
                        blob.arrayBuffer().then(buf => pushZip(buf, 'createObjectURL')).catch(() => {});
                    }
                }).catch(() => {});
            }
        } catch (e) {}
        return url;
    };

    /* ================================================================ *
     * 3. Catch every way a zip URL leaves JS                            *
     * ================================================================ */

    let fetchingZip = false;
    async function handleZipUrl(url, opts = {}) {
        if (fetchingZip) { log('already fetching a zip, ignoring:', url); return; }
        fetchingZip = true;
        currentZipUrl = url;
        log('handleZipUrl:', url);

        if (!V.open) openViewer();
        if (!V.files.length && !zipProcessing) setStatus('Downloading zip…');

        try {
            const r = await origFetch(url, { credentials: 'omit', mode: 'cors' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = await r.arrayBuffer();
            log('Fetched', buf.byteLength.toLocaleString(), 'bytes');

            if (!looksLikeZip(buf)) {
                warn('Fetched body is not a zip. First bytes:',
                     new Uint8Array(buf, 0, Math.min(8, buf.byteLength)));
                throw new Error('Not a zip');
            }

            pushZip(buf, url);

            if (!opts.skipDownload) {
                try {
                    const blob = new OrigBlob([buf], { type: 'application/zip' });
                    const a = document.createElement('a');
                    a.href = origCreateObjectURL.call(URL, blob);
                    a.download = (url.split('/').pop().split('?')[0]) || 'model.zip';
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    __bypassClick = true;
                    a.click();
                    __bypassClick = false;
                    setTimeout(() => {
                        URL.revokeObjectURL(a.href);
                        a.remove();
                    }, 8000);
                } catch (e) { warn('re-download failed:', e); }
            }
        } catch (e) {
            warn('fetch zip failed:', e);
            setStatus('Could not fetch zip: ' + (e.message || e) +
                      '  ·  Click the download again and let it save to disk, then drop it here.');
        } finally {
            fetchingZip = false;
        }
    }

    try {
        const origAssign = Location.prototype.assign;
        Location.prototype.assign = function (url) {
            const abs = (() => { try { return new URL(url, location.href).href; } catch (e) { return url; } })();
            if (isZipUrl(abs)) { log('◆ location.assign intercepted:', abs); handleZipUrl(abs); return; }
            return origAssign.call(this, url);
        };
        const origReplace = Location.prototype.replace;
        Location.prototype.replace = function (url) {
            const abs = (() => { try { return new URL(url, location.href).href; } catch (e) { return url; } })();
            if (isZipUrl(abs)) { log('◆ location.replace intercepted:', abs); handleZipUrl(abs); return; }
            return origReplace.call(this, url);
        };
        ok('Hooked Location.assign / Location.replace');
    } catch (e) { warn('Location hook failed:', e); }

    try {
        const desc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (desc && desc.set && desc.configurable !== false) {
            Object.defineProperty(Location.prototype, 'href', {
                configurable: true, enumerable: desc.enumerable, get: desc.get,
                set(value) {
                    const abs = (() => { try { return new URL(value, location.href).href; } catch (e) { return value; } })();
                    if (isZipUrl(abs)) { log('◆ location.href = … intercepted:', abs); handleZipUrl(abs); return; }
                    return desc.set.call(this, value);
                },
            });
            ok('Hooked location.href setter');
        }
    } catch (e) { warn('location.href hook failed:', e); }

    const origOpen = window.open;
    window.open = function (url, ...rest) {
        try {
            const abs = url ? (() => { try { return new URL(url, location.href).href; } catch (e) { return url; } })() : null;
            if (abs && isZipUrl(abs)) { log('◆ window.open(zip) intercepted:', abs); handleZipUrl(abs); return null; }
        } catch (e) {}
        return origOpen.call(this, url, ...rest);
    };

    try {
        const aDesc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
        if (aDesc && aDesc.set && aDesc.configurable !== false) {
            Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
                configurable: true, enumerable: aDesc.enumerable, get: aDesc.get,
                set(value) {
                    const abs = (() => { try { return new URL(value, location.href).href; } catch (e) { return value; } })();
                    if (isZipUrl(abs)) { log('◆ a.href = zipUrl:', abs); queueMicrotask(() => handleZipUrl(abs)); }
                    return aDesc.set.call(this, value);
                },
            });
            ok('Hooked HTMLAnchorElement.href setter');
        }
    } catch (e) { warn('a.href hook failed:', e); }

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        try {
            if (this instanceof HTMLAnchorElement && /^href$/i.test(name) && typeof value === 'string') {
                const abs = (() => { try { return new URL(value, location.href).href; } catch (e) { return value; } })();
                if (isZipUrl(abs)) { log('◆ a.setAttribute(href, zipUrl):', abs); queueMicrotask(() => handleZipUrl(abs)); }
            }
        } catch (e) {}
        return origSetAttribute.call(this, name, value);
    };
    ok('Hooked Element.setAttribute');

    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        try {
            const href = this.href || '';
            if (!__bypassClick && isZipUrl(href)) {
                log('◆ a.click() with zip href:', href);
                queueMicrotask(() => handleZipUrl(href));
            }
        } catch (e) {}
        return origAnchorClick.apply(this, arguments);
    };

    document.addEventListener('click', (e) => {
        if (__bypassClick) return;
        const path = e.composedPath ? e.composedPath() : [e.target];
        for (const n of path) {
            if (n && n.tagName === 'A' && n.href && isZipUrl(n.href)) {
                log('◆ Click on <a> zip — preventing navigation.');
                e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation();
                handleZipUrl(n.href);
                return;
            }
        }
    }, true);

    function scanAnchors() {
        document.querySelectorAll('a[href]').forEach(a => {
            if (isZipUrl(a.href) && !seenUrls.has('anchor:' + a.href)) {
                seenUrls.add('anchor:' + a.href);
                log('◆ Found <a href=zip> in DOM:', a.href);
                handleZipUrl(a.href, { skipDownload: true });
            }
        });
    }
    window.addEventListener('DOMContentLoaded', () => {
        scanAnchors();
        new MutationObserver(scanAnchors).observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
        });
    });

    /* ================================================================ *
     * 4. Viewer state + UI                                              *
     * ================================================================ */

    const V = {
        root: null, sidebarEl: null, mainEl: null, statusEl: null,
        renderer: null, scene: null, camera: null, controls: null,
        thumbRenderer: null,
        currentObject: null,
        files: [],
        selectedIdx: -1,
        open: false,
        waitTimer: null,
        waitStartedAt: 0,
    };

    function el(tag, style, props) {
        const n = document.createElement(tag);
        if (style) n.style.cssText = style;
        if (props) for (const k in props) {
            if (k === 'text') n.textContent = props[k];
            else if (k === 'html') n.innerHTML = props[k];
            else n[k] = props[k];
        }
        return n;
    }

    function buildUI() {
        if (V.root) return;

        const root = el('div', `
            position: fixed; inset: 0; z-index: 2147483647;
            background: #121212; color: #e6e6e6; display: none;
            font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        `);
        root.id = 'mwcv-root';

        const header = el('div', `
            position:absolute;top:0;left:0;right:0;height:52px;
            display:flex;align-items:center;gap:14px;padding:0 16px;
            background:linear-gradient(#1f1f1f,#181818);
            border-bottom:1px solid #2a2a2a;z-index:10;
        `);
        const title = el('div', 'font-weight:600;color:#fff;', { text: 'Model Viewer' });
        const spacer = el('div', 'flex:1;');
        const shortcuts = el('div', 'color:#888;font-size:12px;white-space:nowrap;');
        shortcuts.innerHTML =
            '<b style="color:#bbb">L-drag</b> rotate · ' +
            '<b style="color:#bbb">R-drag</b> pan · ' +
            '<b style="color:#bbb">M-drag</b>/<b style="color:#bbb">wheel</b> zoom · ' +
            '<b style="color:#bbb">Esc</b> close';
        const dlBtn = el('button', `
            background:#0a84ff;color:#fff;border:0;padding:7px 14px;border-radius:5px;
            cursor:pointer;font-size:12px;font-weight:600;
        `, { text: 'Save .zip' });
        dlBtn.onclick = () => {
            if (!zipBuffers.length) { setStatus('No zip captured yet.'); return; }
            const z = zipBuffers[zipBuffers.length - 1];
            const blob = new OrigBlob([z.buf], { type: 'application/zip' });
            const a = document.createElement('a');
            a.href = origCreateObjectURL.call(URL, blob);
            a.download = (z.url.split('/').pop().split('?')[0]) || 'model.zip';
            __bypassClick = true;
            document.body.appendChild(a);
            a.click();
            __bypassClick = false;
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
        };
        const closeBtn = el('button', `
            background:#333;color:#fff;border:1px solid #444;padding:7px 14px;
            border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;
        `, { text: 'Close' });
        closeBtn.onclick = closeViewer;

        header.append(title, spacer, shortcuts, dlBtn, closeBtn);

        const body = el('div', `position:absolute;top:52px;left:0;right:0;bottom:0;display:flex;`);
        const sidebar = el('aside', `
            width:260px;flex-shrink:0;background:#1a1a1a;
            border-right:1px solid #262626;overflow-y:auto;padding:8px 0;
        `);
        const main = el('main', 'flex:1;position:relative;background:#141414;');
        const status = el('div', `
            position:absolute;left:14px;bottom:10px;color:#999;font-size:12px;
            pointer-events:none;max-width:80%;
        `);

        body.append(sidebar, main);
        main.append(status);
        root.append(header, body);
        document.body.appendChild(root);

        V.root = root;
        V.sidebarEl = sidebar;
        V.mainEl = main;
        V.statusEl = status;

        root.addEventListener('dragover', e => e.preventDefault());
        root.addEventListener('drop', async e => {
            e.preventDefault();
            const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!f) return;
            const buf = await f.arrayBuffer();
            if (/\.zip$/i.test(f.name)) pushZip(buf, 'dropped:' + f.name);
            else if (/\.(stl|3mf)$/i.test(f.name)) addSingleFile(f.name, buf);
            else setStatus('Unsupported file. Drop .zip, .stl, or .3mf.');
        });

        window.addEventListener('keydown', e => {
            if (e.key === 'Escape' && V.open) closeViewer();
        });
    }

    function setStatus(t) { if (V.statusEl) V.statusEl.textContent = t || ''; }

    /* ================================================================ *
     * 5. Custom screen-space pan (overrides TrackballControls' pan)     *
     * ================================================================ */

    const pendingPan = new THREE.Vector3();
    let panActive = false;
    let panPointerId = -1;
    let panLastX = 0, panLastY = 0;

    function computeScreenPanOffset(dx, dy) {
        const cam  = V.camera;
        const ctrl = V.controls;
        if (!cam || !ctrl || !V.renderer) return new THREE.Vector3();

        const target = ctrl.target || new THREE.Vector3(0, 0, 0);
        const dist = new THREE.Vector3().subVectors(cam.position, target).length();
        const fovRad = cam.fov * Math.PI / 180;
        const h = V.renderer.domElement.clientHeight || 600;
        const worldPerPixel = 2 * dist * Math.tan(fovRad / 2) / h;

        // Pull right & up from the camera's own world matrix — screen-relative always.
        cam.updateMatrixWorld();
        const m = cam.matrixWorld.elements;
        const right = new THREE.Vector3(m[0], m[1], m[2]).normalize();
        const up    = new THREE.Vector3(m[4], m[5], m[6]).normalize();

        const off = new THREE.Vector3();
        // Drag right → model moves right → camera moves left.
        off.addScaledVector(right, -dx * worldPerPixel);
        // Drag up → model moves up → camera moves down.
        off.addScaledVector(up,     dy * worldPerPixel);
        return off;
    }

    function onPanDown(e) {
        if (!V.open || !V.renderer) return;
        if (e.target !== V.renderer.domElement) return;
        if (e.button !== 2) return;                    // right button only
        panActive = true;
        panPointerId = e.pointerId;
        panLastX = e.clientX;
        panLastY = e.clientY;
        e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
    }

    function onPanMove(e) {
        if (!panActive || e.pointerId !== panPointerId) return;
        const dx = e.clientX - panLastX;
        const dy = e.clientY - panLastY;
        panLastX = e.clientX;
        panLastY = e.clientY;
        pendingPan.add(computeScreenPanOffset(dx, dy));
        e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
    }

    function onPanUp(e) {
        if (!panActive || e.pointerId !== panPointerId) return;
        panActive = false;
        panPointerId = -1;
        e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
    }

    // Capture phase on window so we beat TrackballControls' own pointerdown.
    window.addEventListener('pointerdown',  onPanDown, true);
    window.addEventListener('pointermove',  onPanMove, true);
    window.addEventListener('pointerup',    onPanUp,   true);
    window.addEventListener('pointercancel',onPanUp,   true);

    /* ================================================================ *
     * 6. Renderers                                                      *
     * ================================================================ */

    function initRenderers() {
        if (V.renderer) return;

        V.scene = new THREE.Scene();
        V.scene.background = new THREE.Color(0x141414);

        V.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200000);
        V.camera.position.set(80, 60, 80);

        V.renderer = new THREE.WebGLRenderer({ antialias: true });
        V.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        V.renderer.domElement.style.display = 'block';
        V.mainEl.insertBefore(V.renderer.domElement, V.statusEl);

        // No grid — just lights.
        V.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const k = new THREE.DirectionalLight(0xffffff, 0.85); k.position.set( 1,  1,  1); V.scene.add(k);
        const f = new THREE.DirectionalLight(0xffffff, 0.35); f.position.set(-1, -1, -1); V.scene.add(f);

        // TrackballControls = free rotation. We disable its pan and use ours.
        V.controls = new THREE.TrackballControls(V.camera, V.renderer.domElement);
        V.controls.rotateSpeed = 3.5;
        V.controls.zoomSpeed   = 1.5;
        V.controls.panSpeed    = 1.0;
        V.controls.staticMoving = false;
        V.controls.dynamicDampingFactor = 0.15;
        V.controls.mouseButtons = {
            LEFT:   THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT:  THREE.MOUSE.PAN,      // still declared, but suppressed via noPan
        };
        V.controls.minDistance = 0.05;
        V.controls.maxDistance = 100000;
        V.controls.noRotate = false;
        V.controls.noZoom   = false;
        V.controls.noPan    = true;      // ← our handler owns panning
        V.renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

        window.addEventListener('resize', () => { if (V.open) resizeMain(); });
        resizeMain();

        V.thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        V.thumbRenderer.setPixelRatio(1);
        V.thumbRenderer.setSize(160, 160, false);
        V.thumbRenderer.outputEncoding = THREE.sRGBEncoding;

        (function tick() {
            requestAnimationFrame(tick);
            if (!V.open) return;
            V.controls.update();
            // Apply our queued pan AFTER controls.update so nothing overwrites it.
            if (pendingPan.lengthSq() > 0) {
                V.camera.position.add(pendingPan);
                if (V.controls.target) V.controls.target.add(pendingPan);
                pendingPan.set(0, 0, 0);
                V.camera.updateMatrixWorld();
            }
            V.renderer.render(V.scene, V.camera);
        })();
    }

    function resizeMain() {
        const w = V.mainEl.clientWidth || 1;
        const h = V.mainEl.clientHeight || 1;
        V.renderer.setSize(w, h, false);
        V.camera.aspect = w / h;
        V.camera.updateProjectionMatrix();
        if (V.controls && V.controls.handleResize) V.controls.handleResize();
    }

    /* ================================================================ *
     * 7. Geometry                                                       *
     * ================================================================ */

    function matDefault() {
        return new THREE.MeshStandardMaterial({
            color: 0xdadada, metalness: 0.06, roughness: 0.72,
        });
    }

    function parseBuffer(buf, name) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.stl')) {
            const geom = new THREE.STLLoader().parse(buf);
            geom.computeVertexNormals();
            return new THREE.Mesh(geom, matDefault());
        }
        if (lower.endsWith('.3mf')) {
            const group = new THREE.ThreeMFLoader().parse(buf);
            group.traverse(n => {
                if (n.isMesh && (!n.material || (Array.isArray(n.material) && !n.material.length))) {
                    n.material = matDefault();
                }
            });
            return group;
        }
        throw new Error('Unsupported format: ' + name);
    }

    function fitCameraToObject(obj, camera, controls) {
        const box = new THREE.Box3().setFromObject(obj);
        if (box.isEmpty()) return;
        const size   = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        obj.position.sub(center);

        const maxDim  = Math.max(size.x, size.y, size.z) || 1;
        const fitDist = (maxDim * 0.5) / Math.tan((camera.fov * Math.PI) / 360) * 1.6;

        const yaw = Math.PI / 4, pitch = 0.85, r = fitDist;
        camera.position.set(
            r * Math.cos(pitch) * Math.sin(yaw),
            r * Math.sin(pitch),
            r * Math.cos(pitch) * Math.cos(yaw),
        );
        camera.near = maxDim / 5000;
        camera.far  = maxDim * 100;
        camera.updateProjectionMatrix();
        camera.lookAt(0, 0, 0);

        controls.target.set(0, 0, 0);
        controls.update();
        if (controls.handleResize) controls.handleResize();
    }

    /* ================================================================ *
     * 8. Thumbnails                                                     *
     * ================================================================ */

    function makeThumbnail(obj) {
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x262626);
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const d1 = new THREE.DirectionalLight(0xffffff, 0.9); d1.position.set(1.2, 1.5, 1.0); scene.add(d1);
        const d2 = new THREE.DirectionalLight(0xffffff, 0.35); d2.position.set(-1, -0.6, -1); scene.add(d2);

        const clone = obj.clone(true);
        scene.add(clone);

        const box = new THREE.Box3().setFromObject(clone);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        clone.position.sub(center);

        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const cam = new THREE.PerspectiveCamera(35, 1, maxDim / 5000, maxDim * 100);
        const r = (maxDim * 0.5) / Math.tan((cam.fov * Math.PI) / 360) * 1.7;
        const yaw = Math.PI / 4, pitch = 0.7;
        cam.position.set(
            r * Math.cos(pitch) * Math.sin(yaw),
            r * Math.sin(pitch),
            r * Math.cos(pitch) * Math.cos(yaw),
        );
        cam.lookAt(0, 0, 0);

        V.thumbRenderer.render(scene, cam);
        const dataUrl = V.thumbRenderer.domElement.toDataURL('image/png');
        scene.remove(clone);
        return dataUrl;
    }

    /* ================================================================ *
     * 9. Zip processing                                                 *
     * ================================================================ */

    let zipProcessing = false;

    async function onZipArrived(buf) {
        if (zipProcessing) return;
        zipProcessing = true;
        try {
            if (V.waitTimer) { clearInterval(V.waitTimer); V.waitTimer = null; }
            if (!V.open) openViewer();

            setStatus('Parsing zip…');
            const zip = await JSZip.loadAsync(buf);

            const entries = [];
            zip.forEach((path, file) => {
                if (file.dir) return;
                const name = path.split('/').pop();
                if (!name) return;
                if (/\.(stl|3mf)$/i.test(name)) entries.push({ path, name, file });
            });
            if (!entries.length) {
                setStatus('No .stl or .3mf files found in zip.');
                zipProcessing = false;
                return;
            }
            entries.sort((a, b) => {
                const rk = x => x.name.toLowerCase().endsWith('.3mf') ? 0 : 1;
                return rk(a) - rk(b);
            });

            V.files.forEach(f => f.row && f.row.remove());
            V.files.length = 0;
            V.selectedIdx = -1;
            if (V.currentObject) { V.scene.remove(V.currentObject); V.currentObject = null; }

            for (const e of entries) {
                const row = addFileRow(e.name, 'loading');
                V.files.push({ name: e.name, path: e.path, buf: null, kind: 'unknown',
                               thumbUrl: null, obj3d: null, row });
            }

            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const rec = V.files[i];
                try {
                    setStatus(`Extracting ${e.name}…`);
                    const fbuf = await e.file.async('arraybuffer');
                    rec.buf  = fbuf;
                    rec.kind = e.name.toLowerCase().endsWith('.3mf') ? '3mf' : 'stl';

                    setStatus(`Parsing ${e.name}…`);
                    rec.obj3d = parseBuffer(fbuf, e.name);

                    setStatus(`Rendering thumbnail ${i + 1}/${entries.length}…`);
                    rec.thumbUrl = makeThumbnail(rec.obj3d);

                    updateFileRow(rec, 'ready');
                } catch (err) {
                    warn('Failed on', e.name, err);
                    rec.error = String(err && err.message || err);
                    updateFileRow(rec, 'error');
                }
            }

            setStatus(`Loaded ${V.files.length} file(s). Select one to view.`);
            const firstReady = V.files.findIndex(f => f.obj3d);
            if (firstReady >= 0) selectFile(firstReady);
        } catch (e) {
            warn('zip parse error', e);
            setStatus('Failed to parse zip: ' + (e.message || e));
        } finally {
            zipProcessing = false;
        }
    }

    async function addSingleFile(name, buf) {
        if (!V.open) openViewer();
        const rec = { name, path: name, buf, kind: name.toLowerCase().endsWith('.3mf') ? '3mf' : 'stl',
                      thumbUrl: null, obj3d: null, row: null };
        rec.row = addFileRow(name, 'loading');
        V.files.push(rec);
        try {
            rec.obj3d = parseBuffer(buf, name);
            rec.thumbUrl = makeThumbnail(rec.obj3d);
            updateFileRow(rec, 'ready');
        } catch (e) {
            rec.error = String(e && e.message || e);
            updateFileRow(rec, 'error');
        }
        if (rec.obj3d) selectFile(V.files.indexOf(rec));
    }

    /* ================================================================ *
     * 10. Sidebar                                                       *
     * ================================================================ */

    function addFileRow(name, state) {
        const row = el('div', `
            display:flex;gap:10px;padding:8px 12px;cursor:pointer;align-items:center;
            border-bottom:1px solid #1f1f1f;user-select:none;background:transparent;
        `);
        const thumbWrap = el('div', `
            width:56px;height:56px;flex-shrink:0;border-radius:6px;overflow:hidden;
            background:#222;display:flex;align-items:center;justify-content:center;
            color:#555;font-size:11px;
        `, { text: '…' });
        const meta  = el('div', 'flex:1;min-width:0;');
        const title = el('div', `
            color:#ddd;font-size:12px;font-weight:600;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        `, { text: name, title: name });
        const sub = el('div', 'color:#777;font-size:11px;margin-top:2px;', { text: 'loading…' });
        meta.append(title, sub);
        row.append(thumbWrap, meta);
        V.sidebarEl.appendChild(row);
        return row;
    }

    function updateFileRow(rec, state) {
        if (!rec.row) return;
        const thumbWrap = rec.row.children[0];
        const sub       = rec.row.children[1].children[1];
        if (state === 'ready') {
            thumbWrap.textContent = '';
            thumbWrap.style.background = '#262626';
            if (rec.thumbUrl) {
                const img = el('img', 'width:100%;height:100%;object-fit:cover;display:block;');
                img.src = rec.thumbUrl;
                thumbWrap.appendChild(img);
            }
            const kb = rec.buf ? (rec.buf.byteLength / 1024).toFixed(1) + ' KB' : '';
            sub.textContent = `${rec.kind.toUpperCase()} · ${kb}`;
            sub.style.color = '#777';
        } else if (state === 'error') {
            thumbWrap.textContent = '!';
            thumbWrap.style.background = '#3a1e1e';
            thumbWrap.style.color = '#e66';
            sub.textContent = 'Error: ' + (rec.error || 'unknown');
            sub.style.color = '#c66';
            rec.row.style.cursor = 'default';
        }
    }

    function selectFile(idx) {
        const rec = V.files[idx];
        if (!rec || !rec.obj3d) return;

        V.files.forEach((f, i) => {
            if (!f.row) return;
            f.row.style.background = i === idx ? '#242424' : 'transparent';
        });
        V.selectedIdx = idx;

        if (V.currentObject) V.scene.remove(V.currentObject);
        V.currentObject = rec.obj3d;
        V.scene.add(rec.obj3d);
        fitCameraToObject(rec.obj3d, V.camera, V.controls);

        setStatus(`${rec.name}  ·  ${rec.kind.toUpperCase()}`);
    }

    document.addEventListener('click', (e) => {
        if (!V.open) return;
        let n = e.target;
        while (n && n !== V.sidebarEl) {
            const idx = V.files.findIndex(f => f.row === n);
            if (idx >= 0) { selectFile(idx); return; }
            n = n.parentElement;
        }
    }, true);

    /* ================================================================ *
     * 11. Open / close                                                  *
     * ================================================================ */

    function openViewer() {
        if (typeof THREE === 'undefined' || typeof JSZip === 'undefined') {
            alert('Viewer dependencies failed to load (THREE or JSZip). See console.');
            return;
        }
        buildUI();
        V.open = true;
        V.root.style.display = 'block';
        requestAnimationFrame(() => {
            initRenderers();
            resizeMain();
            if (!V.files.length && !zipProcessing) {
                if (zipBuffers.length) onZipArrived(zipBuffers[zipBuffers.length - 1].buf);
                else startWaitingStatus();
            }
        });
        log('viewer opened.');
    }

    function startWaitingStatus() {
        if (V.waitTimer) clearInterval(V.waitTimer);
        V.waitStartedAt = Date.now();
        V.waitTimer = setInterval(() => {
            const s = Math.floor((Date.now() - V.waitStartedAt) / 1000);
            setStatus(`Waiting for zip… (${s}s)  If nothing loads, drop the .zip here.`);
        }, 500);
    }

    function closeViewer() {
        if (!V.root) return;
        if (V.waitTimer) { clearInterval(V.waitTimer); V.waitTimer = null; }
        V.open = false;
        V.root.style.display = 'none';
        log('viewer closed.');
    }

    /* ================================================================ *
     * 12. Broad "Download STL/CAD Files" text match                     *
     * ================================================================ */

    const DL_RE = /download\s+(stl|cad)|stl\s*\/\s*cad\s+files/i;

    document.addEventListener('click', (e) => {
        const path = e.composedPath ? e.composedPath() : [e.target];
        for (const node of path) {
            if (!node || node.nodeType !== 1) continue;
            const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
            if (DL_RE.test(txt) && txt.length < 200) {
                log('Download button clicked → opening viewer');
                if (!V.open) openViewer();
                return;
            }
            if (node === document.body) break;
        }
    }, true);

    /* ================================================================ *
     * 13. Boot                                                          *
     * ================================================================ */

    function boot() {
        if (typeof THREE === 'undefined') { warn('THREE not loaded.'); return; }
        if (typeof JSZip === 'undefined') { warn('JSZip not loaded.'); return; }
        ok('THREE r' + THREE.REVISION);
        ok('TrackballControls:', typeof THREE.TrackballControls);
        ok('STLLoader       :', typeof THREE.STLLoader);
        ok('ThreeMFLoader   :', typeof THREE.ThreeMFLoader);
        ok('JSZip           :', typeof JSZip);
        ok('Custom screen-space pan installed.');
        log('Ready. Click "Download STL/CAD Files", or press Alt+Shift+V.');
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else boot();

    window.addEventListener('keydown', e => {
        if (e.altKey && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
            e.preventDefault(); openViewer();
        }
    });

    Object.defineProperty(window, '__mwcv', {
        value: {
            open: openViewer, close: closeViewer, state: V,
            zipBuffers, pushZip, handleZipUrl,
            seenUrls: () => [...seenUrls],
        },
        configurable: true,
    });
})();
