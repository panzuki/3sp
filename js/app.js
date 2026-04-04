// ── bread for myself — app.js (3D & 完全トレース版) ──
// [分割 1 / 4]

const STEP_COLORS = {
  raw:            '#a0a0a0',
  mixing:         '#4a9eff',
  fermentation_1: '#b5e853',
  dividing:       '#53b5e8',
  bench:          '#53e8b5',
  shaping:        '#c853e8',
  proof:          '#e8b553',
  baking:         '#e85353',
  final:          '#ffaa66'
};

const STEP_LABELS = {
  raw: '原材料',
  mixing: 'ミキシング',
  fermentation_1: '一次発酵',
  dividing: '分割',
  bench: 'ベンチ',
  shaping: '成形',
  proof: 'ホイロ',
  baking: '焼成',
  final: '最終生成物'
};

// 3D空間のZ軸（奥行き）の定義。工程が進むほど奥に配置
const STEP_Z = {
  raw: 400,
  mixing: 300,
  fermentation_1: 200,
  dividing: 100,
  bench: 0,
  shaping: -100,
  proof: -200,
  baking: -300,
  final: -400
};

let DATA = null;
let activeStep = 'all';
let activeVolatile = 'all';
let searchQuery = '';
let selectedNode = null;
let relatedNodesGlobal = new Set();
let relatedEdgesGlobal = new Set();

// Three.js 関連のグローバル変数
let scene, camera, renderer, controls;
let nodeMeshMap = new Map(); // id -> Mesh
let edgeLineMap = new Map(); // edgeオブジェクト -> Line
let raycaster, mouse;

// ─ Data loading ─
fetch('data/graph_data.json')
  .then(r => r.json())
  .then(d => {
    DATA = d;
    document.getElementById('stat-sub').textContent = d.meta.substance_count;
    document.getElementById('stat-rxn').textContent = d.meta.reaction_count;
    document.getElementById('stat-edge').textContent = d.meta.edge_count;
    document.getElementById('stat-param').textContent = d.meta.param_count;
    
    initStepLegend();
    init3DGraph();
    initReactionsView();
    initSubstancesView();
    initParamsView();
    initNav();
  });

// ─ Navigation ─
function initNav() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(view + '-view').classList.add('active');
    });
  });
}

// ─ Step legend ─
function initStepLegend() {
  const legend = document.getElementById('step-legend');
  if (!legend) return;
  legend.innerHTML = '';
  const stepCounts = {};
  DATA.reactions.forEach(r => { stepCounts[r.step] = (stepCounts[r.step]||0)+1; });
  
  const allItem = document.createElement('div');
  allItem.className = 'step-item active';
  allItem.dataset.step = 'all';
  allItem.innerHTML = `<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${DATA.reactions.length}</span>`;
  allItem.addEventListener('click', () => filterByStep('all'));
  legend.appendChild(allItem);
  
  Object.entries(STEP_COLORS).forEach(([step, color]) => {
    if (step === 'raw' || step === 'final') return;
    const item = document.createElement('div');
    item.className = 'step-item';
    item.dataset.step = step;
    item.innerHTML = `<div class="step-dot" style="background:${color}"></div><span>${STEP_LABELS[step]||step}</span><span class="step-count">${stepCounts[step]||0}</span>`;
    item.addEventListener('click', () => filterByStep(step));
    legend.appendChild(item);
  });
}
// [分割 2 / 4]

function filterByStep(step) {
  activeStep = step;
  document.querySelectorAll('.step-item').forEach(i => {
    i.classList.toggle('active', i.dataset.step === step || (step==='all' && i.dataset.step==='all'));
  });
  updateGraphVisibility();
}

// 深さ優先探索(DFS)で、指定したノードから「双方向」にすべての接続を辿る
function collectAllConnectedRecursive(startNodeId) {
  const visitedNodes = new Set();
  const visitedEdges = new Set();
  
  // 1. 上流（入力側）へ辿る関数
  function traceUpstream(nodeId) {
    if (visitedNodes.has(nodeId)) return;
    visitedNodes.add(nodeId);
    
    DATA.edges.forEach(e => {
      const srcId = typeof e.source === 'object' ? e.source.id : e.source;
      const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
      if (tgtId === nodeId) {
        visitedEdges.add(e);
        traceUpstream(srcId);
      }
    });
  }
  
  // 2. 下流（出力側）へ辿る関数
  function traceDownstream(nodeId) {
    if (visitedNodes.has(nodeId)) return;
    visitedNodes.add(nodeId);
    
    DATA.edges.forEach(e => {
      const srcId = typeof e.source === 'object' ? e.source.id : e.source;
      const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
      if (srcId === nodeId) {
        visitedEdges.add(e);
        traceDownstream(tgtId);
      }
    });
  }
  
  // 双方向に探索を実行
  traceUpstream(startNodeId);
  visitedNodes.delete(startNodeId); // 起点はリセットして両方で辿れるようにする
  traceDownstream(startNodeId);
  
  return { nodes: visitedNodes, edges: visitedEdges };
}

