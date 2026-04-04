// ══════════════════════════════════════════════════════════════
// bread for myself — app.js
// 工程順・時間軸階層レイアウト版
// ══════════════════════════════════════════════════════════════

// ─── 定数 ───────────────────────────────────────────────────
const STEP_COLORS = {
  raw:            '#6b7280',
  mixing:         '#4a9eff',
  fermentation_1: '#b5e853',
  dividing:       '#53b5e8',
  bench:          '#53e8b5',
  shaping:        '#c853e8',
  proof:          '#e8b553',
  baking:         '#e85353',
  final:          '#ff9f53',
};

const STEP_LABELS = {
  raw:            '原材料',
  mixing:         'ミキシング',
  fermentation_1: '一次発酵',
  dividing:       '分割',
  bench:          'ベンチ',
  shaping:        '成形',
  proof:          'ホイロ',
  baking:         '焼成',
  final:          '最終生成物',
};

// 各バンドの高さ定義（px）
const BAND_DEFS = [
  { step: 'raw',            label: '原材料',     height: 210 },
  { step: 'mixing',         label: 'ミキシング',  height: 230 },
  { step: 'fermentation_1', label: '一次発酵',   height: 170 },
  { step: 'dividing',       label: '分割',       height: 110 },
  { step: 'bench',          label: 'ベンチ',     height: 120 },
  { step: 'shaping',        label: '成形',       height: 120 },
  { step: 'proof',          label: 'ホイロ',     height: 170 },
  { step: 'baking',         label: '焼成',       height: 280 },
  { step: 'final',          label: '最終生成物',  height: 200 },
];

// 累積Yを計算
let _cy = 60;
const BAND_Y   = {};
const BAND_TOP = {};
const BAND_H   = {};
BAND_DEFS.forEach(b => {
  BAND_TOP[b.step] = _cy;
  BAND_Y[b.step]   = _cy + b.height / 2;
  BAND_H[b.step]   = b.height;
  _cy += b.height;
});
const TOTAL_HEIGHT = _cy + 50;
const CANVAS_WIDTH = 5000;

// ─── 状態 ─────────────────────────────────────────────────
let DATA         = null;
let simulation   = null;
let activeStep   = 'all';
let activeVolatile = 'all';
let searchQuery  = '';
let selectedNode = null;
let relatedSet   = null;

// ─── データ読み込み ────────────────────────────────────────
fetch('data/graph_data.json')
  .then(r => r.json())
  .then(d => {
    DATA = d;
    document.getElementById('stat-sub').textContent   = d.meta.substance_count;
    document.getElementById('stat-rxn').textContent   = d.meta.reaction_count;
    document.getElementById('stat-edge').textContent  = d.meta.edge_count;
    document.getElementById('stat-param').textContent = d.meta.param_count;
    initStepLegend();
    initGraph();
    initReactionsView();
    initSubstancesView();
    initParamsView();
    initNav();
  });

// ─── ナビゲーション ────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById(view + '-view').classList.add('active');
      if (view === 'graph' && simulation) simulation.alpha(0.05).restart();
    });
  });
}

// ─── 工程凡例 ─────────────────────────────────────────────
function initStepLegend() {
  const legend    = document.getElementById('step-legend');
  const stepCounts = {};
  DATA.reactions.forEach(r => { stepCounts[r.step] = (stepCounts[r.step] || 0) + 1; });

  const allItem = document.createElement('div');
  allItem.className   = 'step-item active';
  allItem.dataset.step = 'all';
  allItem.innerHTML = `<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${DATA.reactions.length}</span>`;
  allItem.addEventListener('click', () => filterByStep('all'));
  legend.appendChild(allItem);

  ['mixing','fermentation_1','dividing','bench','shaping','proof','baking'].forEach(step => {
    const item = document.createElement('div');
    item.className   = 'step-item';
    item.dataset.step = step;
    item.innerHTML = `<div class="step-dot" style="background:${STEP_COLORS[step]}"></div><span>${STEP_LABELS[step]}</span><span class="step-count">${stepCounts[step] || 0}</span>`;
    item.addEventListener('click', () => filterByStep(step));
    legend.appendChild(item);
  });
}

function filterByStep(step) {
  activeStep = step;
  document.querySelectorAll('.step-item').forEach(i =>
    i.classList.toggle('active', i.dataset.step === step || (step === 'all' && i.dataset.step === 'all'))
  );
  document.querySelectorAll('.stage-pill').forEach(p => {
    const on = p.dataset.step === step;
    p.classList.toggle('active', on);
    p.style.background = (on && step !== 'all') ? STEP_COLORS[step] : '';
    p.style.color      = (on && step !== 'all') ? '#0d0f0e' : '';
  });
  applyVisibility();
}

