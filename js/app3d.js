// ══════════════════════════════════════════════════════════════
// bread for myself — app3d.js
// Three.js r128 による 3D 製パン化学ネットワーク
// ══════════════════════════════════════════════════════════════

// ─── 定数 ────────────────────────────────────────────────────
const STEP_COLORS = {
  raw:            0x6b7280,
  mixing:         0x4a9eff,
  fermentation_1: 0xa8e053,
  dividing:       0x53b5e8,
  bench:          0x53e8b5,
  shaping:        0xc853e8,
  proof:          0xe8b553,
  baking:         0xe85353,
  final:          0xff9f53,
};
const STEP_COLORS_CSS = {
  raw:            '#6b7280',
  mixing:         '#4a9eff',
  fermentation_1: '#a8e053',
  dividing:       '#53b5e8',
  bench:          '#53e8b5',
  shaping:        '#c853e8',
  proof:          '#e8b553',
  baking:         '#e85353',
  final:          '#ff9f53',
};
const STEP_LABELS = {
  raw:'原材料', mixing:'ミキシング', fermentation_1:'一次発酵',
  dividing:'分割', bench:'ベンチ', shaping:'成形',
  proof:'ホイロ', baking:'焼成', final:'最終生成物',
};

// 工程順（Y軸 = 時間軸）
const STEP_ORDER = ['raw','mixing','fermentation_1','dividing','bench','shaping','proof','baking','final'];

// 各工程のY座標（上から下へ）
const STEP_Y = {
  raw:            200,
  mixing:          70,
  fermentation_1: -50,
  dividing:      -140,
  bench:         -220,
  shaping:       -300,
  proof:         -390,
  baking:        -510,
  final:         -640,
};

// 各工程のXZ半径（工程ごとに円柱状に配置）
const STEP_RADIUS = {
  raw: 280, mixing: 220, fermentation_1: 180,
  dividing: 140, bench: 150, shaping: 140,
  proof: 170, baking: 240, final: 200,
};

// ─── 状態 ────────────────────────────────────────────────────
let DATA       = null;
let SCENE_OBJ  = null;   // { scene, camera, renderer, controls, … }
let allMeshes  = [];     // { mesh, node, type }
let lineMeshes = [];     // { line, edge }
let nodeMap    = {};     // id → allMeshes entry
let selectedId = null;
let traceSet   = null;   // null | Set of highlighted IDs
let autoRotate = false;
let activeStep = 'all';
let activeFilter = 'all';
let searchQuery  = '';

// Adjacency for full-chain tracing
let childrenMap  = {};  // id → [id, …]
let parentsMap   = {};  // id → [id, …]

// ─── データ読み込み ──────────────────────────────────────────
fetch('data/graph_data.json')
  .then(r => r.json())
  .then(d => {
    DATA = d;
    document.getElementById('stat-sub').textContent   = d.meta.substance_count;
    document.getElementById('stat-rxn').textContent   = d.meta.reaction_count;
    document.getElementById('stat-edge').textContent  = d.meta.edge_count;
    document.getElementById('stat-param').textContent = d.meta.param_count;

    buildAdjacency();
    initScene();
    buildGraph();
    initUI();
    initNav();
    animate();
  });

// ─── 隣接マップ（全チェーントレース用）─────────────────────
function buildAdjacency() {
  DATA.edges.forEach(e => {
    (childrenMap[e.source] = childrenMap[e.source] || []).push(e.target);
    (parentsMap[e.target]  = parentsMap[e.target]  || []).push(e.source);
  });
}

// BFS で全子孫
function getAllDescendants(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    (childrenMap[cur] || []).forEach(c => { if (!visited.has(c)) queue.push(c); });
  }
  return visited;
}

// BFS で全祖先
function getAllAncestors(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    (parentsMap[cur] || []).forEach(p => { if (!visited.has(p)) queue.push(p); });
  }
  return visited;
}

// ─── 物質バンド推定 ──────────────────────────────────────────
function inferBand(n) {
  // 生成している反応のステップ
  const producedBy = DATA.edges
    .filter(e => e.source !== n.id && e.target === n.id && e.type === 'product')
    .map(e => {
      const rxn = DATA.reactions.find(r => r.id === e.source);
      return rxn ? rxn.step : null;
    }).filter(Boolean);

  if (producedBy.length) {
    for (const s of STEP_ORDER) if (producedBy.includes(s)) return s;
  }

  const tsv = n.tsv_ids || [];
  if (tsv.some(t => String(t).startsWith('11-'))) return 'final';
  if (tsv.some(t => String(t).startsWith('9-')))  return 'proof';
  if (tsv.some(t => String(t).startsWith('7-')))  return 'shaping';
  if (tsv.some(t => String(t).startsWith('5-')))  return 'fermentation_1';
  if (tsv.some(t => String(t).startsWith('3-')))  return 'mixing';

  const consumedBy = DATA.edges
    .filter(e => e.source === n.id && e.type === 'substrate')
    .map(e => {
      const rxn = DATA.reactions.find(r => r.id === e.target);
      return rxn ? rxn.step : null;
    }).filter(Boolean);

  if (consumedBy.length) {
    const idx = STEP_ORDER.indexOf(consumedBy[0]);
    return STEP_ORDER[Math.max(0, idx - 1)];
  }
  return 'raw';
}

