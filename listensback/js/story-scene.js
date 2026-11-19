// A living room drawn as 3D line art: navy outlines with halftone-dot shading on white paper,
// in the style of the ContextXR scene drawings. Everything is real geometry, so the camera can
// orbit and parallax with the pointer.
import * as THREE from '../vendor/three.module.min.js';

export const INK = new THREE.Color('#22305a');

// ---------------------------------------------------------------- materials
const HALFTONE_VS = `
  varying vec3 vN;
  void main() {
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const HALFTONE_FS = `
  uniform vec3 uPaper; uniform vec3 uInk; uniform vec3 uLight;
  uniform float uBase; uniform float uRange; uniform float uCell; uniform float uGlow;
  varying vec3 vN;
  void main() {
    float l = clamp(dot(normalize(vN), normalize(uLight)) * 0.5 + 0.5, 0.0, 1.0);
    float tone = clamp(uBase + (1.0 - l) * uRange, 0.0, 1.0);
    // 45° rotated dot screen in screen space
    vec2 p = gl_FragCoord.xy / uCell;
    p = vec2(p.x + p.y, p.x - p.y) * 0.7071;
    vec2 f = fract(p) - 0.5;
    float r = sqrt(tone) * 0.62;
    float aa = 0.9 / uCell;
    float ink = 1.0 - smoothstep(r - aa, r + aa, length(f));
    if (tone < 0.02) ink = 0.0;
    vec3 c = mix(uPaper, uInk, ink * 0.85);
    c = mix(c, vec3(1.0), uGlow);
    gl_FragColor = vec4(c, 1.0);
  }`;

const DPR = Math.min(2, window.devicePixelRatio || 1);
const LIGHT = new THREE.Vector3(0.45, 0.9, 0.6);

export function halftone({ paper = '#ffffff', base = 0.03, range = 0.35, cell = 4.2 } = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: HALFTONE_VS, fragmentShader: HALFTONE_FS,
    uniforms: {
      uPaper: { value: new THREE.Color(paper) }, uInk: { value: INK.clone() }, uLight: { value: LIGHT },
      uBase: { value: base }, uRange: { value: range }, uCell: { value: cell * DPR }, uGlow: { value: 0 },
    },
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
}
const LINE = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.92 });
const LINE_SOFT = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.35 });
const HULL = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

// A solid with drawn edges.
function solid(geom, mat, { edges = 25, soft = false } = {}) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geom, mat);
  g.add(m);
  g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, edges), soft ? LINE_SOFT : LINE));
  g.userData.mesh = m;
  return g;
}
const box = (w, h, d, mat, opt) => solid(new THREE.BoxGeometry(w, h, d), mat, opt);
// A rounded shape outlined by an inverted hull (for curved things: people, pots, shades).
function curved(geom, mat, hull = 0.008) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geom, mat);
  const h = new THREE.Mesh(geom, HULL);
  // the outline is a slightly larger copy drawn back-faces only
  const s = new THREE.Vector3();
  geom.computeBoundingBox();
  geom.boundingBox.getSize(s);
  h.scale.set(1 + (2 * hull) / Math.max(s.x, 1e-3), 1 + (2 * hull) / Math.max(s.y, 1e-3), 1 + (2 * hull) / Math.max(s.z, 1e-3));
  g.add(h, m);
  g.userData.mesh = m;
  return g;
}
function circleLine(r, segs = 48, mat = LINE) {
  const pts = [];
  for (let i = 0; i <= segs; i++) { const a = (i / segs) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
}
function polyline(points, mat = LINE) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p))), mat);
}

// ---------------------------------------------------------------- the person
// A jointed mannequin: hips → torso → neck/head, shoulders → upper arm → forearm, hips → thigh → shin.
// A tapered limb segment (wider at the top) with a rounded joint at each end.
function limb(len, rTop, rBot, mat) {
  const pivot = new THREE.Group();
  const seg = new THREE.Group();
  const body = curved(new THREE.CylinderGeometry(rTop, rBot, len, 16, 1), mat, 0.006);
  body.position.y = -len / 2; seg.add(body);
  const j0 = curved(new THREE.SphereGeometry(rTop, 14, 10), mat, 0.006); seg.add(j0);
  const j1 = curved(new THREE.SphereGeometry(rBot, 14, 10), mat, 0.006); j1.position.y = -len; seg.add(j1);
  pivot.add(seg);
  const end = new THREE.Group(); end.position.y = -len; pivot.add(end);
  pivot.userData = { end, seg };
  return pivot;
}

// Modelled loosely on David Lindlbauer: short ash-brown hair swept across, short stubble beard, leather jacket
// over a black tee, dark jeans. Proportions are roughly anatomical (head ≈ 1/7.5 of height).
// David's face, shared by both rigs: a real head shape (skull, cheekbones, jaw), a full short
// beard that wraps the jaw and chin, a moustache, brows, and white hair swept up and back.
function buildFace(neck, { skin, hairMat, beardMat, darkMat, browTilt = 0 }) {
  const head = curved(new THREE.SphereGeometry(0.098, 28, 20).scale(0.84, 1.16, 0.98), skin, 0.007);
  head.position.y = 0.155; neck.add(head);
  const face = new THREE.Group(); face.position.y = 0.155; neck.add(face);
  // jaw: a little wider and squarer than the skull's lower half
  const jaw = curved(new THREE.SphereGeometry(0.072, 20, 12).scale(1.02, 0.8, 1.0), skin, 0.004);
  jaw.position.set(0, -0.045, 0.012); face.add(jaw);
  // beard: a closed lower cap over jaw and chin, ear to ear, sitting just proud of the skin
  const beard = curved(new THREE.SphereGeometry(0.082, 28, 14, Math.PI / 2 - 1.7, 3.4, Math.PI * 0.56, Math.PI * 0.44).scale(0.97, 1.02, 1.04), beardMat, 0.002);
  beard.position.set(0, -0.032, 0.012); face.add(beard);
  // moustache: two soft lobes under the nose that meet the beard at the mouth corners
  for (const sx of [-1, 1]) {
    const m = curved(new THREE.SphereGeometry(0.015, 12, 8).scale(1.45, 0.42, 0.6), beardMat, 0.0015);
    m.position.set(sx * 0.016, -0.034, 0.096); m.rotation.z = sx * -0.25; face.add(m);
  }
  // mouth: a short line in the gap under the moustache
  face.add(polyline([[-0.016, -0.053, 0.098], [0, -0.055, 0.1], [0.016, -0.053, 0.098]]));
  // cheekbones and nose
  const nose = curved(new THREE.ConeGeometry(0.017, 0.05, 10).rotateX(Math.PI / 2 + 0.4), skin, 0.003); nose.position.set(0, -0.004, 0.104); face.add(nose);
  // eyes and brows (brows are short bars, slightly angled)
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 8, 6), darkMat); eye.position.set(sx * 0.031, 0.02, 0.088); face.add(eye);
    const brow = curved(new THREE.BoxGeometry(0.03, 0.007, 0.008), beardMat, 0.002);
    brow.position.set(sx * 0.032, 0.041, 0.09); brow.rotation.z = sx * (-0.12 + browTilt); face.add(brow);
    const ear = curved(new THREE.SphereGeometry(0.022, 10, 8).scale(0.45, 1, 0.8), skin, 0.004); ear.position.set(sx * 0.088, 0.003, -0.005); face.add(ear);
  }
  // hair (after his lab and HCII portraits): dark ash-brown, short at the sides, the top longer and
  // combed over to one side from a part above his right eye, so the top is higher on the part side
  // and the fringe sweeps across the forehead and down toward the other temple
  // sides: cut short, a thin lighter layer hugging the skull down to the ears
  const sideMat = halftone({ paper: '#f3f4f6', base: 0.24, range: 0.14, cell: 2.4 });
  const sides = curved(new THREE.SphereGeometry(0.1, 26, 12, Math.PI / 2 + 1.0, Math.PI * 2 - 2.0, 0, Math.PI * 0.4).scale(0.85, 1.15, 0.99), sideMat, 0.0015);
  sides.position.set(0, 0.0, -0.002); face.add(sides);
  // top: the longer hair, a low dome only over the crown
  const cap = curved(new THREE.SphereGeometry(0.097, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.36).scale(0.89, 1.0, 1.02), hairMat, 0.0025);
  cap.position.set(0, 0.016, -0.01);
  // back of the head: a full hair shell, pushed back so the face stays clear and only the back and
  // the sides behind the ears show; this fills the gaps that read as bald spots
  const back = curved(new THREE.SphereGeometry(0.096, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.58).scale(0.9, 1.1, 1.0), sideMat, 0.002);
  back.position.set(0, 0.004, -0.02); face.add(back); face.add(cap);
  const P = -0.042; // the part, on his right (screen left when he faces you)
  // combed-over locks, from the part across the top; each a long soft wedge pointing down-across
  const locks = [
    [P + 0.02, 0.112, 0.055, 0.042, -0.42], [P + 0.045, 0.106, 0.062, 0.04, -0.5], [P + 0.07, 0.096, 0.064, 0.036, -0.62],
    [P + 0.095, 0.083, 0.058, 0.03, -0.78], [P + 0.02, 0.122, 0.01, 0.044, -0.32], [P + 0.055, 0.115, 0.01, 0.042, -0.42],
    [P + 0.085, 0.1, 0.008, 0.036, -0.58], [P + 0.03, 0.118, -0.04, 0.04, -0.28], [P + 0.07, 0.106, -0.04, 0.038, -0.4],
  ];
  for (const [x, y, z, r, rz] of locks) {
    const l = curved(new THREE.SphereGeometry(r, 14, 8).scale(1.8, 0.3, 0.85), hairMat, 0.002);
    l.position.set(x, y - 0.026, z * 0.95); l.rotation.set(-0.25, 0, rz); face.add(l);
  }
  // the short side under the part, sitting flat
  // comb lines following the sweep
  for (let k = 0; k < 4; k++) {
    const z = 0.06 - k * 0.03, y0 = 0.108 - k * 0.002;
    face.add(polyline([[P + 0.005, y0, z], [P + 0.05, y0 - 0.012, z + 0.006], [P + 0.1, y0 - 0.038, z + 0.004]], LINE_SOFT));
  }
  return { head, face };
}

function buildPerson() {
  const skin = halftone({ paper: '#ffffff', base: 0.02, range: 0.28 });
  const tee = halftone({ paper: '#ffffff', base: 0.85, range: 0.1, cell: 3.4 });
  const leather = halftone({ paper: '#e9e9ee', base: 0.84, range: 0.14, cell: 3.4 });
  const jeans = halftone({ paper: '#ececef', base: 0.6, range: 0.22 });
  const shoes = halftone({ paper: '#ffffff', base: 0.8, range: 0.15 });
  const hairMat = halftone({ paper: '#f1f2f4', base: 0.4, range: 0.2, cell: 3.0 });
  const beardMat = halftone({ paper: '#f6ece2', base: 0.2, range: 0.14, cell: 2.2 });
  const darkMat = new THREE.MeshBasicMaterial({ color: INK });
  const root = new THREE.Group();
  const hips = new THREE.Group(); root.add(hips);
  const pelvis = curved(new THREE.SphereGeometry(0.15, 18, 12).scale(1.05, 0.7, 0.72), jeans, 0.006);
  pelvis.position.y = 0.02; hips.add(pelvis);
  const torso = new THREE.Group(); hips.add(torso);
  // waist → ribcage → shoulders, all inside the jacket
  const waist = curved(new THREE.CylinderGeometry(0.135, 0.14, 0.2, 18).scale(1, 1, 0.72), leather, 0.006);
  waist.position.y = 0.13; torso.add(waist);
  const chest = curved(new THREE.SphereGeometry(0.17, 20, 16).scale(1.08, 1.18, 0.7), leather, 0.006);
  chest.position.y = 0.33; torso.add(chest);
  const traps = curved(new THREE.CylinderGeometry(0.07, 0.19, 0.08, 18).scale(1, 1, 0.6), leather, 0.005);
  traps.position.y = 0.49; torso.add(traps);
  const teeStrip = curved(new THREE.CapsuleGeometry(0.032, 0.3, 4, 8), tee, 0.004);
  teeStrip.position.set(0, 0.29, 0.105); teeStrip.scale.z = 0.4; torso.add(teeStrip);
  const jacketBits = new THREE.Group(); torso.add(jacketBits);
  for (const side of [-1, 1]) {
    const lapel = box(0.055, 0.15, 0.015, leather); lapel.position.set(side * 0.06, 0.45, 0.11); lapel.rotation.z = side * 0.4; lapel.rotation.x = -0.15; jacketBits.add(lapel);
    jacketBits.add(polyline([[side * 0.04, 0.06, 0.1], [side * 0.045, 0.42, 0.12]]));
    // silver: a zip track down the open front edge, and lapel snaps
    const silver = new THREE.MeshBasicMaterial({ color: 0xd7dbe3 });
    const track = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.36, 0.006), silver); track.position.set(side * 0.047, 0.24, 0.122); jacketBits.add(track);
    for (let k = 0; k < 9; k++) { const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.006), new THREE.MeshBasicMaterial({ color: 0x8e95a3 })); tooth.position.set(side * 0.047, 0.08 + k * 0.04, 0.125); jacketBits.add(tooth); }
    const snap = new THREE.Mesh(new THREE.CircleGeometry(0.011, 14), silver); snap.position.set(side * 0.085, 0.44, 0.124); snap.rotation.z = side * 0.4; jacketBits.add(snap);
    const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.006, 0.004), silver); pocket.position.set(side * 0.1, 0.16, 0.112); pocket.rotation.z = side * -0.5; jacketBits.add(pocket);
  }
  // the zip pull at the bottom of one side
  const pull = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.03, 0.006), new THREE.MeshBasicMaterial({ color: 0xd7dbe3 })); pull.position.set(0.047, 0.07, 0.13); jacketBits.add(pull);
  // muscles revealed when the jacket rips: pecs and abs
  const abs = new THREE.Group(); abs.visible = false; torso.add(abs);
  const pecs = [];
  for (const sx of [-1, 1]) {
    const pec = curved(new THREE.SphereGeometry(0.075, 14, 10).scale(1.15, 0.75, 0.55), skin, 0.005); pec.position.set(sx * 0.07, 0.39, 0.09); abs.add(pec); pecs.push(pec);
    for (const y of [0.27, 0.2, 0.13]) { const ab = curved(new THREE.SphereGeometry(0.03, 10, 8).scale(1, 0.75, 0.5), skin, 0.004); ab.position.set(sx * 0.035, y, 0.1); abs.add(ab); }
  }
  const neck = new THREE.Group(); neck.position.y = 0.52; torso.add(neck);
  const neckSeg = curved(new THREE.CylinderGeometry(0.046, 0.055, 0.1, 12), skin, 0.005); neckSeg.position.y = 0.03; neck.add(neckSeg);
  const { head } = buildFace(neck, { skin, hairMat, beardMat, darkMat });
  const parts = { root, hips, torso, neck, head, chest, waist, traps, neckSeg, teeStrip, jacketBits, abs, pecs, leather, skin, shoulders: [], upperArms: [], forearms: [], hands: [] };
  for (const side of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(side * 0.205, 0.46, 0); torso.add(sh);
    const shoulder = curved(new THREE.SphereGeometry(0.066, 14, 10), leather, 0.006); sh.add(shoulder);
    const ua = limb(0.29, 0.056, 0.046, leather); sh.add(ua);
    const fa = limb(0.26, 0.046, 0.034, leather); ua.userData.end.add(fa);
    // mitten hand with a thumb
    const hand = new THREE.Group(); hand.position.y = -0.045; fa.userData.end.add(hand);
    hand.add(curved(new THREE.SphereGeometry(0.04, 12, 10).scale(0.75, 1.25, 0.5), skin, 0.004));
    const thumb = curved(new THREE.CapsuleGeometry(0.011, 0.03, 4, 6), skin, 0.003); thumb.position.set(-side * 0.025, 0.01, 0.012); thumb.rotation.z = side * 0.6; hand.add(thumb);
    parts.shoulders.push(shoulder); parts.upperArms.push(ua.userData.seg); parts.forearms.push(fa.userData.seg); parts.hands.push(hand);
    const hp = new THREE.Group(); hp.position.set(side * 0.095, -0.02, 0); hips.add(hp);
    const th = limb(0.44, 0.078, 0.055, jeans); hp.add(th);
    const sn = limb(0.43, 0.052, 0.038, jeans); th.userData.end.add(sn);
    // shoe: heel under the ankle, toe forward
    const shoe = curved(new THREE.CapsuleGeometry(0.045, 0.15, 6, 10).rotateX(Math.PI / 2).scale(0.85, 0.65, 1), shoes, 0.005);
    shoe.position.set(0, -0.035, 0.06); sn.userData.end.add(shoe);
    const k = side < 0 ? 'l' : 'r';
    Object.assign(parts, { [k + 'Sh']: ua, [k + 'El']: fa, [k + 'Hip']: th, [k + 'Knee']: sn });
  }
  return parts;
}

// Muscle-mode David: a separate bodybuilder rig with the same joints (so every pose works):
// V-shaped back, pecs, six-pack, capped delts, biceps and triceps, thick forearms and neck,
// the same white hair and beard, bare-chested in jeans.
function buildBuffPerson() {
  const skin = halftone({ paper: '#ffffff', base: 0.03, range: 0.42 });
  const jeans = halftone({ paper: '#ececef', base: 0.6, range: 0.22 });
  const shoes = halftone({ paper: '#ffffff', base: 0.8, range: 0.15 });
  const hairMat = halftone({ paper: '#f1f2f4', base: 0.4, range: 0.2, cell: 3.0 });
  const beardMat = halftone({ paper: '#f6ece2', base: 0.2, range: 0.14, cell: 2.2 });
  const darkMat = new THREE.MeshBasicMaterial({ color: INK });
  const blob = (r, sx, sy, sz, x, y, z, parent, mat = skin) => { const m = curved(new THREE.SphereGeometry(r, 16, 12).scale(sx, sy, sz), mat, 0.005); m.position.set(x, y, z); parent.add(m); return m; };
  const root = new THREE.Group(), hips = new THREE.Group(); root.add(hips);
  blob(0.16, 1.05, 0.7, 0.72, 0, 0.02, 0, hips, jeans);
  hips.add(polyline([[-0.14, 0.07, 0.11], [0.14, 0.07, 0.11]])); // waistband
  const torso = new THREE.Group(); hips.add(torso);
  // narrow waist widening to a broad back
  const waist = curved(new THREE.CylinderGeometry(0.17, 0.13, 0.22, 20).scale(1, 1, 0.68), skin, 0.006); waist.position.y = 0.14; torso.add(waist);
  const lats = curved(new THREE.CylinderGeometry(0.3, 0.17, 0.3, 24).scale(1, 1, 0.55), skin, 0.006); lats.position.y = 0.38; torso.add(lats);
  const upper = curved(new THREE.SphereGeometry(0.3, 24, 16).scale(1, 0.55, 0.58), skin, 0.006); upper.position.y = 0.5; torso.add(upper);
  // traps
  const traps = curved(new THREE.ConeGeometry(0.2, 0.12, 20).scale(1, 1, 0.6), skin, 0.005); traps.position.y = 0.62; torso.add(traps);
  // pecs and abs
  for (const sx of [-1, 1]) {
    const pec = blob(0.11, 1.25, 0.72, 0.55, sx * 0.1, 0.47, 0.12, torso);
    pec.rotation.z = sx * -0.15;
    for (const [i, y] of [0.31, 0.22, 0.13].entries()) blob(0.04, 1.05, 0.8, 0.5, sx * 0.045, y, 0.115 - i * 0.004, torso);
    blob(0.05, 0.6, 1.6, 0.5, sx * 0.14, 0.24, 0.09, torso); // obliques
  }
  torso.add(polyline([[0, 0.4, 0.15], [0, 0.08, 0.12]]));
  const neck = new THREE.Group(); neck.position.y = 0.64; torso.add(neck);
  const neckSeg = curved(new THREE.CylinderGeometry(0.07, 0.1, 0.12, 14), skin, 0.005); neckSeg.position.y = 0.02; neck.add(neckSeg);
  const { head } = buildFace(neck, { skin: halftone({ paper: '#ffffff', base: 0.02, range: 0.28 }), hairMat, beardMat, darkMat, browTilt: 0.35 });
  const parts = { root, hips, torso, neck, head, shoulders: [], upperArms: [], forearms: [], hands: [], buff: true };
  for (const side of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(side * 0.33, 0.55, 0); torso.add(sh);
    parts.shoulders.push(blob(0.1, 1, 0.95, 0.95, 0, 0, 0, sh)); // capped delt
    const ua = limb(0.3, 0.075, 0.065, skin); sh.add(ua);
    blob(0.06, 0.95, 1.5, 0.95, 0, -0.15, 0.045, ua.userData.seg); // biceps peak
    blob(0.055, 0.9, 1.6, 0.85, 0, -0.13, -0.045, ua.userData.seg); // triceps
    const fa = limb(0.27, 0.068, 0.045, skin); ua.userData.end.add(fa);
    blob(0.05, 0.9, 1.4, 0.9, 0, -0.07, 0.01, fa.userData.seg); // forearm flexors
    const hand = new THREE.Group(); hand.position.y = -0.05; fa.userData.end.add(hand);
    hand.add(curved(new THREE.SphereGeometry(0.048, 12, 10).scale(0.8, 1.2, 0.55), skin, 0.004));
    parts.upperArms.push(ua.userData.seg); parts.forearms.push(fa.userData.seg); parts.hands.push(hand);
    const hp = new THREE.Group(); hp.position.set(side * 0.1, -0.02, 0); hips.add(hp);
    const th = limb(0.44, 0.095, 0.06, jeans); hp.add(th);
    const sn = limb(0.43, 0.065, 0.042, jeans); th.userData.end.add(sn);
    const shoe = curved(new THREE.CapsuleGeometry(0.048, 0.15, 6, 10).rotateX(Math.PI / 2).scale(0.85, 0.65, 1), shoes, 0.005); shoe.position.set(0, -0.035, 0.06); sn.userData.end.add(shoe);
    const k = side < 0 ? 'l' : 'r';
    Object.assign(parts, { [k + 'Sh']: ua, [k + 'El']: fa, [k + 'Hip']: th, [k + 'Knee']: sn });
  }
  return parts;
}

// Pose = joint angles (radians) + hips position. Blendable.
// Sign convention: shoulder z < 0 lifts the LEFT arm outward, z > 0 the right arm.
export const POSES = {
  sit: { y: 0.55, torso: -0.2, neck: 0.16, lSh: [-0.12, 0, 0.1], rSh: [-0.12, 0, -0.1], lEl: [-1.15, 0, -0.05], rEl: [-1.15, 0, 0.05], lHip: [-1.38, 0.08, 0.1], rHip: [-1.38, -0.08, -0.1], lKnee: [1.5, 0, -0.04], rKnee: [1.5, 0, 0.04] },
  frustrated: { y: 0.9, torso: 0.22, neck: 0.45, lSh: [0.15, 0, -0.55], rSh: [0.15, 0, 0.55], lEl: [-0.4, 0, 1.6], rEl: [-0.4, 0, -1.6], lHip: [0, 0, 0.1], rHip: [0, 0, -0.1], lKnee: [0.05, 0, 0], rKnee: [0.05, 0, 0] },
  carry: { y: 0.9, torso: 0.05, neck: -0.05, lSh: [0, 0, -0.3], rSh: [0, 0, 0.3], lEl: [0, 0, 0], rEl: [0, 0, 0], lHip: [-0.08, 0, 0.22], rHip: [-0.08, 0, -0.22], lKnee: [0.12, 0, 0], rKnee: [0.12, 0, 0] },
  carrySquat: { y: 0.55, torso: 0.45, neck: -0.35, lSh: [0.4, 0, -0.32], rSh: [0.4, 0, 0.32], lEl: [0, 0, 0], rEl: [0, 0, 0], lHip: [-1.4, 0, 0.25], rHip: [-1.4, 0, -0.25], lKnee: [1.65, 0, 0], rKnee: [1.65, 0, 0] },
  stand: { y: 0.9, torso: 0, neck: 0, lSh: [0, 0, 0.12], rSh: [0, 0, -0.12], lEl: [-0.15, 0, 0], rEl: [-0.15, 0, 0], lHip: [0, 0, 0.05], rHip: [0, 0, -0.05], lKnee: [0, 0, 0], rKnee: [0, 0, 0] },
  squat: { y: 0.5, torso: 0.55, neck: -0.45, lSh: [-0.35, 0, -1.25], rSh: [-0.35, 0, 1.25], lEl: [0, 0, -1.9], rEl: [0, 0, 1.9], lHip: [-1.45, 0, 0.18], rHip: [-1.45, 0, -0.18], lKnee: [1.75, 0, 0], rKnee: [1.75, 0, 0] },
  rack: { y: 0.9, torso: 0.08, neck: -0.08, lSh: [-0.25, 0, -1.25], rSh: [-0.25, 0, 1.25], lEl: [0, 0, -1.9], rEl: [0, 0, 1.9], lHip: [-0.08, 0, 0.18], rHip: [-0.08, 0, -0.18], lKnee: [0.12, 0, 0], rKnee: [0.12, 0, 0] },
  phoneReach: { y: 0.55, torso: 0.42, neck: 0.35, lSh: [-0.12, 0, 0.1], rSh: [-1.0, 0, -0.05], rEl: [-0.3, 0, 0.05], lEl: [-1.15, 0, -0.05], lHip: [-1.38, 0.08, 0.1], rHip: [-1.38, -0.08, -0.1], lKnee: [1.5, 0, -0.04], rKnee: [1.5, 0, 0.04] },
  phoneHold: { y: 0.55, torso: -0.05, neck: 0.42, lSh: [-0.55, 0, 0.3], rSh: [-0.55, 0, -0.3], lEl: [-1.7, 0, 0.1], rEl: [-1.7, 0, -0.1], lHip: [-1.38, 0.08, 0.1], rHip: [-1.38, -0.08, -0.1], lKnee: [1.5, 0, -0.04], rKnee: [1.5, 0, 0.04] },
  watch: { y: 0.9, torso: 0.06, neck: 0.42, lSh: [-0.55, 0, 0.45], rSh: [0, 0, -0.12], lEl: [-1.75, 0, 0.2], rEl: [-0.15, 0, 0], lHip: [0, 0, 0.08], rHip: [0.05, 0, -0.08], lKnee: [0, 0, 0], rKnee: [0.1, 0, 0] },
  lower: { y: 0.84, torso: 0.3, neck: 0.15, lSh: [-0.45, 0, 0.14], rSh: [-0.45, 0, -0.14], lEl: [-0.15, 0, 0], rEl: [-0.15, 0, 0], lHip: [-0.4, 0, 0.18], rHip: [-0.4, 0, -0.18], lKnee: [0.55, 0, 0], rKnee: [0.55, 0, 0] },
  slump: { y: 0.86, torso: 0.36, neck: 0.7, lSh: [0.06, 0, 0.03], rSh: [0.06, 0, -0.03], lEl: [-0.05, 0, 0], rEl: [-0.05, 0, 0], lHip: [-0.14, 0, 0.07], rHip: [-0.14, 0, -0.07], lKnee: [0.24, 0, 0], rKnee: [0.24, 0, 0] },
  startle: { y: 0.6, torso: -0.38, neck: -0.25, lSh: [-0.9, 0, -0.7], rSh: [-0.9, 0, 0.7], lEl: [-1.4, 0, 0], rEl: [-1.4, 0, 0], lHip: [-1.4, 0, 0.1], rHip: [-1.4, 0, -0.1], lKnee: [1.2, 0, 0], rKnee: [1.2, 0, 0] },
};
export function mixPose(a, b, t) {
  const o = {};
  for (const k of Object.keys(a)) o[k] = Array.isArray(a[k]) ? a[k].map((v, i) => v + (b[k][i] - v) * t) : a[k] + (b[k] - a[k]) * t;
  return o;
}

// ---------------------------------------------------------------- the room
export class Room {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(DPR);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.hoverables = [];
    this.build();
    // camera rig: spherical coordinates around a target, eased toward a "shot"
    this.cam = { target: new THREE.Vector3(-0.4, 0.8, -1.2), yaw: 0.55, pitch: 0.3, dist: 8.2 };
    this.shot = { ...this.cam, target: this.cam.target.clone() };
    this.user = { yaw: 0, pitch: 0, zoom: 1 };
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0 };
    this.shake = 0;
    this.raycaster = new THREE.Raycaster();
    this.bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  build() {
    const S = this.scene;
    const paper = halftone({ base: 0.0, range: 0.12 });
    const wallMat = halftone({ paper: '#ffffff', base: 0.0, range: 0.16, cell: 4.6 });
    const floorMat = halftone({ paper: '#f7f9ff', base: 0.015, range: 0.08, cell: 5 });
    const wood = halftone({ paper: '#ffffff', base: 0.1, range: 0.35 });
    const fabric = halftone({ paper: '#eef2fd', base: 0.1, range: 0.4 });
    const dark = halftone({ paper: '#ffffff', base: 0.55, range: 0.3 });

    // floor + two walls (a cut-away corner)
    const floor = box(6.2, 0.06, 5.2, floorMat); floor.position.set(0, -0.03, 0); S.add(floor);
    const back = box(6.2, 2.7, 0.08, wallMat); back.position.set(0, 1.35, -2.64); S.add(back);
    const left = box(0.08, 2.7, 5.2, wallMat); left.position.set(-3.14, 1.35, 0); S.add(left);
    // floor boards
    for (let x = -2.9; x < 3.1; x += 0.42) S.add(polyline([[x, 0.002, -2.6], [x, 0.002, 2.6]], LINE_SOFT));
    // baseboards
    const bb1 = box(6.2, 0.1, 0.03, paper, { soft: true }); bb1.position.set(0, 0.05, -2.585); S.add(bb1);

    // window with blinds on the back wall
    const win = new THREE.Group(); win.position.set(1.15, 1.55, -2.58);
    const frame = box(1.7, 1.15, 0.06, halftone({ paper: '#f3f6ff', base: 0.02, range: 0.05, cell: 6 })); win.add(frame);
    for (let i = 0; i < 9; i++) win.add(polyline([[-0.8, 0.5 - i * 0.12, 0.04], [0.8, 0.5 - i * 0.12, 0.04]]));
    win.add(polyline([[0, -0.57, 0.04], [0, 0.57, 0.04]]));
    const sill = box(1.85, 0.05, 0.16, paper); sill.position.set(0, -0.6, 0.06); win.add(sill);
    S.add(win);

    // framed pictures: the Drake meme from the MARingBA talk on the back wall, and the three
    // paper posters on the left wall. They are images (not halftone) inside drawn frames.
    this.frames = [];
    const loader = new THREE.TextureLoader();
    const framed = (src, w, h, hoverId, info) => {
      const g = new THREE.Group();
      const fr = box(w + 0.08, h + 0.08, 0.04, halftone({ base: 0.55, range: 0.2 })); g.add(fr);
      const tex = loader.load(src); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      pic.position.z = 0.022; g.add(pic);
      g.userData = { hover: hoverId, info, pic };
      g.traverse((o) => { if (o.isMesh) o.userData.hoverRoot = g; });
      this.hoverables.push(g); this.frames.push(g);
      return g;
    };
    const drake = framed('img/story/drake.png', 0.62, 0.62, 'drake', { title: 'Hotline Bling, ringtone edition', sub: 'From the MARingBA CHI talk' });
    drake.position.set(-0.55, 1.75, -2.57); S.add(drake);
    const posters = [
      ['maringba', 'MARingBA', 'CHI 2024 · Best Paper Honorable Mention', 'index.html', 'https://doi.org/10.1145/3613904.3642376', 'chi2024', 'CHI 2024', 'Honolulu, HI'],
      ['mva', 'Towards Music-Aware Virtual Assistants', 'UIST 2024', 'sing.html', 'https://doi.org/10.1145/3654777.3676416', 'uist2024', 'UIST 2024', 'Pittsburgh, PA'],
      ['rise', 'RISE', 'ISMIR 2025', 'rise.html', 'https://arxiv.org/abs/2509.17112', 'ismir2025', 'ISMIR 2025', 'Daejeon, Korea'],
      ['multiverse', 'MultiVerse', 'UIST 2026', null, 'https://doi.org/10.1145/3830398.3830530', 'uist2026', 'UIST 2026', 'Detroit, MI'],
    ];
    // a small "presented at" plaque under each poster, drawn on a canvas: logo + venue
    const plaque = (logo, venue, city) => {
      const cv = document.createElement('canvas'); cv.width = 720; cv.height = 240;
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const draw = (img) => {
        const g = cv.getContext('2d');
        g.fillStyle = '#fbfbf7'; g.fillRect(0, 0, 720, 240);
        if (img) { const h = 170, w = Math.min(300, (img.width / img.height) * h), hh = (img.height / img.width) * w; g.drawImage(img, 30, 120 - hh / 2, w, hh); }
        g.fillStyle = '#6a6a7a'; g.font = '700 30px Inter, system-ui, sans-serif'; g.fillText('PRESENTED AT', 360, 82);
        g.fillStyle = '#17171c'; g.font = '900 58px Inter, system-ui, sans-serif'; g.fillText(venue, 360, 146);
        g.fillStyle = '#55556a'; g.font = '600 30px Inter, system-ui, sans-serif'; g.fillText(city, 360, 192);
        tex.needsUpdate = true;
      };
      draw(null);
      const im = new Image(); im.onload = () => draw(im); im.src = `img/story/venue-${logo}.png`;
      const g = new THREE.Group();
      g.add(box(0.6 + 0.05, 0.2 + 0.05, 0.03, halftone({ base: 0.55, range: 0.2 })));
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.2), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      pic.position.z = 0.017; g.add(pic);
      return g;
    };
    posters.forEach(([id, title, venue, href, paper, logo, vname, city], i) => {
      const z = -1.95 + i * 0.75;
      const g = framed(`img/story/poster-${id}.png`, 0.6, 0.6 * 2139 / 1292, 'poster', { id, title, venue, href, paper });
      this.posterFrames = this.posterFrames || {}; this.posterFrames[id] = g;
      g.rotation.y = Math.PI / 2;
      g.position.set(-3.07, 1.55, z);
      S.add(g);
      const p = plaque(logo, vname, city);
      p.rotation.y = Math.PI / 2; p.position.set(-3.075, 0.82, z);
      S.add(p);
    });

    // rug
    const rug = box(2.8, 0.012, 1.9, halftone({ paper: '#ffffff', base: 0.18, range: 0.05, cell: 3.6 }), { soft: false });
    rug.position.set(-0.55, 0.006, -0.85); S.add(rug);
    S.add(polyline([[-1.8, 0.014, -1.65], [0.7, 0.014, -1.65], [0.7, 0.014, -0.05], [-1.8, 0.014, -0.05], [-1.8, 0.014, -1.65]], LINE_SOFT));

    // couch
    const couch = new THREE.Group(); couch.position.set(-0.55, 0, -2.0);
    const base = box(2.3, 0.36, 0.95, fabric); base.position.y = 0.2; couch.add(base);
    const backrest = box(2.3, 0.55, 0.24, fabric); backrest.position.set(0, 0.65, -0.36); couch.add(backrest);
    for (const s of [-1, 1]) {
      const arm = box(0.2, 0.62, 0.95, fabric); arm.position.set(s * 1.25, 0.31, 0); couch.add(arm);
      const cush = box(1.08, 0.13, 0.72, halftone({ paper: '#f2f5fe', base: 0.06, range: 0.35 })); cush.position.set(s * 0.55, 0.445, 0.08); couch.add(cush);
      const pil = box(0.42, 0.36, 0.12, halftone({ base: 0.25, range: 0.3 })); pil.position.set(s * 0.82, 0.68, -0.18); pil.rotation.z = s * 0.15; couch.add(pil);
    }
    for (const sx of [-1.25, 1.25]) for (const sz of [-0.4, 0.4]) { const leg = box(0.05, 0.05, 0.05, dark); leg.position.set(sx, 0.0, sz); couch.add(leg); }
    S.add(couch);

    // coffee table + phone + mug
    const table = new THREE.Group(); table.position.set(-0.55, 0, -0.75);
    const top = box(1.15, 0.05, 0.6, wood); top.position.y = 0.42; table.add(top);
    const shelf = box(1.0, 0.03, 0.48, wood); shelf.position.y = 0.12; table.add(shelf);
    for (const sx of [-0.52, 0.52]) for (const sz of [-0.24, 0.24]) { const l = box(0.04, 0.42, 0.04, wood); l.position.set(sx, 0.21, sz); table.add(l); }
    const phone = new THREE.Group(); phone.position.set(0.2, 0.452, 0.04); phone.rotation.y = 0.35;
    const body = box(0.085, 0.012, 0.17, dark); phone.add(body);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.072, 0.15), halftone({ paper: '#ffffff', base: 0.0, range: 0.0 }));
    screen.rotation.x = -Math.PI / 2; screen.position.y = 0.0075; phone.add(screen);
    phone.userData = { hover: 'phone', screen }; table.add(phone);
    const mug = curved(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 18), halftone({ base: 0.05, range: 0.3 }));
    mug.position.set(-0.3, 0.495, -0.08); table.add(mug);
    const books = box(0.3, 0.06, 0.22, halftone({ base: 0.2, range: 0.3 })); books.position.set(-0.2, 0.15, 0); table.add(books);
    S.add(table);
    this.phone = phone;

    // speakers
    this.speakers = [];
    for (const x of [-2.35, 1.15]) {
      const sp = new THREE.Group(); sp.position.set(x, 0, -2.15);
      const cab = box(0.36, 1.08, 0.32, halftone({ paper: '#ffffff', base: 0.08, range: 0.4 })); cab.position.y = 0.54; sp.add(cab);
      const cones = [];
      for (const [y, r] of [[0.92, 0.055], [0.62, 0.115], [0.3, 0.115]]) {
        const ring = new THREE.Group(); ring.position.set(0, y, 0.165);
        ring.add(circleLine(r)); ring.add(circleLine(r * 0.72)); ring.add(circleLine(r * 0.25));
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 32), halftone({ base: 0.35, range: 0.0, cell: 3.2 }));
        disc.position.z = -0.002; ring.add(disc);
        sp.add(ring); cones.push({ ring, r });
      }
      sp.userData = { hover: 'speaker', cones };
      cab.userData.mesh.userData.hoverRoot = sp;
      sp.traverse((o) => { if (o.isMesh) o.userData.hoverRoot = sp; });
      sp.userData.home = sp.position.clone();
      S.add(sp); this.speakers.push(sp); this.hoverables.push(sp);
    }
    phone.traverse((o) => { if (o.isMesh) o.userData.hoverRoot = phone; });
    this.hoverables.push(phone);

    // floor lamp
    const lamp = new THREE.Group(); lamp.position.set(2.05, 0, -1.55);
    const lbase = curved(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 24), dark); lbase.position.y = 0.015; lamp.add(lbase);
    const pole = box(0.025, 1.55, 0.025, dark); pole.position.y = 0.8; lamp.add(pole);
    const shade = curved(new THREE.CylinderGeometry(0.13, 0.24, 0.3, 24, 1, true), halftone({ paper: '#fffbea', base: 0.03, range: 0.15 }));
    shade.position.y = 1.62; lamp.add(shade);
    S.add(lamp);

    // bookshelf on the left wall
    const shelfG = new THREE.Group(); shelfG.position.set(-2.88, 0, 1.25);
    const carcass = box(0.38, 1.85, 1.05, wood); carcass.position.y = 0.925; shelfG.add(carcass);
    for (let i = 1; i < 5; i++) { const s = box(0.36, 0.025, 1.0, wood); s.position.set(0.02, i * 0.37, 0); shelfG.add(s); }
    const rnd = (k) => (Math.sin(k * 12.9898) * 43758.5453) % 1;
    for (let i = 1; i < 4; i++) {
      let z = -0.46;
      for (let k = 0; z < 0.42; k++) {
        const w = 0.04 + Math.abs(rnd(i * 31 + k)) * 0.05, h = 0.2 + Math.abs(rnd(i * 17 + k)) * 0.1;
        const b = box(0.24, h, w, halftone({ base: 0.08 + Math.abs(rnd(k + i)) * 0.5, range: 0.25 }), { soft: true });
        b.position.set(0.04, i * 0.37 + 0.025 + h / 2 + 0.01, z + w / 2); shelfG.add(b); z += w + 0.008;
        if (Math.abs(rnd(i * 7 + k)) > 0.85) z += 0.12;
      }
    }
    // bottom compartment: a drawer that slides out toward the room, with Alex's name card inside
    const drawer = new THREE.Group(); drawer.position.set(0, 0, 0);
    const dfront = box(0.03, 0.22, 0.98, halftone({ paper: '#ffffff', base: 0.18, range: 0.3 })); dfront.position.set(0.19, 0.16, 0); drawer.add(dfront);
    const dknob = box(0.04, 0.035, 0.16, halftone({ base: 0.6, range: 0.1 })); dknob.position.set(0.215, 0.17, 0); drawer.add(dknob);
    const dfloor = box(0.34, 0.02, 0.94, wood); dfloor.position.set(0.02, 0.17, 0); drawer.add(dfloor);
    for (const z of [-0.46, 0.46]) { const dside = box(0.34, 0.1, 0.02, wood); dside.position.set(0.02, 0.22, z); drawer.add(dside); }
    const dback = box(0.02, 0.1, 0.94, wood); dback.position.set(-0.15, 0.22, 0); drawer.add(dback);
    const ncv = document.createElement('canvas'); ncv.width = 512; ncv.height = 300;
    const cardTex = new THREE.CanvasTexture(ncv); cardTex.colorSpace = THREE.SRGBColorSpace; cardTex.anisotropy = 8;
    const drawCard = (img) => {
      const g = ncv.getContext('2d');
      g.fillStyle = '#fffdf6'; g.fillRect(0, 0, 512, 300);
      g.fillStyle = '#22305a'; g.fillRect(0, 0, 512, 14);
      if (img) { g.save(); g.beginPath(); g.arc(96, 150, 70, 0, Math.PI * 2); g.clip(); g.drawImage(img, 26, 80, 140, 140); g.restore(); }
      g.strokeStyle = '#22305a'; g.lineWidth = 4; g.beginPath(); g.arc(96, 150, 70, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#22305a'; g.font = '900 46px Inter, system-ui, sans-serif'; g.fillText('Alex Wang', 190, 140);
      g.font = '600 26px Inter, system-ui, sans-serif'; g.fillStyle = '#4b5878'; g.fillText('PhD student · CMU HCII', 190, 182);
      g.font = '700 20px "Roboto Mono", monospace'; g.fillStyle = '#2f6fde'; g.fillText('click to read', 190, 228);
      cardTex.needsUpdate = true;
    };
    drawCard(null);
    { const im = new Image(); im.onload = () => drawCard(im); im.src = 'img/story/alex.jpg'; }
    const ncard = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.246), new THREE.MeshBasicMaterial({ map: cardTex, toneMapped: false, side: THREE.DoubleSide }));
    // lying flat on the drawer floor, top edge toward the back, so it reads from the room
    ncard.rotation.set(-Math.PI / 2, 0, 0);
    // lean the card back so it reads from the room
    const cardHolder = new THREE.Group(); cardHolder.position.set(0.03, 0.19, 0); cardHolder.rotation.y = Math.PI / 2; cardHolder.add(ncard); drawer.add(cardHolder);
    ncard.userData.hoverRoot = ncard; ncard.userData.hover = 'namecard';
    drawer.traverse((o) => { if (o.isMesh && o !== ncard) o.userData.hoverRoot = drawer; });
    drawer.userData = { hover: 'drawer', open: 0, target: 0 };
    shelfG.add(drawer);
    this.drawer = drawer; this.nameCard = ncard; this.cardHolder = cardHolder;
    this.hoverables.push(drawer); this.hoverables.push(ncard);
    S.add(shelfG);

    // plant
    const plant = new THREE.Group(); plant.position.set(2.55, 0, -2.2);
    const pot = curved(new THREE.CylinderGeometry(0.2, 0.15, 0.36, 22), halftone({ base: 0.12, range: 0.35 })); pot.position.y = 0.18; plant.add(pot);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2, tilt = 0.5 + (i % 3) * 0.2;
      const leaf = curved(new THREE.SphereGeometry(0.16, 12, 8).scale(0.35, 1, 0.08), halftone({ paper: '#eef8f1', base: 0.15, range: 0.4 }), 0.008);
      leaf.position.set(Math.cos(a) * 0.13, 0.55 + (i % 3) * 0.08, Math.sin(a) * 0.13);
      leaf.rotation.set(Math.sin(a) * tilt, a, -Math.cos(a) * tilt);
      plant.add(leaf);
    }
    S.add(plant);

    // workout corner: mat + barbell on the floor
    const mat = box(0.7, 0.012, 1.8, halftone({ paper: '#eef2fd', base: 0.2, range: 0.05, cell: 3.4 }));
    mat.position.set(1.65, 0.006, 0.55); S.add(mat);
    const bar = new THREE.Group();
    const rod = curved(new THREE.CylinderGeometry(0.014, 0.014, 1.5, 10).rotateZ(Math.PI / 2), dark, 0.004); bar.add(rod);
    for (const s of [-1, 1]) {
      const plate = curved(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 28).rotateZ(Math.PI / 2), halftone({ base: 0.5, range: 0.3 }), 0.006);
      plate.position.x = s * 0.6; bar.add(plate);
    }
    bar.position.set(1.65, 0.17, 1.25); S.add(bar);
    this.bar = bar;

    // the person
    this.normal = buildPerson();
    this.buffRig = buildBuffPerson();
    this.person = this.normal;
    this.normal.root.position.set(-0.3, 0, -1.85);
    S.add(this.normal.root);
    this.buffRig.root.visible = false;
    S.add(this.buffRig.root);
    this.pose = { ...POSES.sit };
    this.applyPose(this.pose);
  }

  // Muscle growth: level 0..1 thickens chest, shoulders and arms; ripped swaps the leather
  // jacket for bare skin with pecs and abs.
  // Muscle growth, comically: level 0..1 inflates chest, traps, shoulders, arms and neck while the
  // head stays the same size. Ripped swaps the leather for bare skin with pecs and abs.
  setBuff(level, ripped) {
    const P = this.normal, L = Math.min(level, 0.6);
    P.chest.scale.set(1.08 + L * 0.6, 1.18 + L * 0.2, 0.7 + L * 0.35);
    P.traps.scale.set(1 + L, 1 + L, 0.6 + L * 0.4);
    P.neckSeg.scale.set(1 + L * 0.6, 1, 1 + L * 0.6);
    for (const sh of P.shoulders) sh.scale.setScalar(1 + L * 1.2);
    for (const seg of P.upperArms) seg.scale.set(1 + L * 1.3, 1, 1 + L * 1.3);
    for (const seg of P.forearms) seg.scale.set(1 + L * 0.9, 1, 1 + L * 0.9);
    const want = ripped ? this.buffRig : this.normal;
    if (this.person !== want) {
      want.root.position.copy(this.person.root.position); want.root.rotation.copy(this.person.root.rotation);
      this.person.root.visible = false; want.root.visible = true; this.person = want;
      this.applyPose(this.pose);
    }
  }

  // Leather shreds: burst off the torso and come to rest on the floor (or appear already there).
  ripJacket(animate) {
    const leather = this.normal.leather;
    const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(0.13, 0.02); shape.lineTo(0.09, 0.1); shape.lineTo(0.02, 0.12); shape.lineTo(-0.03, 0.05);
    const geom = new THREE.ExtrudeGeometry(shape, { depth: 0.008, bevelEnabled: false }).center();
    const origin = this.normal.torso.localToWorld(new THREE.Vector3(0, 0.3, 0));
    const rnd = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    this.shards = this.shards || [];
    for (let i = 0; i < 16; i++) {
      const g = solid(geom, leather, { edges: 30 });
      g.scale.setScalar(0.8 + rnd(i, 1) * 0.9);
      const a = rnd(i, 2) * Math.PI * 2;
      if (animate) {
        g.position.copy(origin).add(new THREE.Vector3(Math.cos(a) * 0.12, (rnd(i, 3) - 0.3) * 0.3, Math.sin(a) * 0.1));
        g.userData.v = new THREE.Vector3(Math.cos(a) * (1.2 + rnd(i, 4) * 1.8), 1.6 + rnd(i, 5) * 2.2, Math.sin(a) * (1.2 + rnd(i, 4) * 1.8));
        g.userData.spin = new THREE.Vector3(rnd(i, 6) * 14 - 7, rnd(i, 7) * 14 - 7, rnd(i, 8) * 14 - 7);
      } else {
        const r = 0.35 + rnd(i, 9) * 0.6;
        g.position.set(1.65 + Math.cos(a) * r, 0.006, 0.55 + Math.sin(a) * r * 1.3);
        g.rotation.set(-Math.PI / 2, 0, rnd(i, 10) * 6.28);
      }
      this.scene.add(g); this.shards.push(g);
    }
  }
  updateShards(dt) {
    for (const g of this.shards || []) {
      const v = g.userData.v; if (!v) continue;
      v.y -= 9.8 * dt;
      g.position.addScaledVector(v, dt);
      g.rotation.x += g.userData.spin.x * dt; g.rotation.y += g.userData.spin.y * dt; g.rotation.z += g.userData.spin.z * dt;
      // stay inside the room
      g.position.x = Math.max(-3.0, Math.min(3.0, g.position.x)); g.position.z = Math.max(-2.5, Math.min(2.5, g.position.z));
      if (g.position.y <= 0.006) { g.position.y = 0.006; g.rotation.set(-Math.PI / 2, 0, g.rotation.z); g.userData.v = null; }
    }
  }

  applyPose(p) {
    const P = this.person;
    P.hips.position.y = p.y;
    P.torso.rotation.x = p.torso;
    P.neck.rotation.x = p.neck;
    for (const k of ['lSh', 'rSh', 'lEl', 'rEl', 'lHip', 'rHip', 'lKnee', 'rKnee']) P[k].rotation.set(...p[k]);
  }

  // ---------------------------------------------------------------- camera
  setShot(s, instant = false) {
    // phones are tall and narrow: pull back so the room's width (and David) fits
    if (this.w && this.w < 700) s = { ...s, dist: s.dist * Math.min(1.9, 1 + (700 - this.w) / 420) };
    this.shot = { target: new THREE.Vector3(...s.target), yaw: s.yaw, pitch: s.pitch, dist: s.dist };
    this.user.yaw *= 0.3; this.user.pitch *= 0.3;
    if (instant) { this.cam = { target: this.shot.target.clone(), yaw: s.yaw, pitch: s.pitch, dist: s.dist }; }
  }
  bindInput() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left; this.pointer.y = e.clientY - r.top;
      this.pointer.nx = (this.pointer.x / r.width) * 2 - 1; this.pointer.ny = (this.pointer.y / r.height) * 2 - 1;
      this.pointer.inside = true;
      if (drag) {
        this.user.yaw = drag.yaw - (e.clientX - drag.x) * 0.006;
        this.user.pitch = Math.max(-0.25, Math.min(0.5, drag.pitch + (e.clientY - drag.y) * 0.004));
      }
    });
    c.addEventListener('pointerleave', () => { this.pointer.inside = false; });
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw: this.user.yaw, pitch: this.user.pitch }; c.setPointerCapture(e.pointerId); c.classList.add('grabbing'); });
    c.addEventListener('pointerup', () => { drag = null; c.classList.remove('grabbing'); });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.user.zoom = Math.max(0.6, Math.min(1.4, this.user.zoom * (1 + e.deltaY * 0.001))); }, { passive: false });
  }
  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / Math.max(1, r.height);
    this.applyOffset();
    this.w = r.width; this.h = r.height;
    this.applyOffset();
  }

  // Frame shift: keep the room above the dialogue box, and slide it right when the centre card
  // (on the left) is open so it never covers the character.
  applyOffset() {
    const sx = this.shiftX || 0;
    // narrow screens: the card covers the top and the dialogue the bottom, so frame the room
    // a little lower and a little wider
    const narrow = this.w < 700, cardOn = !!document.querySelector('.vizcard.on');
    this.camera.setViewOffset(this.w, this.h, -sx * this.w, this.h * (narrow ? (cardOn ? -0.06 : 0.04) : 0.1), this.w, this.h);
    this.camera.updateProjectionMatrix();
  }

  hoverTarget() {
    if (!this.pointer.inside) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(this.pointer.nx, -this.pointer.ny), this.camera);
    const meshes = [];
    for (const h of this.hoverables) h.traverse((o) => { if (o.isMesh && o.material !== HULL) meshes.push(o); });
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? hit.object.userData.hoverRoot || null : null;
  }

  // Screen position of a world point (for HTML labels).
  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, behind: p.z > 1 };
  }

  frame(dt, t) {
    // ease toward the shot
    const k = 1 - Math.exp(-dt * 2.2);
    this.cam.target.lerp(this.shot.target, k);
    this.cam.yaw += (this.shot.yaw - this.cam.yaw) * k;
    this.cam.pitch += (this.shot.pitch - this.cam.pitch) * k;
    this.cam.dist += (this.shot.dist - this.cam.dist) * k;
    // pointer parallax + user drag
    const par = this.pointer.inside ? 1 : 0;
    this.parallax = this.parallax || { x: 0, y: 0 };
    this.parallax.x += ((this.pointer.nx || 0) * par - this.parallax.x) * (1 - Math.exp(-dt * 3));
    this.parallax.y += ((this.pointer.ny || 0) * par - this.parallax.y) * (1 - Math.exp(-dt * 3));
    const yaw = this.cam.yaw + this.user.yaw + this.parallax.x * 0.07;
    const pitch = this.cam.pitch + this.user.pitch + this.parallax.y * 0.035;
    const dist = this.cam.dist * this.user.zoom;
    const tg = this.cam.target;
    this.camera.position.set(tg.x + Math.sin(yaw) * Math.cos(pitch) * dist, tg.y + Math.sin(pitch) * dist, tg.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 1.6);
      const s = this.shake * 0.03;
      this.camera.position.x += Math.sin(t * 61) * s; this.camera.position.y += Math.cos(t * 53) * s;
    }
    this.camera.lookAt(tg);
    const want = this.focusShift || 0;
    if (Math.abs((this.shiftX || 0) - want) > 1e-4) { this.shiftX = (this.shiftX || 0) + (want - (this.shiftX || 0)) * (1 - Math.exp(-dt * 3)); this.applyOffset(); }
    this.renderer.render(this.scene, this.camera);
  }
}