// ─── 物質のバンド（Y帯）推定 ─────────────────────────────
function inferBand(n, rxnStepMap, edgesByNode) {
  const ORDER = ['raw','mixing','fermentation_1','dividing','bench','shaping','proof','baking','final'];

  // 「どの反応で生成されたか」→ product edge の source が reaction
  const producedBy = (edgesByNode[n.id] || [])
    .filter(e => e.type === 'product' && rxnStepMap[e.source])
    .map(e => rxnStepMap[e.source]);

  if (producedBy.length) {
    for (const s of ORDER) if (producedBy.includes(s)) return s;
  }

  // tsv 11-* → final
  if ((n.tsv_ids || []).some(t => String(t).startsWith('11-'))) return 'final';

  // 「どの反応で消費されるか」→ 1つ前のバンド
  const consumedBy = (edgesByNode[n.id] || [])
    .filter(e => e.type === 'substrate' && rxnStepMap[e.target])
    .map(e => rxnStepMap[e.target]);

  if (consumedBy.length) {
    const idx = ORDER.indexOf(consumedBy[0]);
    return ORDER[Math.max(0, idx - 1)];
  }

  return 'raw';
}

// ─── メイングラフ ─────────────────────────────────────────
function initGraph() {
  const container = document.getElementById('graph-area');
  let W = container.clientWidth;
  let H = container.clientHeight;

  const svg = d3.select('#graph-canvas').attr('width', W).attr('height', H);

  // エッジ両端インデックス
  const rxnStepMap = {};
  DATA.reactions.forEach(r => rxnStepMap[r.id] = r.step);

  const edgesByNode = {};
  DATA.edges.forEach(e => {
    (edgesByNode[e.source] = edgesByNode[e.source] || []).push(e);
    (edgesByNode[e.target] = edgesByNode[e.target] || []).push(e);
  });

  // ノード生成
  const subNodes = DATA.nodes.map(s => {
    const band = inferBand(s, rxnStepMap, edgesByNode);
    return { ...s, _type: 'substance', _id: s.id, _band: band };
  });
  const rxnNodes = DATA.reactions.map(r => ({
    ...r, _type: 'reaction', _id: r.id, _band: r.step,
  }));

  const nodes = [...subNodes, ...rxnNodes];
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n._id] = n);

  // リンク
  const links = DATA.edges
    .filter(e => nodeMap[e.source] && nodeMap[e.target])
    .map(e => ({ source: e.source, target: e.target, type: e.type, consumed: e.consumed, is_extinct: e.is_extinct }));

  // ── 初期X配置（バンド別にインデックス順）─────────────────
  const bandSubCnt = {};
  const bandRxnCnt = {};
  nodes.forEach(n => {
    if (n._type === 'substance') bandSubCnt[n._band] = (bandSubCnt[n._band] || 0) + 1;
    else                         bandRxnCnt[n._band] = (bandRxnCnt[n._band] || 0) + 1;
  });
  const bandSubIdx = {};
  const bandRxnIdx = {};

  nodes.forEach(n => {
    const band = n._band;
    const cy   = BAND_Y[band] || BAND_Y.raw;
    const bh   = BAND_H[band] || 120;

    if (n._type === 'reaction') {
      const idx   = (bandRxnIdx[band] = (bandRxnIdx[band] || 0));
      const total = bandRxnCnt[band] || 1;
      const span  = Math.min(CANVAS_WIDTH * 0.55, total * 160);
      const sx    = CANVAS_WIDTH / 2 - span / 2;
      n.x     = sx + (idx + 0.5) * (span / total);
      n.y     = cy + (idx % 2 === 0 ? -bh * 0.12 : bh * 0.12);
      n._fy   = cy;
      bandRxnIdx[band]++;
    } else {
      const idx   = (bandSubIdx[band] = (bandSubIdx[band] || 0));
      const total = bandSubCnt[band] || 1;
      const span  = Math.min(CANVAS_WIDTH * 0.82, total * 95 + 200);
      const sx    = CANVAS_WIDTH / 2 - span / 2;
      n.x   = sx + (idx + 0.5) * (span / total);
      n.y   = cy + ((idx % 3) - 1) * bh * 0.22;
      n._fy = cy;
      bandSubIdx[band]++;
    }
  });

  // ── SVG defs ─────────────────────────────────────────────
  const defs = svg.append('defs');

  [
    { id: 'arrow-substrate', color: '#3a5040' },
    { id: 'arrow-product',   color: '#4a8060' },
    { id: 'arrow-extinct',   color: '#773333' },
    { id: 'arrow-hi',        color: '#c8f060' },
  ].forEach(({ id, color }) => {
    defs.append('marker').attr('id', id)
      .attr('viewBox', '0 -4 8 8').attr('refX', 12).attr('refY', 0)
      .attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', color);
  });

  const glow = defs.append('filter').attr('id', 'glow');
  glow.append('feGaussianBlur').attr('stdDeviation', 3).attr('result', 'cb');
  const fm = glow.append('feMerge');
  fm.append('feMergeNode').attr('in', 'cb');
  fm.append('feMergeNode').attr('in', 'SourceGraphic');

  // ── ズーム ───────────────────────────────────────────────
  const zoom = d3.zoom()
    .scaleExtent([0.03, 5])
    .on('zoom', ({ transform }) => g.attr('transform', transform));
  svg.call(zoom);

  const g = svg.append('g');

  // ── 工程帯 ───────────────────────────────────────────────
  const bandGroup = g.append('g').attr('class', 'bands');
  BAND_DEFS.forEach((b, i) => {
    const color = STEP_COLORS[b.step] || '#444';
    const top   = BAND_TOP[b.step];
    const h     = BAND_H[b.step];

    // 背景帯
    bandGroup.append('rect')
      .attr('x', 0).attr('y', top)
      .attr('width', CANVAS_WIDTH).attr('height', h)
      .attr('fill', color)
      .attr('opacity', i % 2 === 0 ? 0.055 : 0.03)
      .attr('class', `band band-${b.step}`);

    // 上境界線
    bandGroup.append('line')
      .attr('x1', 0).attr('y1', top)
      .attr('x2', CANVAS_WIDTH).attr('y2', top)
      .attr('stroke', color).attr('stroke-width', 1.2).attr('opacity', 0.25);

    // 矢印（工程の流れ）
    if (i > 0) {
      bandGroup.append('text')
        .attr('x', 8).attr('y', top - 4)
        .attr('font-family', 'Space Mono, monospace')
        .attr('font-size', 9).attr('fill', color).attr('opacity', 0.5)
        .text('▼');
    }

    // 左ラベル
    bandGroup.append('text')
      .attr('x', 22).attr('y', top + h / 2)
      .attr('dominant-baseline', 'central')
      .attr('font-family', 'Shippori Mincho, serif')
      .attr('font-size', 14).attr('font-weight', 600)
      .attr('fill', color).attr('opacity', 0.55)
      .text(b.label);

    // 右端ラベル（反応数）
    const cnt = DATA.reactions.filter(r => r.step === b.step).length;
    if (cnt > 0) {
      bandGroup.append('text')
        .attr('x', CANVAS_WIDTH - 20).attr('y', top + h / 2)
        .attr('text-anchor', 'end').attr('dominant-baseline', 'central')
        .attr('font-family', 'Space Mono, monospace')
        .attr('font-size', 10).attr('fill', color).attr('opacity', 0.35)
        .text(`${cnt} reactions`);
    }
  });

  // ── フォースシミュレーション ─────────────────────────────
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d._id)
      .distance(d => d.type === 'product' ? 110 : 85)
      .strength(0.2))
    .force('charge', d3.forceManyBody().strength(d => d._type === 'reaction' ? -200 : -70))
    .force('collision', d3.forceCollide(d => d._type === 'reaction' ? 20 : 11).strength(0.9))
    // X: 緩やかな整列
    .force('x', d3.forceX(d => d.x).strength(0.12))
    // Y: バンド中心に強力固定
    .force('y', d3.forceY(d => d._fy || BAND_Y[d._band] || 500).strength(0.92))
    .alphaDecay(0.018)
    .velocityDecay(0.48);

  // ── リンク ───────────────────────────────────────────────
  const linkGroup = g.append('g').attr('class', 'links');
  const link = linkGroup.selectAll('line')
    .data(links).enter().append('line')
    .attr('class', d => `edge edge-${d.type}`)
    .attr('stroke', d => d.is_extinct ? '#553333' : d.type === 'product' ? '#2a5540' : '#263832')
    .attr('stroke-width', 1.2)
    .attr('stroke-opacity', 0.5)
    .attr('marker-end', d => `url(#arrow-${d.is_extinct ? 'extinct' : d.type})`);

  // ── ノード ───────────────────────────────────────────────
  const nodeGroup = g.append('g').attr('class', 'nodes');
  const node = nodeGroup.selectAll('g')
    .data(nodes).enter().append('g')
    .attr('class', d => `node node-${d._type}`)
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag',  dragged)
      .on('end',   dragEnd))
    .on('click', (ev, d) => { ev.stopPropagation(); selectNode(d); })
    .on('mouseover', (ev, d) => showTooltip(ev, d))
    .on('mousemove', ev => moveTooltip(ev))
    .on('mouseout',  () => hideTooltip());

  // 物質：円
  node.filter(d => d._type === 'substance')
    .append('circle')
    .attr('r', d => d.is_volatile ? 7 : (d.reaction_roles?.length || 0) > 2 ? 6 : 5)
    .attr('fill', d => {
      const c = d3.color(STEP_COLORS[d._band] || '#4a8060');
      return c ? c.darker(1.7).toString() : '#2a4035';
    })
    .attr('stroke', d => STEP_COLORS[d._band] || '#3a5040')
    .attr('stroke-width', d => d.is_volatile ? 1.8 : 0.9)
    .attr('stroke-opacity', 0.75);

  // 香気物質：外周点線リング
  node.filter(d => d._type === 'substance' && d.is_volatile)
    .append('circle')
    .attr('r', 11)
    .attr('fill', 'none')
    .attr('stroke', STEP_COLORS.baking)
    .attr('stroke-width', 0.9)
    .attr('stroke-opacity', 0.4)
    .attr('stroke-dasharray', '3,2');

  // 反応：ダイヤ
  node.filter(d => d._type === 'reaction')
    .append('polygon')
    .attr('points', () => { const s = 10; return `0,${-s} ${s * 0.9},0 0,${s} ${-s * 0.9},0`; })
    .attr('fill', d => STEP_COLORS[d.step] || '#666')
    .attr('fill-opacity', 0.85)
    .attr('stroke', '#111').attr('stroke-width', 0.6);

  // 反応IDラベル
  node.filter(d => d._type === 'reaction')
    .append('text')
    .text(d => d.id)
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', 6.5).attr('font-family', 'Space Mono, monospace')
    .attr('fill', '#0a0e0b').attr('font-weight', 'bold')
    .attr('pointer-events', 'none');

  // ── Tick ─────────────────────────────────────────────────
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // ── グローバル参照 ────────────────────────────────────────
  window._graph = { svg, g, zoom, node, link, nodes, links, nodeMap, container };

  // ── コントロール ─────────────────────────────────────────
  document.getElementById('zoom-in').onclick    = () => svg.transition().duration(300).call(zoom.scaleBy, 1.5);
  document.getElementById('zoom-out').onclick   = () => svg.transition().duration(300).call(zoom.scaleBy, 0.67);
  document.getElementById('zoom-reset').onclick = () => fitView();

  // 初期ズーム
  fitView(false);

  // ステージピル
  document.querySelectorAll('.stage-pill').forEach(p =>
    p.addEventListener('click', () => filterByStep(p.dataset.step))
  );

  // 検索
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    applyVisibility();
  });

  // 揮発フィルター
  document.querySelectorAll('.filter-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeVolatile = btn.dataset.filter;
      applyVisibility();
    })
  );

  // 背景クリックで解除
  svg.on('click', () => {
    selectedNode = null; relatedSet = null;
    updateDetailPanel(null);
    applyVisibility();
  });

  updateInfo();

  window.addEventListener('resize', () => {
    const W2 = container.clientWidth;
    const H2 = container.clientHeight;
    svg.attr('width', W2).attr('height', H2);
    simulation.alpha(0.05).restart();
  });
}

