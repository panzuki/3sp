// ══════════════════════════════════════════════════════════════
// bread for myself — app3d.js  (trace_v3)
// Three.js r128 による 3D 製パン化学ネットワーク
// 「工程追跡可能な因果グラフ」対応版
// ══════════════════════════════════════════════════════════════

// ─── 定数 ────────────────────────────────────────────────────
const STEP_COLORS = {
  ingredients:            0x6b7280,
  raw:                    0x6b7280,
  mixing:                 0x4a9eff,
  fermentation_1:         0xa8e053,
  dividing_bench_shaping: 0x53b5e8,
  dividing:               0x53b5e8,
  bench:                  0x53e8b5,
  shaping:                0xc853e8,
  proof:                  0xe8b553,
  baking:                 0xe85353,
  final:                  0xff9f53,
};
const STEP_COLORS_CSS = {
  ingredients:            '#6b7280',
  raw:                    '#6b7280',
  mixing:                 '#4a9eff',
  fermentation_1:         '#a8e053',
  dividing_bench_shaping: '#53b5e8',
  dividing:               '#53b5e8',
  bench:                  '#53e8b5',
  shaping:                '#c853e8',
  proof:                  '#e8b553',
  baking:                 '#e85353',
  final:                  '#ff9f53',
};
const STEP_LABELS = {
  ingredients:            '原材料',
  raw:                    '原材料',
  mixing:                 'ミキシング',
  fermentation_1:         '一次発酵',
  dividing_bench_shaping: '分割・成形',
  dividing:               '分割',
  bench:                  'ベンチ',
  shaping:                '成形',
  proof:                  'ホイロ',
  baking:                 '焼成',
  final:                  '最終生成物',
};

// 工程順（Y軸 = 時間軸）
const STEP_ORDER = ['ingredients','mixing','fermentation_1','dividing_bench_shaping','proof','baking'];

// process_order → Y座標
// node_type 別レイヤー分離: raw_material(top) → substance_instance → reaction
const BASE_Y    = 220;  // ingredients Y
const STAGE_GAP = 180;  // 工程間ギャップ

function getStageY(processOrder) {
  return BASE_Y - processOrder * STAGE_GAP;
}

// node_type ごとのY オフセット（同一工程内で分離）
const TYPE_Y_OFFSET = {
  raw_material:        0,
  substance_instance: -55,
  reaction:            0,   // 反応は中心
};

// XZ 球半径（同工程内の配置用）
const TYPE_RADIUS = {
  raw_material:        420,
  substance_instance:  320,
  reaction:            220,
};

// ─── 状態 ────────────────────────────────────────────────────
let DATA       = null;
let SCENE_OBJ  = null;
let allMeshes  = [];
let lineMeshes = [];
let nodeMap    = {};     // id → { mesh, node, type, stage }
let selectedId = null;
let traceSet   = null;
let autoRotate = false;
let activeStep = 'all';
let activeFilter = 'all';
let searchQuery  = '';

// 隣接マップ（BFS高速化）
let childrenMap = {};
let parentsMap  = {};

// trace_index（JSON済み）
let TRACE_INDEX = {};
let ALIAS_MAP = {};

// ─── データ読み込み ──────────────────────────────────────────
async function loadGraphData() {
  const candidates = [window.GRAPH_DATA_URL, 'data/graph_data.fixed.json', 'data/graph_data.json'].filter(Boolean);
  let lastErr = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return await r.json();
    } catch (err) {
      lastErr = err;
      console.warn('[graph] load failed:', url, err);
    }
  }
  throw lastErr || new Error('graph data not found');
}

function buildAliasMap(d) {
  ALIAS_MAP = {};
  (d.substance_master || []).forEach(m => { if (m.alias_of) ALIAS_MAP[m.master_id] = m.alias_of; });
  (d.nodes || []).forEach(n => { if (n.alias_of) ALIAS_MAP[n.id] = n.alias_of; });
}

loadGraphData()
  .then(d => {
    DATA = d;
    TRACE_INDEX = d.trace_index || {};
    buildAliasMap(d);

    // meta 表示（新フィールド対応）
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
  })
  .catch(err => {
    console.error('[graph] fatal load error', err);
  });

// ─── 隣接マップ ───────────────────────────────────────────────
// edgeBySource: source → edges[]  （全エッジ, type別に参照できる）
// edgeByTarget: target → edges[]
// parentsStrict: stage_carry除外の upstream 用
let edgeBySource = {};   // id → [edge, ...]
let edgeByTarget = {};   // id → [edge, ...]
let parentsStrict = {};  // id → [id, ...]  (stage_carry除外)
let RXN_IDS      = new Set();   // reaction id の集合
let UBIQ_INSTANCES = new Set(); // ユビキタス物質インスタンスID

function buildAdjacency() {
  childrenMap  = {};
  parentsMap   = {};
  edgeBySource = {};
  edgeByTarget = {};
  parentsStrict = {};

  DATA.edges.forEach(e => {
    (childrenMap[e.source] = childrenMap[e.source] || []).push(e.target);
    (parentsMap[e.target]  = parentsMap[e.target]  || []).push(e.source);
    (edgeBySource[e.source] = edgeBySource[e.source] || []).push(e);
    (edgeByTarget[e.target] = edgeByTarget[e.target] || []).push(e);
    if (e.type !== 'stage_carry') {
      (parentsStrict[e.target] = parentsStrict[e.target] || []).push(e.source);
    }
  });

  // reaction ID セット
  RXN_IDS = new Set((DATA.reactions || []).map(r => r.id));

  // ユビキタス物質を計算
  // 5つ以上のRAWから ingredient_to_instance で直接供給される master_id をユビキタスとする
  const masterRawCount = {};
  DATA.edges.forEach(e => {
    if (e.type === 'ingredient_to_instance') {
      const masterId = e.target.includes('@') ? e.target.split('@')[0] : e.target;
      if (!masterRawCount[masterId]) masterRawCount[masterId] = new Set();
      masterRawCount[masterId].add(e.source);
    }
  });
  const ubiqMasters = new Set(
    Object.entries(masterRawCount)
      .filter(([, srcs]) => srcs.size >= 5)
      .map(([mid]) => mid)
  );
  UBIQ_INSTANCES = new Set();
  (DATA.substance_instances || []).forEach(inst => {
    if (ubiqMasters.has(inst.master_id)) UBIQ_INSTANCES.add(inst.id);
  });
  console.log(`[trace] ubiquitous masters: ${[...ubiqMasters].join(', ')}`);
  console.log(`[trace] ubiquitous instances: ${UBIQ_INSTANCES.size}`);
}

