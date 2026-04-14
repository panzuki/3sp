// ══════════════════════════════════════════════════════════════
// bread for myself — app3d.js  v6.0  Semantic Flow
// 仕様: bread_simulation_json_spec v1 + semantic_flow_v3
// データ: data/14_graph_runtime.json (semantic_flow_v3)
// Three.js r128
// ══════════════════════════════════════════════════════════════

// ─── 工程カラー ──────────────────────────────────────────────
const STEP_COLORS = {
  ingredients:            0x6b7280,
  ingredient_component:   0x9b6e3a,
  mixing:                 0x4a9eff,
  fermentation_1:         0xa8e053,
  dividing_bench_shaping: 0x53b5e8,
  proof:                  0xe8b553,
  baking:                 0xe85353,
};
const STEP_COLORS_CSS = {
  ingredients:            '#6b7280',
  ingredient_component:   '#9b6e3a',
  mixing:                 '#4a9eff',
  fermentation_1:         '#a8e053',
  dividing_bench_shaping: '#53b5e8',
  proof:                  '#e8b553',
  baking:                 '#e85353',
};
const STEP_LABELS = {
  ingredients:            '原材料',
  ingredient_component:   '成分分解',
  mixing:                 'ミキシング',
  fermentation_1:         '一次発酵',
  dividing_bench_shaping: '分割・成形',
  proof:                  'ホイロ',
  baking:                 '焼成',
};
const STEP_ORDER = ['ingredients','ingredient_component','mixing','fermentation_1','dividing_bench_shaping','proof','baking'];
const STAGE_PO = {
  ingredients:0, ingredient_component:0.5,
  mixing:1, fermentation_1:2, dividing_bench_shaping:3, proof:4, baking:5
};

const BASE_Y    =  320;
const STAGE_GAP =  200;
function getStageY(po) { return BASE_Y - po * STAGE_GAP; }

const TYPE_RADIUS = {
  raw_material:          500,
  ingredient_component:  390,
  substance_instance:    300,
  reaction:              180,
};
const TYPE_Y_OFFSET = {
  raw_material:          40,
  ingredient_component: -10,
  substance_instance:   -50,
  reaction:              0,
};

// ─── トレース設定（意味フロー）────────────────────────────────
const TRACEABLE_TYPES = new Set(['mass_flow','transformation']);

// ─── グローバル状態 ───────────────────────────────────────────
let GR = null, SM = null, SF = null;
let SCENE_OBJ = null;
let allMeshes = [], lineMeshes = [], nodeMap = {};
let selectedId = null, traceSet = null, traceUpSet = null, traceDnSet = null;
let autoRotate = false, activeStep = 'all', activeFilter = 'all', searchQuery = '';
// ─── ナビゲーション履歴 ───────────────────────────────────────
// traceOrigin: トレース開始時のスナップショット（空タップで戻す）
// navStack: サイドバー内の表示履歴（戻るボタンで遡る）
let traceOrigin = null;  // { id, node, type, traceSet, traceUpSet, traceDnSet, msg, icon }
let navStack    = [];    // [{ id, node, type, stage }]
let fwdMap = {}, bwdMap = {};   // 意味フローの隣接マップ（traceable only）
let fwdAll = {}, bwdAll = {};   // 全エッジの隣接マップ（表示用）
let SUB_MASTER_MAP = {};

// ─── データ読み込み ──────────────────────────────────────────
async function fetchJSON(urls) {
  for (const url of (Array.isArray(urls)?urls:[urls])) {
    try { const r=await fetch(url); if(r.ok) return await r.json(); }
    catch(e) { console.warn('[fetch]', url, e.message); }
  }
  return null;
}

async function loadAll() {
  GR = await fetchJSON(['data/14_graph_runtime.json','data/graph_data.json']);
  if (!GR) throw new Error('data/14_graph_runtime.json が見つかりません');
  SM = await fetchJSON('data/01_substance_master.json');
  SF = await fetchJSON('data/10_sensory_framework.json');
  if (SM) SM.substances.forEach(s => { SUB_MASTER_MAP[s.id]=s; });
}