// ── 3D GRAPH (Three.js) ──
function init3DGraph() {
  const container = document.getElementById('graph-area');
  if (!container) return;
  
  // 既存のSVGキャンバスを削除、または非表示に
  const oldSvg = document.getElementById('graph-canvas');
  if (oldSvg) oldSvg.style.display = 'none';
  
  // Three.js 用のレンダラーを作成
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);
  
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d0f0e');
  
  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 5000);
  camera.position.set(0, 300, 1000);
  
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  
  // 環境光と平行光
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(200, 500, 300);
  scene.add(dirLight);
  
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  
  // データのマッピングと配置の計算
  calculateNodePositions();
  
  // 描画オブジェクトの生成
  create3DSceneObjects();
  
  // イベントリスナー
  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('click', onDocumentMouseDown);
  
  animate();
}

function calculateNodePositions() {
  // ノードの初期Y座標とX座標を散らすためのマップ
  const stepCounters = {};
  
  DATA.nodes.forEach((n, i) => {
    const roles = n.reaction_roles || [];
    let step = 'raw';
    if (roles.length > 0) {
      step = roles[0].step || 'raw';
    }
    n.step = step;
    
    stepCounters[step] = (stepCounters[step] || 0) + 1;
    const count = stepCounters[step];
    
    // 円状またはグリッド状に配置して平面化を防ぐ
    const angle = count * 0.4;
    const radius = 100 + (count * 5);
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle) * radius;
    n.z = STEP_Z[step] || 0;
  });
  
  DATA.reactions.forEach((r, i) => {
    const step = r.step || 'raw';
    stepCounters[step] = (stepCounters[step] || 0) + 1;
    const count = stepCounters[step];
    
    // 反応ノードは中央付近に配置
    const angle = count * 0.6;
    const radius = 30 + (count * 3);
    r.x = Math.cos(angle) * radius;
    r.y = Math.sin(angle) * radius;
    r.z = STEP_Z[step] || 0;
    r._type = 'reaction';
  });
}
// [分割 3 / 4]

function create3DSceneObjects() {
  const sphereGeo = new THREE.SphereGeometry(1, 16, 16);
  const diamondGeo = new THREE.ConeGeometry(6, 12, 4); // 反応はひし形(コーンを上下に合わせるか単体)
  
  // 1. 物質（球体）と反応（コーン）の作成
  const createMesh = (d, isReaction) => {
    let material;
    let size = 6;
    
    if (isReaction) {
      const color = STEP_COLORS[d.step] || '#666';
      material = new THREE.MeshStandardMaterial({ color: color, roughness: 0.4 });
      size = 8;
    } else {
      let color = '#2a4035';
      if (d.is_volatile) color = '#b5e853';
      else if (d.flavor_group) color = '#53e8b5';
      
      material = new THREE.MeshStandardMaterial({ color: color, roughness: 0.3 });
      if (d.is_volatile) size = 9;
    }
    
    let mesh;
    if (isReaction) {
      mesh = new THREE.Mesh(diamondGeo, material);
      mesh.rotation.x = Math.PI / 4;
    } else {
      mesh = new THREE.Mesh(sphereGeo, material);
      mesh.scale.set(size, size, size);
    }
    
    mesh.position.set(d.x, d.y, d.z);
    mesh.userData = { id: d.id, data: d, isReaction: isReaction };
    
    scene.add(mesh);
    nodeMeshMap.set(d.id, mesh);
  };
  
  DATA.nodes.forEach(n => createMesh(n, false));
  DATA.reactions.forEach(r => createMesh(r, true));
  
  // 2. エッジ（ライン）の作成
  DATA.edges.forEach(e => {
    const srcId = typeof e.source === 'object' ? e.source.id : e.source;
    const tgtId = typeof e.target === 'object' ? e.target.id : e.target;
    
    const srcNode = DATA.nodes.find(n => n.id === srcId) || DATA.reactions.find(r => r.id === srcId);
    const tgtNode = DATA.nodes.find(n => n.id === tgtId) || DATA.reactions.find(r => r.id === tgtId);
    
    if (srcNode && tgtNode) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(srcNode.x, srcNode.y, srcNode.z),
        new THREE.Vector3(tgtNode.x, tgtNode.y, tgtNode.z)
      ]);
      
      let color = '#2a3830';
      if (e.is_extinct) color = '#553333';
      else if (e.type === 'product') color = '#2a5040';
      
      const material = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.5, linewidth: 1 });
      const line = new THREE.Line(geometry, material);
      
      scene.add(line);
      edgeLineMap.set(e, line);
    }
  });
}