function canonicalMasterId(id) {
  let cur = id;
  const seen = new Set();
  while (ALIAS_MAP[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = ALIAS_MAP[cur];
  }
  return cur;
}

function canonicalNodeId(nodeId) {
  if (!nodeId) return nodeId;
  if (nodeId.includes('@')) {
    const [mid, stage] = nodeId.split('@');
    return `${canonicalMasterId(mid)}@${stage}`;
  }
  return canonicalMasterId(nodeId);
}

function getTraceIndexEntry(id) {
  const key = canonicalNodeId(id);
  return TRACE_INDEX[key] || TRACE_INDEX[canonicalMasterId(id)] || TRACE_INDEX[id] || {};
}

// ─── 原材料専用の厳格トレース ────────────────────────────────
// アルゴリズム:
//   1. ingredient_to_instance エッジで直接供給されるインスタンスを起点に追加
//      ユビキタス物質は traced に加えるが BFS展開はしない（広がりを止める）
//   2. stage_carry: 同一物質の工程継承。ユビキタスでなければ追跡
//   3. substrate: instance→reaction への遷移。reaction深さを管理し
//      max_rxn_depth (=1) を超えたら止める
//   4. product: reaction→instance。ユビキタスは追加しない
//
// max_rxn_depth=1 の意味: 直接供給物質が入る反応の生成物まで1段階だけ辿る
// これ以上深く辿ると水・グルテン等を経由して全グラフに到達してしまう
function traceIngredientStrict(rawId, maxRxnDepth = 1) {
  const traced = new Set([rawId]);
  const queue  = [];   // [nodeId, rxnDepth]

  (edgeBySource[rawId] || []).forEach(e => {
    if (e.type === 'ingredient_to_instance') {
      traced.add(e.target);
      if (!UBIQ_INSTANCES.has(e.target)) {
        queue.push([e.target, 0]);
      }
    }
  });

while (queue.length) {
  const [current, rxnDepth] = queue.shift();

  (edgeBySource[current] || []).forEach(e => {
    const tgt = e.target;

    if (traced.has(tgt)) return;

    // 1 stage carry は最優先
    if (e.type === 'stage_carry') {
      traced.add(tgt);

      if (!UBIQ_INSTANCES.has(tgt)) {
        queue.push([tgt, rxnDepth]);
      }
      return;
    }

    // 2 substrate → reaction
    if (e.type === 'substrate') {
      traced.add(tgt);

      if (rxnDepth < maxRxnDepth) {
        queue.push([tgt, rxnDepth + 1]);
      }
      return;
    }

    // 3 reaction → product
    if (e.type === 'product') {
      traced.add(tgt);

      if (!UBIQ_INSTANCES.has(tgt)) {
        queue.push([tgt, rxnDepth]);
      }
      return;
    }
  });
}
  return traced;
}

// ─── BFS（全子孫）──────────────────────────────────────────────
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

// ─── BFS（全祖先）──────────────────────────────────────────────
function getAllAncestors(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const cur = queue.pop();
    if (visited.has(cur)) continue;
    visited.add(cur);
    (parentsStrict[cur] || []).forEach(p => { if (!visited.has(p)) queue.push(p); });
  }
  return visited;
}

// ─── 物質インスタンス用トレース（上下両方向, stage_carry除外upstream） ──
function traceAllFast(nodeId) {
  const upstream   = getAllAncestors(nodeId);
  const downstream = getAllDescendants(nodeId);
  const combined   = new Set([...upstream, ...downstream]);
  combined.add(nodeId);
  return { upstream, downstream, combined };
}

function getMasterId(nodeId) {
  // SUB-0022@mixing → SUB-0022 （alias対応）
  if (nodeId.includes('@')) return canonicalMasterId(nodeId.split('@')[0]);
  return canonicalMasterId(nodeId);
}

// ─── 前後2ホップ ─────────────────────────────────────────────
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

// ─── Three.js シーン初期化 ───────────────────────────────────
function initScene() {
  const canvas = document.getElementById('canvas');
  const W = window.innerWidth;
  const H = window.innerHeight;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070a08);
  scene.fog = new THREE.FogExp2(0x070a08, 0.0007);

  const camera = new THREE.PerspectiveCamera(50, W / H, 1, 9000);
  camera.position.set(0, 200, 1050);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.shadowMap.enabled = false;

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir1 = new THREE.DirectionalLight(0xa8e080, 1.1);
  dir1.position.set(300, 600, 400);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0x4080ff, 0.5);
  dir2.position.set(-400, -200, -300);
  scene.add(dir2);
  scene.add(new THREE.PointLight(0xe0b060, 0.6, 2500));

  const controls = createOrbitControls(camera, canvas);
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 5;

  window.addEventListener('resize', () => {
    const W2 = window.innerWidth, H2 = window.innerHeight;
    camera.aspect = W2 / H2;
    camera.updateProjectionMatrix();
    renderer.setSize(W2, H2);
  });

  // サイドバー開閉時にもリサイズイベントを発火
  document.addEventListener('sidebar-changed', () => {
    const W2 = window.innerWidth, H2 = window.innerHeight;
    camera.aspect = W2 / H2;
    camera.updateProjectionMatrix();
    renderer.setSize(W2, H2);
  });

  SCENE_OBJ = { scene, camera, renderer, controls, raycaster };
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasHover);
}