// ─── 全体フィット ─────────────────────────────────────────
function fitView(animate = true) {
  const { svg, zoom, container } = window._graph;
  const W = container.clientWidth;
  const H = container.clientHeight;
  const scale = Math.min(W / CANVAS_WIDTH, H / TOTAL_HEIGHT) * 0.93;
  const tx = (W - CANVAS_WIDTH * scale) / 2;
  const ty = 8;
  if (animate) {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  } else {
    svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
  }
}

// ─── 関連ノード収集（選択→前後2ホップ）──────────────────
function collectRelated(nodeId) {
  const related = new Set([nodeId]);
  const { nodeMap } = window._graph;

  DATA.edges.forEach(e => {
    if (e.source !== nodeId && e.target !== nodeId) return;
    related.add(e.source);
    related.add(e.target);
    // 間に挟まる反応ノードがあれば、その先も1段追加
    const other = e.source === nodeId ? e.target : e.source;
    if (nodeMap[other]?._type === 'reaction') {
      DATA.edges.forEach(e2 => {
        if (e2.source === other || e2.target === other) {
          related.add(e2.source);
          related.add(e2.target);
        }
      });
    }
  });
  return related;
}

// ─── 可視性適用 ──────────────────────────────────────────
function applyVisibility() {
  if (!window._graph) return;
  const { node, link, nodeMap } = window._graph;

  const visRxnIds = activeStep === 'all'
    ? new Set(DATA.reactions.map(r => r.id))
    : new Set(DATA.reactions.filter(r => r.step === activeStep).map(r => r.id));

  const connSubIds = new Set();
  if (activeStep !== 'all') {
    DATA.edges.forEach(e => {
      if (visRxnIds.has(e.source) || visRxnIds.has(e.target)) {
        if (!nodeMap[e.source]?._type || nodeMap[e.source]._type !== 'reaction') connSubIds.add(e.source);
        if (!nodeMap[e.target]?._type || nodeMap[e.target]._type !== 'reaction') connSubIds.add(e.target);
      }
    });
  }

  // ノード opacity
  node.attr('opacity', d => {
    if (relatedSet) return relatedSet.has(d._id) ? 1 : 0.04;
    if (searchQuery) {
      const hit = (d.name || '').toLowerCase().includes(searchQuery)
               || (d.formula || '').toLowerCase().includes(searchQuery)
               || d.id.toLowerCase().includes(searchQuery);
      if (!hit) return 0.04;
    }
    if (activeStep !== 'all') {
      if (d._type === 'reaction' && !visRxnIds.has(d.id))  return 0.04;
      if (d._type === 'substance' && !connSubIds.has(d.id)) return 0.04;
    }
    if (activeVolatile === 'volatile'    && !d.is_volatile) return 0.06;
    if (activeVolatile === 'nonvolatile' &&  d.is_volatile) return 0.06;
    return 1;
  });

  // リンク
  link
    .attr('stroke-width', d => {
      if (!relatedSet) return 1.2;
      const s = typeof d.source === 'object' ? d.source._id : d.source;
      const t = typeof d.target === 'object' ? d.target._id : d.target;
      return (relatedSet.has(s) && relatedSet.has(t)) ? 3 : 0.3;
    })
    .attr('stroke', d => {
      const s = typeof d.source === 'object' ? d.source._id : d.source;
      const t = typeof d.target === 'object' ? d.target._id : d.target;
      if (relatedSet && relatedSet.has(s) && relatedSet.has(t)) {
        return d.type === 'product' ? '#b5e853' : '#4a9eff';
      }
      return d.is_extinct ? '#553333' : d.type === 'product' ? '#2a5540' : '#263832';
    })
    .attr('stroke-opacity', d => {
      const s = typeof d.source === 'object' ? d.source._id : d.source;
      const t = typeof d.target === 'object' ? d.target._id : d.target;
      if (relatedSet) return (relatedSet.has(s) && relatedSet.has(t)) ? 0.92 : 0.03;
      if (activeStep !== 'all' && !visRxnIds.has(s) && !visRxnIds.has(t)) return 0.03;
      return 0.5;
    })
    .attr('marker-end', d => {
      const s = typeof d.source === 'object' ? d.source._id : d.source;
      const t = typeof d.target === 'object' ? d.target._id : d.target;
      if (relatedSet && relatedSet.has(s) && relatedSet.has(t)) return 'url(#arrow-hi)';
      return `url(#arrow-${d.is_extinct ? 'extinct' : d.type})`;
    });

  updateInfo();
}

