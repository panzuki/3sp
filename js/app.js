// ── bread for myself — app.js ──

const STEP_COLORS = {
  mixing:         '#4a9eff',
  fermentation_1: '#b5e853',
  dividing:       '#53b5e8',
  bench:          '#53e8b5',
  shaping:        '#c853e8',
  proof:          '#e8b553',
  baking:         '#e85353',
};
const STEP_LABELS = {
  mixing: 'ミキシング',
  fermentation_1: '一次発酵',
  dividing: '分割',
  bench: 'ベンチ',
  shaping: '成形',
  proof: 'ホイロ',
  baking: '焼成',
};

let DATA = null;
let simulation = null;
let activeFilter = 'all';
let activeStep = 'all';
let activeVolatile = 'all';
let searchQuery = '';
let selectedNode = null;

// ─ Data loading ─
fetch('data/graph_data.json')
  .then(r => r.json())
  .then(d => {
    DATA = d;
    // Update stats
    document.getElementById('stat-sub').textContent = d.meta.substance_count;
    document.getElementById('stat-rxn').textContent = d.meta.reaction_count;
    document.getElementById('stat-edge').textContent = d.meta.edge_count;
    document.getElementById('stat-param').textContent = d.meta.param_count;
    
    initStepLegend();
    initGraph();
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
      if (view === 'graph' && simulation) simulation.restart();
    });
  });
}

// ─ Step legend ─
function initStepLegend() {
  const legend = document.getElementById('step-legend');
  const stepCounts = {};
  DATA.reactions.forEach(r => { stepCounts[r.step] = (stepCounts[r.step]||0)+1; });
  
  // All
  const allItem = document.createElement('div');
  allItem.className = 'step-item active';
  allItem.dataset.step = 'all';
  allItem.innerHTML = `<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${DATA.reactions.length}</span>`;
  allItem.addEventListener('click', () => filterByStep('all'));
  legend.appendChild(allItem);
  
  Object.entries(STEP_COLORS).forEach(([step, color]) => {
    const item = document.createElement('div');
    item.className = 'step-item';
    item.dataset.step = step;
    item.innerHTML = `<div class="step-dot" style="background:${color}"></div><span>${STEP_LABELS[step]||step}</span><span class="step-count">${stepCounts[step]||0}</span>`;
    item.addEventListener('click', () => filterByStep(step));
    legend.appendChild(item);
  });
}

function filterByStep(step) {
  activeStep = step;
  document.querySelectorAll('.step-item').forEach(i => {
    i.classList.toggle('active', i.dataset.step === step || (step==='all' && i.dataset.step==='all'));
  });
  document.querySelectorAll('.stage-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.step === step);
    if (p.dataset.step === step && step !== 'all') {
      p.style.background = STEP_COLORS[step];
      p.style.color = '#0d0f0e';
    } else if (p.dataset.step !== step) {
      p.style.background = '';
      p.style.color = '';
    }
  });
  updateGraphVisibility();
}