// ─── Three.js シーン初期化 ───────────────────────────────────
function initScene() {
  const canvas = document.getElementById('canvas');
  const W = window.innerWidth;
  const H = window.innerHeight;

  // Scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070a08);
  scene.fog = new THREE.FogExp2(0x070a08, 0.0008);

  // Camera
  const camera = new THREE.PerspectiveCamera(50, W / H, 1, 8000);
  camera.position.set(0, 200, 900);

  // Renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.shadowMap.enabled = false;

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir1 = new THREE.DirectionalLight(0xa8e080, 1.1);
  dir1.position.set(300, 600, 400);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x4080ff, 0.5);
  dir2.position.set(-400, -200, -300);
  scene.add(dir2);
  const point = new THREE.PointLight(0xe0b060, 0.6, 2000);
  point.position.set(0, 300, 0);
  scene.add(point);

  // Orbit-like controls (manual implementation for r128 without OrbitControls import)
  const controls = createOrbitControls(camera, canvas);

  // Raycaster
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 5;

  // Resize
  window.addEventListener('resize', () => {
    const W2 = window.innerWidth, H2 = window.innerHeight;
    camera.aspect = W2 / H2;
    camera.updateProjectionMatrix();
    renderer.setSize(W2, H2);
  });

  SCENE_OBJ = { scene, camera, renderer, controls, raycaster };

  // Click / hover
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasHover);
}

// ─── 簡易 OrbitControls ──────────────────────────────────────
function createOrbitControls(camera, canvas) {
  const state = {
    isDragging: false, isRightDrag: false,
    prevX: 0, prevY: 0,
    spherical: { theta: 0, phi: Math.PI / 3, radius: 900 },
    target: new THREE.Vector3(0, -200, 0),
  };

  function updateCamera() {
    const { theta, phi, radius } = state.spherical;
    const sinPhi = Math.sin(phi);
    camera.position.set(
      state.target.x + radius * sinPhi * Math.sin(theta),
      state.target.y + radius * Math.cos(phi),
      state.target.z + radius * sinPhi * Math.cos(theta)
    );
    camera.lookAt(state.target);
  }
  updateCamera();

  canvas.addEventListener('mousedown', e => {
    state.isDragging   = true;
    state.isRightDrag  = e.button === 2;
    state.prevX = e.clientX;
    state.prevY = e.clientY;
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mousemove', e => {
    if (!state.isDragging) return;
    const dx = e.clientX - state.prevX;
    const dy = e.clientY - state.prevY;
    state.prevX = e.clientX; state.prevY = e.clientY;
    if (state.isRightDrag) {
      // Pan
      const right = new THREE.Vector3();
      const up    = new THREE.Vector3();
      camera.getWorldDirection(new THREE.Vector3());
      right.crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize();
      up.copy(camera.up).normalize();
      state.target.addScaledVector(right, -dx * 0.8);
      state.target.addScaledVector(up,     dy * 0.8);
    } else {
      // Rotate
      state.spherical.theta -= dx * 0.005;
      state.spherical.phi   = Math.max(0.1, Math.min(Math.PI - 0.1, state.spherical.phi + dy * 0.005));
    }
    updateCamera();
  });
  window.addEventListener('mouseup', () => { state.isDragging = false; });
  canvas.addEventListener('wheel', e => {
    state.spherical.radius = Math.max(100, Math.min(3000, state.spherical.radius + e.deltaY * 0.5));
    updateCamera();
    e.preventDefault();
  }, { passive: false });

  // Touch support
  let lastTouchDist = 0;
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      state.isDragging = true; state.isRightDrag = false;
      state.prevX = e.touches[0].clientX; state.prevY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && state.isDragging) {
      const dx = e.touches[0].clientX - state.prevX;
      const dy = e.touches[0].clientY - state.prevY;
      state.prevX = e.touches[0].clientX; state.prevY = e.touches[0].clientY;
      state.spherical.theta -= dx * 0.006;
      state.spherical.phi   = Math.max(0.1, Math.min(Math.PI - 0.1, state.spherical.phi + dy * 0.006));
      updateCamera();
    } else if (e.touches.length === 2) {
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      state.spherical.radius = Math.max(100, Math.min(3000, state.spherical.radius - (d - lastTouchDist) * 1.5));
      lastTouchDist = d;
      updateCamera();
    }
  }, { passive: false });
  canvas.addEventListener('touchend', () => { state.isDragging = false; });

  return { state, updateCamera };
}

