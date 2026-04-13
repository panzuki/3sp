// ══════════════════════════════════════════════════════════════
// bread for myself — app3d.js  v5.0
// 仕様: bread_simulation_json_spec v1.0
// データ: data/14_graph_runtime.json (primary)
//         data/01_substance_master.json, 10_sensory_framework.json (enrichment)
// Three.js r128
// ══════════════════════════════════════════════════════════════

// ─── 工程定義 ─────────────────────────────────────────────────
const STEP_COLORS = {
  ingredients:            0x6b7280,
  mixing:                 0x4a9eff,
  fermentation_1:         0xa8e053,
  dividing_bench_shaping: 0x53b5e8,
  proof:                  0xe8b553,
  baking:                 0xe85353,
};
const STEP_COLORS_CSS = {
  ingredients:            '#6b7280',
  mixing:                 '#4a9eff',
  fermentation_1:         '#a8e053',
  dividing_bench_shaping: '#53b5e8',
  proof:                  '#e8b553',
  baking:                 '#e85353',
};
const STEP_LABELS = {
  ingredients:            '原材料',
  mixing:                 'ミキシング',
  fermentation_1:         '一次発酵',
  dividing_bench_shaping: '分割・成形',
  proof:                  'ホイロ',
  baking:                 '焼成',
};
const STEP_ORDER = ['ingredients','mixing','fermentation_1','dividing_bench_shaping','proof','baking'];
const STAGE_PROCESS_ORDER = {ingredients:0,mixing:1,fermentation_1:2,dividing_bench_shaping:3,proof:4,baking:5};

const BASE_Y    =  300;
const STAGE_GAP =  210;
function getStageY(po) { return BASE_Y - po * STAGE_GAP; }

const TYPE_Y_OFFSET = { raw_material:35, substance_instance:-55, reaction:0 };
const TYPE_RADIUS   = { raw_material:480, substance_instance:350, reaction:210 };

// ─── グローバル状態 ───────────────────────────────────────────
let GR = null;          // 14_graph_runtime.json
let SM = null;          // 01_substance_master.json
let SF = null;          // 10_sensory_framework.json
let SCENE_OBJ = null;
let allMeshes = [], lineMeshes = [], nodeMap = {};
let selectedId = null, traceSet = null;
let autoRotate = false, activeStep = 'all', activeFilter = 'all', searchQuery = '';
let childrenMap = {}, parentsMap = {}, edgeBySource = {}, parentsStrict = {};
let UBIQ_INSTANCES = new Set();
let TRACE_INDEX = {}, ALIAS_MAP = {};
let SUB_MASTER_MAP = {};  // id → substance entry (01_substance_master)

// ─── データ読み込み ──────────────────────────────────────────
async function fetchJSON(urls) {
  for (const url of (Array.isArray(urls)?urls:[urls])) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      console.warn('[fetch] skip', url, r.status);
    } catch(e) { console.warn('[fetch] skip', url, e.message); }
  }
  return null;
}

async function loadAll() {
  GR = await fetchJSON(['data/14_graph_runtime.json','data/graph_data_fixed.json']);
  if (!GR) throw new Error('data/14_graph_runtime.json が見つかりません');

  // enrichment files (optional)
  SM = await fetchJSON('data/01_substance_master.json');
  SF = await fetchJSON('data/10_sensory_framework.json');

  // SUB_MASTER_MAP
  if (SM) SM.substances.forEach(s => { SUB_MASTER_MAP[s.id] = s; });
}