// ── GRAPH ──
function initGraph() {
  const svg = d3.select('#graph-canvas');
  const container = document.getElementById('graph-area');
  
  let W = container.clientWidth;
  let H = container.clientHeight;
  
  svg.attr('width', W).attr('height', H);
  
  // Build combined nodes/links
  // nodes = substances + reactions
  const nodes = [];
  const nodeMap = {};
  
  // Substance nodes
  DATA.nodes.forEach(s => {
    const n = { ...s, _type: 'substance', _id: s.id };
    nodes.push(n);
    nodeMap[s.id] = n;
  });
  
  // Reaction nodes
  DATA.reactions.forEach(r => {
    const n = { ...r, _type: 'reaction', _id: r.id };
    nodes.push(n);
    nodeMap[r.id] = n;
  });
  
  // Links
  const links = DATA.edges
    .filter(e => nodeMap[e.source] && nodeMap[e.target])
    .map(e => ({
      source: e.source,
      target: e.target,
      type: e.type,
      consumed: e.consumed,
      is_extinct: e.is_extinct,
    }));
  
  // Defs
  const defs = svg.append('defs');
  
  // Arrow markers
  const arrowColors = {
    substrate: '#3a4a3c',
    product: '#2a4030',
    consumed: '#553333',
  };
  ['substrate','product','extinct'].forEach(t => {
    const color = t==='extinct' ? '#553333' : (t==='product' ? '#2a5040' : '#3a4a3c');
    defs.append('marker')
      .attr('id', `arrow-${t}`)
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 10).attr('refY', 0)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', color);
  });
  
  // Radial gradient for bg
  const radial = defs.append('radialGradient')
    .attr('id', 'bg-grad')
    .attr('cx','50%').attr('cy','50%').attr('r','50%');
  radial.append('stop').attr('offset','0%').attr('stop-color','#1a2020').attr('stop-opacity',0.3);
  radial.append('stop').attr('offset','100%').attr('stop-color','#0d0f0e').attr('stop-opacity',0);

  // Background
  svg.append('rect').attr('width',W).attr('height',H)
    .attr('fill','url(#bg-grad)');
  
  // Zoom
  const zoom = d3.zoom()
    .scaleExtent([0.05, 3])
    .on('zoom', ({transform}) => {
      g.attr('transform', transform);
    });
  svg.call(zoom);
  
  const g = svg.append('g');
  
  // Force simulation
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d._id).distance(d => {
      if (d.type === 'product') return 70;
      return 50;
    }).strength(0.4))
    .force('charge', d3.forceManyBody().strength(d => d._type==='reaction' ? -200 : -80))
    .force('center', d3.forceCenter(W/2, H/2))
    .force('collision', d3.forceCollide(d => d._type==='reaction' ? 16 : 9))
    .alphaDecay(0.015);
  
  // Links
  const link = g.append('g').attr('class','links')
    .selectAll('line')
    .data(links)
    .enter().append('line')
    .attr('class', d => `edge edge-${d.type}`)
    .attr('stroke', d => {
      if (d.is_extinct) return '#553333';
      if (d.type === 'product') return '#2a5040';
      return '#2a3830';
    })
    .attr('stroke-width', 1.2)
    .attr('stroke-opacity', 0.7)
    .attr('marker-end', d => `url(#arrow-${d.is_extinct?'extinct':d.type})`);
  
  // Nodes group
  const node = g.append('g').attr('class','nodes')
    .selectAll('g')
    .data(nodes)
    .enter().append('g')
    .attr('class', d => `node node-${d._type}`)
    .call(d3.drag()
      .on('start', dragStart)
      .on('drag', dragged)
      .on('end', dragEnd)
    )
    .on('click', (event, d) => {
      event.stopPropagation();
      selectNode(d);
    })
    .on('mouseover', (event, d) => showTooltip(event, d))
    .on('mousemove', (event) => moveTooltip(event))
    .on('mouseout', hideTooltip);
  
  // Substance circles
  node.filter(d => d._type === 'substance')
    .append('circle')
    .attr('r', d => d.is_volatile ? 7 : 5)
    .attr('fill', d => {
      if (d.is_volatile) return '#b5e853';
      if (d.flavor_group) return '#53e8b5';
      return '#2a4035';
    })
    .attr('stroke', d => d.is_volatile ? '#b5e85388' : '#1a2820')
    .attr('stroke-width', d => d.is_volatile ? 2 : 1);
  
  // Reaction diamonds
  node.filter(d => d._type === 'reaction')
    .append('polygon')
    .attr('points', d => {
      const s = 9;
      return `0,${-s} ${s},0 0,${s} ${-s},0`;
    })
    .attr('fill', d => STEP_COLORS[d.step] || '#666')
    .attr('fill-opacity', 0.9)
    .attr('stroke', '#000')
    .attr('stroke-width', 0.5);
  
  // Reaction labels (short ID)
  node.filter(d => d._type === 'reaction')
    .append('text')
    .text(d => d.id)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .attr('font-size', 7)
    .attr('font-family', 'Space Mono, monospace')
    .attr('fill', '#000')
    .attr('font-weight', 'bold')
    .attr('pointer-events', 'none');
  
  // Substance volatile indicator
  node.filter(d => d._type === 'substance' && d.is_volatile)
    .append('circle')
    .attr('r', 2)
    .attr('cx', 5).attr('cy', -5)
    .attr('fill', '#e8b553');
  
  // Simulation tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });
  
  // Store references
  window._graph = { svg, g, zoom, node, link, nodes, links, nodeMap };
  
  // Controls
  document.getElementById('zoom-in').onclick = () => svg.transition().call(zoom.scaleBy, 1.5);
  document.getElementById('zoom-out').onclick = () => svg.transition().call(zoom.scaleBy, 0.67);
  document.getElementById('zoom-reset').onclick = () => svg.transition().call(zoom.transform, d3.zoomIdentity.translate(W/2-W/2, H/2-H/2).scale(0.5));
  
  // Stage pills
  document.querySelectorAll('.stage-pill').forEach(pill => {
    pill.addEventListener('click', () => filterByStep(pill.dataset.step));
  });
  
  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase();
    updateGraphVisibility();
  });
  
  // Volatile filter
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeVolatile = btn.dataset.filter;
      updateGraphVisibility();
    });
  });
  
  // Click bg to deselect
  svg.on('click', () => {
    selectedNode = null;
    updateDetailPanel(null);
    updateHighlight();
  });
  
  // Info
  updateInfo();
  
  // Initial zoom to fit
  svg.call(zoom.transform, d3.zoomIdentity.translate(W*0.05, H*0.1).scale(0.4));
  
  // Resize
  window.addEventListener('resize', () => {
    W = container.clientWidth;
    H = container.clientHeight;
    svg.attr('width', W).attr('height', H);
    simulation.force('center', d3.forceCenter(W/2, H/2));
    simulation.alpha(0.1).restart();
  });
}