// ─── グラフ構築 ──────────────────────────────────────────────
function buildGraph() {
  const { scene } = SCENE_OBJ;

  allMeshes  = [];
  lineMeshes = [];
  nodeMap    = {};

  // ── 工程リング表示（半透明の輪） ──────────────────────────
  STEP_ORDER.forEach(step => {
    const r = STEP_RADIUS[step] || 200;
    const y = STEP_Y[step] || 0;
    const color = STEP_COLORS[step] || 0x444444;

    // 薄い円柱リング
    const ringGeo = new THREE.TorusGeometry(r, 1.5, 8, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = y;
    ring.rotation.x = Math.PI / 2;
    scene.add(ring);

    // 水平グリッド線（薄い）
    const pts = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.08 });
    scene.add(new THREE.Line(lineGeo, lineMat));
  });

  // 中央縦軸
  const axisGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 300, 0),
    new THREE.Vector3(0, -700, 0)
  ]);
  scene.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: 0x334433, transparent: true, opacity: 0.3 })));

  // ── 物質ノード（球） ────────────────────────────────────────
  const bandCounts = {};
  const assignedBands = {};
  DATA.nodes.forEach(n => {
    const band = inferBand(n);
    assignedBands[n.id] = band;
    bandCounts[band] = (bandCounts[band] || 0) + 1;
  });
  const bandIdx = {};

  DATA.nodes.forEach(n => {
    const band  = assignedBands[n.id];
    const idx   = (bandIdx[band] = (bandIdx[band] || 0));
    const total = bandCounts[band] || 1;
    const r     = STEP_RADIUS[band] || 200;
    const y     = STEP_Y[band] || 0;

    // XZ: 均等に円弧配置＋わずかなランダムオフセット
    const angle = (idx / total) * Math.PI * 2;
    const rJitter = r + (seededRandom(n.id) - 0.5) * r * 0.3;
    const x = Math.cos(angle) * rJitter;
    const z = Math.sin(angle) * rJitter;
    const yJitter = y + (seededRandom(n.id + 'y') - 0.5) * 40;

    bandIdx[band]++;

    const isVolatile = n.is_volatile;
    const radius3d   = isVolatile ? 7 : n.reaction_roles?.length > 3 ? 6 : 4.5;
    const color      = STEP_COLORS[band] || 0x4a8060;

    // ── Phong sphere ──
    const geo = new THREE.SphereGeometry(radius3d, 16, 12);
    const mat = new THREE.MeshPhongMaterial({
      color,
      emissive: color,
      emissiveIntensity: isVolatile ? 0.35 : 0.08,
      shininess: isVolatile ? 90 : 40,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, yJitter, z);
    mesh.userData = { id: n.id, type: 'substance', node: n, band, originalColor: color };
    scene.add(mesh);

    // 香気物質：外周リング
    if (isVolatile) {
      const ringG = new THREE.TorusGeometry(radius3d + 4, 0.7, 6, 24);
      const ringM = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 });
      const ringMesh = new THREE.Mesh(ringG, ringM);
      ringMesh.position.copy(mesh.position);
      ringMesh.rotation.x = Math.random() * Math.PI;
      scene.add(ringMesh);
    }

    const entry = { mesh, node: n, type: 'substance', band };
    allMeshes.push(entry);
    nodeMap[n.id] = entry;
  });

  // ── 反応ノード（八面体） ────────────────────────────────────
  const rxnBandCounts = {};
  DATA.reactions.forEach(r => rxnBandCounts[r.step] = (rxnBandCounts[r.step] || 0) + 1);
  const rxnBandIdx = {};

  DATA.reactions.forEach(r => {
    const band  = r.step;
    const idx   = (rxnBandIdx[band] = (rxnBandIdx[band] || 0));
    const total = rxnBandCounts[band] || 1;
    const radius3d = STEP_RADIUS[band] || 200;
    const y     = STEP_Y[band] || 0;

    // 反応は少し内側に配置
    const angle = (idx / total) * Math.PI * 2 + Math.PI / total;
    const rr    = radius3d * 0.55;
    const x     = Math.cos(angle) * rr;
    const z     = Math.sin(angle) * rr;
    rxnBandIdx[band]++;

    const color = STEP_COLORS[band] || 0x666666;
    const geo   = new THREE.OctahedronGeometry(9, 0);
    const mat   = new THREE.MeshPhongMaterial({
      color, emissive: color, emissiveIntensity: 0.25,
      shininess: 80, transparent: true, opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.userData = { id: r.id, type: 'reaction', node: r, band, originalColor: color };
    scene.add(mesh);

    const entry = { mesh, node: r, type: 'reaction', band };
    allMeshes.push(entry);
    nodeMap[r.id] = entry;
  });

  // ── エッジ（ライン） ─────────────────────────────────────
  DATA.edges.forEach(e => {
    const srcEntry = nodeMap[e.source];
    const tgtEntry = nodeMap[e.target];
    if (!srcEntry || !tgtEntry) return;

    const srcPos = srcEntry.mesh.position;
    const tgtPos = tgtEntry.mesh.position;

    const pts = [srcPos.clone(), tgtPos.clone()];
    const geo  = new THREE.BufferGeometry().setFromPoints(pts);

    const col = e.is_extinct ? 0x553333 : e.type === 'product' ? 0x2a5540 : 0x263832;
    const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 });
    const line = new THREE.Line(geo, mat);
    SCENE_OBJ.scene.add(line);
    lineMeshes.push({ line, edge: e, mat, originalColor: col });
  });
}