function updateInfo() {
  document.getElementById('info-node-count').textContent = DATA.nodes.length + DATA.reactions.length;
  document.getElementById('info-edge-count').textContent = DATA.edges.length;
}

// ─── ノード選択 ───────────────────────────────────────────
function selectNode(d) {
  selectedNode = d;
  relatedSet   = collectRelated(d._id);
  updateDetailPanel(d);
  applyVisibility();
  panToNode(d);
}

function panToNode(d) {
  const { svg, zoom, container } = window._graph;
  const W = container.clientWidth;
  const H = container.clientHeight;
  const cur = d3.zoomTransform(svg.node());
  const scale = Math.max(cur.k, 0.5);
  svg.transition().duration(400).call(
    zoom.transform,
    d3.zoomIdentity.translate(W / 2 - d.x * scale, H / 2 - d.y * scale).scale(scale)
  );
}

// ─── 詳細パネル ───────────────────────────────────────────
function updateDetailPanel(d) {
  const panel = document.getElementById('detail-panel');
  if (!d) {
    panel.innerHTML = `<div class="detail-empty">
      ノードをクリックすると<br>詳細が表示されます。<br><br>
      <span style="color:var(--accent)">◆</span> ダイヤ = 反応<br>
      <span style="color:var(--accent2)">●</span> 丸 = 物質<br>
      <span style="color:${STEP_COLORS.baking}">⊙</span> 二重丸 = 香気物質<br><br>
      ドラッグ / スクロールで移動
    </div>`;
    return;
  }
  d._type === 'reaction' ? renderReactionDetail(panel, d) : renderSubstanceDetail(panel, d);
}