function updateGraphVisibility() {
  if (!window._graph) return;
  const { node, link, nodeMap } = window._graph;
  
  // Get visible reaction IDs for step filter
  const visibleRxnIds = new Set(
    DATA.reactions
      .filter(r => activeStep==='all' || r.step===activeStep)
      .map(r => r.id)
  );
  
  // Get substance IDs connected to visible reactions
  const connectedSubIds = new Set();
  DATA.edges.forEach(e => {
    if (visibleRxnIds.has(e.source) || visibleRxnIds.has(e.target)) {
      if (!DATA.reactions.find(r=>r.id===e.source)) connectedSubIds.add(e.source);
      if (!DATA.reactions.find(r=>r.id===e.target)) connectedSubIds.add(e.target);
    }
  });
  
  node.attr('opacity', d => {
    if (d._type === 'reaction') {
      if (!visibleRxnIds.has(d.id)) return 0.05;
    } else {
      if (activeStep !== 'all' && !connectedSubIds.has(d.id)) return 0.05;
      if (activeVolatile === 'volatile' && !d.is_volatile) return 0.08;
      if (activeVolatile === 'nonvolatile' && d.is_volatile) return 0.08;
    }
    if (searchQuery) {
      const match = (d.name||'').toLowerCase().includes(searchQuery) ||
                    (d.formula||'').toLowerCase().includes(searchQuery) ||
                    (d.id||'').toLowerCase().includes(searchQuery);
      if (!match) return 0.05;
    }
    if (selectedNode) {
      return isConnectedToSelected(d) ? 1 : 0.08;
    }
    return 1;
  });
  
  link.attr('opacity', d => {
    const src = typeof d.source === 'object' ? d.source._id : d.source;
    const tgt = typeof d.target === 'object' ? d.target._id : d.target;
    if (activeStep !== 'all' && !visibleRxnIds.has(src) && !visibleRxnIds.has(tgt)) return 0.02;
    if (selectedNode) {
      const srcId = typeof d.source === 'object' ? d.source._id : d.source;
      const tgtId = typeof d.target === 'object' ? d.target._id : d.target;
      return (srcId===selectedNode._id || tgtId===selectedNode._id) ? 0.9 : 0.03;
    }
    return 0.5;
  });
  
  updateInfo();
}

function isConnectedToSelected(d) {
  if (!selectedNode) return true;
  if (d._id === selectedNode._id) return true;
  return DATA.edges.some(e => {
    const src = typeof e.source === 'object' ? e.source._id : e.source;
    const tgt = typeof e.target === 'object' ? e.target._id : e.target;
    return (src===selectedNode._id && tgt===d._id) ||
           (tgt===selectedNode._id && src===d._id);
  });
}

function updateHighlight() {
  updateGraphVisibility();
}

function updateInfo() {
  // Count visible nodes/edges
  document.getElementById('info-node-count').textContent = 
    (DATA.nodes.length + DATA.reactions.length);
  document.getElementById('info-edge-count').textContent = DATA.edges.length;
}