// ─── シード乱数（IDベースで再現性ある配置） ────────────────
function seededRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  h = (h ^ (h >>> 16)) * 0x45d9f3b | 0;
  h = (h ^ (h >>> 16)) * 0x45d9f3b | 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 0xFFFFFFFF);
}

// ─── クリック処理 ─────────────────────────────────────────
let _clickMoved = false;
let _mouseDownPos = { x: 0, y: 0 };
document.getElementById('canvas').addEventListener('mousedown', e => {
  _clickMoved = false;
  _mouseDownPos = { x: e.clientX, y: e.clientY };
});
document.getElementById('canvas').addEventListener('mousemove', e => {
  if (Math.hypot(e.clientX - _mouseDownPos.x, e.clientY - _mouseDownPos.y) > 5) _clickMoved = true;
});

function onCanvasClick(e) {
  if (_clickMoved) return;
  const hit = raycast(e);
  if (!hit) {
    clearSelection();
    return;
  }
  const { id, type, node } = hit.object.userData;
  selectNode(id, node, type);
}

let _hoveredId = null;
function onCanvasHover(e) {
  const hit = raycast(e);
  if (hit) {
    const { id, node } = hit.object.userData;
    if (id !== _hoveredId) {
      _hoveredId = id;
      showTooltip(e, node, hit.object.userData.type);
    } else {
      moveTooltip(e);
    }
    document.getElementById('canvas').style.cursor = 'pointer';
  } else {
    _hoveredId = null;
    hideTooltip();
    document.getElementById('canvas').style.cursor = 'default';
  }
}

function raycast(e) {
  const { camera, raycaster } = SCENE_OBJ;
  const rect = document.getElementById('canvas').getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    ((e.clientY - rect.top)  / rect.height) * -2 + 1
  );
  raycaster.setFromCamera(mouse, camera);
  const meshes = allMeshes.map(m => m.mesh);
  const hits   = raycaster.intersectObjects(meshes);
  return hits.length ? hits[0] : null;
}

// ─── ノード選択 ───────────────────────────────────────────
function selectNode(id, node, type) {
  selectedId = id;

  // トレース方向を決定
  // raw / mixing → 下流トレース（全子孫）
  // final / baking → 上流トレース（全祖先）
  // それ以外 → 両方向（前後2ホップ）
  const entry = nodeMap[id];
  const band  = entry?.band || 'raw';
  let traceIds;

  if (['raw', 'mixing'].includes(band)) {
    // 下流（子孫）全体
    traceIds = getAllDescendants(id);
    showTraceBar(`▼ ${node.name || id} から下流 ${traceIds.size} ノードをトレース`);
  } else if (['baking', 'final'].includes(band)) {
    // 上流（祖先）全体
    traceIds = getAllAncestors(id);
    showTraceBar(`▲ ${node.name || id} の上流 ${traceIds.size} ノードをトレース`);
  } else {
    // 前後2ホップ（反応経由）
    traceIds = getNeighbors2(id);
    showTraceBar(`◎ ${node.name || id} の関連 ${traceIds.size} ノード`);
  }

  traceSet = traceIds;
  applyHighlight();
  updateDetailPanel(node, type, band);
}

// 前後2ホップ
function getNeighbors2(id) {
  const s = new Set([id]);
  DATA.edges.forEach(e => {
    if (e.source !== id && e.target !== id) return;
    s.add(e.source); s.add(e.target);
    const other = e.source === id ? e.target : e.source;
    DATA.edges.forEach(e2 => {
      if (e2.source === other || e2.target === other) { s.add(e2.source); s.add(e2.target); }
    });
  });
  return s;
}

function clearSelection() {
  selectedId = null; traceSet = null;
  hideTraceBar();
  applyHighlight();
  updateDetailPanel(null);
}