loadAll().then(() => {
  TRACE_INDEX = GR.trace_index || {};
  buildAliasMap();
  buildAdjacency();
  initScene();
  buildGraph();
  initUI();
  initNav();
  animate();

  const m = GR.meta || {};
  setEl('stat-sub',  m.substance_count   ?? GR.substance_master?.length ?? '—');
  setEl('stat-rxn',  m.reaction_count    ?? GR.reactions?.length        ?? '—');
  setEl('stat-edge', m.edge_count        ?? GR.edges?.length            ?? '—');
  setEl('stat-param',m.param_count       ?? GR.params?.length           ?? '—');
}).catch(err => {
  console.error('[fatal]', err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
      background:#070a08;color:#e85353;font-family:monospace;font-size:13px;z-index:9999;padding:30px;text-align:center">
      <div>❌ データ読み込み失敗<br><br>
      <code style="color:#aaa;font-size:11px">${err.message}</code><br><br>
      <span style="color:#6b7280;font-size:11px">data/ フォルダに JSON ファイルを配置してください</span></div></div>`);
});

function setEl(id, val) { const el=document.getElementById(id); if(el) el.textContent=val; }

// ─── エイリアス / 隣接 ───────────────────────────────────────
function buildAliasMap() {
  ALIAS_MAP = {};
  (GR.substance_master||[]).forEach(m => { if (m.alias_of) ALIAS_MAP[m.master_id]=m.alias_of; });
  (GR.nodes||[]).forEach(n => { if (n.alias_of) ALIAS_MAP[n.id]=n.alias_of; });
}
function canonicalId(id) {
  let cur=id; const seen=new Set();
  while (ALIAS_MAP[cur]&&!seen.has(cur)) { seen.add(cur); cur=ALIAS_MAP[cur]; }
  return cur;
}
function canonicalNodeId(id) {
  if (!id) return id;
  if (id.includes('@')) { const [m,s]=id.split('@'); return `${canonicalId(m)}@${s}`; }
  return canonicalId(id);
}
function getTraceEntry(id) {
  const k=canonicalNodeId(id);
  return TRACE_INDEX[k]||TRACE_INDEX[canonicalId(id)]||TRACE_INDEX[id]||{};
}

function buildAdjacency() {
  childrenMap={}; parentsMap={}; edgeBySource={}; parentsStrict={};
  GR.edges.forEach(e => {
    (childrenMap[e.source] = childrenMap[e.source]||[]).push(e.target);
    (parentsMap[e.target]  = parentsMap[e.target] ||[]).push(e.source);
    (edgeBySource[e.source]= edgeBySource[e.source]||[]).push(e);
    if (e.type!=='stage_carry') (parentsStrict[e.target]=parentsStrict[e.target]||[]).push(e.source);
  });

  // ユビキタス物質（5以上の原材料から直接供給）
  const mrCount={};
  GR.edges.forEach(e => {
    if (e.type==='ingredient_to_instance') {
      const mid=e.target.includes('@')?e.target.split('@')[0]:e.target;
      if (!mrCount[mid]) mrCount[mid]=new Set();
      mrCount[mid].add(e.source);
    }
  });
  const ubiqMasters=new Set(Object.entries(mrCount).filter(([,s])=>s.size>=5).map(([m])=>m));
  UBIQ_INSTANCES=new Set();
  (GR.substance_instances||[]).forEach(i=>{ if(ubiqMasters.has(i.master_id)) UBIQ_INSTANCES.add(i.id); });
}

// ─── トレース ────────────────────────────────────────────────
function traceIngredient(rawId) {
  const traced=new Set([rawId]); const queue=[];
  (edgeBySource[rawId]||[]).forEach(e=>{
    if (e.type==='ingredient_to_instance'){
      traced.add(e.target);
      if (!UBIQ_INSTANCES.has(e.target)) queue.push([e.target,0]);
    }
  });
  while (queue.length) {
    const [cur,rxd]=queue.shift();
    (edgeBySource[cur]||[]).forEach(e=>{
      if (traced.has(e.target)) return;
      if (e.type==='stage_carry'){traced.add(e.target);if(!UBIQ_INSTANCES.has(e.target))queue.push([e.target,rxd]);return;}
      if (e.type==='substrate'){traced.add(e.target);queue.push([e.target,rxd+1]);return;}
      if (e.type==='product'){traced.add(e.target);if(!UBIQ_INSTANCES.has(e.target))queue.push([e.target,rxd]);return;}
    });
  }
  return traced;
}
function bfsDown(id){
  const v=new Set(); const q=[id];
  while(q.length){const c=q.pop();if(v.has(c))continue;v.add(c);(childrenMap[c]||[]).forEach(x=>{if(!v.has(x))q.push(x);});}
  return v;
}
function bfsUp(id){
  const v=new Set(); const q=[id];
  while(q.length){const c=q.pop();if(v.has(c))continue;v.add(c);(parentsStrict[c]||[]).forEach(x=>{if(!v.has(x))q.push(x);});}
  return v;
}
function traceBoth(id){
  const up=bfsUp(id),dn=bfsDown(id);
  return {upstream:up,downstream:dn,combined:new Set([...up,...dn,id])};
}
function neighbors2(id){
  const s=new Set([id]);
  GR.edges.forEach(e=>{
    if(e.source!==id&&e.target!==id)return;
    s.add(e.source);s.add(e.target);
    const other=e.source===id?e.target:e.source;
    GR.edges.forEach(e2=>{if(e2.source===other||e2.target===other){s.add(e2.source);s.add(e2.target);}});
  });
  return s;
}

// ─── シード乱数 ──────────────────────────────────────────────
function sr(str){
  let h=0; for(let i=0;i<str.length;i++) h=(Math.imul(31,h)+str.charCodeAt(i))|0;
  h=(h^(h>>>16))*0x45d9f3b|0;h=(h^(h>>>16))*0x45d9f3b|0;h=h^(h>>>16);
  return (h>>>0)/0xFFFFFFFF;
}

// ─── Three.js シーン ─────────────────────────────────────────
function initScene(){
  const canvas=document.getElementById('canvas');
  const W=window.innerWidth,H=window.innerHeight;
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x070a08);
  scene.fog=new THREE.FogExp2(0x070a08,0.00052);
  const camera=new THREE.PerspectiveCamera(48,W/H,1,10000);
  camera.position.set(0,120,1250);
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.setSize(W,H);
  scene.add(new THREE.AmbientLight(0xffffff,0.42));
  const d1=new THREE.DirectionalLight(0xa8e080,1.2);d1.position.set(400,700,400);scene.add(d1);
  const d2=new THREE.DirectionalLight(0x4080ff,0.5);d2.position.set(-500,-200,-300);scene.add(d2);
  scene.add(new THREE.PointLight(0xe0b060,0.7,3000));
  const controls=makeControls(camera,canvas);
  SCENE_OBJ={scene,camera,renderer,controls,raycaster:new THREE.Raycaster()};
  const onResize=()=>{
    const W2=window.innerWidth,H2=window.innerHeight;
    camera.aspect=W2/H2;camera.updateProjectionMatrix();renderer.setSize(W2,H2);
  };
  window.addEventListener('resize',onResize);
  document.addEventListener('sidebar-changed',onResize);
  canvas.addEventListener('click',onCanvasClick);
  canvas.addEventListener('mousemove',onCanvasHover);
}

function makeControls(camera,canvas){
  const st={isDragging:false,isRight:false,prevX:0,prevY:0,
    sph:{theta:.15,phi:Math.PI/3.1,radius:1250},target:new THREE.Vector3(0,-200,0)};
  function upd(){
    const {theta,phi,radius}=st.sph,sp=Math.sin(phi);
    camera.position.set(st.target.x+radius*sp*Math.sin(theta),st.target.y+radius*Math.cos(phi),st.target.z+radius*sp*Math.cos(theta));
    camera.lookAt(st.target);
  }
  upd();
  canvas.addEventListener('mousedown',e=>{st.isDragging=true;st.isRight=e.button===2;st.prevX=e.clientX;st.prevY=e.clientY;});
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  window.addEventListener('mousemove',e=>{
    if(!st.isDragging)return;
    const dx=e.clientX-st.prevX,dy=e.clientY-st.prevY;
    st.prevX=e.clientX;st.prevY=e.clientY;
    if(st.isRight){
      const r=new THREE.Vector3(),u=new THREE.Vector3();
      r.crossVectors(camera.getWorldDirection(new THREE.Vector3()),camera.up).normalize();
      u.copy(camera.up).normalize();
      st.target.addScaledVector(r,-dx*.9);st.target.addScaledVector(u,dy*.9);
    }else{
      st.sph.theta-=dx*.005;
      st.sph.phi=Math.max(.08,Math.min(Math.PI-.08,st.sph.phi+dy*.005));
    }
    upd();
  });
  window.addEventListener('mouseup',()=>st.isDragging=false);
  canvas.addEventListener('wheel',e=>{
    e.preventDefault();
    st.sph.radius=Math.max(150,Math.min(5500,st.sph.radius*(1+e.deltaY*.001)));
    upd();
  },{passive:false});
  let t0=null,td0=0;
  canvas.addEventListener('touchstart',e=>{
    if(e.touches.length===1)t0={x:e.touches[0].clientX,y:e.touches[0].clientY};
    else td0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  },{passive:true});
  canvas.addEventListener('touchmove',e=>{
    if(e.touches.length===1&&t0){
      const dx=e.touches[0].clientX-t0.x,dy=e.touches[0].clientY-t0.y;
      t0={x:e.touches[0].clientX,y:e.touches[0].clientY};
      st.sph.theta-=dx*.006;st.sph.phi=Math.max(.08,Math.min(Math.PI-.08,st.sph.phi+dy*.006));upd();
    }else if(e.touches.length===2){
      const td=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      st.sph.radius=Math.max(150,Math.min(5500,st.sph.radius*(td0/td)));td0=td;upd();
    }
  },{passive:true});
  return {state:st,updateCamera:upd};
}

// ─── グラフ構築 ──────────────────────────────────────────────
function buildGraph(){
  const {scene}=SCENE_OBJ;
  allMeshes=[];lineMeshes=[];nodeMap={};

  // ガイドリング + 縦軸
  STEP_ORDER.forEach((step,i)=>{
    const y=getStageY(i),col=STEP_COLORS[step]||0x444444;
    if(step==='ingredients'){
      addRing(scene,TYPE_RADIUS.raw_material,y+TYPE_Y_OFFSET.raw_material,col,.18);
    }else{
      addRing(scene,TYPE_RADIUS.substance_instance,y+TYPE_Y_OFFSET.substance_instance,col,.12);
      addRing(scene,TYPE_RADIUS.reaction,y+TYPE_Y_OFFSET.reaction,col,.08);
    }
  });
  const axG=new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,BASE_Y+90,0),new THREE.Vector3(0,getStageY(STEP_ORDER.length-1)-110,0)
  ]);
  scene.add(new THREE.Line(axG,new THREE.LineBasicMaterial({color:0x1a3322,transparent:true,opacity:.4})));

  // ── 原材料ノード（八面体）────────────────────────────────
  const raws=GR.raw_materials||[];
  raws.forEach((rm,idx)=>{
    const angle=(idx/raws.length)*Math.PI*2;
    const rj=TYPE_RADIUS.raw_material+(sr(rm.id)-.5)*TYPE_RADIUS.raw_material*.18;
    const y0=getStageY(0)+TYPE_Y_OFFSET.raw_material;
    const yj=y0+(sr(rm.id+'y')-.5)*30;
    const col=STEP_COLORS.ingredients;
    const mesh=new THREE.Mesh(new THREE.OctahedronGeometry(14,0),
      new THREE.MeshPhongMaterial({color:col,emissive:col,emissiveIntensity:.38,shininess:70,transparent:true,opacity:1}));
    mesh.position.set(Math.cos(angle)*rj,yj,Math.sin(angle)*rj);
    // ING IDをuserDataに付加
    const ingId = rm.ing_id || rm.id;
    mesh.userData={id:rm.id,ing_id:ingId,type:'raw_material',node:rm,stage:'ingredients',process_order:0,originalColor:col};
    scene.add(mesh);
    const entry={mesh,node:rm,type:'raw_material',stage:'ingredients'};
    allMeshes.push(entry);nodeMap[rm.id]=entry;
    if(ingId!==rm.id) nodeMap[ingId]=entry;  // ING-xxx でも引けるように
  });

  // ── substance_instance ノード（球）──────────────────────
  const instByStage={};
  (GR.substance_instances||[]).forEach(inst=>{
    const s=inst.stage||'mixing';
    (instByStage[s]=instByStage[s]||[]).push(inst);
  });
  Object.entries(instByStage).forEach(([stage,insts])=>{
    const po=insts[0].process_order??STAGE_PROCESS_ORDER[stage]??1;
    const total=insts.length;
    const yBase=getStageY(po)+TYPE_Y_OFFSET.substance_instance;
    const rBase=TYPE_RADIUS.substance_instance;
    insts.forEach((inst,idx)=>{
      const angle=(idx/total)*Math.PI*2;
      const rj=rBase+(sr(inst.id)-.5)*rBase*.33;
      const yj=yBase+(sr(inst.id+'y')-.5)*42;
      const col=STEP_COLORS[stage]||0x4a8060;
      const isVol=!!inst.is_volatile,r3d=isVol?8:5;
      // 01_substance_master から追加情報
      const smEntry=SUB_MASTER_MAP[inst.master_id]||{};
      const cat=smEntry.category||'starch';
      const mesh=new THREE.Mesh(new THREE.SphereGeometry(r3d,18,12),
        new THREE.MeshPhongMaterial({color:col,emissive:col,
          emissiveIntensity:isVol?.48:.1,shininess:isVol?105:45,transparent:true,opacity:1}));
      mesh.position.set(Math.cos(angle)*rj,yj,Math.sin(angle)*rj);
      mesh.userData={id:inst.id,type:'substance_instance',node:inst,stage,process_order:po,originalColor:col,category:cat};
      scene.add(mesh);
      if(isVol){
        const ring=new THREE.Mesh(new THREE.TorusGeometry(r3d+5,.8,6,28),
          new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.36}));
        ring.position.copy(mesh.position);
        ring.rotation.x=Math.PI/2+(sr(inst.id+'rx')-.5)*1.0;
        ring.rotation.z=(sr(inst.id+'rz')-.5)*.8;
        scene.add(ring);
      }
      const entry={mesh,node:inst,type:'substance_instance',stage};
      allMeshes.push(entry);nodeMap[inst.id]=entry;
    });
  });

  // ── node aliasマップ（既存nodes → instanceへの橋渡し）──
  (GR.nodes||[]).forEach(n=>{
    if(nodeMap[n.id]||n.hidden)return;
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
  GR.reactions.forEach(r=>{const s=r.stage||r.step||'mixing';(rxnByStage[s]=rxnByStage[s]||[]).push(r);});
  Object.entries(rxnByStage).forEach(([stage,rxns])=>{
    const po=rxns[0].process_order??STAGE_PROCESS_ORDER[stage]??1;
    const total=rxns.length;
    const yBase=getStageY(po);
    rxns.forEach((rxn,idx)=>{
      const angle=(idx/total)*Math.PI*2+Math.PI/total;
      const rr=TYPE_RADIUS.reaction+((idx%3)-1)*32;
      const yj=yBase+(sr(rxn.id+'y')-.5)*22;
      const col=STEP_COLORS[stage]||0x666666;
      const mesh=new THREE.Mesh(new THREE.OctahedronGeometry(10,0),
        new THREE.MeshPhongMaterial({color:col,emissive:col,emissiveIntensity:.32,shininess:90,transparent:true,opacity:1}));
      mesh.position.set(Math.cos(angle)*rr,yj,Math.sin(angle)*rr);
      mesh.userData={id:rxn.id,type:'reaction',node:rxn,stage,process_order:po,originalColor:col};
      scene.add(mesh);
      const entry={mesh,node:rxn,type:'reaction',stage};
      allMeshes.push(entry);nodeMap[rxn.id]=entry;
    });
  });

  // ── エッジ（ライン）────────────────────────────────────
  GR.edges.forEach(e=>{
    const se=nodeMap[e.source],te=nodeMap[e.target];
    if(!se||!te)return;
    const geo=new THREE.BufferGeometry().setFromPoints([se.mesh.position.clone(),te.mesh.position.clone()]);
    let col;
    if(e.type==='product')col=0x2a5540;
    else if(e.type==='stage_carry')col=0x334455;
    else if(e.type==='ingredient_to_instance')col=0x6b5530;
    else col=e.is_extinct?0x553333:0x263832;
    const mat=new THREE.LineBasicMaterial({color:col,transparent:true,opacity:.23});
    const line=new THREE.Line(geo,mat);
    scene.add(line);
    lineMeshes.push({line,edge:e,mat,originalColor:col});
  });
}

function addRing(scene,radius,y,color,opacity){
  const mesh=new THREE.Mesh(new THREE.TorusGeometry(radius,1.2,8,72),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity}));
  mesh.position.y=y;mesh.rotation.x=Math.PI/2;scene.add(mesh);
}

// ─── ハイライト ───────────────────────────────────────────────
function applyHighlight(){
  allMeshes.forEach(({mesh})=>{
    const ud=mesh.userData;
    const inTr=traceSet?traceSet.has(ud.id):true,vis=isVisible(ud),isSel=ud.id===selectedId;
    if(!vis){mesh.material.opacity=0.02;mesh.material.emissiveIntensity=0;return;}
    if(!inTr&&traceSet){mesh.material.opacity=0.04;mesh.material.emissiveIntensity=0;mesh.scale.setScalar(1);}
    else if(isSel){
      mesh.material.color.setHex(0xffffff);mesh.material.emissive.setHex(0xffffff);
      mesh.material.emissiveIntensity=0.75;mesh.material.opacity=1;mesh.scale.setScalar(1.65);
    }else{
      const col=ud.originalColor,isVol=ud.node?.is_volatile;
      mesh.material.color.setHex(col);mesh.material.emissive.setHex(col);
      mesh.material.emissiveIntensity=inTr&&traceSet?(isVol?.58:.24):(isVol?.40:.1);
      mesh.material.opacity=1;mesh.scale.setScalar(1);
    }
  });
  lineMeshes.forEach(({edge,mat,originalColor})=>{
    if(traceSet){
      const both=traceSet.has(edge.source)&&traceSet.has(edge.target);
      mat.opacity=both?.90:.016;
      if(both){
        if(edge.type==='product')mat.color.setHex(0xa8e053);
        else if(edge.type==='stage_carry')mat.color.setHex(0x4488aa);
        else if(edge.type==='ingredient_to_instance')mat.color.setHex(0xffaa55);
        else mat.color.setHex(0x4a9eff);
      }else mat.color.setHex(originalColor);
    }else{mat.opacity=.20;mat.color.setHex(originalColor);}
  });
}

function isVisible(ud){
  const {id,type,stage}=ud;
  if(activeStep!=='all'){
    if(type==='reaction'&&stage!==activeStep)return false;
    if(type==='substance_instance'&&stage!==activeStep)return false;
    if(type==='raw_material'&&activeStep!=='ingredients')return false;
  }
  if(activeFilter==='volatile'&&(type==='substance_instance'||type==='substance')&&!ud.node?.is_volatile)return false;
  if(activeFilter==='reactions'&&type!=='reaction')return false;
  if(searchQuery){
    const n=ud.node;
    if(!((n?.name||'').toLowerCase().includes(searchQuery)||(n?.formula||'').toLowerCase().includes(searchQuery)||(id||'').toLowerCase().includes(searchQuery)))return false;
  }
  return true;
}

// ─── アニメーション ───────────────────────────────────────────
let _fr=0;
function animate(){
  requestAnimationFrame(animate);_fr++;
  if(autoRotate&&SCENE_OBJ){SCENE_OBJ.controls.state.sph.theta+=.0025;SCENE_OBJ.controls.updateCamera();}
  if(selectedId&&nodeMap[selectedId]){const s=1.48+Math.sin(_fr*.09)*.18;nodeMap[selectedId].mesh.scale.setScalar(s);}
  SCENE_OBJ.renderer.render(SCENE_OBJ.scene,SCENE_OBJ.camera);
}

// ─── クリック / ホバー ────────────────────────────────────────
let _cm=false,_md={x:0,y:0};
document.addEventListener('DOMContentLoaded',()=>{
  const cv=document.getElementById('canvas');
  cv.addEventListener('mousedown',e=>{_cm=false;_md={x:e.clientX,y:e.clientY};});
  cv.addEventListener('mousemove',e=>{if(Math.hypot(e.clientX-_md.x,e.clientY-_md.y)>5)_cm=true;});
});

function onCanvasClick(e){
  if(_cm)return;
  const hit=raycast(e);
  if(!hit){clearSel();return;}
  selectNode(hit.object.userData.id,hit.object.userData.node,hit.object.userData.type);
}
let _hov=null;
function onCanvasHover(e){
  const hit=raycast(e);
  if(hit){
    const {id,node,type}=hit.object.userData;
    if(id!==_hov){_hov=id;showTT(e,node,type);}else moveTT(e);
    document.getElementById('canvas').style.cursor='pointer';
  }else{_hov=null;hideTT();document.getElementById('canvas').style.cursor='default';}
}
function raycast(e){
  const {camera,raycaster}=SCENE_OBJ;
  const rect=document.getElementById('canvas').getBoundingClientRect();
  const mouse=new THREE.Vector2(((e.clientX-rect.left)/rect.width)*2-1,((e.clientY-rect.top)/rect.height)*-2+1);
  raycaster.setFromCamera(mouse,camera);
  const hits=raycaster.intersectObjects(allMeshes.map(m=>m.mesh));
  return hits.length?hits[0]:null;
}

// ─── ノード選択 ───────────────────────────────────────────────
function selectNode(id,node,type){
  selectedId=id;
  const entry=nodeMap[id];
  const stage=entry?.stage||node?.stage||'mixing';
  let traceIds,msg,icon='🔍';
  if(type==='raw_material'){
    traceIds=traceIngredient(id);
    msg=`${node?.name||id} → 下流 ${traceIds.size-1} ノード`;icon='🔶';
  }else if(stage==='baking'||stage==='final'){
    const {upstream,combined}=traceBoth(id);
    traceIds=combined;msg=`${node?.name||id} ← 上流 ${upstream.size} ノード`;icon='🔴';
  }else if(type==='substance_instance'||type==='substance'){
    const {upstream,downstream,combined}=traceBoth(id);
    traceIds=combined;msg=`${node?.name||id}  ▲${upstream.size}  ▼${downstream.size}`;icon='🔵';
  }else{
    traceIds=neighbors2(id);msg=`${node?.name||id}  関連 ${traceIds.size} ノード`;icon='🔷';
  }
  traceSet=traceIds;applyHighlight();showTraceBar(msg,icon);updateDetail(node,type,stage);
}
function clearSel(){selectedId=null;traceSet=null;hideTraceBar();applyHighlight();updateDetail(null);}

// ─── トレースバー ─────────────────────────────────────────────
function showTraceBar(msg,icon){
  setEl('trace-icon',icon||'🔍');setEl('trace-info',msg);
  document.getElementById('trace-bar').classList.add('visible');
}
function hideTraceBar(){document.getElementById('trace-bar').classList.remove('visible');}
document.getElementById('trace-close').addEventListener('click',clearSel);

// ─── ツールチップ ─────────────────────────────────────────────
function showTT(e,node,type){
  if(!node)return;
  setEl('tt-name',node.name||node.id||'');
  let sub='';
  if(type==='reaction')sub=`反応  [${STEP_LABELS[node.stage||node.step]||''}]`;
  else if(type==='raw_material')sub='原材料  '+(node.ing_name||'');
  else{
    const smE=SUB_MASTER_MAP[node.master_id]||{};
    sub=[node.formula,node.is_volatile?'★ 香気物質':'',smE.category?`[${smE.category}]`:'',node.stage?`[${STEP_LABELS[node.stage]}]`:''].filter(Boolean).join('  ');
  }
  setEl('tt-sub',sub.trim());
  document.getElementById('tooltip').style.opacity='1';moveTT(e);
}
function moveTT(e){
  const tt=document.getElementById('tooltip');
  tt.style.left=Math.min(e.clientX+16,window.innerWidth-240)+'px';
  tt.style.top=Math.max(e.clientY-34,8)+'px';
}
function hideTT(){document.getElementById('tooltip').style.opacity='0';}

// ─── 詳細パネル ───────────────────────────────────────────────
function updateDetail(node,type,stage){
  const panel=document.getElementById('detail-panel');
  if(!node){
    panel.innerHTML=`<div class="detail-empty">
      球をクリックすると詳細表示<br><br>
      <b style="color:var(--text2)">トレース</b><br>
      🔶 原材料 → 下流全経路<br>
      🔵 中間物質 → ⇅上下両方向<br>
      🔴 焼成物 → 上流全経路<br>
      🔷 反応 → 前後2ホップ<br><br>
      <b style="color:var(--text2)">操作</b><br>
      ドラッグ → 回転<br>ホイール/ピンチ → ズーム<br>右ドラッグ → パン
    </div>`;return;
  }
  if(type==='reaction') detailRxn(panel,node,stage);
  else if(type==='raw_material') detailRaw(panel,node);
  else detailSub(panel,node,stage);
}

function detailSub(panel,n,stage){
  const bc=STEP_COLORS_CSS[stage]||'#4a8060';
  const mid=canonicalId(n.master_id||n.id);
  const masterNode=(GR.nodes||[]).find(s=>s.id===mid);
  const smE=SUB_MASTER_MAP[mid]||{};
  const sa=masterNode?.snapshot||{};
  const skeys=['post_mixing_g','post_fermentation_1_g','post_dividing_bench_shaping_g','post_proof_g','post_baking_g'];
  const slbls=['ミキシング後','発酵後','成形後','ホイロ後','焼成後'];
  const vals=skeys.map(k=>parseFloat(sa[k])||0),maxV=Math.max(...vals,.001);
  const ti=getTraceEntry(mid);
  const upC=ti.upstream?ti.upstream.length:(Object.keys(Object.fromEntries((parentsStrict[n.id]||[]).map(x=>[x,1]))).length);
  const dnC=ti.downstream?ti.downstream.length:((GR.edges||[]).filter(e=>e.source===n.id).length);
  const myInsts=(GR.substance_instances||[]).filter(i=>canonicalId(i.master_id)===mid);

  // 01_substance_masterからの物性情報
  const physHTML=smE.id?`
    <div class="detail-section">
      <div class="detail-section-title">物性（仕様書）</div>
      <div style="font-size:9px;color:var(--text2);line-height:1.8">
        ${smE.category?`カテゴリ: <span style="color:var(--accent2)">${smE.category}</span><br>`:''}
        ${smE.physical?.molecular_weight?`分子量: ${smE.physical.molecular_weight} g/mol<br>`:''}
        ${smE.physical?.volatility_class?`揮発性: ${smE.physical.volatility_class}<br>`:''}
        ${smE.sensory?.odor_threshold_ppm?`臭気閾値: ${smE.sensory.odor_threshold_ppm} ppm<br>`:''}
        ${smE.sensory?.descriptors?.length?`香り記述: ${smE.sensory.descriptors.join(', ')}<br>`:''}
      </div>
    </div>`:''

  const instHTML=myInsts.length?`
    <div class="detail-section"><div class="detail-section-title">工程インスタンス</div>${
    myInsts.map(i=>`<div style="display:flex;gap:6px;align-items:center;margin-bottom:3px;font-size:10px;cursor:pointer"
      onclick="selectNode('${i.id}',(GR.substance_instances||[]).find(x=>x.id==='${i.id}'),'substance_instance')">
      <div style="width:7px;height:7px;border-radius:50%;background:${STEP_COLORS_CSS[i.stage]||'#888'};flex-shrink:0"></div>
      <span style="color:${STEP_COLORS_CSS[i.stage]||'#888'};min-width:72px">${STEP_LABELS[i.stage]||i.stage}</span>
      <span style="color:var(--accent2)">${i.amount_g!=null?i.amount_g.toFixed(3)+'g':'—'}</span>
    </div>`).join('')}</div>`:'';

  const snapHTML=vals.some(v=>v>0)?`
    <div class="detail-section"><div class="detail-section-title">工程別含量</div><div class="snap-bar-wrap">${
    skeys.map((k,i)=>{const v=sa[k];if(v==null)return'';
      return`<div class="snap-bar-row"><span class="snap-bar-label">${slbls[i]}</span>
        <div class="snap-bar"><div class="snap-bar-fill" style="width:${Math.min(100,(parseFloat(v)||0)/maxV*100)}%;background:${bc}"></div></div>
        <span class="snap-bar-val">${typeof v==='number'?v.toFixed(3):v}g</span></div>`;
    }).join('')}</div></div>`:'';

  const roles=masterNode?.reaction_roles||[];
  panel.innerHTML=`<div class="detail-card">
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${n.name}</div>
    ${n.formula?`<div class="detail-formula">${n.formula}</div>`:''}
    <span class="badge" style="background:${bc};color:#070a08">${STEP_LABELS[stage]||stage}</span>
    ${n.is_volatile?`<span style="font-size:9px;color:#e8b553;padding:2px 6px;border:1px solid #e8b553;border-radius:2px;margin-left:4px">★ 香気</span>`:''}
    <div style="margin-top:10px;display:flex;gap:14px">
      <div style="font-size:10px;color:var(--text3)">上流 <span style="color:var(--accent2)">${upC}</span></div>
      <div style="font-size:10px;color:var(--text3)">下流 <span style="color:var(--accent)">${dnC}</span></div>
    </div>
    ${n.note?`<div style="font-size:10px;color:var(--text2);margin-top:8px;line-height:1.65;border-left:2px solid ${bc};padding-left:8px">${n.note}</div>`:''}
    ${physHTML}${instHTML}${snapHTML}
    ${roles.length?`<div class="detail-section"><div class="detail-section-title">反応への関与 (${roles.length})</div>${
      roles.slice(0,8).map(r=>`<div style="display:flex;gap:5px;align-items:center;margin-bottom:3px;font-size:10px">
        <span style="min-width:44px;font-weight:bold;color:var(--accent2)">${r.reaction_id}</span>
        <span style="color:${r.consumed?'#e85353':'#53e8b5'}">${r.consumed?'消費':'触媒'}</span>
      </div>`).join('')}${roles.length>8?`<div style="font-size:9px;color:var(--text3)">他 ${roles.length-8}件</div>`:''}</div>`:''}</div>`;
}

function detailRaw(panel,rm){
  const col=STEP_COLORS_CSS.ingredients;
  // ING master情報
  const ingMaster=(GR.ingredient_master||{ingredients:[]}).ingredients?.find(i=>i.raw_id===rm.id);
  const downInsts=GR.edges.filter(e=>e.source===rm.id&&e.type==='ingredient_to_instance')
    .map(e=>(GR.substance_instances||[]).find(i=>i.id===e.target)).filter(Boolean);
  const ingHTML=ingMaster?`
    <div class="detail-section"><div class="detail-section-title">原材料マスター情報</div>
    <div style="font-size:10px;color:var(--text2);line-height:1.8">
      ID: <span style="color:var(--accent2)">${ingMaster.id}</span><br>
      投入量: <span style="color:var(--accent)">${ingMaster.amount_g}g</span>
    </div></div>`:'';
  panel.innerHTML=`<div class="detail-card">
    <div class="detail-id">${rm.id}</div>
    <div class="detail-name">${rm.name}</div>
    <span class="badge" style="background:${col};color:#070a08">原材料</span>
    ${rm.ing_id?`<div style="font-size:9px;color:var(--text3);margin-top:5px">ING ID: ${rm.ing_id}</div>`:''}
    <div style="margin-top:10px;font-size:10px;color:var(--text3)">下流ノード数 <span style="color:var(--accent)">${Math.max(0,traceIngredient(rm.id).size-1)}</span></div>
    ${ingHTML}
    ${downInsts.length?`<div class="detail-section"><div class="detail-section-title">直接供給先 (${downInsts.length})</div>${
      downInsts.map(i=>`<div style="font-size:10px;color:${STEP_COLORS_CSS[i.stage]||'#888'};margin-bottom:4px;cursor:pointer;display:flex;align-items:center;gap:6px"
        onclick="selectNode('${i.id}',(GR.substance_instances||[]).find(x=>x.id==='${i.id}'),'substance_instance')">
        <div style="width:6px;height:6px;border-radius:50%;background:${STEP_COLORS_CSS[i.stage]||'#888'}"></div>
        ${i.name}${i.amount_g!=null?`<span style="color:var(--accent2);margin-left:auto">${i.amount_g.toFixed(3)}g</span>`:''}
      </div>`).join('')}</div>`:''}</div>`;
}

function detailRxn(panel,r,stage){
  const col=STEP_COLORS_CSS[r.stage||r.step]||'#666';
  const subsList=GR.edges.filter(e=>e.target===r.id&&e.type==='substrate').map(e=>nodeMap[e.source]?.node).filter(Boolean);
  const prodsList=GR.edges.filter(e=>e.source===r.id&&e.type==='product').map(e=>nodeMap[e.target]?.node).filter(Boolean);
  const cond=r.conditions||{};
  const condHTML=cond.temperature_C?`<div style="font-size:10px;color:var(--text3);margin-top:6px;line-height:1.7">
    🌡 ${cond.temperature_C.min??'?'}–${cond.temperature_C.max??'?'}℃
    ${cond.time_min?`  ⏱ ${cond.time_min.min}–${cond.time_min.max}min`:''}</div>`:'';
  const sens=r.sensitivity_to_param||{};
  const sensHTML=Object.keys(sens).length?`<div class="detail-section"><div class="detail-section-title">感度パラメーター</div>${
    Object.entries(sens).map(([k,v])=>{const pct=Math.round((typeof v==='number'?v:.5)*100);const c=pct>75?'#e85353':pct>50?'#e8b553':'#53e8b5';
      return`<div class="snap-bar-row"><span class="snap-bar-label">${k}</span><div class="snap-bar"><div class="snap-bar-fill" style="width:${pct}%;background:${c}"></div></div><span class="snap-bar-val">${pct}%</span></div>`;
    }).join('')}</div>`:'';
  panel.innerHTML=`<div class="detail-card">
    <div class="detail-id">${r.id}</div><div class="detail-name">${r.name}</div>
    <span class="badge" style="background:${col};color:#070a08">${STEP_LABELS[r.stage||r.step]||r.stage}</span>
    ${r.equation?`<div style="font-size:10px;color:var(--text2);line-height:1.65;margin:8px 0;border-left:2px solid ${col};padding-left:8px">${r.equation}</div>`:''}
    ${r.equation_formula?`<div class="detail-formula" style="font-size:9px">${r.equation_formula}</div>`:''}
    ${condHTML}${sensHTML}
    ${subsList.length?`<div class="detail-section"><div class="detail-section-title">▶ 基質 (${subsList.length})</div>${
      subsList.slice(0,8).map(s=>`<div style="font-size:10px;color:var(--text2);margin-bottom:3px;cursor:pointer;display:flex;align-items:center;gap:5px"
        onclick="selectNode('${s.id}',(GR.substance_instances||[]).find(i=>i.id==='${s.id}')||(GR.nodes||[]).find(n=>n.id==='${s.id}'),'substance_instance')">
        <div style="width:5px;height:5px;border-radius:50%;background:${STEP_COLORS_CSS[s.stage]||'#888'}"></div>
        ${s.name}${s.stage?`<span style="color:var(--text3);font-size:9px">[${STEP_LABELS[s.stage]||s.stage}]</span>`:''}
      </div>`).join('')}${subsList.length>8?`<div style="font-size:9px;color:var(--text3)">他 ${subsList.length-8}件</div>`:''}</div>`:''}
    ${prodsList.length?`<div class="detail-section"><div class="detail-section-title">✦ 生成物 (${prodsList.length})</div>${
      prodsList.map(s=>`<div style="font-size:10px;color:${s.is_volatile?'var(--accent3)':'var(--accent2)'};margin-bottom:3px;display:flex;align-items:center;gap:5px">
        ${s.is_volatile?'★':'●'} ${s.name}${s.amount_g!=null?`<span style="color:var(--text3);margin-left:auto">${typeof s.amount_g==='number'?s.amount_g.toFixed(3):s.amount_g}g</span>`:''}
      </div>`).join('')}</div>`:''}</div>`;
}

// ─── UI 初期化 ────────────────────────────────────────────────
function initUI(){
  const legend=document.getElementById('step-legend');
  const stepCounts={};
  GR.reactions.forEach(r=>{const s=r.stage||r.step;stepCounts[s]=(stepCounts[s]||0)+1;});

  const allItem=document.createElement('div');
  allItem.className='step-item active';allItem.dataset.step='all';
  allItem.innerHTML=`<div class="step-dot" style="background:#555"></div><span>全工程</span><span class="step-count">${GR.reactions.length}</span>`;
  allItem.addEventListener('click',()=>{activeStep='all';applyHighlight();setStepActive('all');});
  legend.appendChild(allItem);
  STEP_ORDER.forEach(step=>{
    const item=document.createElement('div');item.className='step-item';item.dataset.step=step;
    item.innerHTML=`<div class="step-dot" style="background:${STEP_COLORS_CSS[step]}"></div><span>${STEP_LABELS[step]}</span><span class="step-count">${stepCounts[step]||0}</span>`;
    item.addEventListener('click',()=>{activeStep=step;applyHighlight();setStepActive(step);});
    legend.appendChild(item);
  });
  function setStepActive(step){document.querySelectorAll('.step-item').forEach(i=>i.classList.toggle('active',i.dataset.step===step));}

  document.querySelectorAll('.filter-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');activeFilter=btn.dataset.filter;applyHighlight();
  }));
  document.getElementById('search-input').addEventListener('input',e=>{searchQuery=e.target.value.toLowerCase();applyHighlight();});

  document.getElementById('btn-zoom-in').onclick=()=>{SCENE_OBJ.controls.state.sph.radius=Math.max(150,SCENE_OBJ.controls.state.sph.radius*.72);SCENE_OBJ.controls.updateCamera();};
  document.getElementById('btn-zoom-out').onclick=()=>{SCENE_OBJ.controls.state.sph.radius=Math.min(5500,SCENE_OBJ.controls.state.sph.radius*1.38);SCENE_OBJ.controls.updateCamera();};
  document.getElementById('btn-reset').onclick=()=>{
    const s=SCENE_OBJ.controls.state;
    s.sph={theta:.15,phi:Math.PI/3.1,radius:1250};s.target.set(0,-200,0);
    SCENE_OBJ.controls.updateCamera();clearSel();
  };
  document.getElementById('btn-rotate').onclick=()=>{
    autoRotate=!autoRotate;
    const btn=document.getElementById('btn-rotate');
    btn.style.color=autoRotate?'var(--accent)':'';btn.style.borderColor=autoRotate?'var(--accent)':'';
  };
}

// ─── ナビゲーション ───────────────────────────────────────────
function initNav(){
  initRxnView();initSubView();initParamsView();
  document.querySelectorAll('.nav-tab').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const view=btn.dataset.view;
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    if(view!=='graph')document.getElementById(view+'-view').classList.add('active');
  }));
}

function initRxnView(){
  const fd=document.getElementById('rxn-step-filter');
  const ab=document.createElement('button');ab.className='filter-btn active';ab.textContent='全工程';ab.dataset.step='all';fd.appendChild(ab);
  STEP_ORDER.filter(s=>s!=='ingredients').forEach(step=>{
    const b=document.createElement('button');b.className='filter-btn';b.textContent=STEP_LABELS[step];b.dataset.step=step;b.style.borderColor=STEP_COLORS_CSS[step];fd.appendChild(b);
  });
  let rxnStep='all';
  fd.addEventListener('click',e=>{
    if(!e.target.classList.contains('filter-btn'))return;
    fd.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    e.target.classList.add('active');rxnStep=e.target.dataset.step;renderRxnGrid();
  });
  document.getElementById('rxn-search').addEventListener('input',renderRxnGrid);
  function renderRxnGrid(){
    const q=document.getElementById('rxn-search').value.toLowerCase();
    const grid=document.getElementById('rxn-grid');grid.innerHTML='';
    GR.reactions
      .filter(r=>rxnStep==='all'||(r.stage||r.step)===rxnStep)
      .filter(r=>!q||(r.name||'').toLowerCase().includes(q)||r.id.toLowerCase().includes(q))
      .forEach(r=>{
        const stg=r.stage||r.step,col=STEP_COLORS_CSS[stg]||'#666';
        const subs=GR.edges.filter(e=>e.target===r.id&&e.type==='substrate').length;
        const prods=GR.edges.filter(e=>e.source===r.id&&e.type==='product').length;
        const card=document.createElement('div');card.className='rxn-card';card.style.borderLeftColor=col;
        card.innerHTML=`<div><span class="rxn-step-badge" style="background:${col}">${STEP_LABELS[stg]||stg}</span></div>
          <div class="rxn-id">${r.id}</div><div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div style="margin-top:6px;font-size:9px"><span style="color:var(--text3)">基質 ${subs} → </span><span style="color:${col}">生成物 ${prods}</span></div>`;
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

function initSubView(){
  document.getElementById('sub-search').addEventListener('input',e=>renderSubTable(e.target.value.toLowerCase()));
  renderSubTable('');
}
function renderSubTable(q){
  const tbody=document.getElementById('sub-tbody');
  // 01_substance_masterがあればそちらを優先、なければGRのsubstance_master
  const ml=(SM?.substances)||GR.substance_master||[];
  // 01の場合はid/name, GRの場合はmaster_id/name
  const filtered=ml.filter(s=>{
    const id=s.id||s.master_id||'';const nm=s.name||'';const fm=s.formula||'';
    return !q||nm.toLowerCase().includes(q)||fm.toLowerCase().includes(q)||id.toLowerCase().includes(q);
  });
  setEl('sub-count-label',`${filtered.length} / ${ml.length}件`);
  tbody.innerHTML='';
  filtered.slice(0,300).forEach(s=>{
    const id=s.id||s.master_id;
    const cat=s.category||s.nutrition_cat||'—';
    const isVol=s.is_volatile||false;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td style="font-size:9px;color:var(--text3)">${id}</td>
      <td style="color:var(--text)">${s.name}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.formula||'—'}</td>
      <td style="font-size:9px;color:#e8b553">${isVol?'★':'—'}</td>
      <td style="font-size:9px;color:var(--text3)">${cat}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.snapshot_count||'—'}</td>`;
    tr.addEventListener('click',()=>{
      document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
      document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      const ti=TRACE_INDEX[id];const instId=ti?.instances?.[0]||id;
      const instNode=(GR.substance_instances||[]).find(i=>i.id===instId)||(GR.nodes||[]).find(n=>n.id===id);
      selectNode(instId,instNode,'substance_instance');
    });
    tbody.appendChild(tr);
  });
  if(filtered.length>300){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:var(--text3);font-size:9px;padding:10px">+${filtered.length-300}件（検索で絞り込み）</td>`;
    tbody.appendChild(tr);
  }
}

function initParamsView(){
  const grid=document.getElementById('params-grid');
  // control_parameters (仕様書形式) か params (旧形式) を使う
  const params=GR.params||[];
  const cp=GR.control_parameters||{};
  params.forEach(p=>{
    const cpEntry=cp[p.param_id]||{};
    const card=document.createElement('div');card.className='param-card';
    const isRange=typeof p.range?.min==='number'&&typeof p.range?.max==='number';
    const min=isRange?p.range.min:0,max=isRange?p.range.max:100;
    const val=cpEntry.current??p.value??(min+max)/2;
    const affects=(p.affects_reactions||[]).slice(0,5);
    card.innerHTML=`<div class="param-id">${p.param_id}</div><div class="param-name">${p.name}</div>
      <div class="param-val-row"><span class="param-unit">${p.unit||cpEntry.unit||''}</span><span class="param-val-display" id="pv-${p.param_id}">${typeof val==='number'?val.toFixed(1):val}</span></div>
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
