/* 3D reserve viewer: real DEM terrain, kriged ore panels (UNFC / grade / thickness), drill holes with
 * assay-coloured intercepts, mined-out ground, proposed infill holes, strike cut-away and hover inspection. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const UNFC_COLORS = { 111: '#1f9d55', 122: '#7bc96f', 331: '#2f7ed8', 332: '#7fb3ef', 333: '#f0a73a', 'Below cut-off': '#9aa1b0', Depleted: '#5b5563' };
const GRADE_STOPS = [[20, [70, 90, 160]], [30, [60, 170, 200]], [36, [120, 200, 90]], [40, [245, 200, 60]], [44, [235, 110, 40]], [50, [170, 20, 60]]];
export function gradeColor(g) {
  if (g == null) return new THREE.Color('#888');
  let i = 0; while (i < GRADE_STOPS.length - 2 && g > GRADE_STOPS[i + 1][0]) i++;
  const [g0, c0] = GRADE_STOPS[i], [g1, c1] = GRADE_STOPS[i + 1], k = Math.min(1, Math.max(0, (g - g0) / (g1 - g0)));
  return new THREE.Color(`rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`);
}
export const GRADE_LEGEND = GRADE_STOPS.map(([g, c]) => ({ g, css: `rgb(${c.join(',')})` }));
const thickColor = (t) => new THREE.Color().setHSL(0.72 - Math.min(1, t / 14) * 0.62, 0.7, 0.5);

export class ReserveViewer {
  constructor(container, { onHover } = {}) {
    this.el = container; this.onHover = onHover;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 5, 30000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08; this.controls.maxPolarAngle = Math.PI * 0.95;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(800, 1500, 600); this.scene.add(sun);
    this.clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e9);
    this.groups = {};
    this.exag = 1;
    this.mode = 'unfc';
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container);
    this.renderer.domElement.addEventListener('pointermove', (e) => this.hover(e));
    this.renderer.domElement.addEventListener('pointerleave', () => this.onHover?.(null));
    this.resize();
    const loop = () => { this.raf = requestAnimationFrame(loop); this.controls.update(); this.renderer.render(this.scene, this.camera); };
    loop();
  }

  /** local (E, N, Z) metres → three.js (x = E, y = Z·exag, z = −N), relative to the scene centre */
  v(e, n, z) { return new THREE.Vector3(e - this.c[0], (z - this.c[2]) * this.exag, -(n - this.c[1])); }
  dir(d) { return new THREE.Vector3(d[0], d[2] * this.exag, -d[1]); }

  load(data) {
    this.data = data;
    const f = data.frame;
    const mid = f.lenses[0];
    const centreV = (f.mined_v + f.plan_v) / 2;
    this.c = [f.origin[0] + f.dd[0] * centreV, f.origin[1] + f.dd[1] * centreV, f.origin[2] + f.dd[2] * centreV * 0.6];
    void mid;
    this.build();
    this.resetView();
  }

  clear() {
    Object.values(this.groups).forEach((g) => { this.scene.remove(g); g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); });
    this.groups = {};
  }

  build() {
    this.clear();
    const d = this.data, f = d.frame;
    const lensOff = Object.fromEntries(f.lenses.map((L) => [L.id, L.offset]));
    const P = (lens, u, v) => { const o = lensOff[lens]; return [f.origin[0] + f.n[0] * o + f.s[0] * u + f.dd[0] * v, f.origin[1] + f.n[1] * o + f.s[1] * u + f.dd[1] * v, f.origin[2] + f.n[2] * o + f.s[2] * u + f.dd[2] * v]; };
    const sV = this.dir(f.s).normalize(), ddV = this.dir(f.dd), nV = this.dir(f.n);
    const ddLen = ddV.length(); ddV.normalize(); nV.normalize();
    this.stepUdir = sV.clone();

    // --- terrain
    const dem = d.dem, N = dem.n, H = dem.half_m, g = new THREE.BufferGeometry();
    const pos = [], col = [], idx = [];
    const zs = dem.z, zmin = Math.min(...zs), zmax = Math.max(...zs);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const e = -H + (c / (N - 1)) * 2 * H, n = H - (r / (N - 1)) * 2 * H, z = zs[r * N + c];
      const p = this.v(e, n, z); pos.push(p.x, p.y, p.z);
      const k = (z - zmin) / (zmax - zmin || 1), cc = new THREE.Color().setHSL(0.28 - k * 0.2, 0.35, 0.42 + k * 0.2); col.push(cc.r, cc.g, cc.b);
    }
    for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) { const a = r * N + c; idx.push(a, a + N, a + 1, a + 1, a + N, a + N + 1); }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
    const terrain = new THREE.Group();
    terrain.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })));
    terrain.add(new THREE.LineSegments(new THREE.WireframeGeometry(g), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08 })));
    this.groups.terrain = terrain; this.scene.add(terrain);

    // --- ore panels (instanced, oriented in the plane of the lode)
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mk = (list, mat) => {
      const im = new THREE.InstancedMesh(box, mat, Math.max(1, list.length));
      const m4 = new THREE.Matrix4(), bx = new THREE.Vector3(), by = new THREE.Vector3(), bz = new THREE.Vector3();
      list.forEach((p, i) => {
        const c = P(p.lens, p.u, p.v), pos3 = this.v(...c);
        bx.copy(sV).multiplyScalar(d.panel_m * 0.94);
        by.copy(ddV).multiplyScalar(d.panel_m * ddLen * 0.94);
        bz.copy(nV).multiplyScalar(Math.max(0.8, p.T) * this.exag);
        m4.makeBasis(bx, by, bz).setPosition(pos3);
        im.setMatrixAt(i, m4);
      });
      im.count = list.length; im.userData.list = list;
      return im;
    };
    const live = d.panels.filter((p) => p.unfc !== 'Depleted' && p.T > 0.3), dead = d.panels.filter((p) => p.unfc === 'Depleted' && p.T > 0.3);
    const oreMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1, clippingPlanes: [this.clip] });
    this.ore = mk(live, oreMat);
    this.depleted = mk(dead, new THREE.MeshStandardMaterial({ color: 0x6b6474, transparent: true, opacity: 0.16, depthWrite: false, clippingPlanes: [this.clip] }));
    const og = new THREE.Group(); og.add(this.ore); this.groups.ore = og; this.scene.add(og);
    const dg = new THREE.Group(); dg.add(this.depleted); this.groups.depleted = dg; this.scene.add(dg);
    this.recolor();

    // --- drill holes: background trace + ore-grade coloured intercepts
    const bg = [], seg = [], segCol = [];
    const collars = [];
    d.holes.forEach((h) => {
      const C = [h.collar_e, h.collar_n, h.collar_z], w = h.dir;
      const at = (t) => this.v(C[0] + w[0] * t, C[1] + w[1] * t, C[2] + w[2] * t);
      const a = at(0), b = at(h.depth_m); bg.push(a.x, a.y, a.z, b.x, b.y, b.z);
      collars.push(a);
      h.assays.forEach(([fr, to, mn]) => {
        if (mn < 12) return;
        const p0 = at(fr), p1 = at(to), c = gradeColor(mn);
        seg.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z); segCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
      });
    });
    const holes = new THREE.Group();
    const bgG = new THREE.BufferGeometry(); bgG.setAttribute('position', new THREE.Float32BufferAttribute(bg, 3));
    holes.add(new THREE.LineSegments(bgG, new THREE.LineBasicMaterial({ color: 0xcfd6e6, transparent: true, opacity: 0.35, clippingPlanes: [this.clip] })));
    const sG = new THREE.BufferGeometry(); sG.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)); sG.setAttribute('color', new THREE.Float32BufferAttribute(segCol, 3));
    holes.add(new THREE.LineSegments(sG, new THREE.LineBasicMaterial({ vertexColors: true, clippingPlanes: [this.clip] })));
    const cG = new THREE.BufferGeometry().setFromPoints(collars);
    holes.add(new THREE.Points(cG, new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: true })));
    this.groups.holes = holes; this.scene.add(holes);

    // --- proposed holes
    const prop = new THREE.Group();
    (d.proposals || []).forEach((pr) => {
      const az = (pr.azimuth * Math.PI) / 180, inc = (-pr.dip * Math.PI) / 180;
      const w = [Math.sin(az) * Math.cos(inc), Math.cos(az) * Math.cos(inc), -Math.sin(inc)];
      const a = this.v(pr.collar.e, pr.collar.n, pr.collar.z), b = this.v(pr.collar.e + w[0] * pr.length_m, pr.collar.n + w[1] * pr.length_m, pr.collar.z + w[2] * pr.length_m);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({ color: 0xff3d7f, dashSize: 14, gapSize: 9 }));
      line.computeLineDistances(); prop.add(line);
      const tgt = P(pr.lens, pr.u, pr.v), s = new THREE.Mesh(new THREE.SphereGeometry(9, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3d7f }));
      s.position.copy(this.v(...tgt)); prop.add(s);
    });
    this.groups.proposals = prop; this.scene.add(prop);

    // --- reference levels: mined-out limit and approved mining depth
    const lv = new THREE.Group();
    const surfZ = f.origin[2] + 12;
    [[f.mined_to_m, 0x8b8595], [f.plan_depth_m, 0xd9467c]].forEach(([depth, color]) => {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(f.strike_len_m * 1.3, 700), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.035, side: THREE.DoubleSide, depthWrite: false }));
      pl.rotation.x = -Math.PI / 2;
      const ctr = this.v(f.origin[0] + f.dd[0] * f.mined_v, f.origin[1] + f.dd[1] * f.mined_v, surfZ - depth);
      pl.position.set(ctr.x, ctr.y, ctr.z);
      pl.rotation.z = Math.atan2(sV.z, sV.x) * -1;
      lv.add(pl);
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(pl.geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
      edge.position.copy(pl.position); edge.rotation.copy(pl.rotation); lv.add(edge);
    });
    this.groups.levels = lv; this.scene.add(lv);
    this.setClip(this.clipU ?? null);
  }

  recolor() {
    if (!this.ore) return;
    const list = this.ore.userData.list;
    list.forEach((p, i) => this.ore.setColorAt(i, this.mode === 'grade' ? gradeColor(p.grade) : this.mode === 'thickness' ? thickColor(p.T) : new THREE.Color(UNFC_COLORS[p.unfc] || '#999')));
    if (this.ore.instanceColor) this.ore.instanceColor.needsUpdate = true;
  }
  setMode(m) { this.mode = m; this.recolor(); }
  setVisible(key, on) { if (this.groups[key]) this.groups[key].visible = on; }
  setExaggeration(x) { this.exag = x; const vis = Object.fromEntries(Object.entries(this.groups).map(([k, g]) => [k, g.visible])); this.build(); Object.entries(vis).forEach(([k, on]) => this.setVisible(k, on)); }
  /** cut away everything beyond strike position u (metres along strike); null = no cut */
  setClip(u) {
    this.clipU = u;
    if (u == null) { this.clip.set(new THREE.Vector3(-1, 0, 0), 1e9); return; }
    const f = this.data.frame, P0 = this.v(f.origin[0] + f.s[0] * u, f.origin[1] + f.s[1] * u, f.origin[2]);
    const nrm = this.stepUdir.clone().negate();
    this.clip.setFromNormalAndCoplanarPoint(nrm, P0);
  }
  /** face-on view of the lode from the hanging-wall side, slightly from above and along strike */
  resetView() {
    const f = this.data.frame, L = f.strike_len_m;
    const n = this.dir(f.n).normalize(), s = this.dir(f.s).normalize();
    this.camera.position.copy(n.multiplyScalar(L * 0.95).add(new THREE.Vector3(0, L * 0.28, 0)).add(s.multiplyScalar(-L * 0.28)));
    this.controls.target.set(0, -40 * this.exag, 0);
    this.controls.update();
  }
  resize() {
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 500;
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }
  hover(e) {
    if (!this.ore || !this.onHover) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = this.raycaster.intersectObject(this.ore, false).find((h) => this.clip.distanceToPoint(h.point) >= 0 || this.clipU == null);
    this.onHover(hit ? { panel: this.ore.userData.list[hit.instanceId], x: e.clientX - r.left, y: e.clientY - r.top } : null);
  }
  dispose() {
    cancelAnimationFrame(this.raf); this.ro.disconnect(); this.clear(); this.controls.dispose(); this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