// ─── ハイライト ───────────────────────────────────────────
function applyHighlight() {
  allMeshes.forEach(({ mesh, node }) => {
    const id  = mesh.userData.id;
    const col = mesh.userData.originalColor;
    const isSelected = id === selectedId;
    const inTrace    = traceSet ? traceSet.has(id) : true;
    const visible    = isVisible(mesh.userData);

    if (!visible) {
      mesh.material.opacity = 0.03;
      mesh.material.emissiveIntensity = 0;
      return;
    }

    if (!inTrace && traceSet) {
      mesh.material.opacity = 0.04;
      mesh.material.emissiveIntensity = 0;
    } else if (isSelected) {
      mesh.material.color.setHex(0xffffff);
      mesh.material.emissive.setHex(0xffffff);
      mesh.material.emissiveIntensity = 0.6;
      mesh.material.opacity = 1;
      // スケールでパルス（選択時）
      mesh.scale.setScalar(1.5);
    } else {
      mesh.material.color.setHex(col);
      mesh.material.emissive.setHex(col);
      mesh.material.emissiveIntensity = mesh.userData.type === 'substance' && mesh.userData.node?.is_volatile ? 0.35 : 0.12;
      mesh.material.opacity = 1;
      mesh.scale.setScalar(1);
    }
  });

  lineMeshes.forEach(({ line, edge, mat, originalColor }) => {
    const s = edge.source, t = edge.target;
    if (traceSet) {
      const both = traceSet.has(s) && traceSet.has(t);
      mat.opacity  = both ? 0.9 : 0.02;
      mat.color.setHex(both ? (edge.type === 'product' ? 0xa8e053 : 0x4a9eff) : originalColor);
      line.material.linewidth = both ? 3 : 1;
    } else {
      mat.opacity = 0.3;
      mat.color.setHex(originalColor);
    }
  });
}

function isVisible(userData) {
  const id   = userData.id;
  const type = userData.type;
  const band = userData.band;

  if (activeStep !== 'all' && type === 'reaction' && band !== activeStep) return false;
  if (activeStep !== 'all' && type === 'substance') {
    // その工程に属する反応につながっているか
    const connected = DATA.edges.some(e => {
      const rxn = DATA.reactions.find(r =>
        (r.id === e.source || r.id === e.target) && r.step === activeStep
      );
      return rxn && (e.source === id || e.target === id);
    });
    if (!connected) return false;
  }

  if (activeFilter === 'volatile' && type === 'substance' && !userData.node?.is_volatile) return false;
  if (activeFilter === 'reactions' && type === 'substance') return false;

  if (searchQuery) {
    const n = userData.node;
    const hit = (n?.name || '').toLowerCase().includes(searchQuery)
             || (n?.formula || '').toLowerCase().includes(searchQuery)
             || (id || '').toLowerCase().includes(searchQuery);
    if (!hit) return false;
  }
  return true;
}

// ─── アニメーションループ ─────────────────────────────────
let _frame = 0;
function animate() {
  requestAnimationFrame(animate);
  _frame++;

  // 自動回転
  if (autoRotate && SCENE_OBJ) {
    SCENE_OBJ.controls.state.spherical.theta += 0.003;
    SCENE_OBJ.controls.updateCamera();
  }

  // 選択ノードパルス
  if (selectedId) {
    const entry = nodeMap[selectedId];
    if (entry) {
      const s = 1.4 + Math.sin(_frame * 0.08) * 0.15;
      entry.mesh.scale.setScalar(s);
    }
  }

  SCENE_OBJ.renderer.render(SCENE_OBJ.scene, SCENE_OBJ.camera);
}

// ─── トレースバー ─────────────────────────────────────────
function showTraceBar(msg) {
  document.getElementById('trace-info').textContent = msg;
  document.getElementById('trace-bar').classList.add('visible');
}
function hideTraceBar() { document.getElementById('trace-bar').classList.remove('visible'); }
document.getElementById('trace-close').addEventListener('click', clearSelection);