// ─── 簡易 OrbitControls ──────────────────────────────────────
function createOrbitControls(camera, canvas) {
  const state = {
    isDragging: false, isRightDrag: false,
    prevX: 0, prevY: 0,
    spherical: { theta: 0, phi: Math.PI / 3, radius: 1050 },
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
    state.isDragging = true; state.isRightDrag = e.button === 2;
    state.prevX = e.clientX; state.prevY = e.clientY;
  });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('mousemove', e => {
    if (!state.isDragging) return;
    const dx = e.clientX - state.prevX, dy = e.clientY - state.prevY;
    state.prevX = e.clientX; state.prevY = e.clientY;
    if (state.isRightDrag) {
      const right = new THREE.Vector3(), up = new THREE.Vector3();
      right.crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize();
      up.copy(camera.up).normalize();
      state.target.addScaledVector(right, -dx * 0.8);
      state.target.addScaledVector(up, dy * 0.8);
    } else {
      state.spherical.theta -= dx * 0.005;
      state.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, state.spherical.phi + dy * 0.005));
    }
    updateCamera();
  });
  window.addEventListener('mouseup', () => { state.isDragging = false; });
  canvas.addEventListener('wheel', e => {
    state.spherical.radius = Math.max(100, Math.min(4000, state.spherical.radius + e.deltaY * 0.5));
    updateCamera();
    e.preventDefault();
  }, { passive: false });
  let lastTouchDist = 0;
  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      state.isDragging = true; state.isRightDrag = false;
      state.prevX = e.touches[0].clientX; state.prevY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && state.isDragging) {
      const dx = e.touches[0].clientX - state.prevX, dy = e.touches[0].clientY - state.prevY;
      state.prevX = e.touches[0].clientX; state.prevY = e.touches[0].clientY;
      state.spherical.theta -= dx * 0.006;
      state.spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, state.spherical.phi + dy * 0.006));
      updateCamera();
    } else if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      state.spherical.radius = Math.max(100, Math.min(4000, state.spherical.radius - (d - lastTouchDist) * 1.5));
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
  allMeshes = []; lineMeshes = []; nodeMap = {};

  // ── 工程リング表示 ──────────────────────────────────────
  STEP_ORDER.forEach((step, i) => {
    const po    = i;  // process_order と対応
    const y     = getStageY(po);
    const color = STEP_COLORS[step] || 0x444444;
    // substance_instance 層リング
    const r_inst = TYPE_RADIUS.substance_instance;
    addRing(scene, r_inst, y + TYPE_Y_OFFSET.substance_instance, color, 0.15);
    // reaction 層リング
    if (step !== 'ingredients') {
      const r_rxn = TYPE_RADIUS.reaction;
      addRing(scene, r_rxn, y, color, 0.09);
    }
    // raw_material 層リング（ingredientsのみ）
    if (step === 'ingredients') {
      addRing(scene, TYPE_RADIUS.raw_material, y, color, 0.18);
    }
  });

  // 中央縦軸
  const axisGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 300, 0),
    new THREE.Vector3(0, getStageY(STEP_ORDER.length - 1) - 100, 0)
  ]);
  scene.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: 0x334433, transparent: true, opacity: 0.3 })));

  // ── raw_material ノード ─────────────────────────────────
  const rawMats = DATA.raw_materials || [];
  const rawCount = rawMats.length;
  rawMats.forEach((rm, idx) => {
    const angle = (idx / rawCount) * Math.PI * 2;
    const r     = TYPE_RADIUS.raw_material;
    const y     = getStageY(0) + TYPE_Y_OFFSET.raw_material;
    const rj    = r + (seededRandom(rm.id) - 0.5) * r * 0.2;
    const x     = Math.cos(angle) * rj;
    const z     = Math.sin(angle) * rj;
    const yj    = y + (seededRandom(rm.id + 'y') - 0.5) * 30;
    const color = STEP_COLORS.ingredients;
    // 六面体（ダイヤ型）で原材料を示す
    const geo   = new THREE.OctahedronGeometry(11, 0);
    const mat   = new THREE.MeshPhongMaterial({
      color, emissive: color, emissiveIntensity: 0.3, shininess: 60,
      transparent: true, opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, yj, z);
    mesh.userData = { id: rm.id, type: 'raw_material', node: rm, stage: 'ingredients', process_order: 0, originalColor: color };
    scene.add(mesh);
    const entry = { mesh, node: rm, type: 'raw_material', stage: 'ingredients' };
    allMeshes.push(entry);
    nodeMap[rm.id] = entry;
  });

  // ── substance_instance ノード ───────────────────────────
  // stage × process_order ごとにグルーピングしてXZ配置
  const instByStage = {};
  (DATA.substance_instances || []).forEach(inst => {
    const s = inst.stage || 'mixing';
    (instByStage[s] = instByStage[s] || []).push(inst);
  });

  Object.entries(instByStage).forEach(([stage, insts]) => {
    const po    = insts[0].process_order || 1;
    const total = insts.length;
    const y_base = getStageY(po) + TYPE_Y_OFFSET.substance_instance;
    const r_base = TYPE_RADIUS.substance_instance;

    insts.forEach((inst, idx) => {
      const angle = (idx / total) * Math.PI * 2;
      const rj    = r_base + (seededRandom(inst.id) - 0.5) * r_base * 0.3;
      const x     = Math.cos(angle) * rj;
      const z     = Math.sin(angle) * rj;
      const yj    = y_base + (seededRandom(inst.id + 'y') - 0.5) * 35;

      const color     = STEP_COLORS[stage] || 0x4a8060;
      const isVolatile = inst.is_volatile;
      const r3d       = isVolatile ? 7 : 4.5;

      const geo = new THREE.SphereGeometry(r3d, 16, 12);
      const mat = new THREE.MeshPhongMaterial({
        color, emissive: color,
        emissiveIntensity: isVolatile ? 0.35 : 0.08,
        shininess: isVolatile ? 90 : 40,
        transparent: true, opacity: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, yj, z);
      mesh.userData = {
        id: inst.id, type: 'substance_instance',
        node: inst, stage, process_order: inst.process_order,
        originalColor: color,
      };
      scene.add(mesh);

      if (isVolatile) {
        const ringG = new THREE.TorusGeometry(r3d + 4, 0.7, 6, 24);
        const ringM = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 });
        const rm2   = new THREE.Mesh(ringG, ringM);
        rm2.position.copy(mesh.position);
        rm2.rotation.x = Math.random() * Math.PI;
        scene.add(rm2);
      }

      const entry = { mesh, node: inst, type: 'substance_instance', stage };
      allMeshes.push(entry);
      nodeMap[inst.id] = entry;
    });
  });

  // ── 旧 nodes (master-level substance) を補完 ──────────────
  // substance_master には対応するインスタンスが存在する。
  // 旧 UI（一覧クリックなど）で SUB-XXXX を参照するために nodeMap に追加
  // ただし 3D ではインスタンスが表示される（mesh は first instance を使う）
  (DATA.nodes || []).forEach(n => {
    if (nodeMap[n.id]) return;  // すでに登録済みなら skip
    // インスタンスが1つもない物質（stage_nodes = null）はダミー配置
    const stageNodes = n.stage_nodes || [];
    if (stageNodes.length > 0) {
      // 最初のインスタンスのmeshを指す
      const firstInstId = stageNodes[0].instance_id;
      if (nodeMap[firstInstId]) {
        nodeMap[n.id] = nodeMap[firstInstId];  // aliasとして登録
      }
    } else {
      // stage_nodesなし → invisible dummy（選択可能にするため ghost を作る）
      const color = STEP_COLORS['raw'];
      const geo   = new THREE.SphereGeometry(3, 8, 6);
      const mat   = new THREE.MeshPhongMaterial({
        color, transparent: true, opacity: 0.0,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, BASE_Y, 0);
      mesh.userData = { id: n.id, type: 'substance', node: n, stage: 'raw', originalColor: color };
      scene.add(mesh);
      nodeMap[n.id] = { mesh, node: n, type: 'substance', stage: 'raw' };
      allMeshes.push(nodeMap[n.id]);
    }
  });

  // ── 反応ノード（八面体） ─────────────────────────────────
  const rxnByStage = {};
  DATA.reactions.forEach(r => {
    const s = r.stage || r.step || 'mixing';
    (rxnByStage[s] = rxnByStage[s] || []).push(r);
  });

  Object.entries(rxnByStage).forEach(([stage, rxns]) => {
    const po    = rxns[0].process_order || 1;
    const total = rxns.length;
    const y_base = getStageY(po);
    const r_base = TYPE_RADIUS.reaction;

    rxns.forEach((rxn, idx) => {
      const angle = (idx / total) * Math.PI * 2 + Math.PI / total;
      const rr = r_base + ((idx % 2) * 35);
      const x     = Math.cos(angle) * rr;
      const z     = Math.sin(angle) * rr;

      const color = STEP_COLORS[stage] || 0x666666;
      const geo   = new THREE.OctahedronGeometry(9, 0);
      const mat   = new THREE.MeshPhongMaterial({
        color, emissive: color, emissiveIntensity: 0.25,
        shininess: 80, transparent: true, opacity: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y_base, z);
      mesh.userData = { id: rxn.id, type: 'reaction', node: rxn, stage, originalColor: color };
      scene.add(mesh);

      const entry = { mesh, node: rxn, type: 'reaction', stage };
      allMeshes.push(entry);
      nodeMap[rxn.id] = entry;
    });
  });

  // ── エッジ（ライン） ────────────────────────────────────
  DATA.edges.forEach(e => {
    const srcEntry = nodeMap[e.source];
    const tgtEntry = nodeMap[e.target];
    if (!srcEntry || !tgtEntry) return;

    const srcPos = srcEntry.mesh.position;
    const tgtPos = tgtEntry.mesh.position;
    const geo    = new THREE.BufferGeometry().setFromPoints([srcPos.clone(), tgtPos.clone()]);

    // エッジタイプ別色
    let col;
    if (e.type === 'product')              col = 0x2a5540;
    else if (e.type === 'stage_carry')     col = 0x334455;
    else if (e.type === 'ingredient_to_instance') col = 0x6b5530;
    else if (e.is_extinct)                 col = 0x553333;
    else                                   col = 0x263832;

    const mat  = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.3 });
    const line = new THREE.Line(geo, mat);
    SCENE_OBJ.scene.add(line);
    lineMeshes.push({ line, edge: e, mat, originalColor: col });
  });
}