function selectNode(d) {
  selectedNode = d;
  updateDetailPanel(d);
  updateHighlight();
}

function updateDetailPanel(d) {
  const panel = document.getElementById('detail-panel');
  if (!d) {
    panel.innerHTML = '<div class="detail-empty">ノードをクリックすると<br>詳細が表示されます。<br><br>ドラッグでパン、<br>スクロールでズーム。</div>';
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
  
  const rolesHTML = d.reaction_roles && d.reaction_roles.length > 0 ? `
    <div class="detail-section">
      <div class="detail-section-title">反応への関与</div>
      ${d.reaction_roles.map(r => `
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">
          <span style="font-size:10px;color:var(--accent2);min-width:40px;">${r.reaction_id}</span>
          <span style="font-size:10px;color:${r.consumed?'#e85353':'#53e8b5'};">${r.role} ${r.consumed?'(消費)':'(触媒)'}</span>
          ${r.is_extinct?'<span style="font-size:9px;color:#e85353;">消滅</span>':''}
        </div>`).join('')}
    </div>` : '';
  
  panel.innerHTML = `
    <div class="detail-card">
      <div class="detail-id">${d.id}</div>
      <div class="detail-name">${d.name}</div>
      ${d.formula ? `<div class="detail-formula">${d.formula}</div>` : ''}
      ${d.is_volatile ? '<div style="font-size:10px;color:var(--accent3);margin-bottom:6px;">★ 香気物質</div>' : ''}
      ${d.flavor_group ? `<div class="detail-row"><span class="detail-label">フレーバー群</span><span class="detail-value">${d.flavor_group}</span></div>` : ''}
      ${d.nutrition_cat ? `<div class="detail-row"><span class="detail-label">栄養カテゴリ</span><span class="detail-value">${d.nutrition_cat}</span></div>` : ''}
      ${d.notes && d.notes.length > 0 ? `<div style="font-size:10px;color:var(--text2);margin-top:8px;line-height:1.6;">${d.notes[0]}</div>` : ''}
      ${snapshotHTML}
      ${rolesHTML}
    </div>`;
}

function renderReactionDetail(panel, d) {
  const color = STEP_COLORS[d.step] || '#666';
  const label = STEP_LABELS[d.step] || d.step;
  
  // Find connected substances
  const substrates = DATA.edges
    .filter(e => {
      const tgt = typeof e.target === 'object' ? e.target._id : e.target;
      return tgt === d.id && e.type === 'substrate';
    })
    .map(e => {
      const src = typeof e.source === 'object' ? e.source._id : e.source;
      return DATA.nodes.find(n => n.id === src);
    }).filter(Boolean);
    
  const products = DATA.edges
    .filter(e => {
      const src = typeof e.source === 'object' ? e.source._id : e.source;
      return src === d.id && e.type === 'product';
    })
    .map(e => {
      const tgt = typeof e.target === 'object' ? e.target._id : e.target;
      return DATA.nodes.find(n => n.id === tgt);
    }).filter(Boolean);
  
  panel.innerHTML = `
    <div class="detail-card">
      <div class="detail-id">${d.id}</div>
      <div class="detail-name">${d.name}</div>
      <div style="margin-bottom:8px;"><span class="badge badge-step" style="background:${color};">${label}</span></div>
      ${d.equation ? `<div style="font-size:10px;color:var(--text2);line-height:1.6;margin-bottom:8px;">${d.equation}</div>` : ''}
      ${d.equation_formula ? `<div class="detail-formula" style="font-size:9px;">${d.equation_formula}</div>` : ''}
      
      ${substrates.length > 0 ? `
        <div class="detail-section">
          <div class="detail-section-title">基質 (${substrates.length})</div>
          ${substrates.slice(0,6).map(s => `
            <div style="font-size:10px;color:var(--text2);margin-bottom:2px;">
              ▶ ${s.name}${s.formula?` <span style="color:var(--text3)">${s.formula}</span>`:''}
            </div>`).join('')}
          ${substrates.length>6?`<div style="font-size:9px;color:var(--text3)">+ ${substrates.length-6} more</div>`:''}
        </div>` : ''}
      
      ${products.length > 0 ? `
        <div class="detail-section">
          <div class="detail-section-title">生成物 (${products.length})</div>
          ${products.map(s => `
            <div style="font-size:10px;color:var(--accent2);margin-bottom:2px;">
              ✦ ${s.name}${s.is_volatile?' <span style="color:var(--accent3)">★香気</span>':''}
            </div>`).join('')}
        </div>` : ''}
      
      ${d.notes && d.notes.length > 0 ? `
        <div class="detail-section">
          <div class="detail-section-title">備考</div>
          ${d.notes.map(n=>`<div style="font-size:10px;color:var(--text2);line-height:1.6;">${n}</div>`).join('')}
        </div>` : ''}
    </div>`;
}

// Drag handlers
function dragStart(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragEnd(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// Tooltip
function showTooltip(event, d) {
  const tt = document.getElementById('tooltip');
  document.getElementById('tt-name').textContent = d.name || d.id;
  let sub = '';
  if (d._type === 'reaction') sub = `${STEP_LABELS[d.step]||d.step} / ${d.equation||''}`;
  else sub = `${d.formula||''} ${d.is_volatile?'[香気物質]':''}`;
  document.getElementById('tt-sub').textContent = sub.trim();
  tt.style.opacity = '1';
  moveTooltip(event);
}
function moveTooltip(event) {
  const tt = document.getElementById('tooltip');
  const x = event.clientX + 14;
  const y = event.clientY - 30;
  tt.style.left = Math.min(x, window.innerWidth-260) + 'px';
  tt.style.top = Math.max(y, 10) + 'px';
}
function hideTooltip() {
  document.getElementById('tooltip').style.opacity = '0';
}

// ── REACTIONS VIEW ──
function initReactionsView() {
  // Step filter buttons
  const filterDiv = document.getElementById('rxn-step-filter');
  const allBtn = document.createElement('button');
  allBtn.className = 'filter-btn active';
  allBtn.textContent = '全工程';
  allBtn.dataset.step = 'all';
  filterDiv.appendChild(allBtn);
  
  Object.entries(STEP_LABELS).forEach(([step, label]) => {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.textContent = label;
    btn.dataset.step = step;
    btn.style.borderColor = STEP_COLORS[step];
    filterDiv.appendChild(btn);
  });
  
  let rxnStepFilter = 'all';
  filterDiv.addEventListener('click', e => {
    if (!e.target.classList.contains('filter-btn')) return;
    filterDiv.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    rxnStepFilter = e.target.dataset.step;
    renderRxnGrid();
  });
  
  document.getElementById('rxn-search').addEventListener('input', renderRxnGrid);
  
  function renderRxnGrid() {
    const q = document.getElementById('rxn-search').value.toLowerCase();
    const grid = document.getElementById('rxn-grid');
    grid.innerHTML = '';
    
    DATA.reactions
      .filter(r => rxnStepFilter==='all' || r.step===rxnStepFilter)
      .filter(r => !q || (r.name||'').toLowerCase().includes(q) || (r.id||'').toLowerCase().includes(q))
      .forEach(r => {
        const color = STEP_COLORS[r.step] || '#666';
        const label = STEP_LABELS[r.step] || r.step;
        
        // Count substrates/products
        const subs = DATA.edges.filter(e => {
          const tgt = typeof e.target === 'object' ? e.target._id : e.target;
          return tgt === r.id;
        }).length;
        const prods = DATA.edges.filter(e => {
          const src = typeof e.source === 'object' ? e.source._id : e.source;
          return src === r.id;
        }).length;
        
        const card = document.createElement('div');
        card.className = 'rxn-card';
        card.innerHTML = `
          <div><span class="rxn-step-badge" style="background:${color};">${label}</span></div>
          <div class="rxn-id">${r.id}</div>
          <div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div class="rxn-subs" style="margin-top:8px;">
            <span style="color:var(--text3)">基質 ${subs}</span> → 
            <span style="color:var(--accent2)">生成物 ${prods}</span>
          </div>`;
        card.addEventListener('click', () => {
          // Switch to graph and highlight
          document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
          document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
          document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
          document.getElementById('graph-view').classList.add('active');
          if (simulation) simulation.restart();
          setTimeout(() => {
            const graphNode = window._graph?.nodes.find(n => n._id === r.id);
            if (graphNode) selectNode(graphNode);
          }, 100);
        });
        grid.appendChild(card);
      });
  }
  
  renderRxnGrid();
}

// ── SUBSTANCES VIEW ──
function initSubstancesView() {
  let subFilter = '';
  
  document.getElementById('sub-search').addEventListener('input', e => {
    subFilter = e.target.value.toLowerCase();
    renderSubTable();
  });
  
  function renderSubTable() {
    const tbody = document.getElementById('sub-tbody');
    const filtered = DATA.nodes.filter(s =>
      !subFilter ||
      (s.name||'').toLowerCase().includes(subFilter) ||
      (s.formula||'').toLowerCase().includes(subFilter) ||
      (s.id||'').toLowerCase().includes(subFilter)
    );
    
    document.getElementById('sub-count-label').textContent = `${filtered.length} / ${DATA.nodes.length} 件`;
    
    tbody.innerHTML = '';
    filtered.slice(0, 200).forEach(s => {
      const roles = (s.reaction_roles||[]).length;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-id">${s.id}</td>
        <td class="td-name">${s.name}</td>
        <td class="td-formula">${s.formula||'—'}</td>
        <td class="td-volatile">${s.is_volatile?'★ 香気':'—'}</td>
        <td style="font-size:10px;color:var(--text3);">${s.nutrition_cat||'—'}</td>
        <td class="td-roles">${roles > 0 ? `<span style="color:var(--accent2)">${roles}</span>` : '—'}</td>`;
      tr.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
        document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('graph-view').classList.add('active');
        if (simulation) simulation.restart();
        setTimeout(() => {
          const graphNode = window._graph?.nodes.find(n => n._id === s.id);
          if (graphNode) selectNode(graphNode);
        }, 100);
      });
      tbody.appendChild(tr);
    });
    if (filtered.length > 200) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="6" style="text-align:center;color:var(--text3);font-size:10px;padding:12px;">+ ${filtered.length-200} 件（検索で絞り込み）</td>`;
      tbody.appendChild(tr);
    }
  }
  renderSubTable();
}

// ── PARAMS VIEW ──
function initParamsView() {
  const view = document.getElementById('params-view');
  
  DATA.params.forEach(p => {
    const card = document.createElement('div');
    card.className = 'param-card';
    
    const isNum = typeof p.range?.min === 'number';
    const isRange = isNum && typeof p.range?.max === 'number';
    const min = isRange ? p.range.min : 0;
    const max = isRange ? p.range.max : 100;
    const val = typeof p.value === 'number' ? p.value : ((min+max)/2);
    
    const affects = (p.affects_reactions||[]).slice(0,5);
    
    card.innerHTML = `
      <div class="param-id">${p.param_id}</div>
      <div class="param-name">${p.name}</div>
      <div class="param-val-row">
        <span class="param-unit">${p.unit}</span>
        <span class="param-val-display" id="pv-${p.param_id}">${val}</span>
      </div>
      ${isRange ? `
        <div class="param-slider-wrap">
          <input type="range" class="param-slider" 
            min="${min}" max="${max}" 
            value="${Math.max(min,Math.min(max,val))}"
            step="${(max-min)/100}"
            id="ps-${p.param_id}">
          <div class="param-range">${min} — ${max} ${p.unit}</div>
        </div>` : `<div class="param-range">${JSON.stringify(p.range?.allowed||p.range?.stages||p.value)}</div>`}
      ${affects.length > 0 ? `
        <div class="param-affects">
          <div class="param-affects-title">影響する反応</div>
          ${affects.map(a => {
            const score = a.score || 0;
            const pct = score * 100;
            const color = score > 0.8 ? '#e85353' : score > 0.5 ? '#e8b553' : '#53e8b5';
            return `<div class="affect-row">
              <span class="affect-rxn">${a.reaction_id}</span>
              <div class="affect-bar"><div class="affect-fill" style="width:${pct}%;background:${color};"></div></div>
              <span class="affect-label">${a.sensitivity}</span>
            </div>`;
          }).join('')}
        </div>` : ''}`;
    
    view.appendChild(card);
    
    // Slider interaction
    if (isRange) {
      const slider = card.querySelector('.param-slider');
      const display = card.querySelector(`#pv-${p.param_id}`);
      slider.addEventListener('input', () => {
        display.textContent = parseFloat(slider.value).toFixed(1);
      });
    }
  });
}