function updateGraphVisibility() {
  if (!DATA) return;
  
  nodeMeshMap.forEach((mesh, id) => {
    const d = mesh.userData.data;
    const isReaction = mesh.userData.isReaction;
    
    let visible = true;
    if (activeStep !== 'all' && d.step !== activeStep) visible = false;
    if (activeVolatile === 'volatile' && !isReaction && !d.is_volatile) visible = false;
    
    if (searchQuery && !(d.name || '').toLowerCase().includes(searchQuery)) visible = false;
    
    mesh.visible = visible;
    
    // ハイライトロジックの適用
    if (selectedNode) {
      const isRelated = relatedNodesGlobal.has(id) || id === selectedNode.id;
      mesh.material.opacity = isRelated ? 1.0 : 0.1;
      mesh.material.transparent = true;
    } else {
      mesh.material.opacity = 1.0;
      mesh.material.transparent = false;
    }
  });
  
  edgeLineMap.forEach((line, e) => {
    if (selectedNode) {
      const isRelated = relatedEdgesGlobal.has(e);
      line.material.opacity = isRelated ? 1.0 : 0.05;
      line.material.linewidth = isRelated ? 2 : 1;
    } else {
      line.material.opacity = 0.5;
      line.material.linewidth = 1;
    }
  });
}

function onDocumentMouseDown(event) {
  const container = document.getElementById('graph-area');
  const rect = container.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;
  
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(Array.from(nodeMeshMap.values()));
  
  if (intersects.length > 0) {
    const clickedMesh = intersects[0].object;
    const d = clickedMesh.userData.data;
    
    selectedNode = d;
    
    // 最初の食材から最後の物質まで全て辿る（双方向トレース）
    const traceResults = collectAllConnectedRecursive(d.id);
    relatedNodesGlobal = traceResults.nodes;
    relatedEdgesGlobal = traceResults.edges;
    
    updateDetailPanel(d);
    updateGraphVisibility();
  } else {
    selectedNode = null;
    relatedNodesGlobal.clear();
    relatedEdgesGlobal.clear();
    updateDetailPanel(null);
    updateGraphVisibility();
  }
}
// [分割 4 / 4]

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onWindowResize() {
  const container = document.getElementById('graph-area');
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

// ── 既存のUI更新系（そのまま維持） ──

function updateDetailPanel(d) {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  if (!d) {
    panel.innerHTML = '<div class="detail-empty">ノードをクリックすると<br>詳細が表示されます。<br><br>ドラッグ：回転<br>ホイール：ズーム</div>';
    return;
  }
  
  if (d._type === 'reaction') {
    renderReactionDetail(panel, d);
  } else {
    renderSubstanceDetail(panel, d);
  }
}

function renderSubstanceDetail(panel, d) {
  const sa = d.snapshot || {};
  const stages = ['post_mixing_g','post_fermentation_1_g','post_dividing_bench_shaping_g','post_proof_g','post_baking_g'];
  const stageLabels = ['ミキシング後','一次発酵後','成形後','ホイロ後','焼成後'];
  const maxVal = Math.max(...stages.map(s => parseFloat(sa[s])||0), 0.001);
  
  const snapshotHTML = Object.keys(sa).length > 0 ? `
    <div class="detail-section">
      <div class="detail-section-title">工程別含量</div>
      <div class="snapshot-bar-wrap">
        ${stages.map((s,i) => {
          const v = sa[s];
          if (!v && v!==0) return '';
          const pct = Math.min(100, (parseFloat(v)||0)/maxVal*100);
          return `<div class="snapshot-bar-row">
            <span class="snapshot-bar-label">${stageLabels[i]}</span>
            <div class="snapshot-bar"><div class="snapshot-bar-fill" style="width:${pct}%"></div></div>
            <span class="snapshot-bar-val">${typeof v==='number'?v.toFixed(2):v}g</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';
  
  panel.innerHTML = `
    <div class="detail-card">
      <div class="detail-id">${d.id}</div>
      <div class="detail-name">${d.name}</div>
      ${d.formula ? `<div class="detail-formula">${d.formula}</div>` : ''}
      ${d.is_volatile ? '<div style="font-size:10px;color:var(--accent3);margin-bottom:6px;">★ 香気物質</div>' : ''}
      ${d.notes && d.notes.length > 0 ? `<div style="font-size:10px;color:var(--text2);margin-top:8px;line-height:1.6;">${d.notes[0]}</div>` : ''}
      ${snapshotHTML}
    </div>`;
}

function renderReactionDetail(panel, d) {
  const color = STEP_COLORS[d.step] || '#666';
  const label = STEP_LABELS[d.step] || d.step;
  
  panel.innerHTML = `
    <div class="detail-card">
      <div class="detail-id">${d.id}</div>
      <div class="detail-name">${d.name}</div>
      <div style="margin-bottom:8px;"><span class="badge badge-step" style="background:${color};">${label}</span></div>
      ${d.equation ? `<div style="font-size:10px;color:var(--text2);line-height:1.6;margin-bottom:8px;">${d.equation}</div>` : ''}
      ${d.notes && d.notes.length > 0 ? `
        <div class="detail-section">
          <div class="detail-section-title">備考</div>
          ${d.notes.map(n=>`<div style="font-size:10px;color:var(--text2);line-height:1.6;">${n}</div>`).join('')}
        </div>` : ''}
    </div>`;
}

// ── 以下リストビューやパラメータなどの関数（従来と同等のダミーを維持、または元コードから移植してください）
function initReactionsView() {}
function initSubstancesView() {}
function initParamsView() {}