// ─── ツールチップ ─────────────────────────────────────────
function showTooltip(e, node, type) {
  document.getElementById('tt-name').textContent = node?.name || node?.id || '?';
  const sub = type === 'reaction'
    ? `${STEP_LABELS[node?.step] || node?.step}  ·  ${(node?.equation || '').slice(0, 55)}`
    : `${node?.formula || ''}  ${node?.is_volatile ? '[ 香気物質 ]' : ''}`;
  document.getElementById('tt-sub').textContent = sub.trim();
  document.getElementById('tooltip').style.opacity = '1';
  moveTooltip(e);
}
function moveTooltip(e) {
  const tt = document.getElementById('tooltip');
  tt.style.left = Math.min(e.clientX + 14, window.innerWidth - 230) + 'px';
  tt.style.top  = Math.max(e.clientY - 32, 10) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').style.opacity = '0'; }

// ─── 詳細パネル ───────────────────────────────────────────
function updateDetailPanel(node, type, band) {
  const panel = document.getElementById('detail-panel');
  if (!node) {
    panel.innerHTML = `<div class="detail-empty">
      球をクリックすると詳細表示。<br><br>
      <b style="color:var(--text2)">トレース機能：</b><br>
      原材料 → クリックで下流▼<br>
      最終生成物 → クリックで上流▲<br><br>
      <b style="color:var(--text2)">操作：</b><br>
      ドラッグ → 回転<br>
      ホイール → ズーム<br>
      右ドラッグ → パン
    </div>`;
    return;
  }
  type === 'reaction' ? renderRxnDetail(panel, node, band) : renderSubDetail(panel, node, band);
}

function renderSubDetail(panel, n, band) {
  const sa     = n.snapshot || {};
  const stages = ['post_mixing_g','post_fermentation_1_g','post_dividing_bench_shaping_g','post_proof_g','post_baking_g'];
  const stageL = ['ミキシング後','発酵後','成形後','ホイロ後','焼成後'];
  const vals   = stages.map(s => parseFloat(sa[s]) || 0);
  const maxV   = Math.max(...vals, 0.001);
  const bc     = STEP_COLORS_CSS[band] || '#4a8060';

  const snapHTML = vals.some(v => v > 0) ? `
    <div class="detail-section">
      <div class="detail-section-title">工程別含量</div>
      <div class="snap-bar-wrap">
        ${stages.map((s, i) => {
          const v = sa[s]; if (!v && v !== 0) return '';
          const pct = Math.min(100, (parseFloat(v) || 0) / maxV * 100);
          return `<div class="snap-bar-row">
            <span class="snap-bar-label">${stageL[i]}</span>
            <div class="snap-bar"><div class="snap-bar-fill" style="width:${pct}%;background:${bc}"></div></div>
            <span class="snap-bar-val">${typeof v==='number'?v.toFixed(2):v}g</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const roles = n.reaction_roles || [];
  const downCount = (childrenMap[n.id] || []).length;
  const upCount   = (parentsMap[n.id] || []).length;

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${n.name}</div>
    ${n.formula ? `<div class="detail-formula">${n.formula}</div>` : ''}
    <span class="badge" style="background:${bc};color:#070a08">${STEP_LABELS[band] || band}</span>
    ${n.is_volatile ? `<span style="font-size:9px;color:#e8b553;padding:2px 5px;border:1px solid #e8b553;border-radius:2px;margin-left:4px">★ 香気物質</span>` : ''}
    <div style="margin-top:10px;display:flex;gap:10px">
      <div style="font-size:10px;color:var(--text3)">上流 <span style="color:var(--accent2)">${upCount}</span></div>
      <div style="font-size:10px;color:var(--text3)">下流 <span style="color:var(--accent)">${downCount}</span></div>
    </div>
    ${n.notes?.[0] ? `<div style="font-size:10px;color:var(--text2);margin-top:8px;line-height:1.65;border-left:2px solid ${bc};padding-left:8px">${n.notes[0]}</div>` : ''}
    ${snapHTML}
    ${roles.length ? `
    <div class="detail-section">
      <div class="detail-section-title">反応への関与 (${roles.length})</div>
      ${roles.slice(0,6).map(r=>`
        <div style="display:flex;gap:5px;align-items:center;margin-bottom:3px;font-size:10px">
          <span style="color:${STEP_COLORS_CSS[r.step]||'#53e8b5'};min-width:40px;font-weight:bold">${r.reaction_id}</span>
          <span style="color:${r.consumed?'#e85353':'#53e8b5'}">${r.consumed?'消費':'触媒'}</span>
        </div>`).join('')}
      ${roles.length>6?`<div style="font-size:9px;color:var(--text3)">+${roles.length-6}件</div>`:''}
    </div>` : ''}
  </div>`;
}

function renderRxnDetail(panel, r, band) {
  const color = STEP_COLORS_CSS[r.step] || '#666';

  const subsList = DATA.edges
    .filter(e => e.target === r.id && e.type === 'substrate')
    .map(e => nodeMap[e.source]?.node).filter(Boolean);
  const prodsList = DATA.edges
    .filter(e => e.source === r.id && e.type === 'product')
    .map(e => nodeMap[e.target]?.node).filter(Boolean);

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${r.id}</div>
    <div class="detail-name">${r.name}</div>
    <span class="badge" style="background:${color};color:#070a08">${STEP_LABELS[r.step]||r.step}</span>
    ${r.equation ? `<div style="font-size:10px;color:var(--text2);line-height:1.65;margin:8px 0;border-left:2px solid ${color};padding-left:8px">${r.equation}</div>` : ''}
    ${r.equation_formula ? `<div class="detail-formula" style="font-size:9px;margin-bottom:8px">${r.equation_formula}</div>` : ''}
    ${subsList.length ? `
    <div class="detail-section">
      <div class="detail-section-title">▶ 基質 (${subsList.length})</div>
      ${subsList.slice(0,6).map(s=>`<div style="font-size:10px;color:var(--text2);margin-bottom:2px">● ${s.name}</div>`).join('')}
      ${subsList.length>6?`<div style="font-size:9px;color:var(--text3)">+${subsList.length-6}件</div>`:''}
    </div>` : ''}
    ${prodsList.length ? `
    <div class="detail-section">
      <div class="detail-section-title">✦ 生成物 (${prodsList.length})</div>
      ${prodsList.map(s=>`<div style="font-size:10px;color:${s.is_volatile?'var(--accent3)':'var(--accent2)'};margin-bottom:2px">${s.name}${s.is_volatile?' ★':''}</div>`).join('')}
    </div>` : ''}
  </div>`;
}

// ─── UI 初期化 ────────────────────────────────────────────
function initUI() {
  // step legend
  const legend = document.getElementById('step-legend');
  const stepCounts = {};
  DATA.reactions.forEach(r => stepCounts[r.step] = (stepCounts[r.step]||0)+1);

  const allItem = document.createElement('div');
  allItem.className = 'step-item active'; allItem.dataset.step = 'all';
  allItem.innerHTML = `<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${DATA.reactions.length}</span>`;
  allItem.addEventListener('click', () => { activeStep='all'; applyHighlight(); setStepActive('all'); });
  legend.appendChild(allItem);

  STEP_ORDER.filter(s => s!=='raw'&&s!=='final').forEach(step => {
    const item = document.createElement('div');
    item.className = 'step-item'; item.dataset.step = step;
    item.innerHTML = `<div class="step-dot" style="background:${STEP_COLORS_CSS[step]}"></div><span>${STEP_LABELS[step]}</span><span class="step-count">${stepCounts[step]||0}</span>`;
    item.addEventListener('click', () => { activeStep=step; applyHighlight(); setStepActive(step); });
    legend.appendChild(item);
  });

  function setStepActive(step) {
    document.querySelectorAll('.step-item').forEach(i =>
      i.classList.toggle('active', i.dataset.step === step)
    );
  }

  // volatile filter
  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      applyHighlight();
    })
  );

  // search
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    applyHighlight();
  });

  // controls
  document.getElementById('btn-zoom-in').onclick  = () => {
    SCENE_OBJ.controls.state.spherical.radius = Math.max(100, SCENE_OBJ.controls.state.spherical.radius * 0.7);
    SCENE_OBJ.controls.updateCamera();
  };
  document.getElementById('btn-zoom-out').onclick = () => {
    SCENE_OBJ.controls.state.spherical.radius = Math.min(3000, SCENE_OBJ.controls.state.spherical.radius * 1.4);
    SCENE_OBJ.controls.updateCamera();
  };
  document.getElementById('btn-reset').onclick = () => {
    const s = SCENE_OBJ.controls.state;
    s.spherical = { theta: 0, phi: Math.PI/3, radius: 900 };
    s.target.set(0, -200, 0);
    SCENE_OBJ.controls.updateCamera();
  };
  document.getElementById('btn-rotate').onclick = () => {
    autoRotate = !autoRotate;
    document.getElementById('btn-rotate').style.color = autoRotate ? 'var(--accent)' : '';
    document.getElementById('btn-rotate').style.borderColor = autoRotate ? 'var(--accent)' : '';
  };
}