loadAll().then(() => {
  buildAdjacency();
  initScene();
  buildGraph();
  initUI();
  initNav();
  animate();
  const m = GR.meta||{};
  setEl('stat-sub',  m.substance_count  ?? GR.substance_master?.length ?? '—');
  setEl('stat-rxn',  m.reaction_count   ?? GR.reactions?.length        ?? '—');
  setEl('stat-edge', m.edge_count       ?? GR.edges?.length            ?? '—');
  setEl('stat-param',m.param_count      ?? GR.params?.length           ?? '—');
}).catch(err => {
  console.error('[fatal]',err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
      background:#070a08;color:#e85353;font-family:monospace;font-size:13px;z-index:9999;padding:30px;text-align:center">
      <div>❌ データ読み込み失敗<br><br>
      <code style="color:#aaa;font-size:11px">${err.message}</code><br><br>
      <span style="color:#6b7280;font-size:11px">data/14_graph_runtime.json を配置してください</span></div></div>`);
});

function setEl(id,v) { const e=document.getElementById(id); if(e) e.textContent=v; }

// ─── 隣接マップ構築 ──────────────────────────────────────────
function buildAdjacency() {
  fwdMap={}; bwdMap={}; fwdAll={}; bwdAll={};
  for (const e of GR.edges) {
    (fwdAll[e.source]=fwdAll[e.source]||[]).push(e);
    (bwdAll[e.target]=bwdAll[e.target]||[]).push(e);
    if (TRACEABLE_TYPES.has(e.type)) {
      (fwdMap[e.source]=fwdMap[e.source]||[]).push(e.target);
      (bwdMap[e.target]=bwdMap[e.target]||[]).push(e.source);
    }
  }
}

// ─── 意味フロートレース ───────────────────────────────────────
function traceDown(startId) {
  const vis=new Set(); const q=[startId];
  while (q.length) {
    const n=q.pop(); if(vis.has(n)) continue; vis.add(n);
    for (const nx of (fwdMap[n]||[])) if(!vis.has(nx)) q.push(nx);
  }
  return vis;
}
function traceUp(startId) {
  const vis=new Set(); const q=[startId];
  while (q.length) {
    const n=q.pop(); if(vis.has(n)) continue; vis.add(n);
    for (const nx of (bwdMap[n]||[])) if(!vis.has(nx)) q.push(nx);
  }
  return vis;
}
function traceBoth(id) {
  const up=traceUp(id), dn=traceDown(id);
  return { upstream:up, downstream:dn, combined:new Set([...up,...dn,id]) };
}

// 反応のneighbor（前後の実体ノードを全エッジから取得）
function rxnNeighbors(rxnId) {
  const s=new Set([rxnId]);
  for (const e of (bwdAll[rxnId]||[])) s.add(e.source);
  for (const e of (fwdAll[rxnId]||[])) s.add(e.target);
  // transformation エッジで直接繋がるノードも追加
  for (const e of GR.edges) {
    if (e.type==='transformation' && e.reaction===rxnId) {
      s.add(e.source); s.add(e.target);
    }
  }
  return s;
}

// ─── シード乱数 ──────────────────────────────────────────────
function sr(str) {
  let h=0; for(let i=0;i<str.length;i++) h=(Math.imul(31,h)+str.charCodeAt(i))|0;
  h=(h^(h>>>16))*0x45d9f3b|0; h=(h^(h>>>16))*0x45d9f3b|0; h=h^(h>>>16);
  return (h>>>0)/0xFFFFFFFF;
}

// ─── Three.js シーン ─────────────────────────────────────────
function initScene() {
  const canvas=document.getElementById('canvas');
  const W=window.innerWidth, H=window.innerHeight;
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x070a08);
  scene.fog=new THREE.FogExp2(0x070a08, 0.00050);
  const camera=new THREE.PerspectiveCamera(48,W/H,1,12000);
  camera.position.set(0,100,1300);
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.setSize(W,H);
  scene.add(new THREE.AmbientLight(0xffffff,0.40));
  const d1=new THREE.DirectionalLight(0xa8e080,1.2); d1.position.set(400,700,400); scene.add(d1);
  const d2=new THREE.DirectionalLight(0x4080ff,0.5); d2.position.set(-500,-200,-300); scene.add(d2);
  scene.add(new THREE.PointLight(0xe0b060,0.7,3000));
  const controls=makeControls(camera,canvas);
  SCENE_OBJ={scene,camera,renderer,controls,raycaster:new THREE.Raycaster()};
  const onResize=()=>{
    const W2=window.innerWidth, H2=window.innerHeight;
    camera.aspect=W2/H2; camera.updateProjectionMatrix(); renderer.setSize(W2,H2);
  };
  window.addEventListener('resize',onResize);
  document.addEventListener('sidebar-changed',onResize);
  canvas.addEventListener('click',onCanvasClick);
  canvas.addEventListener('mousemove',onCanvasHover);
}

function makeControls(camera,canvas) {
  const st={isDragging:false,isRight:false,prevX:0,prevY:0,
    sph:{theta:.15,phi:Math.PI/3.1,radius:1300},target:new THREE.Vector3(0,-220,0)};
  function upd() {
    const {theta,phi,radius}=st.sph, sp=Math.sin(phi);
    camera.position.set(st.target.x+radius*sp*Math.sin(theta),
      st.target.y+radius*Math.cos(phi), st.target.z+radius*sp*Math.cos(theta));
    camera.lookAt(st.target);
  }
  upd();
  canvas.addEventListener('mousedown',e=>{st.isDragging=true;st.isRight=e.button===2;st.prevX=e.clientX;st.prevY=e.clientY;});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  window.addEventListener('mousemove',e=>{
    if(!st.isDragging) return;
    const dx=e.clientX-st.prevX, dy=e.clientY-st.prevY;
    st.prevX=e.clientX; st.prevY=e.clientY;
    if(st.isRight){
      const r=new THREE.Vector3(),u=new THREE.Vector3();
      r.crossVectors(camera.getWorldDirection(new THREE.Vector3()),camera.up).normalize();
      u.copy(camera.up).normalize();
      st.target.addScaledVector(r,-dx*.9); st.target.addScaledVector(u,dy*.9);
    } else {
      st.sph.theta-=dx*.005;
      st.sph.phi=Math.max(.08,Math.min(Math.PI-.08,st.sph.phi+dy*.005));
    }
    upd();
  });
  window.addEventListener('mouseup',()=>st.isDragging=false);
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();
    st.sph.radius=Math.max(150,Math.min(6000,st.sph.radius*(1+e.deltaY*.001)));
    upd();
  },{passive:false});
  let t0=null,td0=0;
  canvas.addEventListener('touchstart',e=>{
    if(e.touches.length===1) t0={x:e.touches[0].clientX,y:e.touches[0].clientY};
    else td0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  },{passive:true});
  canvas.addEventListener('touchmove',e=>{
    if(e.touches.length===1&&t0){
      const dx=e.touches[0].clientX-t0.x, dy=e.touches[0].clientY-t0.y;
      t0={x:e.touches[0].clientX,y:e.touches[0].clientY};
      st.sph.theta-=dx*.006;
      st.sph.phi=Math.max(.08,Math.min(Math.PI-.08,st.sph.phi+dy*.006));
      upd();
    } else if(e.touches.length===2){
      const td=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      st.sph.radius=Math.max(150,Math.min(6000,st.sph.radius*(td0/td)));
      td0=td; upd();
    }
  },{passive:true});
  return {state:st,updateCamera:upd};
}

// ─── グラフ構築 ──────────────────────────────────────────────
function buildGraph() {
  const {scene}=SCENE_OBJ;
  allMeshes=[]; lineMeshes=[]; nodeMap={};

  // ガイドリング + 縦軸
  const stepsWithRings = [
    {step:'ingredients', po:0, type:'raw_material'},
    {step:'ingredient_component', po:0.5, type:'ingredient_component'},
    {step:'mixing',      po:1, type:'substance_instance'},
    {step:'fermentation_1', po:2, type:'substance_instance'},
    {step:'dividing_bench_shaping', po:3, type:'substance_instance'},
    {step:'proof',       po:4, type:'substance_instance'},
    {step:'baking',      po:5, type:'substance_instance'},
  ];
  stepsWithRings.forEach(({step, po, type})=>{
    const y=getStageY(po), col=STEP_COLORS[step]||0x444444;
    addRing(scene, TYPE_RADIUS[type],    y+TYPE_Y_OFFSET[type],    col, .15);
    if(step!=='ingredients'&&step!=='ingredient_component')
      addRing(scene, TYPE_RADIUS.reaction, y+TYPE_Y_OFFSET.reaction, col, .07);
  });
  const axG=new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,BASE_Y+100,0),
    new THREE.Vector3(0,getStageY(5)-120,0)
  ]);
  scene.add(new THREE.Line(axG,new THREE.LineBasicMaterial({color:0x1a3322,transparent:true,opacity:.4})));

  // ── 原材料ノード（大八面体）─────────────────────────────
  const raws=GR.raw_materials||[];
  raws.forEach((rm,idx)=>{
    const angle=(idx/raws.length)*Math.PI*2;
    const rj=TYPE_RADIUS.raw_material+(sr(rm.id)-.5)*TYPE_RADIUS.raw_material*.15;
    const y0=getStageY(0)+TYPE_Y_OFFSET.raw_material;
    const yj=y0+(sr(rm.id+'y')-.5)*28;
    const col=STEP_COLORS.ingredients;
    const mesh=new THREE.Mesh(new THREE.OctahedronGeometry(15,0),
      new THREE.MeshPhongMaterial({color:col,emissive:col,emissiveIntensity:.38,shininess:70,transparent:true,opacity:1}));
    mesh.position.set(Math.cos(angle)*rj, yj, Math.sin(angle)*rj);
    mesh.userData={id:rm.id,type:'raw_material',node:rm,stage:'ingredients',process_order:0,originalColor:col};
    scene.add(mesh);
    const entry={mesh,node:rm,type:'raw_material',stage:'ingredients'};
    allMeshes.push(entry); nodeMap[rm.id]=entry;
    if(rm.ing_id) nodeMap[rm.ing_id]=entry;
  });

  // ── ingredient_component ノード（小ダイヤ型）────────────
  const comps=GR.ingredient_components||[];
  // RAW別にグループ化
  const compByRaw={};
  comps.forEach(c=>{ (compByRaw[c.raw_parent]=compByRaw[c.raw_parent]||[]).push(c); });

  comps.forEach(comp=>{
    const rawEntry=nodeMap[comp.raw_parent];
    const siblings=compByRaw[comp.raw_parent]||[];
    const idx=siblings.indexOf(comp);
    const total=siblings.length;
    // 親の周囲にサブ円配置
    let baseAngle=0;
    if(rawEntry) {
      const rawPos=rawEntry.mesh.position;
      baseAngle=Math.atan2(rawPos.z, rawPos.x);
    } else {
      baseAngle=(Object.keys(compByRaw).indexOf(comp.raw_parent)/Object.keys(compByRaw).length)*Math.PI*2;
    }
    const spread = Math.PI * 0.4;
    const angle  = baseAngle + (total>1 ? (idx/(total-1)-.5)*spread : 0);
    const rj=TYPE_RADIUS.ingredient_component+(sr(comp.id)-.5)*60;
    const y0=getStageY(0.5)+TYPE_Y_OFFSET.ingredient_component;
    const yj=y0+(sr(comp.id+'y')-.5)*30;
    const col=STEP_COLORS.ingredient_component;

    const mesh=new THREE.Mesh(new THREE.OctahedronGeometry(5,0),
      new THREE.MeshPhongMaterial({color:col,emissive:col,emissiveIntensity:.28,shininess:60,transparent:true,opacity:.9}));
    mesh.position.set(Math.cos(angle)*rj, yj, Math.sin(angle)*rj);
    mesh.userData={id:comp.id,type:'ingredient_component',node:comp,stage:'ingredient_component',process_order:0.5,originalColor:col};
    scene.add(mesh);
    const entry={mesh,node:comp,type:'ingredient_component',stage:'ingredient_component'};
    allMeshes.push(entry); nodeMap[comp.id]=entry;
  });

  // ── substance_instance ノード（球）──────────────────────
  const instByStage={};
  (GR.substance_instances||[]).forEach(inst=>{
    const s=inst.stage||'mixing';
    (instByStage[s]=instByStage[s]||[]).push(inst);
  });
  Object.entries(instByStage).forEach(([stage,insts])=>{
    const po=STAGE_PO[stage]??1;
    const total=insts.length;
    const yBase=getStageY(po)+TYPE_Y_OFFSET.substance_instance;
    const rBase=TYPE_RADIUS.substance_instance;
    insts.forEach((inst,idx)=>{
      const angle=(idx/total)*Math.PI*2;
      const rj=rBase+(sr(inst.id)-.5)*rBase*.35;
      const yj=yBase+(sr(inst.id+'y')-.5)*44;
      const col=STEP_COLORS[stage]||0x4a8060;
      const isVol=!!inst.is_volatile, r3d=isVol?8:5;
      const smE=SUB_MASTER_MAP[inst.master_id]||{};
      const mesh=new THREE.Mesh(new THREE.SphereGeometry(r3d,18,12),
        new THREE.MeshPhongMaterial({color:col,emissive:col,
          emissiveIntensity:isVol?.50:.10,shininess:isVol?105:45,transparent:true,opacity:1}));
      mesh.position.set(Math.cos(angle)*rj, yj, Math.sin(angle)*rj);
      mesh.userData={id:inst.id,type:'substance_instance',node:inst,stage,
        process_order:po,originalColor:col,category:smE.category};
      scene.add(mesh);
      if(isVol) {
        const ring=new THREE.Mesh(new THREE.TorusGeometry(r3d+5,.8,6,28),
          new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.36}));
        ring.position.copy(mesh.position);
        ring.rotation.x=Math.PI/2+(sr(inst.id+'rx')-.5)*1.0;
        ring.rotation.z=(sr(inst.id+'rz')-.5)*.8;
        scene.add(ring);
      }
      const entry={mesh,node:inst,type:'substance_instance',stage};
      allMeshes.push(entry); nodeMap[inst.id]=entry;
    });
  });

  // ── node alias（旧 SUB-XXXX → インスタンスへの橋渡し）──
  (GR.nodes||[]).forEach(n=>{
    if(nodeMap[n.id]||n.hidden) return;
    const sn=n.stage_nodes||[];
    if(sn.length>0&&nodeMap[sn[0].instance_id]){nodeMap[n.id]=nodeMap[sn[0].instance_id];return;}
    const col=STEP_COLORS['mixing'];
    const mesh=new THREE.Mesh(new THREE.SphereGeometry(3,8,6),new THREE.MeshPhongMaterial({color:col,transparent:true,opacity:0}));
    mesh.position.set(0,BASE_Y,0);
    mesh.userData={id:n.id,type:'substance',node:n,stage:'mixing',originalColor:col};
    scene.add(mesh);
    nodeMap[n.id]={mesh,node:n,type:'substance',stage:'mixing'};
    allMeshes.push(nodeMap[n.id]);
  });

  // ── 反応ノード（八面体）─────────────────────────────────
  const rxnByStage={};
  GR.reactions.forEach(r=>{ const s=r.stage||r.step||'mixing'; (rxnByStage[s]=rxnByStage[s]||[]).push(r); });
  Object.entries(rxnByStage).forEach(([stage,rxns])=>{
    const po=STAGE_PO[stage]??1;
    const total=rxns.length;
    rxns.forEach((rxn,idx)=>{
      const angle=(idx/total)*Math.PI*2+Math.PI/total;
      const rr=TYPE_RADIUS.reaction+((idx%3)-1)*28;
      const yj=getStageY(po)+(sr(rxn.id+'y')-.5)*22;
      const col=STEP_COLORS[stage]||0x666666;
      const mesh=new THREE.Mesh(new THREE.OctahedronGeometry(9,0),
        new THREE.MeshPhongMaterial({color:col,emissive:col,emissiveIntensity:.28,shininess:90,transparent:true,opacity:1}));
      mesh.position.set(Math.cos(angle)*rr, yj, Math.sin(angle)*rr);
      mesh.userData={id:rxn.id,type:'reaction',node:rxn,stage,process_order:po,originalColor:col};
      scene.add(mesh);
      const entry={mesh,node:rxn,type:'reaction',stage};
      allMeshes.push(entry); nodeMap[rxn.id]=entry;
    });
  });

  // ── エッジ（ライン）────────────────────────────────────
  GR.edges.forEach(e=>{
    const se=nodeMap[e.source], te=nodeMap[e.target];
    if(!se||!te) return;
    const geo=new THREE.BufferGeometry().setFromPoints([se.mesh.position.clone(),te.mesh.position.clone()]);
    let col, opacity;
    if(e.type==='transformation')      { col=0x2a8850; opacity=.28; }
    else if(e.type==='mass_flow')      { col=0x4466aa; opacity=.20; }
    else                               { col=0x263832; opacity=.15; }
    const mat=new THREE.LineBasicMaterial({color:col,transparent:true,opacity});
    const line=new THREE.Line(geo,mat);
    scene.add(line);
    lineMeshes.push({line,edge:e,mat,originalColor:col,baseOpacity:opacity});
  });
}

function addRing(scene,radius,y,color,opacity) {
  const mesh=new THREE.Mesh(new THREE.TorusGeometry(radius,1.2,8,72),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity}));
  mesh.position.y=y; mesh.rotation.x=Math.PI/2; scene.add(mesh);
}

// ─── ハイライト ───────────────────────────────────────────────
function applyHighlight() {
  allMeshes.forEach(({mesh})=>{
    const ud=mesh.userData;
    const inTr=traceSet?traceSet.has(ud.id):true, vis=isVisible(ud), isSel=ud.id===selectedId;
    if(!vis){mesh.material.opacity=0.02;mesh.material.emissiveIntensity=0;return;}
    if(!inTr&&traceSet){mesh.material.opacity=0.04;mesh.material.emissiveIntensity=0;mesh.scale.setScalar(1);}
    else if(isSel){
      mesh.material.color.setHex(0xffffff); mesh.material.emissive.setHex(0xffffff);
      mesh.material.emissiveIntensity=0.80; mesh.material.opacity=1; mesh.scale.setScalar(1.7);
    } else {
      const col=ud.originalColor, isVol=ud.node?.is_volatile;
      mesh.material.color.setHex(col); mesh.material.emissive.setHex(col);
      // 上流はcool、下流はwarmで色分け
      let ei;
      if(inTr&&traceSet) {
        const inUp=traceUpSet&&traceUpSet.has(ud.id);
        const inDn=traceDnSet&&traceDnSet.has(ud.id);
        if(inUp&&inDn)      ei = isVol ? .60 : .28;
        else if(inUp)       ei = isVol ? .55 : .24;
        else if(inDn)       ei = isVol ? .65 : .32;
        else                ei = isVol ? .50 : .20;
      } else ei = isVol ? .40 : .10;
      mesh.material.emissiveIntensity=ei;
      mesh.material.opacity=1; mesh.scale.setScalar(1);
    }
  });

  lineMeshes.forEach(({edge,mat,originalColor,baseOpacity})=>{
    if(traceSet) {
      const both=traceSet.has(edge.source)&&traceSet.has(edge.target);
      mat.opacity=both?.92:.015;
      if(both){
        if(edge.type==='transformation')     mat.color.setHex(0xa8e053);  // 緑：変換
        else if(edge.type==='mass_flow'&&edge.source?.startsWith('COMP')) mat.color.setHex(0xffaa55);  // 橙：成分分解
        else if(edge.type==='mass_flow')     mat.color.setHex(0x4488cc);  // 青：質量流
        else                                 mat.color.setHex(0x666666);
      } else mat.color.setHex(originalColor);
    } else { mat.opacity=baseOpacity; mat.color.setHex(originalColor); }
  });
}

function isVisible(ud) {
  const {id,type,stage}=ud;
  if(activeStep!=='all') {
    const s = stage||'';
    if(type==='reaction'           &&s!==activeStep) return false;
    if(type==='substance_instance' &&s!==activeStep) return false;
    if(type==='raw_material'       &&activeStep!=='ingredients') return false;
    if(type==='ingredient_component'&&activeStep!=='ingredient_component'&&activeStep!=='ingredients') return false;
  }
  if(activeFilter==='volatile'&&(type==='substance_instance'||type==='substance')&&!ud.node?.is_volatile) return false;
  if(activeFilter==='reactions'&&type!=='reaction') return false;
  if(searchQuery) {
    const n=ud.node;
    const hit=(n?.name||'').toLowerCase().includes(searchQuery)
           ||(n?.formula||'').toLowerCase().includes(searchQuery)
           ||(id||'').toLowerCase().includes(searchQuery);
    if(!hit) return false;
  }
  return true;
}

// ─── アニメーション ───────────────────────────────────────────
let _fr=0;
function animate() {
  requestAnimationFrame(animate); _fr++;
  if(autoRotate&&SCENE_OBJ) { SCENE_OBJ.controls.state.sph.theta+=.0022; SCENE_OBJ.controls.updateCamera(); }
  if(selectedId&&nodeMap[selectedId]) {
    const s=1.52+Math.sin(_fr*.09)*.18; nodeMap[selectedId].mesh.scale.setScalar(s);
  }
  SCENE_OBJ.renderer.render(SCENE_OBJ.scene,SCENE_OBJ.camera);
}

// ─── クリック / ホバー ────────────────────────────────────────
let _cm=false, _md={x:0,y:0};
document.addEventListener('DOMContentLoaded',()=>{
  const cv=document.getElementById('canvas');
  cv.addEventListener('mousedown',e=>{_cm=false;_md={x:e.clientX,y:e.clientY};});
  cv.addEventListener('mousemove',e=>{if(Math.hypot(e.clientX-_md.x,e.clientY-_md.y)>5)_cm=true;});
});

function onCanvasClick(e) {
  if(_cm) return;
  const hit=raycast(e);

  if(!hit) {
    // 空タップ：トレース中なら origin に戻す、なければ全解除
    if(traceOrigin) {
      _restoreTraceOrigin();
    } else {
      clearSel();
    }
    return;
  }

  const { id, node, type } = hit.object.userData;

  // ── トレース中の再タップ処理 ──────────────────────────────
  if(traceSet && traceSet.has(id)) {
    // ハイライト範囲内ノード → selectedId だけ変えてサイドバー更新
    // トレース（ハイライト）は維持、navStack には積まない
    selectedId = id;
    const entry = nodeMap[id];
    const stage = entry?.stage || node?.stage || 'mixing';
    applyHighlight();
    updateDetail(node, type, stage);
    // ツールチップは非表示に
    hideTT();
    return;
  }

  // ── 新規トレース開始 ─────────────────────────────────────
  navStack = [];  // 新トレース開始でスタックリセット
  selectNode(id, node, type);
}
let _hov=null;
function onCanvasHover(e) {
  const hit=raycast(e);
  if(hit){
    const {id,node,type}=hit.object.userData;
    if(id!==_hov){_hov=id; showTT(e,node,type);} else moveTT(e);
    document.getElementById('canvas').style.cursor='pointer';
  } else { _hov=null; hideTT(); document.getElementById('canvas').style.cursor='default'; }
}
function raycast(e) {
  const {camera,raycaster}=SCENE_OBJ;
  const rect=document.getElementById('canvas').getBoundingClientRect();
  const mouse=new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,((e.clientY-rect.top)/rect.height)*-2+1);
  raycaster.setFromCamera(mouse,camera);
  const hits=raycaster.intersectObjects(allMeshes.map(m=>m.mesh));
  return hits.length?hits[0]:null;
}

// ─── ノード選択（意味フロートレース）────────────────────────
function selectNode(id,node,type) {
  selectedId=id;
  const entry=nodeMap[id];
  const stage=entry?.stage||node?.stage||'mixing';
  let traceIds, msg, icon='🔍';

  if(type==='raw_material') {
    const dn=traceDown(id);
    traceIds=dn; traceUpSet=new Set([id]); traceDnSet=dn;
    msg=`${node?.name||id} → 下流 ${dn.size-1} ノード`; icon='🔶';

  } else if(type==='ingredient_component') {
    const dn=traceDown(id);
    const up=new Set([id, node?.raw_parent||''].filter(Boolean));
    traceIds=new Set([...dn,...up]); traceUpSet=up; traceDnSet=dn;
    msg=`${node?.name||id} 成分 → 下流 ${dn.size} ノード`; icon='🟡';

  } else if(stage==='baking'||stage==='final') {
    const up=traceUp(id);
    traceIds=up; traceUpSet=up; traceDnSet=new Set([id]);
    msg=`${node?.name||id} ← 来歴 ${up.size-1} ノード`; icon='🔴';

  } else if(type==='substance_instance'||type==='substance') {
    const {upstream,downstream,combined}=traceBoth(id);
    traceIds=combined; traceUpSet=upstream; traceDnSet=downstream;
    msg=`${node?.name||id}  ▲来歴${upstream.size-1}  ▼行先${downstream.size-1}`; icon='🔵';

  } else {
    traceIds=rxnNeighbors(id);
    traceUpSet=new Set(); traceDnSet=new Set();
    msg=`${node?.name||id}  関連 ${traceIds.size} ノード`; icon='🔷';
  }

  traceSet=traceIds;

  // トレース起点スナップショットを保存
  traceOrigin={ id, node, type, stage,
    traceSet: new Set(traceIds),
    traceUpSet: traceUpSet ? new Set(traceUpSet) : null,
    traceDnSet: traceDnSet ? new Set(traceDnSet) : null,
    msg, icon };
  navStack=[];  // 新トレース開始でスタックリセット

  applyHighlight();
  showTraceBar(msg,icon);
  updateDetail(node,type,stage);
}

// トレース起点に戻す（空タップ時）
function _restoreTraceOrigin() {
  if(!traceOrigin) return;
  const o=traceOrigin;
  selectedId  = o.id;
  traceSet    = new Set(o.traceSet);
  traceUpSet  = o.traceUpSet ? new Set(o.traceUpSet) : null;
  traceDnSet  = o.traceDnSet ? new Set(o.traceDnSet) : null;
  navStack    = [];
  applyHighlight();
  showTraceBar(o.msg, o.icon);
  updateDetail(o.node, o.type, o.stage);
}

function clearSel() {
  selectedId=null; traceSet=null; traceUpSet=null; traceDnSet=null;
  traceOrigin=null; navStack=[];
  hideTraceBar(); applyHighlight(); updateDetail(null);
}

// ─── トレースバー ─────────────────────────────────────────────
function showTraceBar(msg,icon) {
  setEl('trace-icon',icon||'🔍'); setEl('trace-info',msg);
  document.getElementById('trace-bar').classList.add('visible');
}
function hideTraceBar() { document.getElementById('trace-bar').classList.remove('visible'); }
document.getElementById('trace-close').addEventListener('click',clearSel);

// ─── ツールチップ ─────────────────────────────────────────────
function showTT(e,node,type) {
  if(!node) return;
  setEl('tt-name', node.name||node.id||'');
  let sub='';
  if(type==='reaction') sub=`反応  [${STEP_LABELS[node.stage||node.step]||''}]`;
  else if(type==='raw_material') sub=`原材料  ${node.ing_name||''}`;
  else if(type==='ingredient_component') {
    sub=`成分  [${node.substance_ref||''}]  ${node.state?.mass_g!=null?node.state.mass_g.toFixed(2)+'g':''}`;
  } else {
    const smE=SUB_MASTER_MAP[node.master_id]||{};
    sub=[node.formula, node.is_volatile?'★ 香気物質':'',
         smE.category?`[${smE.category}]`:'',
         node.stage?`[${STEP_LABELS[node.stage]}]`:''].filter(Boolean).join('  ');
  }
  setEl('tt-sub',sub.trim());
  document.getElementById('tooltip').style.opacity='1';
  moveTT(e);
}
function moveTT(e) {
  const tt=document.getElementById('tooltip');
  tt.style.left=Math.min(e.clientX+16,window.innerWidth-240)+'px';
  tt.style.top=Math.max(e.clientY-34,8)+'px';
}
function hideTT() { document.getElementById('tooltip').style.opacity='0'; }

// ─── 詳細パネル ───────────────────────────────────────────────
function updateDetail(node, type, stage, pushNav) {
  // pushNav=true のとき、前の状態を navStack に積む
  const panel=document.getElementById('detail-panel');
  if(!node) {
    navStack=[];
    panel.innerHTML=`<div class="detail-empty">
      球をクリックすると詳細表示<br><br>
      <b style="color:var(--text2)">意味フロートレース</b><br>
      🔶 原材料 → 下流全経路<br>🟡 成分 → 下流経路<br>
      🔵 中間物質 → ▲来歴 ▼行先<br>🔴 焼成物 → 上流来歴<br>
      🔷 反応 → 直接接続<br><br>
      <b style="color:var(--text2)">エッジ色</b><br>
      <span style="color:#a8e053">■</span> 変換 (transformation)<br>
      <span style="color:#4488cc">■</span> 質量流 (mass_flow)<br>
      <span style="color:#ffaa55">■</span> 成分分解 (ingredient→comp)<br><br>
      <b style="color:var(--text2)">操作</b><br>
      ドラッグ → 回転 / ホイール → ズーム<br>右ドラッグ → パン
    </div>`;
    return;
  }
  if(type==='reaction')              detailRxn(panel,node,stage);
  else if(type==='raw_material')     detailRaw(panel,node);
  else if(type==='ingredient_component') detailComp(panel,node);
  else                               detailSub(panel,node,stage);
}

// ── 戻るボタン HTML ──────────────────────────────────────────
function _backBtnHTML(label='← 戻る') {
  return `<button onclick="_navBack()" style="
    background:transparent; border:1px solid var(--border); color:var(--text3);
    font-family:'Space Mono',monospace; font-size:9px; padding:4px 10px;
    cursor:pointer; border-radius:2px; margin-bottom:10px; display:flex;
    align-items:center; gap:5px; transition:all .15s;"
    onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
    onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'">
    ${label}
  </button>`;
}

// ナビゲーション：スタックから前の表示に戻る
function _navBack() {
  if(!navStack.length) return;
  const prev = navStack.pop();
  selectedId = prev.id;
  // highlight は traceOrigin を維持（再計算しない）
  if(traceOrigin) {
    traceSet    = new Set(traceOrigin.traceSet);
    traceUpSet  = traceOrigin.traceUpSet ? new Set(traceOrigin.traceUpSet) : null;
    traceDnSet  = traceOrigin.traceDnSet ? new Set(traceOrigin.traceDnSet) : null;
  }
  applyHighlight();
  updateDetail(prev.node, prev.type, prev.stage);  // push しない
}

// ── サイドバーから物質詳細に遷移（原材料詳細から）──────────
function _navToSubFromRaw(instId, rawId) {
  // 現在表示中の原材料ノードをスタックに積む
  const rm = (GR.raw_materials||[]).find(r=>r.id===rawId);
  if(!rm) return;
  navStack.push({ id: rawId, node: rm, type: 'raw_material', stage: 'ingredients' });
  _showInstDetail(instId);
}

// ── 物質インスタンスIDから詳細表示 ─────────────────────────
function _showInstDetail(instId) {
  const inst = (GR.substance_instances||[]).find(i=>i.id===instId)
             || (GR.nodes||[]).find(n=>n.id===instId);
  if(!inst) return;
  selectedId = instId;
  const stage = inst.stage || (inst.stage_nodes?.[0]?.stage) || 'mixing';
  applyHighlight();
  const panel = document.getElementById('detail-panel');
  detailSub(panel, inst, stage);
}

// ── サイドバーから物質詳細に遷移（汎用）────────────────────
function _navToSub(instId, fromNode, fromType, fromStage) {
  navStack.push({ id: fromNode?.id||fromNode, node: fromNode, type: fromType, stage: fromStage });
  _showInstDetail(instId);
}

// ── ingredient_component 詳細 ───────────────────────────────
function detailComp(panel,comp) {
  const col=STEP_COLORS_CSS.ingredient_component;
  const smE=SUB_MASTER_MAP[comp.substance_ref]||{};
  const dn=traceDown(comp.id); const dnSize=dn.size-1;
  // 下流の焼成物を取得
  const bakingDn=[...dn].filter(id=>{
    const inst=(GR.substance_instances||[]).find(i=>i.id===id);
    return inst&&inst.stage==='baking';
  }).slice(0,5);

  panel.innerHTML=`<div class="detail-card">
    <div class="detail-id">${comp.id}</div>
    <div class="detail-name">${comp.name}</div>
    <span class="badge" style="background:${col};color:#070a08">成分分解</span>
    <div style="margin-top:8px;font-size:10px;color:var(--text3)">
      原材料: <span style="color:var(--accent2)">${comp.raw_parent}</span>
    </div>
    <div style="font-size:10px;color:var(--text3)">
      物質参照: <span style="color:var(--accent2)">${comp.substance_ref}</span>
    </div>
    ${comp.state?.mass_g!=null?`<div style="font-size:10px;color:var(--text3)">
      投入量: <span style="color:var(--accent)">${comp.state.mass_g.toFixed(3)}g</span>
      (比率: ${(comp.state.ratio*100).toFixed(1)}%)</div>`:''}
    ${smE.category?`<div style="font-size:9px;color:var(--text3);margin-top:4px">カテゴリ: ${smE.category}</div>`:''}
    <div style="margin-top:10px;font-size:10px;color:var(--text3)">
      下流ノード数: <span style="color:var(--accent)">${dnSize}</span>
    </div>
    ${bakingDn.length?`<div class="detail-section">
      <div class="detail-section-title">焼成後に到達する物質</div>
      ${bakingDn.map(id=>{
        const inst=(GR.substance_instances||[]).find(i=>i.id===id);
        return inst?`<div style="font-size:10px;color:#e85353;margin-bottom:3px">● ${inst.name}</div>`:'';
      }).join('')}
    </div>`:''}
  </div>`;
}

// ── 物質インスタンス詳細 ──────────────────────────────────────
function detailSub(panel,n,stage) {
  const bc=STEP_COLORS_CSS[stage]||'#4a8060';
  // master_id の正規化
  const mid=(n.master_id||n.id).split('@')[0];
  const masterNode=(GR.nodes||[]).find(s=>s.id===mid);
  const smE=SUB_MASTER_MAP[mid]||{};
  const sa=masterNode?.snapshot||{};
  const skeys=['post_mixing_g','post_fermentation_1_g','post_dividing_bench_shaping_g','post_proof_g','post_baking_g'];
  const slbls=['ミキシング後','発酵後','成形後','ホイロ後','焼成後'];
  const vals=skeys.map(k=>parseFloat(sa[k])||0), maxV=Math.max(...vals,.001);

  // trace index から来歴・行先
  const ti=GR.trace_index?.[n.id]||GR.trace_index?.[mid]||{};
  const upC=(ti.upstream||[]).length, dnC=(ti.downstream||[]).length;

  // 自分のCOMPノードを探す
  const myComps=(GR.ingredient_components||[]).filter(c=>c.substance_ref===mid);

  // 工程インスタンス
  const myInsts=(GR.substance_instances||[]).filter(i=>(i.master_id||i.id.split('@')[0])===mid);

  // transformation で生成されたもの（incoming transformation エッジ）
  const inTfm=GR.edges.filter(e=>e.type==='transformation'&&e.target===n.id).slice(0,3);
  const outTfm=GR.edges.filter(e=>e.type==='transformation'&&e.source===n.id).slice(0,3);

  const snapHTML=vals.some(v=>v>0)?`
    <div class="detail-section"><div class="detail-section-title">工程別含量</div><div class="snap-bar-wrap">${
    skeys.map((k,i)=>{const v=sa[k];if(v==null)return'';
      return`<div class="snap-bar-row"><span class="snap-bar-label">${slbls[i]}</span>
        <div class="snap-bar"><div class="snap-bar-fill" style="width:${Math.min(100,(parseFloat(v)||0)/maxV*100)}%;background:${bc}"></div></div>
        <span class="snap-bar-val">${typeof v==='number'?v.toFixed(3):v}g</span></div>`;
    }).join('')}</div></div>`:'';

  const flowHTML=inTfm.length||outTfm.length?`
    <div class="detail-section">
      <div class="detail-section-title">質量フロー</div>
      ${inTfm.map(e=>{
        const src=(GR.substance_instances||[]).find(i=>i.id===e.source);
        return src?`<div style="font-size:9px;color:var(--text3)">⬅ ${src.name} [${e.reaction||''}]</div>`:'';}
      ).join('')}
      ${outTfm.map(e=>{
        const tgt=(GR.substance_instances||[]).find(i=>i.id===e.target);
        return tgt?`<div style="font-size:9px;color:var(--accent2)">➡ ${tgt.name} [${e.reaction||''}]</div>`:'';}
      ).join('')}
    </div>`:'';

  const physHTML=smE.id?`
    <div class="detail-section"><div class="detail-section-title">物性</div>
    <div style="font-size:9px;color:var(--text2);line-height:1.8">
      ${smE.category?`カテゴリ: <span style="color:var(--accent2)">${smE.category}</span><br>`:''}
      ${smE.physical?.molecular_weight?`分子量: ${smE.physical.molecular_weight} g/mol<br>`:''}
      ${smE.sensory?.odor_threshold_ppm!=null?`臭気閾値: ${smE.sensory.odor_threshold_ppm} ppm<br>`:''}
      ${smE.sensory?.descriptors?.length?`香り記述: ${smE.sensory.descriptors.join(', ')}<br>`:''}
    </div></div>`:'';

  const roles=(masterNode?.reaction_roles||[]);
  const hasBack = navStack.length > 0;

  panel.innerHTML=`<div class="detail-card">
    ${hasBack ? _backBtnHTML() : ''}
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${n.name}</div>
    ${n.formula?`<div class="detail-formula">${n.formula}</div>`:''}
    <span class="badge" style="background:${bc};color:#070a08">${STEP_LABELS[stage]||stage}</span>
    ${n.is_volatile?`<span style="font-size:9px;color:#e8b553;padding:2px 6px;border:1px solid #e8b553;border-radius:2px;margin-left:4px">★ 香気</span>`:''}
    <div style="margin-top:10px;display:flex;gap:16px">
      <div style="font-size:10px;color:var(--text3)">▲来歴 <span style="color:var(--accent2)">${upC}</span></div>
      <div style="font-size:10px;color:var(--text3)">▼行先 <span style="color:var(--accent)">${dnC}</span></div>
    </div>
    ${myComps.length?`<div style="font-size:9px;color:var(--text3);margin-top:5px">
      原材料由来: ${myComps.map(c=>`<span style="color:#9b6e3a">${c.raw_parent}</span>`).join(', ')}
    </div>`:''}
    ${physHTML}${flowHTML}
    <div class="detail-section"><div class="detail-section-title">工程インスタンス</div>${
      myInsts.map(inst=>`<div style="display:flex;gap:6px;align-items:center;margin-bottom:3px;font-size:10px;cursor:pointer"
        onclick="selectNode('${inst.id}',(GR.substance_instances||[]).find(x=>x.id==='${inst.id}'),'substance_instance')">
        <div style="width:7px;height:7px;border-radius:50%;background:${STEP_COLORS_CSS[inst.stage]||'#888'};flex-shrink:0"></div>
        <span style="color:${STEP_COLORS_CSS[inst.stage]||'#888'};min-width:72px">${STEP_LABELS[inst.stage]||inst.stage}</span>
        <span style="color:var(--accent2)">${inst.amount_g!=null?inst.amount_g.toFixed(3)+'g':'—'}</span>
      </div>`).join('')}
    </div>
    ${snapHTML}
    ${roles.length?`<div class="detail-section"><div class="detail-section-title">反応への関与</div>${
      roles.slice(0,6).map(r=>`<div style="display:flex;gap:5px;align-items:center;margin-bottom:3px;font-size:10px">
        <span style="min-width:44px;font-weight:bold;color:var(--accent2)">${r.reaction_id}</span>
        <span style="color:${r.consumed?'#e85353':'#53e8b5'}">${r.consumed?'消費':'触媒'}</span>
      </div>`).join('')}</div>`:''}</div>`;
}

// ── 原材料詳細 ───────────────────────────────────────────────
function detailRaw(panel,rm) {
  const col=STEP_COLORS_CSS.ingredients;
  const myComps=(GR.ingredient_components||[]).filter(c=>c.raw_parent===rm.id);
  const dnCount=traceDown(rm.id).size-1;
  const hasBack = navStack.length > 0;

  panel.innerHTML=`<div class="detail-card">
    ${hasBack ? _backBtnHTML() : ''}
    <div class="detail-id">${rm.id}</div>
    <div class="detail-name">${rm.name}</div>
    <span class="badge" style="background:${col};color:#070a08">原材料</span>
    ${rm.ing_id?`<div style="font-size:9px;color:var(--text3);margin-top:5px">ING ID: ${rm.ing_id}</div>`:''}
    <div style="margin-top:10px;font-size:10px;color:var(--text3)">
      下流ノード数: <span style="color:var(--accent)">${dnCount}</span>
    </div>
    ${myComps.length?`<div class="detail-section">
      <div class="detail-section-title">成分一覧 (${myComps.length})</div>
      ${myComps.map(c=>{
        const instId = c.substance_ref + '@mixing';
        const hasInst = (GR.substance_instances||[]).some(i=>i.id===instId);
        const targetId = hasInst ? instId : c.substance_ref;
        return `<div style="display:flex;gap:6px;align-items:center;margin-bottom:3px;font-size:10px;cursor:pointer"
          onclick="_navToSubFromRaw('${targetId}','${rm.id}')"
          onmouseover="this.style.background='rgba(255,255,255,.07)'"
          onmouseout="this.style.background=''"
          style="padding:3px 4px;border-radius:2px;transition:background .12s">
          <div style="width:6px;height:6px;background:#9b6e3a;flex-shrink:0"></div>
          <span style="color:#c89050;min-width:100px">${c.name||c.substance_ref}</span>
          ${c.state?.mass_g!=null?`<span style="color:var(--accent2);margin-left:auto">${c.state.mass_g.toFixed(3)}g</span>`:''}
        </div>`;
      }).join('')}
    </div>`:''}
  </div>`;
}

// ── 反応詳細 ──────────────────────────────────────────────────
function detailRxn(panel,r,stage) {
  const col=STEP_COLORS_CSS[r.stage||r.step]||'#666';
  // stoichiometry から入出力を取得
  const stoich=r.stoichiometry||[];
  // transformation エッジからも取得（stoichiometryがない場合のfallback）
  const tfmEdges=GR.edges.filter(e=>e.type==='transformation'&&e.reaction===r.id);
  const inputs  = new Set(tfmEdges.map(e=>e.source));
  const outputs = new Set(tfmEdges.map(e=>e.target));
  const inList  = [...inputs].map(id=>(GR.substance_instances||[]).find(i=>i.id===id)).filter(Boolean);
  const outList = [...outputs].map(id=>(GR.substance_instances||[]).find(i=>i.id===id)).filter(Boolean);

  const cond=r.conditions||{};
  const condHTML=cond.temperature_C?`<div style="font-size:10px;color:var(--text3);margin-top:6px;line-height:1.7">
    🌡 ${cond.temperature_C.min??'?'}–${cond.temperature_C.max??'?'}℃
    ${cond.time_min?`  ⏱ ${cond.time_min.min}–${cond.time_min.max}min`:''}</div>`:'';
  const sens=r.sensitivity_to_param||{};
  const sensHTML=Object.keys(sens).length?`<div class="detail-section"><div class="detail-section-title">感度</div>${
    Object.entries(sens).map(([k,v])=>{const pct=Math.round((typeof v==='number'?v:.5)*100);const c=pct>75?'#e85353':pct>50?'#e8b553':'#53e8b5';
      return`<div class="snap-bar-row"><span class="snap-bar-label">${k}</span><div class="snap-bar"><div class="snap-bar-fill" style="width:${pct}%;background:${c}"></div></div><span class="snap-bar-val">${pct}%</span></div>`;
    }).join('')}</div>`:'';

  panel.innerHTML=`<div class="detail-card">
    <div class="detail-id">${r.id}</div><div class="detail-name">${r.name}</div>
    <span class="badge" style="background:${col};color:#070a08">${STEP_LABELS[r.stage||r.step]||r.stage}</span>
    ${r.equation?`<div style="font-size:10px;color:var(--text2);line-height:1.65;margin:8px 0;border-left:2px solid ${col};padding-left:8px">${r.equation}</div>`:''}
    ${r.equation_formula?`<div class="detail-formula" style="font-size:9px">${r.equation_formula}</div>`:''}
    ${condHTML}${sensHTML}
    ${inList.length?`<div class="detail-section"><div class="detail-section-title">▶ 入力 (${inList.length})</div>${
      inList.slice(0,8).map(s=>`<div style="font-size:10px;color:var(--text2);margin-bottom:3px;cursor:pointer;display:flex;align-items:center;gap:5px"
        onclick="selectNode('${s.id}',(GR.substance_instances||[]).find(i=>i.id==='${s.id}'),'substance_instance')">
        <div style="width:5px;height:5px;border-radius:50%;background:${STEP_COLORS_CSS[s.stage]||'#888'}"></div>
        ${s.name}${s.stage?`<span style="color:var(--text3);font-size:9px">[${STEP_LABELS[s.stage]||s.stage}]</span>`:''}
      </div>`).join('')}${inList.length>8?`<div style="font-size:9px;color:var(--text3)">他 ${inList.length-8}件</div>`:''}</div>`:''}
    ${outList.length?`<div class="detail-section"><div class="detail-section-title">✦ 出力 (${outList.length})</div>${
      outList.map(s=>`<div style="font-size:10px;color:${s.is_volatile?'var(--accent3)':'var(--accent2)'};margin-bottom:3px;display:flex;align-items:center;gap:5px">
        ${s.is_volatile?'★':'●'} ${s.name}
        ${s.amount_g!=null?`<span style="color:var(--text3);margin-left:auto">${typeof s.amount_g==='number'?s.amount_g.toFixed(3):s.amount_g}g</span>`:''}
      </div>`).join('')}</div>`:''}</div>`;
}

// ─── UI 初期化 ────────────────────────────────────────────────
function initUI() {
  const legend=document.getElementById('step-legend');
  const stepCounts={};
  GR.reactions.forEach(r=>{ const s=r.stage||r.step; stepCounts[s]=(stepCounts[s]||0)+1; });

  const allItem=document.createElement('div');
  allItem.className='step-item active'; allItem.dataset.step='all';
  allItem.innerHTML=`<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${GR.reactions.length}</span>`;
  allItem.addEventListener('click',()=>{activeStep='all';applyHighlight();setStepActive('all');});
  legend.appendChild(allItem);

  STEP_ORDER.forEach(step=>{
    const item=document.createElement('div'); item.className='step-item'; item.dataset.step=step;
    const cnt=step==='ingredient_component'?(GR.ingredient_components||[]).length:(stepCounts[step]||0);
    item.innerHTML=`<div class="step-dot" style="background:${STEP_COLORS_CSS[step]}"></div><span>${STEP_LABELS[step]}</span><span class="step-count">${cnt}</span>`;
    item.addEventListener('click',()=>{activeStep=step;applyHighlight();setStepActive(step);});
    legend.appendChild(item);
  });

  function setStepActive(step) { document.querySelectorAll('.step-item').forEach(i=>i.classList.toggle('active',i.dataset.step===step)); }

  document.querySelectorAll('.filter-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); activeFilter=btn.dataset.filter; applyHighlight();
  }));
  document.getElementById('search-input').addEventListener('input',e=>{ searchQuery=e.target.value.toLowerCase(); applyHighlight(); });

  document.getElementById('btn-zoom-in').onclick=()=>{SCENE_OBJ.controls.state.sph.radius=Math.max(150,SCENE_OBJ.controls.state.sph.radius*.72);SCENE_OBJ.controls.updateCamera();};
  document.getElementById('btn-zoom-out').onclick=()=>{SCENE_OBJ.controls.state.sph.radius=Math.min(6000,SCENE_OBJ.controls.state.sph.radius*1.38);SCENE_OBJ.controls.updateCamera();};
  document.getElementById('btn-reset').onclick=()=>{
    const s=SCENE_OBJ.controls.state;
    s.sph={theta:.15,phi:Math.PI/3.1,radius:1300}; s.target.set(0,-220,0);
    SCENE_OBJ.controls.updateCamera(); clearSel();
  };
  document.getElementById('btn-rotate').onclick=()=>{
    autoRotate=!autoRotate;
    const btn=document.getElementById('btn-rotate');
    btn.style.color=autoRotate?'var(--accent)':''; btn.style.borderColor=autoRotate?'var(--accent)':'';
  };
}

// ─── ナビゲーション ───────────────────────────────────────────
function initNav() {
  initRxnView(); initSubView(); initParamsView();
  document.querySelectorAll('.nav-tab').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const view=btn.dataset.view;
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    if(view!=='graph') document.getElementById(view+'-view').classList.add('active');
  }));
}

function initRxnView() {
  const fd=document.getElementById('rxn-step-filter');
  const ab=document.createElement('button'); ab.className='filter-btn active'; ab.textContent='全工程'; ab.dataset.step='all'; fd.appendChild(ab);
  ['mixing','fermentation_1','dividing_bench_shaping','proof','baking'].forEach(step=>{
    const b=document.createElement('button'); b.className='filter-btn'; b.textContent=STEP_LABELS[step]; b.dataset.step=step; b.style.borderColor=STEP_COLORS_CSS[step]; fd.appendChild(b);
  });
  let rxnStep='all';
  fd.addEventListener('click',e=>{
    if(!e.target.classList.contains('filter-btn')) return;
    fd.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    e.target.classList.add('active'); rxnStep=e.target.dataset.step; renderRxnGrid();
  });
  document.getElementById('rxn-search').addEventListener('input',renderRxnGrid);
  function renderRxnGrid() {
    const q=document.getElementById('rxn-search').value.toLowerCase();
    const grid=document.getElementById('rxn-grid'); grid.innerHTML='';
    GR.reactions
      .filter(r=>rxnStep==='all'||(r.stage||r.step)===rxnStep)
      .filter(r=>!q||(r.name||'').toLowerCase().includes(q)||r.id.toLowerCase().includes(q))
      .forEach(r=>{
        const stg=r.stage||r.step, col=STEP_COLORS_CSS[stg]||'#666';
        const tfm=GR.edges.filter(e=>e.type==='transformation'&&e.reaction===r.id);
        const inC=new Set(tfm.map(e=>e.source)).size;
        const outC=new Set(tfm.map(e=>e.target)).size;
        const card=document.createElement('div'); card.className='rxn-card'; card.style.borderLeftColor=col;
        card.innerHTML=`<div><span class="rxn-step-badge" style="background:${col}">${STEP_LABELS[stg]||stg}</span></div>
          <div class="rxn-id">${r.id}</div><div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div style="margin-top:6px;font-size:9px">
            <span style="color:var(--text3)">入力 ${inC} → </span><span style="color:${col}">出力 ${outC}</span>
          </div>`;
        card.addEventListener('click',()=>{
          document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
          document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
          document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
          selectNode(r.id,r,'reaction');
        });
        grid.appendChild(card);
      });
  }
  renderRxnGrid();
}

function initSubView() {
  document.getElementById('sub-search').addEventListener('input',e=>renderSubTable(e.target.value.toLowerCase()));
  renderSubTable('');
}
function renderSubTable(q) {
  const tbody=document.getElementById('sub-tbody');
  const ml=(SM?.substances)||GR.substance_master||[];
  const filtered=ml.filter(s=>{
    const id=s.id||s.master_id||'', nm=s.name||'', fm=s.formula||'';
    return !q||nm.toLowerCase().includes(q)||fm.toLowerCase().includes(q)||id.toLowerCase().includes(q);
  });
  setEl('sub-count-label',`${filtered.length} / ${ml.length}件`);
  tbody.innerHTML='';
  filtered.slice(0,300).forEach(s=>{
    const id=s.id||s.master_id;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td style="font-size:9px;color:var(--text3)">${id}</td>
      <td style="color:var(--text)">${s.name}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.formula||'—'}</td>
      <td style="font-size:9px;color:#e8b553">${s.is_volatile?'★':'—'}</td>
      <td style="font-size:9px;color:var(--text3)">${s.category||s.nutrition_cat||'—'}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.snapshot_count||'—'}</td>`;
    tr.addEventListener('click',()=>{
      document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
      document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      const instNode=(GR.substance_instances||[]).find(i=>(i.master_id||i.id.split('@')[0])===id)
                   ||(GR.nodes||[]).find(n=>n.id===id);
      if(instNode) selectNode(instNode.id,instNode,'substance_instance');
    });
    tbody.appendChild(tr);
  });
  if(filtered.length>300) {
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:var(--text3);font-size:9px;padding:10px">+${filtered.length-300}件（検索で絞り込み）</td>`;
    tbody.appendChild(tr);
  }
}