function renderSubstanceDetail(panel, d) {
  const sa     = d.snapshot || {};
  const stages = ['post_mixing_g','post_fermentation_1_g','post_dividing_bench_shaping_g','post_proof_g','post_baking_g'];
  const stageL = ['ミキシング後','発酵後','成形後','ホイロ後','焼成後'];
  const vals   = stages.map(s => parseFloat(sa[s]) || 0);
  const maxV   = Math.max(...vals, 0.001);
  const bc     = STEP_COLORS[d._band] || '#4a8060';

  const snapHTML = vals.some(v => v > 0) ? `
    <div class="detail-section">
      <div class="detail-section-title">工程別含量</div>
      <div class="snapshot-bar-wrap">
        ${stages.map((s, i) => {
          const v = sa[s]; if (!v && v !== 0) return '';
          const pct = Math.min(100, (parseFloat(v) || 0) / maxV * 100);
          return `<div class="snapshot-bar-row">
            <span class="snapshot-bar-label">${stageL[i]}</span>
            <div class="snapshot-bar"><div class="snapshot-bar-fill" style="width:${pct}%;background:${bc}"></div></div>
            <span class="snapshot-bar-val">${typeof v === 'number' ? v.toFixed(2) : v}g</span>
          </div>`;
        }).join('')}
      </div>
    </div>` : '';

  const roles = d.reaction_roles || [];
  const rolesHTML = roles.length ? `
    <div class="detail-section">
      <div class="detail-section-title">反応への関与 (${roles.length})</div>
      ${roles.slice(0, 8).map(r => `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:3px;">
          <span style="font-size:10px;color:${STEP_COLORS[r.step]||'#53e8b5'};min-width:44px;font-weight:bold;">${r.reaction_id}</span>
          <span style="font-size:10px;color:${r.consumed?'#e85353':'#53e8b5'}">${r.role}${r.consumed?' (消費)':' (触媒)'}</span>
          ${r.is_extinct?'<span style="font-size:9px;color:#e85353;margin-left:4px;">消滅</span>':''}
        </div>`).join('')}
      ${roles.length > 8 ? `<div style="font-size:9px;color:var(--text3)">+ ${roles.length-8} 件</div>` : ''}
    </div>` : '';

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${d.id}</div>
    <div class="detail-name">${d.name}</div>
    ${d.formula ? `<div class="detail-formula">${d.formula}</div>` : ''}
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
      <span class="badge badge-step" style="background:${bc}">${STEP_LABELS[d._band]||d._band}</span>
      ${d.is_volatile?`<span style="font-size:10px;color:${STEP_COLORS.baking};padding:2px 6px;border:1px solid ${STEP_COLORS.baking};border-radius:2px;">★ 香気物質</span>`:''}
    </div>
    ${d.flavor_group?`<div class="detail-row"><span class="detail-label">フレーバー群</span><span class="detail-value">${d.flavor_group}</span></div>`:''}
    ${d.nutrition_cat?`<div class="detail-row"><span class="detail-label">栄養カテゴリ</span><span class="detail-value">${d.nutrition_cat}</span></div>`:''}
    ${d.notes?.[0]?`<div style="font-size:10px;color:var(--text2);margin-top:8px;line-height:1.65;border-left:2px solid ${bc};padding-left:8px;">${d.notes[0]}</div>`:''}
    ${snapHTML}${rolesHTML}
  </div>`;
}

function renderReactionDetail(panel, d) {
  const color = STEP_COLORS[d.step] || '#666';
  const label = STEP_LABELS[d.step] || d.step;
  const { nodeMap } = window._graph;

  const getId = x => typeof x === 'object' ? x._id : x;

  const subs  = DATA.edges
    .filter(e => getId(e.target) === d.id && e.type === 'substrate')
    .map(e => nodeMap[getId(e.source)]).filter(Boolean);
  const prods = DATA.edges
    .filter(e => getId(e.source) === d.id && e.type === 'product')
    .map(e => nodeMap[getId(e.target)]).filter(Boolean);

  panel.innerHTML = `<div class="detail-card">
    <div class="detail-id">${d.id}</div>
    <div class="detail-name">${d.name}</div>
    <span class="badge badge-step" style="background:${color};margin-bottom:8px;display:inline-block">${label}</span>
    ${d.equation?`<div style="font-size:10px;color:var(--text2);line-height:1.65;margin:8px 0;border-left:2px solid ${color};padding-left:8px">${d.equation}</div>`:''}
    ${d.equation_formula?`<div class="detail-formula" style="font-size:9px;margin-bottom:10px">${d.equation_formula}</div>`:''}

    ${subs.length?`
      <div class="detail-section">
        <div class="detail-section-title">▶ 基質 (${subs.length})</div>
        ${subs.slice(0,8).map(s=>`
          <div style="font-size:10px;color:var(--text2);margin-bottom:2px;display:flex;gap:4px;align-items:baseline">
            <span style="color:${STEP_COLORS[s._band||'raw']||'#4a9eff'};font-size:8px">●</span>
            ${s.name}${s.formula?`<span style="color:var(--text3);font-size:9px"> ${s.formula}</span>`:''}
          </div>`).join('')}
        ${subs.length>8?`<div style="font-size:9px;color:var(--text3)">+ ${subs.length-8} 件</div>`:''}
      </div>`:''}

    ${prods.length?`
      <div class="detail-section">
        <div class="detail-section-title">✦ 生成物 (${prods.length})</div>
        ${prods.map(s=>`
          <div style="font-size:10px;color:${s.is_volatile?'var(--accent3)':'var(--accent2)'};margin-bottom:2px">
            ${s.name}${s.is_volatile?' <span style="font-size:9px">★香気</span>':''}
          </div>`).join('')}
      </div>`:''}

    ${d.notes?.length?`
      <div class="detail-section">
        <div class="detail-section-title">備考</div>
        ${d.notes.map(n=>`<div style="font-size:10px;color:var(--text2);line-height:1.6">${n}</div>`).join('')}
      </div>`:''}
  </div>`;
}

// ─── ドラッグ（Y軸はバンド内に制限）────────────────────
function dragStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.12).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) {
  d.fx = event.x;
  const top = BAND_TOP[d._band] || 0;
  const bot = top + (BAND_H[d._band] || 120);
  d.fy = Math.max(top + 12, Math.min(bot - 12, event.y));
}
function dragEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// ─── ツールチップ ─────────────────────────────────────────
function showTooltip(ev, d) {
  document.getElementById('tt-name').textContent = d.name || d.id;
  document.getElementById('tt-sub').textContent  = d._type === 'reaction'
    ? `${STEP_LABELS[d.step]||d.step}  ·  ${(d.equation||'').slice(0,60)}`
    : `${d.formula||''}  ${d.is_volatile?'[ 香気物質 ]':''}`.trim();
  document.getElementById('tooltip').style.opacity = '1';
  moveTooltip(ev);
}
function moveTooltip(ev) {
  const tt = document.getElementById('tooltip');
  tt.style.left = Math.min(ev.clientX + 14, window.innerWidth - 260) + 'px';
  tt.style.top  = Math.max(ev.clientY - 30, 10) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').style.opacity = '0'; }

// ══════════════════════════════════════════════════════════════
// ── 反応一覧ビュー
// ══════════════════════════════════════════════════════════════
function initReactionsView() {
  const filterDiv = document.getElementById('rxn-step-filter');

  const ab = document.createElement('button');
  ab.className = 'filter-btn active'; ab.textContent = '全工程'; ab.dataset.step = 'all';
  filterDiv.appendChild(ab);

  ['mixing','fermentation_1','dividing','bench','shaping','proof','baking'].forEach(step => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.textContent = STEP_LABELS[step];
    btn.dataset.step = step;
    btn.style.borderColor = STEP_COLORS[step];
    filterDiv.appendChild(btn);
  });

  let rxnStep = 'all';
  filterDiv.addEventListener('click', e => {
    if (!e.target.classList.contains('filter-btn')) return;
    filterDiv.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    rxnStep = e.target.dataset.step;
    renderRxnGrid();
  });
  document.getElementById('rxn-search').addEventListener('input', renderRxnGrid);

  function renderRxnGrid() {
    const q    = document.getElementById('rxn-search').value.toLowerCase();
    const grid = document.getElementById('rxn-grid');
    grid.innerHTML = '';
    DATA.reactions
      .filter(r => rxnStep === 'all' || r.step === rxnStep)
      .filter(r => !q || (r.name||'').toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
      .forEach(r => {
        const color = STEP_COLORS[r.step] || '#666';
        const subs  = DATA.edges.filter(e => e.target === r.id).length;
        const prods = DATA.edges.filter(e => e.source === r.id).length;
        const card  = document.createElement('div');
        card.className = 'rxn-card';
        card.style.cssText += `;border-left:3px solid ${color}`;
        card.innerHTML = `
          <div><span class="rxn-step-badge" style="background:${color}">${STEP_LABELS[r.step]||r.step}</span></div>
          <div class="rxn-id">${r.id}</div>
          <div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div class="rxn-subs" style="margin-top:8px">
            <span style="color:var(--text3)">基質 ${subs}</span>
            <span style="color:var(--text3);margin:0 4px">→</span>
            <span style="color:${color}">生成物 ${prods}</span>
          </div>`;
        card.addEventListener('click', () => jumpToGraph(r.id));
        grid.appendChild(card);
      });
  }
  renderRxnGrid();
}

// ══════════════════════════════════════════════════════════════
// ── 物質一覧ビュー
// ══════════════════════════════════════════════════════════════
function initSubstancesView() {
  document.getElementById('sub-search').addEventListener('input', e => renderSubTable(e.target.value.toLowerCase()));
  renderSubTable('');
}
function renderSubTable(q) {
  const tbody    = document.getElementById('sub-tbody');
  const filtered = DATA.nodes.filter(s =>
    !q || (s.name||'').toLowerCase().includes(q) ||
    (s.formula||'').toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
  );
  document.getElementById('sub-count-label').textContent = `${filtered.length} / ${DATA.nodes.length} 件`;
  tbody.innerHTML = '';
  filtered.slice(0, 300).forEach(s => {
    const roles = (s.reaction_roles||[]).length;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-id">${s.id}</td>
      <td class="td-name">${s.name}</td>
      <td class="td-formula">${s.formula||'—'}</td>
      <td class="td-volatile">${s.is_volatile?'★ 香気':'—'}</td>
      <td style="font-size:10px;color:var(--text3)">${s.nutrition_cat||'—'}</td>
      <td class="td-roles">${roles>0?`<span style="color:var(--accent2)">${roles}</span>`:'—'}</td>`;
    tr.addEventListener('click', () => jumpToGraph(s.id));
    tbody.appendChild(tr);
  });
  if (filtered.length > 300) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" style="text-align:center;color:var(--text3);font-size:10px;padding:12px">+ ${filtered.length-300} 件（検索で絞り込み）</td>`;
    tbody.appendChild(tr);
  }
}