// ─── ナビゲーション ───────────────────────────────────────
function initNav() {
  // 反応一覧
  initReactionsView();
  initSubstancesView();
  initParamsView();

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      // canvas/sidebar は常時表示（3Dグラフは背後に）
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      if (view !== 'graph') document.getElementById(view + '-view').classList.add('active');
    });
  });
}

// ── 反応一覧 ──────────────────────────────────────────────
function initReactionsView() {
  const fd = document.getElementById('rxn-step-filter');
  const ab = document.createElement('button');
  ab.className='filter-btn active'; ab.textContent='全工程'; ab.dataset.step='all';
  fd.appendChild(ab);
  STEP_ORDER.filter(s=>s!=='raw'&&s!=='final').forEach(step => {
    const b = document.createElement('button');
    b.className='filter-btn'; b.textContent=STEP_LABELS[step]; b.dataset.step=step;
    b.style.borderColor=STEP_COLORS_CSS[step];
    fd.appendChild(b);
  });
  let rxnStep='all';
  fd.addEventListener('click',e=>{
    if(!e.target.classList.contains('filter-btn'))return;
    fd.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    e.target.classList.add('active'); rxnStep=e.target.dataset.step; renderRxnGrid();
  });
  document.getElementById('rxn-search').addEventListener('input',renderRxnGrid);

  function renderRxnGrid(){
    const q=document.getElementById('rxn-search').value.toLowerCase();
    const grid=document.getElementById('rxn-grid'); grid.innerHTML='';
    DATA.reactions
      .filter(r=>rxnStep==='all'||r.step===rxnStep)
      .filter(r=>!q||(r.name||'').toLowerCase().includes(q)||r.id.toLowerCase().includes(q))
      .forEach(r=>{
        const color=STEP_COLORS_CSS[r.step]||'#666';
        const subs=DATA.edges.filter(e=>e.target===r.id).length;
        const prods=DATA.edges.filter(e=>e.source===r.id).length;
        const card=document.createElement('div'); card.className='rxn-card';
        card.style.borderLeftColor=color;
        card.innerHTML=`
          <div><span class="rxn-step-badge" style="background:${color}">${STEP_LABELS[r.step]||r.step}</span></div>
          <div class="rxn-id">${r.id}</div>
          <div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div class="rxn-subs" style="margin-top:7px;font-size:9px">
            <span style="color:var(--text3)">基質 ${subs}</span> → <span style="color:${color}">生成物 ${prods}</span>
          </div>`;
        card.addEventListener('click',()=>{
          document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
          document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
          document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
          const entry=nodeMap[r.id];
          if(entry) selectNode(r.id, r, 'reaction');
        });
        grid.appendChild(card);
      });
  }
  renderRxnGrid();
}

