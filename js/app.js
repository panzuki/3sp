// ── bread for myself — app.js (3Dクリック補正＆完全版) ──
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
  final:          '#ff9f53'
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

let scene, camera, renderer, controls;
let nodeMeshMap = new Map();
let edgeLineMap = new Map();
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

// 起点から終点、終点から起点まで再帰的にすべてを繋ぐ関数
function collectAllConnectedRecursive(startNodeId) {
  const visitedNodes = new Set();
  const visitedEdges = new Set();
  
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
  
  traceUpstream(startNodeId);
  visitedNodes.delete(startNodeId);
  traceDownstream(startNodeId);
  
  return { nodes: visitedNodes, edges: visitedEdges };
}

// ── 3D GRAPH ──
function init3DGraph() {
  const container = document.getElementById('graph-area');
  if (!container) return;
  
  const oldSvg = document.getElementById('graph-canvas');
  if (oldSvg) oldSvg.style.display = 'none';
  
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
  
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(200, 500, 300);
  scene.add(dirLight);
  
  raycaster = new THREE.Raycaster();
  raycaster.params.Line.threshold = 3; // 判定の幅を持たせる
  mouse = new THREE.Vector2();
  
  calculateNodePositions();
  create3DSceneObjects();
  
  window.addEventListener('resize', onWindowResize);
  
  // クリックズレ対策：mousedownとmouseupの組み合わせで誤作動を防ぐ
  let isDragging = false;
  renderer.domElement.addEventListener('mousedown', () => { isDragging = false; });
  renderer.domElement.addEventListener('mousemove', () => { isDragging = true; });
  renderer.domElement.addEventListener('mouseup', (e) => {
    if (!isDragging) onDocumentMouseDown(e);
  });
  
  animate();
}

function calculateNodePositions() {
  const stepCounters = {};
  
  DATA.nodes.forEach((n, i) => {
    const roles = n.reaction_roles || [];
    let step = 'raw';
    if (roles.length > 0) step = roles[0].step || 'raw';
    n.step = step;
    
    stepCounters[step] = (stepCounters[step] || 0) + 1;
    const count = stepCounters[step];
    
    const angle = count * 0.5;
    const radius = 120 + (count * 4);
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle) * radius;
    n.z = STEP_Z[step] || 0;
  });
  
  DATA.reactions.forEach((r, i) => {
    const step = r.step || 'raw';
    stepCounters[step] = (stepCounters[step] || 0) + 1;
    const count = stepCounters[step];
    
    const angle = count * 0.6;
    const radius = 40 + (count * 3);
    r.x = Math.cos(angle) * radius;
    r.y = Math.sin(angle) * radius;
    r.z = STEP_Z[step] || 0;
    r._type = 'reaction';
  });
}


// [分割 3 / 4]

function create3DSceneObjects() {
  const sphereGeo = new THREE.SphereGeometry(1, 24, 24); // 解像度を上げて綺麗に
  const diamondGeo = new THREE.ConeGeometry(7, 14, 4);
  
  const createMesh = (d, isReaction) => {
    let material;
    let size = 7;
    
    if (isReaction) {
      const color = STEP_COLORS[d.step] || '#666';
      material = new THREE.MeshStandardMaterial({ color: color, roughness: 0.4 });
      size = 1; // コーンはscaleではなく元サイズで
    } else {
      let color = '#2a4035';
      if (d.is_volatile) color = '#b5e853';
      else if (d.flavor_group) color = '#53e8b5';
      
      material = new THREE.MeshStandardMaterial({ color: color, roughness: 0.3 });
      if (d.is_volatile) size = 11;
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
      
      const material = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.4 });
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
    let visible = true;
    if (activeStep !== 'all' && d.step !== activeStep) visible = false;
    mesh.visible = visible;
    
    if (selectedNode) {
      const isRelated = relatedNodesGlobal.has(id) || id === selectedNode.id;
      mesh.material.opacity = isRelated ? 1.0 : 0.08;
      mesh.material.transparent = true;
    } else {
      mesh.material.opacity = 1.0;
      mesh.material.transparent = false;
    }
  });
  
  edgeLineMap.forEach((line, e) => {
    if (selectedNode) {
      const isRelated = relatedEdgesGlobal.has(e);
      line.material.opacity = isRelated ? 1.0 : 0.02;
    } else {
      line.material.opacity = 0.4;
    }
  });
}

function onDocumentMouseDown(event) {
  const container = document.getElementById('graph-area');
  const rect = container.getBoundingClientRect();
  
  // ズレ補正：クライアント座標から領域の位置を正確に引く
  mouse.x = ((event.clientX - rect.left) / container.clientWidth) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / container.clientHeight) * 2 + 1;
  
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(Array.from(nodeMeshMap.values()));
  
  if (intersects.length > 0) {
    const clickedMesh = intersects[0].object;
    const d = clickedMesh.userData.data;
    
    selectedNode = d;
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

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// [分割 4 / 4]

function onWindowResize() {
  const container = document.getElementById('graph-area');
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

function updateDetailPanel(d) {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  if (!d) {
    panel.innerHTML = '<div class="detail-empty">球体をタップすると<br>詳細が表示されます。<br><br>ドラッグ：回転<br>ホイール：ズーム</div>';
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
    </div>`;
}

// ── UIタブ（リスト）の復元 ──
function initReactionsView() {
  const grid = document.getElementById('rxn-grid');
  if (!grid) return;
  grid.innerHTML = '';
  DATA.reactions.forEach(r => {
    const card = document.createElement('div');
    card.className = 'rxn-card';
    card.innerHTML = `<div class="rxn-id">${r.id}</div><div class="rxn-name">${r.name}</div>`;
    grid.appendChild(card);
  });
}

function initSubstancesView() {
  const tbody = document.getElementById('sub-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  DATA.nodes.slice(0, 100).forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.id}</td><td>${s.name}</td><td>${s.formula||'—'}</td><td>${s.is_volatile?'★':''}</td><td>${s.nutrition_cat||''}</td><td>—</td>`;
    tbody.appendChild(tr);
  });
}

function initParamsView() {
  const view = document.getElementById('params-view');
  if (!view) return;
  view.innerHTML = '';
  DATA.params.forEach(p => {
    const card = document.createElement('div');
    card.className = 'param-card';
    card.innerHTML = `<div class="param-name">${p.name}</div><div class="param-val-row">${p.value} ${p.unit}</div>`;
    view.appendChild(card);
  });
}