function initParamsView() {
  const grid=document.getElementById('params-grid');
  const cp=GR.control_parameters||{};
  (GR.params||[]).forEach(p=>{
    const cpE=cp[p.param_id]||{};
    const card=document.createElement('div'); card.className='param-card';
    const isRange=typeof p.range?.min==='number'&&typeof p.range?.max==='number';
    const min=isRange?p.range.min:0, max=isRange?p.range.max:100;
    const val=cpE.current??p.value??(min+max)/2;
    const affects=(p.affects_reactions||[]).slice(0,5);
    card.innerHTML=`<div class="param-id">${p.param_id}</div><div class="param-name">${p.name}</div>
      <div class="param-val-row"><span class="param-unit">${p.unit||''}</span>
        <span class="param-val-display" id="pv-${p.param_id}">${typeof val==='number'?val.toFixed(1):val}</span></div>
      ${isRange?`<input type="range" class="param-slider" min="${min}" max="${max}" value="${Math.max(min,Math.min(max,typeof val==='number'?val:min))}" step="${(max-min)/100}">
        <div class="param-range">${min} — ${max} ${p.unit||''}</div>`:`<div class="param-range">${JSON.stringify(p.range?.allowed||p.value)}</div>`}
      ${affects.length?`<div class="param-affects-title">影響する反応</div>${affects.map(a=>{
        const sc=a.score||0,pct=sc*100,c=sc>.8?'#e85353':sc>.5?'#e8b553':'#53e8b5';
        return`<div class="affect-row"><span class="affect-rxn">${a.reaction_id}</span><div class="affect-bar"><div class="affect-fill" style="width:${pct}%;background:${c}"></div></div><span class="affect-lbl">${a.sensitivity}</span></div>`;
      }).join('')}`:''}`;
    if(isRange){
      const sl=card.querySelector('.param-slider'),dp=card.querySelector(`#pv-${p.param_id}`);
      sl.addEventListener('input',()=>dp.textContent=parseFloat(sl.value).toFixed(1));
    }
    grid.appendChild(card);
  });
}