// ── 物質一覧 ──────────────────────────────────────────────
function initSubstancesView(){
  document.getElementById('sub-search').addEventListener('input',e=>renderSubTable(e.target.value.toLowerCase()));
  renderSubTable('');
}
function renderSubTable(q){
  const tbody=document.getElementById('sub-tbody');
  const filtered=DATA.nodes.filter(s=>!q||(s.name||'').toLowerCase().includes(q)||(s.formula||'').toLowerCase().includes(q)||s.id.toLowerCase().includes(q));
  document.getElementById('sub-count-label').textContent=`${filtered.length}/${DATA.nodes.length}件`;
  tbody.innerHTML='';
  filtered.slice(0,300).forEach(s=>{
    const roles=(s.reaction_roles||[]).length;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td style="font-size:9px;color:var(--text3)">${s.id}</td>
      <td style="color:var(--text)">${s.name}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.formula||'—'}</td>
      <td style="font-size:9px;color:#e8b553">${s.is_volatile?'★':'—'}</td>
      <td style="font-size:9px;color:var(--text3)">${s.nutrition_cat||'—'}</td>
      <td style="font-size:9px;color:var(--accent2)">${roles>0?roles:'—'}</td>`;
    tr.addEventListener('click',()=>{
      document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
      document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      selectNode(s.id,s,'substance');
    });
    tbody.appendChild(tr);
  });
  if(filtered.length>300){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:var(--text3);font-size:9px;padding:10px">+${filtered.length-300}件（検索で絞り込み）</td>`;
    tbody.appendChild(tr);
  }
}

// ── パラメーター ──────────────────────────────────────────
function initParamsView(){
  const grid=document.getElementById('params-grid');
  DATA.params.forEach(p=>{
    const card=document.createElement('div'); card.className='param-card';
    const isRange=typeof p.range?.min==='number'&&typeof p.range?.max==='number';
    const min=isRange?p.range.min:0, max=isRange?p.range.max:100;
    const val=typeof p.value==='number'?p.value:(min+max)/2;
    const affects=(p.affects_reactions||[]).slice(0,5);
    card.innerHTML=`
      <div class="param-id">${p.param_id}</div>
      <div class="param-name">${p.name}</div>
      <div class="param-val-row"><span class="param-unit">${p.unit}</span><span class="param-val-display" id="pv-${p.param_id}">${typeof val==='number'?val.toFixed(1):val}</span></div>
      ${isRange?`<input type="range" class="param-slider" min="${min}" max="${max}" value="${Math.max(min,Math.min(max,val))}" step="${(max-min)/100}">
        <div class="param-range">${min}—${max} ${p.unit}</div>`:`<div class="param-range">${JSON.stringify(p.range?.allowed||p.value)}</div>`}
      ${affects.length?`<div class="param-affects-title">影響する反応</div>
        ${affects.map(a=>{const s=a.score||0,pct=s*100,c=s>.8?'#e85353':s>.5?'#e8b553':'#53e8b5';
          return `<div class="affect-row"><span class="affect-rxn">${a.reaction_id}</span><div class="affect-bar"><div class="affect-fill" style="width:${pct}%;background:${c}"></div></div><span class="affect-lbl">${a.sensitivity}</span></div>`;
        }).join('')}`:''}`;
    if(isRange){
      const sl=card.querySelector('.param-slider'),dp=card.querySelector(`#pv-${p.param_id}`);
      sl.addEventListener('input',()=>dp.textContent=parseFloat(sl.value).toFixed(1));
    }
    grid.appendChild(card);
  });
}