function addRing(scene, radius, y, color, opacity) {
  const geo = new THREE.TorusGeometry(radius, 1.2, 8, 64);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
  const ring = new THREE.Mesh(geo, mat);
  ring.position.y = y;
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);
}

// ─── シード乱数 ──────────────────────────────────────────────
function seededRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  h = (h ^ (h >>> 16)) * 0x45d9f3b | 0;
  h = (h ^ (h >>> 16)) * 0x45d9f3b | 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 0xFFFFFFFF);
}

// ─── クリック処理 ─────────────────────────────────────────────
let _clickMoved = false, _mouseDownPos = { x: 0, y: 0 };
document.getElementById('canvas').addEventListener('mousedown', e => {
  _clickMoved = false; _mouseDownPos = { x: e.clientX, y: e.clientY };
});
document.getElementById('canvas').addEventListener('mousemove', e => {
  if (Math.hypot(e.clientX - _mouseDownPos.x, e.clientY - _mouseDownPos.y) > 5) _clickMoved = true;
});

function onCanvasClick(e) {
  if (_clickMoved) return;
  const hit = raycast(e);
  if (!hit) { clearSelection(); return; }
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
    _hoveredId = null; hideTooltip();
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

// ─── ノード選択 ───────────────────────────────────────────────
function selectNode(id, node, type) {
  selectedId = id;
  const entry = nodeMap[id];
  const stage = entry?.stage || node?.stage || 'mixing';

  let traceIds, traceMsg, traceIcon = '🔍';

  if (type === 'raw_material') {
    // 原材料 → 下流全体（stage_carry 除外の厳格BFS）
    traceIds  = traceIngredientStrict(id, 99);
  traceMsg  = `${node.name || id} → 原材料由来 ${traceIds.size} ノード`;
  traceIcon = '🔶';
  } else if (stage === 'baking' || stage === 'final') {
    // 焼成物 → 上流全体
    const { upstream, combined } = traceAllFast(id);
    traceIds  = combined;
    traceMsg  = `${node.name || id}  ←  上流 ${upstream.size} ノード`;
    traceIcon = '🔴';
  } else if (type === 'substance_instance' || type === 'substance') {
    // 中間物質 → 両方向
    const { upstream, downstream, combined } = traceAllFast(id);
    traceIds  = combined;
    traceMsg  = `${node.name || id}  |  ▲${upstream.size}  ▼${downstream.size}`;
    traceIcon = '🔵';
  } else {
    // 反応 → 前後2ホップ
    traceIds  = getNeighbors2(id);
    traceMsg  = `${node.name || id}  関連 ${traceIds.size} ノード`;
    traceIcon = '🔷';
  }

  traceSet = traceIds;
  applyHighlight();
  showTraceBar(traceMsg, traceIcon);
  updateDetailPanel(node, type, stage);
}

function clearSelection() {
  selectedId = null; traceSet = null;
  hideTraceBar();
  applyHighlight();
  updateDetailPanel(null);
}

// ─── ハイライト ───────────────────────────────────────────────
function applyHighlight() {
  allMeshes.forEach(({ mesh }) => {
    const id  = mesh.userData.id;
    const col = mesh.userData.originalColor;
    const isSelected = id === selectedId;
    const inTrace    = traceSet ? traceSet.has(id) : true;
    const visible    = isVisible(mesh.userData);

    if (!visible) {
      mesh.material.opacity = 0.02;
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
      mesh.scale.setScalar(1.5);
    } else {
      mesh.material.color.setHex(col);
      mesh.material.emissive.setHex(col);
      const isVol = mesh.userData.node?.is_volatile;
      mesh.material.emissiveIntensity = isVol ? 0.35 : 0.12;
      mesh.material.opacity = 1;
      mesh.scale.setScalar(1);
    }
  });

  lineMeshes.forEach(({ line, edge, mat, originalColor }) => {
    const s = edge.source, t = edge.target;
    if (traceSet) {
      const both = traceSet.has(s) && traceSet.has(t);
      mat.opacity = both ? 0.9 : 0.02;
      if (both) {
        if (edge.type === 'product')              mat.color.setHex(0xa8e053);
        else if (edge.type === 'stage_carry')     mat.color.setHex(0x4488aa);
        else if (edge.type === 'ingredient_to_instance') mat.color.setHex(0xffaa55);
        else                                      mat.color.setHex(0x4a9eff);
      } else {
        mat.color.setHex(originalColor);
      }
    } else {
      mat.opacity = 0.28;
      mat.color.setHex(originalColor);
    }
  });
}

function isVisible(userData) {
  const id   = userData.id;
  const type = userData.type;
  const stage = userData.stage;

  if (activeStep !== 'all') {
    // 工程フィルター
    if (type === 'reaction' && stage !== activeStep) return false;
    if ((type === 'substance_instance') && stage !== activeStep) return false;
    if (type === 'raw_material' && activeStep !== 'ingredients') return false;
  }

  if (activeFilter === 'volatile' && (type === 'substance_instance' || type === 'substance') && !userData.node?.is_volatile) return false;
  if (activeFilter === 'reactions' && type !== 'reaction') return false;

  if (searchQuery) {
    const n = userData.node;
    const hit = (n?.name || '').toLowerCase().includes(searchQuery)
             || (n?.formula || '').toLowerCase().includes(searchQuery)
             || (id || '').toLowerCase().includes(searchQuery);
    if (!hit) return false;
  }
  return true;
}

// ─── アニメーションループ ─────────────────────────────────────
let _frame = 0;
function animate() {
  requestAnimationFrame(animate);
  _frame++;
  if (autoRotate && SCENE_OBJ) {
    SCENE_OBJ.controls.state.spherical.theta += 0.003;
    SCENE_OBJ.controls.updateCamera();
  }
  if (selectedId) {
    const entry = nodeMap[selectedId];
    if (entry) {
      const s = 1.4 + Math.sin(_frame * 0.08) * 0.15;
      entry.mesh.scale.setScalar(s);
    }
  }
  SCENE_OBJ.renderer.render(SCENE_OBJ.scene, SCENE_OBJ.camera);
}

// ─── トレースバー ─────────────────────────────────────────────
function showTraceBar(msg, icon) {
  const iconEl = document.getElementById('trace-icon');
  if (iconEl && icon) iconEl.textContent = icon;
  document.getElementById('trace-info').textContent = msg;
  document.getElementById('trace-bar').classList.add('visible');
}
function hideTraceBar() { document.getElementById('trace-bar').classList.remove('visible'); }
document.getElementById('trace-close').addEventListener('click', clearSelection);

// ─── ツールチップ ─────────────────────────────────────────────
function showTooltip(e, node, type) {
  document.getElementById('tt-name').textContent = node?.name || node?.id || '?';
  let sub;
  if (type === 'reaction') {
    sub = `${STEP_LABELS[node?.stage || node?.step] || node?.step}  ·  ${(node?.equation || '').slice(0, 55)}`;
  } else if (type === 'raw_material') {
    sub = `原材料`;
  } else {
    sub = `${node?.formula || ''}  ${node?.is_volatile ? '[ 香気物質 ]' : ''}  ${node?.stage ? '[' + STEP_LABELS[node.stage] + ']' : ''}`;
  }
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

// ─── 詳細パネル ───────────────────────────────────────────────
function updateDetailPanel(node, type, stage) {
  const panel = document.getElementById('detail-panel');
  if (!node) {
    panel.innerHTML = `<div class="detail-empty">
      球をクリックすると詳細表示。<br><br>
      <b style="color:var(--text2)">トレース機能（v2）：</b><br>
      🔶 原材料クリック → 下流▼全経路<br>
      🔵 物質インスタンス → ⇅上流+下流<br>
      🔴 焼成物クリック → 上流▲全経路<br>
      🔷 反応クリック → 前後2ホップ<br><br>
      <b style="color:var(--text2)">操作：</b><br>
      ドラッグ → 回転<br>
      ホイール → ズーム<br>
      右ドラッグ → パン
    </div>`;
    return;
  }
  if (type === 'reaction')      renderRxnDetail(panel, node, stage);
  else if (type === 'raw_material') renderRawDetail(panel, node);
  else                           renderSubDetail(panel, node, stage);
}

// ── 物質インスタンス詳細 ──────────────────────────────────────
function renderSubDetail(panel, n, stage) {
  // スナップショット: node が instance の場合は amount_g を使う
  // node が master の場合は stage_nodes を使う
  const bc = STEP_COLORS_CSS[stage] || '#4a8060';
  const canonicalMaster = canonicalMasterId(n.master_id || n.id);
  const masterNode = (DATA.nodes || []).find(s => s.id === canonicalMaster) || (DATA.nodes || []).find(s => s.id === (n.master_id || n.id));
  const sa   = masterNode?.snapshot || {};
  const stages = ['post_mixing_g','post_fermentation_1_g','post_dividing_bench_shaping_g','post_proof_g','post_baking_g'];
  const stageL = ['ミキシング後','発酵後','成形後','ホイロ後','焼成後'];
  const vals = stages.map(s => parseFloat(sa[s]) || 0);
  const maxV = Math.max(...vals, 0.001);

  // trace_index から上流/下流カウント
  const masterId = canonicalMasterId(n.master_id || n.id);
  const ti = getTraceIndexEntry(masterId);
  const upCount   = ti.upstream   ? ti.upstream.length   : (parentsMap[n.id]  || []).length;
  const downCount = ti.downstream ? ti.downstream.length : (childrenMap[n.id] || []).length;

  // 工程別インスタンス一覧
  const myInstances = (DATA.substance_instances || []).filter(i => canonicalMasterId(i.master_id) === masterId);
  const instHTML = myInstances.length ? `
    <div class="detail-section">
      <div class="detail-section-title">工程インスタンス</div>
      ${myInstances.map(inst => `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:3px;font-size:10px;cursor:pointer"
             onclick="selectNode('${inst.id}', DATA.substance_instances.find(i=>i.id==='${inst.id}'), 'substance_instance')">
          <span style="color:${STEP_COLORS_CSS[inst.stage]||'#888'};min-width:70px">${STEP_LABELS[inst.stage]||inst.stage}</span>
          <span style="color:var(--accent2)">${inst.amount_g != null ? inst.amount_g.toFixed(2) + 'g' : '—'}</span>
        </div>`).join('')}
    </div>` : '';

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

  const roles = masterNode?.reaction_roles || [];

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${n.name}</div>
    ${n.formula ? `<div class="detail-formula">${n.formula}</div>` : ''}
    <span class="badge" style="background:${bc};color:#070a08">${STEP_LABELS[stage] || stage}</span>
    ${n.is_volatile ? `<span style="font-size:9px;color:#e8b553;padding:2px 5px;border:1px solid #e8b553;border-radius:2px;margin-left:4px">★ 香気物質</span>` : ''}
    ${n.node_type === 'substance_instance' ? `<span style="font-size:9px;color:var(--text3);padding:2px 5px;margin-left:4px">[インスタンス]</span>` : ''}
    <div style="margin-top:10px;display:flex;gap:12px">
      <div style="font-size:10px;color:var(--text3)">上流 <span style="color:var(--accent2)">${upCount}</span></div>
      <div style="font-size:10px;color:var(--text3)">下流 <span style="color:var(--accent)">${downCount}</span></div>
    </div>
    ${(n.alias_of || masterNode?.alias_of) ? `<div style="font-size:10px;color:#e8b553;margin-top:8px;line-height:1.6">旧ID / alias → ${n.alias_of || masterNode?.alias_of}</div>` : ''}
    ${n.note || n.notes?.[0] ? `<div style="font-size:10px;color:var(--text2);margin-top:8px;line-height:1.65;border-left:2px solid ${bc};padding-left:8px">${n.note || n.notes?.[0]}</div>` : ''}
    ${instHTML}
    ${snapHTML}
    ${roles.length ? `
    <div class="detail-section">
      <div class="detail-section-title">反応への関与 (${roles.length})</div>
      ${roles.slice(0,6).map(r=>`
        <div style="display:flex;gap:5px;align-items:center;margin-bottom:3px;font-size:10px">
          <span style="min-width:40px;font-weight:bold">${r.reaction_id}</span>
          <span style="color:${r.consumed?'#e85353':'#53e8b5'}">${r.consumed?'消費':'触媒'}</span>
        </div>`).join('')}
      ${roles.length>6?`<div style="font-size:9px;color:var(--text3)">+${roles.length-6}件</div>`:''}
    </div>` : ''}
  </div>`;
}

// ── 原材料詳細 ───────────────────────────────────────────────
function renderRawDetail(panel, rm) {
  const color = STEP_COLORS_CSS.ingredients;
  // この原材料から始まるインスタンスを検索
  const downEdges = DATA.edges.filter(e => e.source === rm.id && e.type === 'ingredient_to_instance');
  const downInsts = downEdges.map(e => e.target).map(tid => {
    const inst = (DATA.substance_instances || []).find(i => i.id === tid);
    return inst;
  }).filter(Boolean);

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${rm.id}</div>
    <div class="detail-name">${rm.name}</div>
    <span class="badge" style="background:${color};color:#070a08">原材料</span>
    <div style="margin-top:10px;font-size:10px;color:var(--text3)">
      下流物質 <span style="color:var(--accent)">${Math.max(0, traceIngredientStrict(rm.id, 99).size - 1)}</span> ノード
    </div>
    ${downInsts.length ? `
    <div class="detail-section">
      <div class="detail-section-title">供給先物質 (${downInsts.length})</div>
      ${downInsts.map(i => `
        <div style="font-size:10px;color:${STEP_COLORS_CSS[i.stage]||'#888'};margin-bottom:3px;cursor:pointer"
             onclick="selectNode('${i.id}', DATA.substance_instances.find(x=>x.id==='${i.id}'), 'substance_instance')">
          ● ${i.name} <span style="color:var(--text3)">[${STEP_LABELS[i.stage]||i.stage}]</span>
        </div>`).join('')}
    </div>` : ''}
  </div>`;
}

// ── 反応詳細 ──────────────────────────────────────────────────
function renderRxnDetail(panel, r, stage) {
  const color = STEP_COLORS_CSS[r.stage || r.step] || '#666';
  const subsList = DATA.edges
    .filter(e => e.target === r.id && e.type === 'substrate')
    .map(e => nodeMap[e.source]?.node).filter(Boolean);
  const prodsList = DATA.edges
    .filter(e => e.source === r.id && e.type === 'product')
    .map(e => nodeMap[e.target]?.node).filter(Boolean);

  const cond = r.conditions || {};
  const condHTML = cond.temperature_C ? `
    <div style="font-size:10px;color:var(--text3);margin-top:6px">
      🌡 ${cond.temperature_C.min}–${cond.temperature_C.max}℃
      ${cond.time_min ? `  ⏱ ${cond.time_min.min}–${cond.time_min.max}min` : ''}
    </div>` : '';

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${r.id}</div>
    <div class="detail-name">${r.name}</div>
    <span class="badge" style="background:${color};color:#070a08">${STEP_LABELS[r.stage||r.step]||r.stage}</span>
    ${r.equation ? `<div style="font-size:10px;color:var(--text2);line-height:1.65;margin:8px 0;border-left:2px solid ${color};padding-left:8px">${r.equation}</div>` : ''}
    ${r.equation_formula ? `<div class="detail-formula" style="font-size:9px;margin-bottom:8px">${r.equation_formula}</div>` : ''}
    ${condHTML}
    ${subsList.length ? `
    <div class="detail-section">
      <div class="detail-section-title">▶ 基質 (${subsList.length})</div>
      ${subsList.slice(0,6).map(s=>`<div style="font-size:10px;color:var(--text2);margin-bottom:2px">● ${s.name}${s.stage ? ' <span style=color:var(--text3)>['+STEP_LABELS[s.stage]+']</span>' : ''}</div>`).join('')}
      ${subsList.length>6?`<div style="font-size:9px;color:var(--text3)">+${subsList.length-6}件</div>`:''}
    </div>` : ''}
    ${prodsList.length ? `
    <div class="detail-section">
      <div class="detail-section-title">✦ 生成物 (${prodsList.length})</div>
      ${prodsList.map(s=>`<div style="font-size:10px;color:${s.is_volatile?'var(--accent3)':'var(--accent2)'};margin-bottom:2px">${s.name}${s.is_volatile?' ★':''}</div>`).join('')}
    </div>` : ''}
  </div>`;
}

// ─── UI 初期化 ────────────────────────────────────────────────
function initUI() {
  const legend = document.getElementById('step-legend');
  const stepCounts = {};
  DATA.reactions.forEach(r => stepCounts[r.stage || r.step] = (stepCounts[r.stage||r.step]||0)+1);

  const allItem = document.createElement('div');
  allItem.className = 'step-item active'; allItem.dataset.step = 'all';
  allItem.innerHTML = `<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${DATA.reactions.length}</span>`;
  allItem.addEventListener('click', () => { activeStep='all'; applyHighlight(); setStepActive('all'); });
  legend.appendChild(allItem);

  STEP_ORDER.forEach(step => {
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

  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      applyHighlight();
    })
  );

  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    applyHighlight();
  });

  document.getElementById('btn-zoom-in').onclick = () => {
    SCENE_OBJ.controls.state.spherical.radius = Math.max(100, SCENE_OBJ.controls.state.spherical.radius * 0.7);
    SCENE_OBJ.controls.updateCamera();
  };
  document.getElementById('btn-zoom-out').onclick = () => {
    SCENE_OBJ.controls.state.spherical.radius = Math.min(4000, SCENE_OBJ.controls.state.spherical.radius * 1.4);
    SCENE_OBJ.controls.updateCamera();
  };
  document.getElementById('btn-reset').onclick = () => {
    const s = SCENE_OBJ.controls.state;
    s.spherical = { theta: 0, phi: Math.PI/3, radius: 1050 };
    s.target.set(0, -200, 0);
    SCENE_OBJ.controls.updateCamera();
  };
  document.getElementById('btn-rotate').onclick = () => {
    autoRotate = !autoRotate;
    document.getElementById('btn-rotate').style.color = autoRotate ? 'var(--accent)' : '';
    document.getElementById('btn-rotate').style.borderColor = autoRotate ? 'var(--accent)' : '';
  };
}

// ─── ナビゲーション ───────────────────────────────────────────
function initNav() {
  initReactionsView();
  initSubstancesView();
  initParamsView();

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      if (view !== 'graph') document.getElementById(view + '-view').classList.add('active');
    });
  });
}

// ── 反応一覧 ──────────────────────────────────────────────────
function initReactionsView() {
  const fd = document.getElementById('rxn-step-filter');
  const ab = document.createElement('button');
  ab.className='filter-btn active'; ab.textContent='全工程'; ab.dataset.step='all';
  fd.appendChild(ab);
  STEP_ORDER.filter(s => s !== 'ingredients').forEach(step => {
    const b = document.createElement('button');
    b.className='filter-btn'; b.textContent=STEP_LABELS[step]; b.dataset.step=step;
    b.style.borderColor=STEP_COLORS_CSS[step];
    fd.appendChild(b);
  });
  let rxnStep='all';
  fd.addEventListener('click', e => {
    if (!e.target.classList.contains('filter-btn')) return;
    fd.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active'); rxnStep = e.target.dataset.step; renderRxnGrid();
  });
  document.getElementById('rxn-search').addEventListener('input', renderRxnGrid);

  function renderRxnGrid() {
    const q = document.getElementById('rxn-search').value.toLowerCase();
    const grid = document.getElementById('rxn-grid'); grid.innerHTML = '';
    DATA.reactions
      .filter(r => rxnStep==='all' || (r.stage||r.step) === rxnStep)
      .filter(r => !q || (r.name||'').toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      .forEach(r => {
        const stg = r.stage || r.step;
        const color = STEP_COLORS_CSS[stg] || '#666';
        const subs  = DATA.edges.filter(e => e.target === r.id).length;
        const prods = DATA.edges.filter(e => e.source === r.id).length;
        const card  = document.createElement('div'); card.className='rxn-card';
        card.style.borderLeftColor = color;
        card.innerHTML=`
          <div><span class="rxn-step-badge" style="background:${color}">${STEP_LABELS[stg]||stg}</span></div>
          <div class="rxn-id">${r.id}</div>
          <div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div class="rxn-subs" style="margin-top:7px;font-size:9px">
            <span style="color:var(--text3)">基質 ${subs}</span> → <span style="color:${color}">生成物 ${prods}</span>
          </div>`;
        card.addEventListener('click', () => {
          document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
          document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
          document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
          selectNode(r.id, r, 'reaction');
        });
        grid.appendChild(card);
      });
  }
  renderRxnGrid();
}

// ── 物質一覧 ──────────────────────────────────────────────────
function initSubstancesView() {
  document.getElementById('sub-search').addEventListener('input', e => renderSubTable(e.target.value.toLowerCase()));
  renderSubTable('');
}
function renderSubTable(q) {
  const tbody = document.getElementById('sub-tbody');
  // substance_master を使う
  const masterList = DATA.substance_master || DATA.nodes || [];
  const filtered = masterList.filter(s =>
    !q || (s.name||'').toLowerCase().includes(q) || (s.formula||'').toLowerCase().includes(q)
       || (s.master_id||s.id||'').toLowerCase().includes(q)
  );
  document.getElementById('sub-count-label').textContent = `${filtered.length}/${masterList.length}件`;
  tbody.innerHTML = '';
  filtered.slice(0, 300).forEach(s => {
    const id   = s.master_id || s.id;
    const tr   = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-size:9px;color:var(--text3)">${id}</td>
      <td style="color:var(--text)">${s.name}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.formula||'—'}</td>
      <td style="font-size:9px;color:#e8b553">${s.is_volatile?'★':'—'}</td>
      <td style="font-size:9px;color:var(--text3)">${s.nutrition_cat||'—'}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.snapshot_count||'—'}</td>`;
    tr.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      // インスタンスがある場合は最初のインスタンスを選択
      const ti = TRACE_INDEX[id];
      const instId = ti?.instances?.[0] || id;
      const instNode = (DATA.substance_instances||[]).find(i => i.id === instId)
                    || (DATA.nodes||[]).find(n => n.id === id);
      selectNode(instId, instNode, 'substance_instance');
    });
    tbody.appendChild(tr);
  });
  if (filtered.length > 300) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" style="text-align:center;color:var(--text3);font-size:9px;padding:10px">+${filtered.length-300}件（検索で絞り込み）</td>`;
    tbody.appendChild(tr);
  }
}