// ─── グラフへジャンプ ─────────────────────────────────────
function jumpToGraph(id) {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('graph-view').classList.add('active');
  if (simulation) simulation.alpha(0.05).restart();
  setTimeout(() => {
    const n = window._graph?.nodes.find(n => n._id === id);
    if (n) selectNode(n);
  }, 80);
}

// ══════════════════════════════════════════════════════════════
// ── パラメータービュー
// ══════════════════════════════════════════════════════════════
function initParamsView() {
  const view = document.getElementById('params-view');
  DATA.params.forEach(p => {
    const card   = document.createElement('div');
    card.className = 'param-card';
    const isRange = typeof p.range?.min === 'number' && typeof p.range?.max === 'number';
    const min = isRange ? p.range.min : 0;
    const max = isRange ? p.range.max : 100;
    const val = typeof p.value === 'number' ? p.value : (min+max)/2;
    const affects = (p.affects_reactions||[]).slice(0,6);

    card.innerHTML = `
      <div class="param-id">${p.param_id}</div>
      <div class="param-name">${p.name}</div>
      <div class="param-val-row">
        <span class="param-unit">${p.unit}</span>
        <span class="param-val-display" id="pv-${p.param_id}">${typeof val==='number'?val.toFixed(1):val}</span>
      </div>
      ${isRange?`
        <div class="param-slider-wrap">
          <input type="range" class="param-slider" min="${min}" max="${max}" value="${Math.max(min,Math.min(max,val))}" step="${(max-min)/100}">
          <div class="param-range">${min} — ${max} ${p.unit}</div>
        </div>`:`<div class="param-range">${JSON.stringify(p.range?.allowed||p.range?.stages||p.value)}</div>`}
      ${affects.length?`
        <div class="param-affects">
          <div class="param-affects-title">影響する反応</div>
          ${affects.map(a=>{
            const score=a.score||0, pct=score*100;
            const color=score>0.8?'#e85353':score>0.5?'#e8b553':'#53e8b5';
            return `<div class="affect-row">
              <span class="affect-rxn">${a.reaction_id}</span>
              <div class="affect-bar"><div class="affect-fill" style="width:${pct}%;background:${color}"></div></div>
              <span class="affect-label">${a.sensitivity}</span>
            </div>`;
          }).join('')}
        </div>`:''}`;

    if (isRange) {
      const slider = card.querySelector('.param-slider');
      const disp   = card.querySelector(`#pv-${p.param_id}`);
      slider.addEventListener('input', () => disp.textContent = parseFloat(slider.value).toFixed(1));
    }
    view.appendChild(card);
  });
}
