// 3D previews for STL print files: a model you can turn in the viewer, and a still for the cards.
import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";

// STL comes as binary (most) or ASCII; both become one triangle mesh.
export function parseSTL(buf) {
  const dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const pos = [];
  if (n && 84 + n * 50 === buf.byteLength) {
    for (let i = 0; i < n; i++) { const o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++) pos.push(dv.getFloat32(o + k * 4, true)); }
  } else {
    const t = new TextDecoder().decode(buf);
    for (const m of t.matchAll(/vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g)) pos.push(+m[1], +m[2], +m[3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals(); g.center(); g.computeBoundingSphere();
  return g;
}

function scene(g, w, h, canvas) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, canvas });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.setSize(w, h, false);
  const s = new THREE.Scene();
  s.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1, 1.4, 1.2); s.add(key);
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x0f766e, roughness: 0.55, metalness: 0.05 }));
  mesh.rotation.x = -Math.PI / 2; // print files are Z-up
  s.add(mesh);
  const r = g.boundingSphere.radius || 1;
  const cam = new THREE.PerspectiveCamera(35, w / h, r / 100, r * 100);
  cam.position.set(r * 1.9, r * 1.5, r * 2.3); cam.lookAt(0, 0, 0);
  return { renderer, s, cam };
}

// Live, rotatable model inside an element.
export async function showSTL(el, url) {
  const g = parseSTL(await (await fetch(url)).arrayBuffer());
  const w = el.clientWidth || 800, h = el.clientHeight || 600;
  const canvas = document.createElement("canvas"); canvas.style.width = "100%"; canvas.style.height = "100%"; el.replaceChildren(canvas);
  const { renderer, s, cam } = scene(g, w, h, canvas);
  // Drag to turn, scroll or pinch to zoom, right-drag (or Shift-drag) to move it around; arrow keys move it too.
  const ctl = new OrbitControls(cam, canvas); ctl.enableDamping = true; ctl.screenSpacePanning = true; ctl.listenToKeyEvents?.(window);
  canvas.addEventListener("pointerdown", (e) => { if (e.shiftKey && e.button === 0) { ctl.mouseButtons.LEFT = 2; canvas.addEventListener("pointerup", () => (ctl.mouseButtons.LEFT = 0), { once: true }); } }, true);
  const home = cam.position.clone(); const reset = () => { cam.position.copy(home); ctl.target.set(0, 0, 0); ctl.update(); renderer.render(s, cam); };
  const bar = document.createElement("div"); bar.className = "v3dbar";
  bar.innerHTML = `<span>Drag to turn · scroll or pinch to zoom · right-drag or Shift-drag to move</span><button type="button" class="btn small">Reset view</button>`;
  bar.querySelector("button").onclick = reset; el.appendChild(bar);
  const fit = () => { const W = el.clientWidth || w, H = el.clientHeight || h; renderer.setSize(W, H, false); cam.aspect = W / H; cam.updateProjectionMatrix(); renderer.render(s, cam); };
  const ro = new ResizeObserver(fit); ro.observe(el);
  // Drawn only while it moves (a turn, a zoom, the glide after letting go), not 60 times a second while still.
  let on = true, queued = false;
  const frame = () => { queued = false; if (!on || !canvas.isConnected) { ro.disconnect(); return renderer.dispose(); } const moving = ctl.update(); renderer.render(s, cam); if (moving) draw(); };
  const draw = () => { if (!queued) { queued = true; requestAnimationFrame(frame); } };
  ctl.addEventListener("change", draw); new ResizeObserver(draw).observe(el); draw();
  return () => { on = false; };
}

// A still image for a card, one at a time (a shared queue keeps the page light).
let chain = Promise.resolve();
export function snapshotSTL(url, w = 480, h = 360) {
  const job = chain.then(async () => {
    const g = parseSTL(await (await fetch(url)).arrayBuffer());
    const { renderer, s, cam } = scene(g, w, h, document.createElement("canvas"));
    renderer.render(s, cam);
    const data = renderer.domElement.toDataURL("image/png");
    renderer.dispose(); g.dispose();
    return data;
  });
  chain = job.catch(() => {});
  return job;
}