// ── パラメーター ──────────────────────────────────────────────
function initParamsView() {
  const grid = document.getElementById('params-grid');
  DATA.params.forEach(p => {
    const card = document.createElement('div'); card.className = 'param-card';
    const isRange = typeof p.range?.min === 'number' && typeof p.range?.max === 'number';
    const min = isRange ? p.range.min : 0, max = isRange ? p.range.max : 100;
    const val = typeof p.value === 'number' ? p.value : (min + max) / 2;
    const affects = (p.affects_reactions || []).slice(0, 5);
    card.innerHTML = `
      <div class="param-id">${p.param_id}</div>
      <div class="param-name">${p.name}</div>
      <div class="param-val-row"><span class="param-unit">${p.unit}</span><span class="param-val-display" id="pv-${p.param_id}">${typeof val==='number'?val.toFixed(1):val}</span></div>
      ${isRange?`<input type="range" class="param-slider" min="${min}" max="${max}" value="${Math.max(min,Math.min(max,val))}" step="${(max-min)/100}">
        <div class="param-range">${min}—${max} ${p.unit}</div>`:`<div class="param-range">${JSON.stringify(p.range?.allowed||p.value)}</div>`}
      ${affects.length?`<div class="param-affects-title">影響する反応</div>
        ${affects.map(a=>{const s=a.score||0,pct=s*100,c=s>.8?'#e85353':s>.5?'#e8b553':'#53e8b5';
          return `<div class="affect-row"><span class="affect-rxn">${a.reaction_id}</span><div class="affect-bar"><div class="affect-fill" style="width:${pct}%;background:${c}"></div></div><span class="affect-lbl">${a.sensitivity}</span></div>`;
        }).join('')}`:''}`;
    if (isRange) {
      const sl = card.querySelector('.param-slider'), dp = card.querySelector(`#pv-${p.param_id}`);
      sl.addEventListener('input', () => dp.textContent = parseFloat(sl.value).toFixed(1));
    }
    grid.appendChild(card);
  });
}
