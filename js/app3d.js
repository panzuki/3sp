// ══════════════════════════════════════════════════════════════
// bread for myself — app3d.js  v8.6  RAW upstream trace fix
// 仕様: 原材料ノードまでの上流トレース完全修正版
//   - dfsUp から fromIngredientEdge フラグを廃止
//   - bwdMap の ingredient_input を単純に逆向き辿るだけにして
//     COMP → RAW まで完全に遡れるよう修正
//   - onNodeClick を selectNode() に委譲しトレース経路を統一
//   - 反応一覧クリックとツリークリックが同一結果を返すよう保証
//   - UNRハブは substance_instance 起点では展開停止
// データ: 14_graph_runtime.json  schema v3.3-unreaction-hub
// Three.js r128
//
// アーキテクチャ:
//   nodes[] + edges[]  のグラフをそのまま描画
//   TRACEABLE = ["ingredient_input", "input", "output"] (+ mass_flow fallback)
//   reaction もグラフノード → trace() で統一処理
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

// ─── トレース設定（§10.3）────────────────────────────────────
// ingredient_input / input / output を主対象にトレース
// 旧データ互換のため mass_flow も残す
const TRACEABLE_TYPES = new Set(['ingredient_input','input','output','mass_flow','flow_split']);

// ─── グローバル状態 ───────────────────────────────────────────
let GR = null, SM = null;
let SCENE_OBJ = null;
let allMeshes = [], lineMeshes = [], nodeMap = {};
let selectedId = null, traceSet = null, traceUpSet = null, traceDnSet = null;
let autoRotate = false, activeStep = 'all', activeFilter = 'all', searchQuery = '';

// ─── Snapshot（v3.0）─────────────────────────────────────────
let activeSnapshot = 'all';
let SNAP_MAP = {};

// ─── ナビゲーション履歴 ───────────────────────────────────────
let traceOrigin = null;
let navStack    = [];

// ─── §10.2 隣接マップ（仕様書通り）──────────────────────────
let fwdMap = {};   // node_id → [edge, ...]
let bwdMap = {};   // node_id → [edge, ...]
let SUB_MASTER_MAP = {};

// ─── データ読み込み ──────────────────────────────────────────
async function fetchJSON(urls) {
  for (const url of (Array.isArray(urls)?urls:[urls])) {
    try { const r=await fetch(url); if(r.ok) return await r.json(); }
    catch(e) { console.warn('[fetch]', url, e.message); }
  }
  return null;
}

// loadAll() は下部の FLOW-RUNTIME OVERRIDES セクションで定義（SimSpec込み完全版）
// 起動エントリポイントもそちらに統合済み

function setEl(id,v) { const e=document.getElementById(id); if(e) e.textContent=v; }

// ─── §10.2 隣接マップ構築（仕様書通り）──────────────────────
function buildAdjacency() {
  fwdMap = {}; bwdMap = {};
  (GR.nodes||[]).forEach(n => {
    fwdMap[n.id] = [];
    bwdMap[n.id] = [];
  });
  (GR.edges||[]).forEach(e => {
    if (!fwdMap[e.source]) fwdMap[e.source] = [];
    if (!bwdMap[e.target]) bwdMap[e.target] = [];
    fwdMap[e.source].push(e);
    bwdMap[e.target].push(e);
  });
}

// ─── §10.4 トレースロジック v8.6 ──────────────────────────────
//
// 【実データ確認済みのエッジ構造】
//   RAW --ingredient_input--> COMP --ingredient_input--> SUB
//   SUB --input--> RXN --output--> SUB
//   ※ RAW の bwdMap は空（RAW より上流ノードは存在しない）
//
// 【v8.5 のバグ】
//   dfsUp(COMP, fromIngredientEdge=true) で isIngNode=true かつ
//   fromIngredientEdge=true → return してしまい、COMP から RAW へ
//   辿る前に停止していた。
//
// 【v8.6 修正方針】
//   dfsUp: fromIngredientEdge フラグを廃止し、シンプルに
//     「bwdMap の ingredient_input / input / output / mass_flow / flow_split
//      を再帰的に逆向きに辿る」だけにする。
//     RAW の bwdMap は空なので自然停止。爆発も起きない
//     （dfsUp は fwdMap を一切触らないため ingredient_input 下流には展開しない）。
//
//   dfsDn: ingredient モード（RAW/COMP 起点）では ingredient_input のみ展開。
//          normal モード（SUB/RXN 起点）では input/output/mass_flow/flow_split のみ展開。
//
//   反応ノード起点: 入力物質→dfsUp、出力物質→dfsDn(normal) で統一。
// ──────────────────────────────────────────────────────────────

function isUNRHub(nodeId) {
  return typeof nodeId === 'string' && nodeId.startsWith('node-UNR-HUB-');
}

function getNodeType(nodeId) {
  const entry = nodeMap[nodeId];
  return entry ? (entry.node?.type || entry.type || '') : '';
}

function trace(nodeId) {
  return traceUnified(nodeId);
}

// 統一トレース関数（v8.6）
function traceUnified(nodeId) {
  const startType = getNodeType(nodeId);
  const startIsHub        = isUNRHub(nodeId);
  const startIsIngredient = (startType === 'raw_material' || startType === 'ingredient_component');
  const startIsReaction   = (startType === 'reaction' || startType === 'unreaction');

  const upVisited = new Set();
  const dnVisited = new Set();

  // ── 上流DFS ──────────────────────────────────────────────────
  // bwdMap を逆向きに辿るだけ。
  // ingredient_input も辿るので SUB←COMP←RAW まで完全に遡れる。
  // fwdMap は一切触らないので ingredient_input 下流への爆発は起きない。
  // RAW の bwdMap は空なので自然停止。
  function dfsUp(n, depth) {
    if (!n || depth > 400 || upVisited.has(n)) return;
    upVisited.add(n);
    if (isUNRHub(n) && !startIsHub) return;
    for (const e of (bwdMap[n] || [])) {
      if (['ingredient_input', 'input', 'output', 'mass_flow', 'flow_split'].includes(e.type)) {
        dfsUp(e.source, depth + 1);
      }
    }
  }

  // ── 下流DFS ──────────────────────────────────────────────────
  // mode='ingredient': RAW/COMP 起点。ingredient_input のみ辿る。
  //                    SUB に到達したら 'normal' に切替。
  // mode='normal'    : SUB/RXN 起点。input/output/mass_flow/flow_split のみ辿る。
  //                    ingredient_input は辿らない（爆発防止）。
  function dfsDn(n, depth, mode) {
    if (!n || depth > 400 || dnVisited.has(n)) return;
    dnVisited.add(n);
    if (isUNRHub(n) && !startIsHub) return;
    for (const e of (fwdMap[n] || [])) {
      if (mode === 'ingredient') {
        if (e.type === 'ingredient_input') {
          const ttype = getNodeType(e.target);
          const nextMode = (ttype === 'raw_material' || ttype === 'ingredient_component')
            ? 'ingredient' : 'normal';
          dfsDn(e.target, depth + 1, nextMode);
        }
      } else {
        if (['input', 'output', 'mass_flow', 'flow_split'].includes(e.type)) {
          dfsDn(e.target, depth + 1, 'normal');
        }
      }
    }
  }

  if (startIsReaction) {
    // 反応ノード起点: 入力物質から上流、出力物質から下流
    upVisited.add(nodeId);
    dnVisited.add(nodeId);
    for (const e of (bwdMap[nodeId] || [])) {
      if (e.type === 'input') dfsUp(e.source, 0);
    }
    for (const e of (fwdMap[nodeId] || [])) {
      if (e.type === 'output') dfsDn(e.target, 0, 'normal');
    }
  } else {
    dfsUp(nodeId, 0);
    dfsDn(nodeId, 0, startIsIngredient ? 'ingredient' : 'normal');
  }

  const combined = new Set([...upVisited, ...dnVisited, nodeId]);
  return { combined, upstream: upVisited, downstream: dnVisited };
}

// ─── シード乱数 ──────────────────────────────────────────────
function sr(str) {
  let h=0; for(let i=0;i<str.length;i++) h=(Math.imul(31,h)+str.charCodeAt(i))|0;
  h=(h^(h>>>16))*0x45d9f3b|0; h=(h^(h>>>16))*0x45d9f3b|0; h=h^(h>>>16);
  return (h>>>0)/0xFFFFFFFF;
}
function tintHex(hex, t=.28) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(0xffffff), t);
  return c.getHex();
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
  window.addEventListener('resize',()=>{
    const W2=window.innerWidth, H2=window.innerHeight;
    camera.aspect=W2/H2; camera.updateProjectionMatrix(); renderer.setSize(W2,H2);
  });
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

// ─── §10.8 グラフ構築 ────────────────────────────────────────
function buildGraph() {
  const {scene}=SCENE_OBJ;
  allMeshes=[]; lineMeshes=[]; nodeMap={};

  // ガイドリング
  const ringDefs = [
    {po:0,   col:STEP_COLORS.ingredients,            r:500},
    {po:0.5, col:STEP_COLORS.ingredient_component,   r:390},
    {po:1,   col:STEP_COLORS.mixing,                 r:300},
    {po:2,   col:STEP_COLORS.fermentation_1,         r:300},
    {po:3,   col:STEP_COLORS.dividing_bench_shaping, r:300},
    {po:4,   col:STEP_COLORS.proof,                  r:300},
    {po:5,   col:STEP_COLORS.baking,                 r:300},
  ];
  ringDefs.forEach(({po,col,r})=>{
    addRing(scene,r,getStageY(po)-50,col,.13);
    if(po>=1) addRing(scene,180,getStageY(po),col,.06);
  });
  const axG=new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0,BASE_Y+100,0),
    new THREE.Vector3(0,getStageY(5)-120,0)
  ]);
  scene.add(new THREE.Line(axG,new THREE.LineBasicMaterial({color:0x1a3322,transparent:true,opacity:.4})));

  // ─── ノードを type 別に配置 ─────────────────────────────────
  const byType = {raw_material:[], ingredient_component:[], substance_instance:[], reaction:[], unreaction:[]};
  (GR.nodes||[]).forEach(n => {
    const t = n.type || 'substance_instance';
    (byType[t] = byType[t]||[]).push(n);
  });

  // 型ごとにサブグループ化（stageで）
  function placeNodes(nodeList, getPos, getColor, getSize, getShape) {
    nodeList.forEach((n,idx)=>{
      const {x,y,z} = getPos(n, idx, nodeList.length);
      const col = getColor(n);
      const size = getSize(n);
      const shape = getShape(n);

      let geo;
      if (shape === 'sphere')      geo = new THREE.SphereGeometry(size,16,10);
      else if (shape === 'octa')   geo = new THREE.OctahedronGeometry(size,0);
      else if (shape === 'tetra')  geo = new THREE.TetrahedronGeometry(size,0);
      else                         geo = new THREE.SphereGeometry(size,8,6);

      const isVol = !!n.is_volatile;
      const mat = new THREE.MeshPhongMaterial({
        color: col, emissive: col,
        emissiveIntensity: isVol ? .45 : ((n.type==='reaction'||n.type==='unreaction') ? .32 : .10),
        shininess: (n.type==='reaction'||n.type==='unreaction') ? 90 : 45,
        transparent: true, opacity: n.orphan ? 0.35 : 1
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x,y,z);
      mesh.userData = {
        id: n.id, type: n.type, node: n,
        stage: n.stage||'mixing',
        process_order: n.process_order||0,
        originalColor: col,
        snapshot: n.snapshot
      };
      scene.add(mesh);

      if (isVol && n.type==='substance_instance') {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(size+4,.7,6,24),
          new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:.3})
        );
        ring.position.copy(mesh.position);
        ring.rotation.x = Math.PI/2 + (sr(n.id+'rx')-.5)*.9;
        scene.add(ring);
      }

      const entry = {mesh, node:n, type:n.type, stage:n.stage||'mixing'};
      allMeshes.push(entry);
      nodeMap[n.id] = entry;
    });
  }

  // 原材料
  placeNodes(byType.raw_material||[],
    (n,i,total)=>{
      const a=(i/total)*Math.PI*2;
      const r=500+(sr(n.id)-.5)*75;
      return {x:Math.cos(a)*r, y:getStageY(0)+40+(sr(n.id+'y')-.5)*28, z:Math.sin(a)*r};
    },
    ()=>STEP_COLORS.ingredients,
    ()=>15,
    ()=>'octa'
  );

  // ingredient_component
  const compByRaw = {};
  (byType.ingredient_component||[]).forEach(c=>{
    (compByRaw[c.raw_parent]=compByRaw[c.raw_parent]||[]).push(c);
  });
  placeNodes(byType.ingredient_component||[],
    (n,i,total)=>{
      const siblings = compByRaw[n.raw_parent]||[];
      const idx = siblings.indexOf(n);
      const rawEntry = nodeMap[n.raw_parent];
      let baseAngle = rawEntry
        ? Math.atan2(rawEntry.mesh.position.z, rawEntry.mesh.position.x)
        : (Object.keys(compByRaw).indexOf(n.raw_parent)/Object.keys(compByRaw).length)*Math.PI*2;
      const spread = Math.PI*.4;
      const angle = baseAngle + (siblings.length>1 ? (idx/(siblings.length-1)-.5)*spread : 0);
      const r = 390+(sr(n.id)-.5)*60;
      return {x:Math.cos(angle)*r, y:getStageY(.5)-10+(sr(n.id+'y')-.5)*30, z:Math.sin(angle)*r};
    },
    ()=>STEP_COLORS.ingredient_component,
    ()=>5,
    ()=>'octa'
  );

  // substance_instance（stageごとにグループ）
  const instByStage = {};
  (byType.substance_instance||[]).forEach(n=>{
    const s=n.stage||'mixing'; (instByStage[s]=instByStage[s]||[]).push(n);
  });
  Object.entries(instByStage).forEach(([stage,insts])=>{
    placeNodes(insts,
      (n,i,total)=>{
        const po=STAGE_PO[stage]??1;
        const a=(i/total)*Math.PI*2;
        const r=300+(sr(n.id)-.5)*105;
        return {x:Math.cos(a)*r, y:getStageY(po)-50+(sr(n.id+'y')-.5)*44, z:Math.sin(a)*r};
      },
      (n)=>STEP_COLORS[stage]||0x4a8060,
      (n)=>n.is_volatile?8:5,
      ()=>'sphere'
    );
  });

  // reaction（stageごと、内側リングに配置）
  const rxnByStage = {};
  (byType.reaction||[]).forEach(n=>{
    const s=n.stage||'mixing'; (rxnByStage[s]=rxnByStage[s]||[]).push(n);
  });
  Object.entries(rxnByStage).forEach(([stage,rxns])=>{
    placeNodes(rxns,
      (n,i,total)=>{
        const po=STAGE_PO[stage]??1;
        const a=(i/total)*Math.PI*2+Math.PI/total;
        const r=180+((i%3)-1)*26;
        return {x:Math.cos(a)*r, y:getStageY(po)+(sr(n.id+'y')-.5)*22, z:Math.sin(a)*r};
      },
      (n)=>n.orphan ? 0x444444 : (STEP_COLORS[stage]||0x666666),
      ()=>9,
      ()=>'octa'
    );
  });

  // unreaction ハブノード（各工程に1つ、化学反応群の中央に配置）
  // node-UNR-HUB-SNAP-00N 形式: 全ての「変化なし」物質エッジが集約・分岐するハブ
  const unrxByStage = {};
  (byType.unreaction||[]).forEach(n=>{
    const s=n.stage||'mixing'; (unrxByStage[s]=unrxByStage[s]||[]).push(n);
  });
  Object.entries(unrxByStage).forEach(([stage,items])=>{
    placeNodes(items,
      (n,i,total)=>{
        const po=STAGE_PO[stage]??1;
        // 各工程の化学反応クラスタ中央（原点付近）に配置
        return {x:0, y:getStageY(po), z:0};
      },
      ()=>0x999999,
      ()=>14,   // ハブは大きく
      ()=>'tetra'
    );
  });

  // ─── エッジ描画 ─────────────────────────────────────────────
  // §10.9 色分け: ingredient_input=茶灰, input=橙, output=水色, mass_flow=青（旧互換）
  const EDGE_STYLE = {
    mass_flow:        {col:0x88aaff, opacity:.18},
    input:            {col:0xff8844, opacity:.34},
    output:           {col:0x44ccdd, opacity:.34},
    ingredient_input: {col:0x8b6a3e, opacity:.28},
  };

  (GR.edges||[]).forEach(e=>{
    const se=nodeMap[e.source], te=nodeMap[e.target];
    if(!se||!te) return;
    const style=EDGE_STYLE[e.type]||{col:0x333333,opacity:.10};
    const geo=new THREE.BufferGeometry().setFromPoints(
      [se.mesh.position.clone(), te.mesh.position.clone()]
    );
    const mat=new THREE.LineBasicMaterial({color:style.col,transparent:true,opacity:style.opacity});
    const line=new THREE.Line(geo,mat);
    scene.add(line);
    lineMeshes.push({line,edge:e,mat,originalColor:style.col,baseOpacity:style.opacity});
  });
}

function addRing(scene,radius,y,color,opacity) {
  const mesh=new THREE.Mesh(new THREE.TorusGeometry(radius,1.2,8,72),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity}));
  mesh.position.y=y; mesh.rotation.x=Math.PI/2; scene.add(mesh);
}

function isEdgeVisible(edge) {
  const se=nodeMap[edge.source], te=nodeMap[edge.target];
  if(!se||!te) return false;
  const srcVis=isVisible(se.mesh.userData);
  const tgtVis=isVisible(te.mesh.userData);
  if(!srcVis||!tgtVis) return false;
  if(activeSnapshot==='all') return true;
  if(edge.snapshot===activeSnapshot||edge.from_snapshot===activeSnapshot||edge.to_snapshot===activeSnapshot) return true;
  const snap=SNAP_MAP[activeSnapshot];
  if(!snap) return true;
  return se.mesh.userData.stage===snap.stage||te.mesh.userData.stage===snap.stage;
}

// ─── §10.6 ハイライト ────────────────────────────────────────
function applyHighlight() {
  allMeshes.forEach(({mesh})=>{
    const ud=mesh.userData;
    const inTr = traceSet ? traceSet.has(ud.id) : true;
    const vis  = isVisible(ud);
    const isSel= ud.id===selectedId;

    if(!vis){mesh.material.opacity=0.02;mesh.material.emissiveIntensity=0;return;}

    if(!inTr && traceSet) {
      mesh.material.opacity=0.04; mesh.material.emissiveIntensity=0; mesh.scale.setScalar(1);
    } else if(isSel) {
      mesh.material.color.setHex(0xffffff); mesh.material.emissive.setHex(0xffffff);
      mesh.material.emissiveIntensity=0.80; mesh.material.opacity=1; mesh.scale.setScalar(1.7);
    } else {
      const col=ud.originalColor, isVol=ud.node?.is_volatile;
      mesh.material.color.setHex(col); mesh.material.emissive.setHex(col);
      let ei;
      if(inTr && traceSet) {
        const inUp = traceUpSet && traceUpSet.has(ud.id);
        const inDn = traceDnSet && traceDnSet.has(ud.id);
        if(ud.type==='reaction'||ud.type==='unreaction') ei = .55;
        else if(inUp&&inDn) ei = isVol?.60:.28;
        else if(inUp)       ei = isVol?.55:.24;
        else if(inDn)       ei = isVol?.65:.32;
        else                ei = isVol?.50:.20;
      } else ei = isVol?.40:.10;
      mesh.material.emissiveIntensity=ei;
      mesh.material.opacity= ud.node?.orphan ? 0.45 : 1;
      mesh.scale.setScalar(1);
    }
  });

  lineMeshes.forEach(({edge,mat,originalColor,baseOpacity})=>{
    const edgeVisible = isEdgeVisible(edge);
    if(traceSet) {
      const both=edgeVisible&&traceSet.has(edge.source)&&traceSet.has(edge.target);
      mat.opacity=both?.92:.012;
      if(both){
        if(edge.type==='input')             mat.color.setHex(0xff8844);
        else if(edge.type==='output')       mat.color.setHex(0x44ccdd);
        else if(edge.type==='ingredient_input') mat.color.setHex(0xc89a63);
        else if(edge.type==='mass_flow')    mat.color.setHex(0x88aaff);
        else                                mat.color.setHex(0x888888);
      } else mat.color.setHex(originalColor);
    } else {
      mat.color.setHex(originalColor);
      if(!edgeVisible) {
        mat.opacity=0.01;
      } else if(activeSnapshot!=='all') {
        const inSnap = edge.snapshot===activeSnapshot || edge.from_snapshot===activeSnapshot || edge.to_snapshot===activeSnapshot;
        mat.opacity = inSnap ? Math.min(.95, baseOpacity*2.2) : Math.max(.05, baseOpacity*.8);
      } else {
        mat.opacity=baseOpacity;
      }
    }
  });
}

// ─── §10.7 Snapshotフィルター ────────────────────────────────
function isVisible(ud) {
  const {id,type,stage,snapshot}=ud;

  if(activeSnapshot!=='all') {
    const snap=SNAP_MAP[activeSnapshot];
    if(snap) {
      if(type==='substance_instance' && stage!==snap.stage) return false;
      if(type==='reaction'           && stage!==snap.stage) return false;
      if(type==='unreaction'         && stage!==snap.stage) return false;
    }
  }

  if(activeStep!=='all') {
    if(type==='reaction'            && stage!==activeStep) return false;
    if(type==='unreaction'          && stage!==activeStep) return false;
    if(type==='substance_instance'  && stage!==activeStep) return false;
    if(type==='raw_material'        && activeStep!=='ingredients') return false;
    if(type==='ingredient_component'&&activeStep!=='ingredient_component'&&activeStep!=='ingredients') return false;
  }
  if(activeFilter==='volatile'&&type==='substance_instance'&&!ud.node?.is_volatile) return false;
  if(activeFilter==='reactions'&&type!=='reaction') return false;
  if(searchQuery) {
    const n=ud.node;
    const hit=(n?.name||'').toLowerCase().includes(searchQuery)
           ||(n?.formula||'').toLowerCase().includes(searchQuery)
           ||(n?.equation||'').toLowerCase().includes(searchQuery)
           ||(n?.substance_ref||'').toLowerCase().includes(searchQuery)
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
    if(traceOrigin) _restoreTraceOrigin();
    else clearSel();
    return;
  }
  const {id,node,type}=hit.object.userData;
  if(traceSet&&traceSet.has(id)) {
    selectedId=id; applyHighlight(); updateDetail(node,type); hideTT(); return;
  }
  navStack=[];
  selectNode(id,node,type);
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

// ─── §10.4 ノード選択（trace統一）───────────────────────────
// reaction も substance_instance も同じ trace() で処理する
function selectNode(id,node,type) {
  selectedId=id;
  const {combined,upstream,downstream}=trace(id);
  traceSet   =combined;
  traceUpSet =upstream;
  traceDnSet =downstream;

  let icon='🔍', msg='';
  if(type==='raw_material') {
    icon='🔶'; msg=`${node?.name||id}  ▼下流 ${combined.size-1} ノード`;
  } else if(type==='ingredient_component') {
    // COMP起点は下流のみ辿る（ingredient_input チェーン）
    icon='🟤'; msg=`${node?.name||id}  ▼下流 ${downstream.size-1} ノード（成分→物質）`;
  } else if(type==='reaction') {
    const ins  = (bwdMap[id]||[]).filter(e=>e.type==='input').length;
    const outs = (fwdMap[id]||[]).filter(e=>e.type==='output').length;
    icon='🔷'; msg=`${node?.name||id}  入力 ${ins}  出力 ${outs}  経路 ${combined.size-1}`;
  } else if(type==='unreaction') {
    const ins  = (bwdMap[id]||[]).filter(e=>e.type==='input').length;
    const outs = (fwdMap[id]||[]).filter(e=>e.type==='output').length;
    const isHub = node?.hub === true || id.startsWith('node-UNR-HUB-');
    const stageLabel = STEP_LABELS[node?.stage] || node?.stage || '';
    const nextLabel  = STEP_LABELS[node?.next_stage] || node?.next_stage || '';
    if (isHub) {
      icon='🟣';
      msg=`UNR ハブ [${stageLabel}→${nextLabel}]  集約 ${ins} 物質  ※ハブ経由の波及は抑制`;
    } else {
      icon='🟣'; msg=`${node?.name||id}  UNR 変化なし  入力 ${ins}  出力 ${outs}`;
    }
  } else if(node?.stage==='baking') {
    icon='🔴'; msg=`${node?.name||id}  ▲来歴 ${upstream.size-1}`;
  } else {
    icon='🔵'; msg=`${node?.name||id}  ▲${upstream.size-1}  ▼${downstream.size-1}`;
  }

  traceOrigin={id,node,type,traceSet:new Set(combined),traceUpSet:new Set(upstream),traceDnSet:new Set(downstream),msg,icon};
  navStack=[];
  applyHighlight();
  showTraceBar(msg,icon);
  updateDetail(node,type);
}

function _restoreTraceOrigin() {
  if(!traceOrigin) return;
  const o=traceOrigin;
  selectedId=o.id; traceSet=new Set(o.traceSet);
  traceUpSet=o.traceUpSet?new Set(o.traceUpSet):null;
  traceDnSet=o.traceDnSet?new Set(o.traceDnSet):null;
  navStack=[];
  applyHighlight(); showTraceBar(o.msg,o.icon); updateDetail(o.node,o.type);
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
  setEl('tt-name',node.name||node.id||'');
  let sub='';
  if(type==='reaction') {
    sub=`反応 [${STEP_LABELS[node.stage]||node.stage||''}]${node.orphan?' ⚪ 孤立':''}`;
  } else if(type==='unreaction') {
    sub=`UNR / 変化なし・未解析 [${STEP_LABELS[node.stage]||node.stage||''}] → ${STEP_LABELS[node.next_stage]||node.next_stage||''}`;
  } else if(type==='raw_material') {
    sub=`原材料`;
  } else if(type==='ingredient_component') {
    sub=`成分 [${node.substance_ref||''}]`;
  } else {
    sub=[node.formula||'', node.is_volatile?'★香気':'',
         node.stage?`[${STEP_LABELS[node.stage]||node.stage}]`:''].filter(Boolean).join('  ');
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
function updateDetail(node,type) {
  const panel=document.getElementById('detail-panel');
  if(!node) {
    navStack=[];
    panel.innerHTML=`<div class="detail-empty">
      ノードをクリックすると詳細表示<br><br>
      <b style="color:var(--text2)">トレース（RAW / COMP / SUB 完全対応）</b><br>
      🔶 原材料 → ▼下流全経路<br>
      🟤 成分ノード → ▲▼双方向<br>
      🔵 物質 → ▲▼双方向<br>
      🔷 反応ノード → 入力・出力・経路<br>
      🟣 UNR ハブ → 工程ごとに1つ<br>
      &nbsp;&nbsp;&nbsp;&nbsp;変化なし物質を集約・次工程へ分岐<br>
      &nbsp;&nbsp;&nbsp;&nbsp;※ 選択時は隣接物質のみ表示<br><br>
      <b style="color:var(--text2)">エッジ色</b><br>
      <span style="color:#8b6a3e">■</span> ingredient_input（原材料→成分→物質）<br>
      <span style="color:#ff8844">■</span> input（物質→反応 / 物質→UNRハブ）<br>
      <span style="color:#44ccdd">■</span> output（反応 / UNRハブ→物質）<br>      <span style="color:#88aaff">■</span> flow_split（工程間の連続）<br><br>
      <b style="color:var(--text2)">操作</b><br>
      ドラッグ→回転 / ホイール→ズーム<br>右ドラッグ→パン
    </div>`;
    return;
  }
  if(type==='reaction')              detailRxn(panel,node);
  else if(type==='unreaction')       detailUnreaction(panel,node);
  else if(type==='raw_material')     detailRaw(panel,node);
  else if(type==='ingredient_component') detailComp(panel,node);
  else                               detailSub(panel,node);
}

function _backBtnHTML() {
  return `<button onclick="_navBack()" style="
    background:transparent;border:1px solid var(--border);color:var(--text3);
    font-family:'Space Mono',monospace;font-size:9px;padding:4px 10px;
    cursor:pointer;border-radius:2px;margin-bottom:10px;display:flex;
    align-items:center;gap:5px;transition:all .15s"
    onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
    onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text3)'">← 戻る</button>`;
}

function _navBack() {
  if(!navStack.length) return;
  const prev=navStack.pop();
  selectedId=prev.id;
  if(traceOrigin){traceSet=new Set(traceOrigin.traceSet);traceUpSet=traceOrigin.traceUpSet?new Set(traceOrigin.traceUpSet):null;traceDnSet=traceOrigin.traceDnSet?new Set(traceOrigin.traceDnSet):null;}
  applyHighlight(); updateDetail(prev.node,prev.type);
}

function snapBadge(snap_id) {
  if(!snap_id) return '';
  const s=SNAP_MAP[snap_id];
  if(!s) return '';
  return `<span class="snap-badge" style="--snap-color:${s.color}">${s.label_ja}</span>`;
}

// ─── §11.4 物質インスタンス詳細 ──────────────────────────────
function edgeBadgeColor(type, dir='in') {
  if(type==='ingredient_input') return '#8b6a3e';
  if(type==='mass_flow') return '#88aaff';
  if(type==='output') return '#44ccdd';
  return dir==='in' ? '#ff8844' : '#44ccdd';
}

function edgeArrow(type, dir='in') {
  if(type==='mass_flow') return dir==='in' ? '←' : '→';
  return dir==='in' ? '⬅' : '➡';
}

function detailSub(panel,n) {
  const stage=n.stage||'mixing';
  const bc=STEP_COLORS_CSS[stage]||'#4a8060';
  const smE=SUB_MASTER_MAP[n.ref||n.master_id||n.id]||{};
  const hasBack=navStack.length>0;
  const snapBadgeHTML=snapBadge(n.snapshot);

  // §11.4 入出力
  const nodeId=n.id;
  const inEdges =(bwdMap[nodeId]||[]).filter(e=>TRACEABLE_TYPES.has(e.type));
  const outEdges=(fwdMap[nodeId]||[]).filter(e=>TRACEABLE_TYPES.has(e.type));

  const makeLink=(nid,label)=>`<span style="cursor:pointer;color:var(--accent2);font-size:9px"
    onclick="_jumpTo('${nid}')">${label}</span>`;

  const inHTML = inEdges.slice(0,5).map(e=>{
    const src=nodeMap[e.source]; if(!src) return '';
    const col=edgeBadgeColor(e.type,'in');
    return `<div style="font-size:9px;color:var(--text3);margin-bottom:2px">
      <span style="color:${col}">${edgeArrow(e.type,'in')}</span>
      ${makeLink(e.source, src.node?.name||e.source.slice(0,20))}
      <span style="color:var(--text3);font-size:8px">[${e.reaction||e.type}]</span>
    </div>`;
  }).join('');

  const outHTML = outEdges.slice(0,5).map(e=>{
    const tgt=nodeMap[e.target]; if(!tgt) return '';
    const col=edgeBadgeColor(e.type,'out');
    return `<div style="font-size:9px;color:var(--text3);margin-bottom:2px">
      <span style="color:${col}">${edgeArrow(e.type,'out')}</span>
      ${makeLink(e.target, tgt.node?.name||e.target.slice(0,20))}
      <span style="color:var(--text3);font-size:8px">[${e.reaction||e.type}]</span>
    </div>`;
  }).join('');

  const physHTML=smE.id?`<div class="detail-section"><div class="detail-section-title">物性</div>
    <div style="font-size:9px;color:var(--text2);line-height:1.8">
    ${smE.physical?.molecular_weight?`分子量: ${smE.physical.molecular_weight} g/mol<br>`:''}
    ${smE.sensory?.odor_threshold_ppm!=null?`臭気閾値: ${smE.sensory.odor_threshold_ppm} ppm<br>`:''}
    ${smE.sensory?.descriptors?.length?`香り: ${smE.sensory.descriptors.join(', ')}<br>`:''}
    </div></div>`:'';

  const upC=traceUpSet?traceUpSet.size-1:0, dnC=traceDnSet?traceDnSet.size-1:0;

  panel.innerHTML=`<div class="detail-card">
    ${hasBack?_backBtnHTML():''}
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${n.name}</div>
    ${n.formula?`<div class="detail-formula">${n.formula}</div>`:''}
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      <span class="badge" style="background:${bc};color:#070a08">${STEP_LABELS[stage]||stage}</span>
      ${snapBadgeHTML}
      ${n.is_volatile?`<span style="font-size:9px;color:#e8b553;padding:2px 6px;border:1px solid #e8b553;border-radius:2px">★ 香気</span>`:''}
      ${n.is_ghost?`<span style="font-size:8px;color:#888;padding:1px 5px;border:1px solid #555;border-radius:2px">補完</span>`:''}
    </div>
    <div style="margin-top:10px;display:flex;gap:16px">
      <div style="font-size:10px;color:var(--text3)">▲来歴 <span style="color:var(--accent2)">${upC}</span></div>
      <div style="font-size:10px;color:var(--text3)">▼行先 <span style="color:var(--accent)">${dnC}</span></div>
    </div>
    ${n.amount_g!=null?`<div style="font-size:10px;color:var(--text3);margin-top:4px">質量: <span style="color:var(--accent)">${typeof n.amount_g==='number'?n.amount_g.toFixed(3):n.amount_g}g</span></div>`:''}
    ${physHTML}
    ${inHTML||outHTML?`<div class="detail-section">
      <div class="detail-section-title">接続エッジ</div>
      ${inHTML}${outHTML}
      ${(inEdges.length>5||outEdges.length>5)?`<div style="font-size:8px;color:var(--text3)">他 ${Math.max(0,inEdges.length-5)+Math.max(0,outEdges.length-5)} 件</div>`:''}
    </div>`:''}
  </div>`;
}

// ─── §11.4 UNRハブ詳細 ───────────────────────────────────────
function detailUnreaction(panel,n) {
  const col=STEP_COLORS_CSS[n.stage]||'#777';
  const hasBack=navStack.length>0;
  const snapBadgeHTML=snapBadge(n.snapshot);
  const isHub = n.hub === true || (n.id||'').startsWith('node-UNR-HUB-');
  const inputs=(bwdMap[n.id]||[]).filter(e=>e.type==='input'||e.type==='ingredient_input');
  const outputs=(fwdMap[n.id]||[]).filter(e=>e.type==='output');
  const makeLine=(edge,dir='in')=>{
    const peerId=dir==='in'?edge.source:edge.target;
    const peer=nodeMap[peerId]?.node;
    if(!peer) return '';
    return `<div style="font-size:10px;color:var(--text2);margin-bottom:4px">
      <span style="color:${edgeBadgeColor(edge.type,dir)}">${edgeArrow(edge.type,dir)}</span>
      <span style="cursor:pointer;color:var(--accent2)" onclick="_jumpTo('${peerId}')">${peer.name||peerId}</span>
      <span style="color:var(--text3);font-size:8px">[${edge.type}]</span>
    </div>`;
  };
  panel.innerHTML=`<div class="detail-card">
    ${hasBack?_backBtnHTML():''}
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${isHub?`🔗 変化なし ハブ（${STEP_LABELS[n.stage]||n.stage} → ${STEP_LABELS[n.next_stage]||n.next_stage}）`:(n.name||'未反応継承')}</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      <span class="badge unr">UNR${isHub?' HUB':''}</span>
      ${snapBadgeHTML}
    </div>
    ${isHub?`<div style="font-size:10px;color:var(--text3);margin-top:8px;line-height:1.8;padding:8px;border:1px solid #333;border-radius:4px;background:rgba(255,255,255,.03)">
      このハブノードは<b style="color:var(--text2)">${inputs.length}物質</b>の「変化なし」継承を集約します。<br>
      各物質ノードのエッジがここに集まり、次工程（<span style="color:var(--accent)">${STEP_LABELS[n.next_stage]||n.next_stage}</span>）の
      同一物質ノードへ分岐していきます。<br>
      <span style="color:var(--text3);font-size:9px">※ トレース時はハブ経由の他物質への波及は表示されません</span>
    </div>`:''}
    <div style="font-size:10px;color:var(--text3);line-height:1.8;margin-top:8px">
      ${!isHub?`substance_ref: <span style="color:var(--accent2)">${n.substance_ref||'—'}</span><br>`:''}
      次 snapshot: <span style="color:var(--accent)">${n.next_snapshot||'—'}</span><br>
      次工程: <span style="color:var(--accent)">${STEP_LABELS[n.next_stage]||n.next_stage||'—'}</span>
    </div>
    ${inputs.length?`<div class="detail-section"><div class="detail-section-title">入力物質 (${inputs.length})</div>${inputs.slice(0,10).map(e=>makeLine(e,'in')).join('')}${inputs.length>10?`<div style="font-size:8px;color:var(--text3)">他 ${inputs.length-10} 件</div>`:''}</div>`:''}
    ${outputs.length?`<div class="detail-section"><div class="detail-section-title">出力先物質 (${outputs.length})</div>${outputs.slice(0,10).map(e=>makeLine(e,'out')).join('')}${outputs.length>10?`<div style="font-size:8px;color:var(--text3)">他 ${outputs.length-10} 件</div>`:''}</div>`:''}
  </div>`;
}

function detailRxn(panel,r) {
  const col=STEP_COLORS_CSS[r.stage]||'#666';
  const hasBack=navStack.length>0;
  const snapBadgeHTML=snapBadge(r.snapshot);

  // §11.4 getReactionIO（仕様書通り）
  const inputs  = (bwdMap[r.id]||[]).filter(e=>e.type==='input').map(e=>e.source);
  const outputs = (fwdMap[r.id]||[]).filter(e=>e.type==='output').map(e=>e.target);

  const inList  = inputs.map(id=>nodeMap[id]?.node).filter(Boolean);
  const outList = outputs.map(id=>nodeMap[id]?.node).filter(Boolean);

  const cond=r.conditions||{};
  const condHTML=cond.temperature_C?`<div style="font-size:10px;color:var(--text3);margin-top:6px;line-height:1.7">
    🌡 ${cond.temperature_C.min??'?'}–${cond.temperature_C.max??'?'}℃
    ${cond.time_min?`⏱ ${cond.time_min.min}–${cond.time_min.max}min`:''}</div>`:'';

  panel.innerHTML=`<div class="detail-card">
    ${hasBack?_backBtnHTML():''}
    <div class="detail-id">${r.id}${r.orphan?' <span style="color:#888;font-size:8px">孤立</span>':''}</div>
    <div class="detail-name">${r.name}</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      <span class="badge" style="background:${col};color:#070a08">${STEP_LABELS[r.stage]||r.stage||''}</span>
      ${snapBadgeHTML}
      ${r.orphan?`<span style="font-size:8px;color:#888;padding:1px 5px;border:1px solid #555;border-radius:2px">⚪ データなし</span>`:''}
    </div>
    ${r.equation?`<div style="font-size:10px;color:var(--text2);margin:8px 0;border-left:2px solid ${col};padding-left:8px;line-height:1.6">${r.equation}</div>`:''}
    ${r.equation_formula?`<div class="detail-formula" style="font-size:9px">${r.equation_formula}</div>`:''}
    ${condHTML}
    ${inList.length?`<div class="detail-section"><div class="detail-section-title">▶ 入力物質 (${inList.length})</div>${
      inList.slice(0,8).map(s=>`<div style="font-size:10px;color:var(--text2);margin-bottom:3px;cursor:pointer;padding:2px 4px;border-radius:2px"
        onclick="_jumpTo('${s.id}')"
        onmouseover="this.style.background='rgba(255,255,255,.06)'"
        onmouseout="this.style.background=''">
        <span style="color:${STEP_COLORS_CSS[s.stage]||'#888'};font-size:8px">●</span> ${s.name}
        ${s.amount_g!=null?`<span style="color:var(--text3);margin-left:auto;float:right">${typeof s.amount_g==='number'?s.amount_g.toFixed(3):s.amount_g}g</span>`:''}
      </div>`).join('')}
      ${inList.length>8?`<div style="font-size:9px;color:var(--text3)">他 ${inList.length-8}件</div>`:''}</div>`:''}
    ${outList.length?`<div class="detail-section"><div class="detail-section-title">✦ 出力物質 (${outList.length})</div>${
      outList.map(s=>`<div style="font-size:10px;color:${s.is_volatile?'var(--accent3)':'var(--accent2)'};margin-bottom:3px;cursor:pointer;padding:2px 4px;border-radius:2px"
        onclick="_jumpTo('${s.id}')"
        onmouseover="this.style.background='rgba(255,255,255,.06)'"
        onmouseout="this.style.background=''">
        ${s.is_volatile?'★':'●'} ${s.name}
        ${s.amount_g!=null?`<span style="color:var(--text3);margin-left:auto;float:right">${typeof s.amount_g==='number'?s.amount_g.toFixed(3):s.amount_g}g</span>`:''}
      </div>`).join('')}</div>`:''}
  </div>`;
}

function detailRaw(panel,rm) {
  const hasBack=navStack.length>0;
  const col=STEP_COLORS_CSS.ingredients;
  const dnCount=trace(rm.id).combined.size-1;
  const comps=(GR.nodes||[]).filter(n=>n.type==='ingredient_component'&&n.raw_parent===rm.id);
  panel.innerHTML=`<div class="detail-card">
    ${hasBack?_backBtnHTML():''}
    <div class="detail-id">${rm.id}</div>
    <div class="detail-name">${rm.name}</div>
    <span class="badge" style="background:${col};color:#070a08">原材料</span>
    <div style="margin-top:10px;font-size:10px;color:var(--text3)">
      下流ノード数: <span style="color:var(--accent)">${dnCount}</span>
    </div>
    ${comps.length?`<div class="detail-section">
      <div class="detail-section-title">成分一覧 (${comps.length})</div>
      ${comps.map(c=>`<div style="font-size:10px;color:#c89050;margin-bottom:3px;cursor:pointer"
        onclick="_jumpTo('${c.id}')">
        ▸ ${c.name||c.substance_ref} ${c.state?.mass_g!=null?`<span style="color:var(--accent2)">${c.state.mass_g.toFixed(3)}g</span>`:''}
      </div>`).join('')}
    </div>`:''}
  </div>`;
}

function detailComp(panel,comp) {
  const hasBack=navStack.length>0;
  const col=STEP_COLORS_CSS.ingredient_component;
  const dnCount=trace(comp.id).combined.size-1;
  panel.innerHTML=`<div class="detail-card">
    ${hasBack?_backBtnHTML():''}
    <div class="detail-id">${comp.id}</div>
    <div class="detail-name">${comp.name}</div>
    <span class="badge" style="background:${col};color:#070a08">成分分解</span>
    <div style="font-size:10px;color:var(--text3);margin-top:8px">
      原材料: <span style="color:var(--accent2)">${comp.raw_parent}</span>
    </div>
    ${comp.state?.mass_g!=null?`<div style="font-size:10px;color:var(--text3)">
      投入量: <span style="color:var(--accent)">${comp.state.mass_g.toFixed(3)}g</span></div>`:''}
    <div style="font-size:10px;color:var(--text3)">下流ノード数: <span style="color:var(--accent)">${dnCount}</span></div>
  </div>`;
}

// ノードにジャンプ（サイドバーリンク用）
function _jumpTo(nodeId) {
  const entry=nodeMap[nodeId];
  if(!entry) return;
  const {node,type}=entry;
  navStack.push({id:selectedId,node:nodeMap[selectedId]?.node,type:nodeMap[selectedId]?.type});
  selectedId=nodeId;
  applyHighlight();
  updateDetail(node,type);
}

// ─── Snapshotタイムライン ────────────────────────────────────
function initSnapshotTimeline() {
  const container=document.getElementById('snapshot-timeline');
  if(!container) return;
  const snaps=GR.snapshots||[];
  if(!snaps.length){container.style.display='none';return;}
  container.innerHTML='';

  const allBtn=document.createElement('button');
  allBtn.className='snap-btn active'; allBtn.dataset.snapId='all';
  allBtn.innerHTML=`<span class="snap-btn-num">全</span><span class="snap-btn-label">すべて</span>`;
  allBtn.addEventListener('click',()=>setActiveSnapshot('all'));
  container.appendChild(allBtn);

  const sep=document.createElement('div'); sep.className='snap-sep';
  container.appendChild(sep);

  snaps.forEach((snap,idx)=>{
    const instCnt=(GR.nodes||[]).filter(n=>n.type==='substance_instance'&&n.snapshot===snap.id).length;
    const rxnCnt =(GR.nodes||[]).filter(n=>n.type==='reaction'&&n.snapshot===snap.id).length;
    const unrxCnt=(GR.nodes||[]).filter(n=>n.type==='unreaction'&&n.snapshot===snap.id).length;
    const btn=document.createElement('button');
    btn.className='snap-btn'; btn.dataset.snapId=snap.id;
    btn.innerHTML=`<span class="snap-btn-num" style="color:${snap.color}">${idx+1}</span>
      <span class="snap-btn-label">${snap.label_ja}</span>
      <span class="snap-btn-count">${instCnt}</span>`;
    btn.title=`${snap.label} | 物質${instCnt} 反応${rxnCnt} 継承${unrxCnt}`;
    btn.style.setProperty('--snap-color',snap.color||'#888');
    btn.addEventListener('click',()=>setActiveSnapshot(snap.id));
    container.appendChild(btn);
    if(idx<snaps.length-1){
      const arr=document.createElement('div'); arr.className='snap-arrow'; arr.textContent='›';
      container.appendChild(arr);
    }
  });
}

function setActiveSnapshot(snapId) {
  activeSnapshot=snapId;
  if(snapId!=='all'&&SNAP_MAP[snapId]) {
    activeStep=SNAP_MAP[snapId].stage;
    document.querySelectorAll('.step-item').forEach(i=>i.classList.toggle('active',i.dataset.step===activeStep));
  } else {
    activeStep='all';
    document.querySelectorAll('.step-item').forEach(i=>i.classList.toggle('active',i.dataset.step==='all'));
  }
  document.querySelectorAll('.snap-btn').forEach(b=>b.classList.toggle('active',b.dataset.snapId===snapId));
  applyHighlight();
}

// ─── UI初期化 ────────────────────────────────────────────────
function initUI() {
  const legend=document.getElementById('step-legend');
  const rxnCounts={};
  (GR.nodes||[]).filter(n=>n.type==='reaction').forEach(n=>{rxnCounts[n.stage]=(rxnCounts[n.stage]||0)+1;});

  const allItem=document.createElement('div');
  allItem.className='step-item active'; allItem.dataset.step='all';
  allItem.innerHTML=`<div class="step-dot" style="background:#555"></div><span>全工程</span>
    <span class="step-count">${(GR.nodes||[]).filter(n=>n.type==='reaction').length}</span>`;
  allItem.addEventListener('click',()=>{activeStep='all';applyHighlight();setStepActive('all');});
  legend.appendChild(allItem);

  STEP_ORDER.forEach(step=>{
    const item=document.createElement('div'); item.className='step-item'; item.dataset.step=step;
    const cnt=step==='ingredient_component'
      ?(GR.nodes||[]).filter(n=>n.type==='ingredient_component').length
      :(rxnCounts[step]||0);
    item.innerHTML=`<div class="step-dot" style="background:${STEP_COLORS_CSS[step]}"></div>
      <span>${STEP_LABELS[step]}</span><span class="step-count">${cnt}</span>`;
    item.addEventListener('click',()=>{activeStep=step;applyHighlight();setStepActive(step);});
    legend.appendChild(item);
  });
  function setStepActive(s){document.querySelectorAll('.step-item').forEach(i=>i.classList.toggle('active',i.dataset.step===s));}

  initSnapshotTimeline();

  document.querySelectorAll('.filter-btn').forEach(btn=>btn.addEventListener('click',()=>{
    document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); activeFilter=btn.dataset.filter; applyHighlight();
  }));
  document.getElementById('search-input').addEventListener('input',e=>{searchQuery=e.target.value.toLowerCase();applyHighlight();});

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
    // GR.reactions（元定義）を使用。ノードグラフの反応ノードと対応
    (GR.reactions||[])
      .filter(r=>rxnStep==='all'||(r.stage||r.step)===rxnStep)
      .filter(r=>!q||(r.name||'').toLowerCase().includes(q)||r.id.toLowerCase().includes(q))
      .forEach(r=>{
        const stage=r.stage||r.step, col=STEP_COLORS_CSS[stage]||'#666';
        const rxnNodeId=`node-RXN-${r.id}-${({mixing:'SNAP-001',fermentation_1:'SNAP-002',dividing_bench_shaping:'SNAP-003',proof:'SNAP-004',baking:'SNAP-005'})[stage]||'SNAP-001'}`;
        const rxnNode=nodeMap[rxnNodeId];
        const inC=(bwdMap[rxnNodeId]||[]).filter(e=>e.type==='input').length;
        const outC=(fwdMap[rxnNodeId]||[]).filter(e=>e.type==='output').length;
        const isOrphan=rxnNode?.node?.orphan||false;
        const card=document.createElement('div'); card.className='rxn-card';
        card.style.borderLeftColor=isOrphan?'#444':col;
        card.innerHTML=`<div><span class="rxn-step-badge" style="background:${isOrphan?'#444':col}">${STEP_LABELS[stage]||stage}</span>
          ${isOrphan?`<span style="font-size:8px;color:#666;margin-left:4px">孤立</span>`:''}</div>
          <div class="rxn-id">${r.id}</div>
          <div class="rxn-name">${r.name}</div>
          <div class="rxn-eq">${r.equation||''}</div>
          <div style="margin-top:6px;font-size:9px">
            <span style="color:var(--text3)">入力 ${inC} → </span><span style="color:${col}">出力 ${outC}</span>
          </div>`;
        card.addEventListener('click',()=>{
          if(!rxnNodeId||!nodeMap[rxnNodeId]) return;
          document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
          document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
          document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
          selectNode(rxnNodeId,nodeMap[rxnNodeId].node,'reaction');
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
  const ml=(SM?.substances)||(GR.nodes||[]).filter(n=>n.type==='substance_instance'&&!n.is_ghost).map(n=>({
    id:n.ref||n.id, name:n.name, formula:n.formula, is_volatile:n.is_volatile,
    nutrition_cat:n.nutrition_cat, category:n.nutrition_cat
  }));
  const seen=new Set(); const unique=[];
  ml.forEach(s=>{ if(!seen.has(s.id)){seen.add(s.id);unique.push(s);} });
  const filtered=unique.filter(s=>{
    const id=s.id||'', nm=s.name||'', fm=s.formula||'';
    return !q||nm.toLowerCase().includes(q)||fm.toLowerCase().includes(q)||id.toLowerCase().includes(q);
  });
  setEl('sub-count-label',`${filtered.length} / ${unique.length}件`);
  tbody.innerHTML='';
  filtered.slice(0,300).forEach(s=>{
    const id=s.id||'';
    const tr=document.createElement('tr');
    tr.innerHTML=`<td style="font-size:9px;color:var(--text3)">${id}</td>
      <td style="color:var(--text)">${s.name||''}</td>
      <td style="font-size:9px;color:var(--accent2)">${s.formula||'—'}</td>
      <td style="font-size:9px;color:#e8b553">${s.is_volatile?'★':'—'}</td>
      <td style="font-size:9px;color:var(--text3)">${s.category||s.nutrition_cat||'—'}</td>
      <td style="font-size:9px;color:var(--accent2)">—</td>`;
    tr.addEventListener('click',()=>{
      document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('active'));
      document.querySelector('.nav-tab[data-view="graph"]').classList.add('active');
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      // mixing のインスタンスを探してselect
      const nid=`node-${id}-SNAP-001`;
      const entry=nodeMap[nid]||(GR.nodes||[]).find(n=>n.ref===id||n.id===id);
      if(entry) selectNode(entry.id||nid, entry.node||entry, 'substance_instance');
    });
    tbody.appendChild(tr);
  });
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


// === FLOW-RUNTIME OVERRIDES v4.0 ==========================================
var FLOW_SIM_SPEC = null;
var FLOW_SIM_RUNTIME = null;

// ── §B1. substance_id=null の補完 ────────────────────────────
// ingredient flow（9件）は ingredient_id を持つが substance_id が null。
// origin_node から ingredient_id を使ってラベルを補完する。
function inferSubstanceId(flow) {
  if (flow.substance_id) return flow.substance_id;
  // ingredient_id を代替IDとして返す（トレース・表示用）
  return flow.ingredient_id || flow.origin_node || null;
}

// ── §B2. Flow History の動的生成 ─────────────────────────────
// JSONに history フィールドは存在しないため、
// 同一 substance_id を持つ flow をスナップショット順に並べて
// 各 flow への input edge の reaction を via として生成する。
var FLOW_HISTORY_MAP = {};  // substance_id → history[]
var FLOW_INPUT_RXN = {};    // flow_id → reaction_id[]

function buildFlowHistory(graph) {
  const flows = graph.flows || [];
  const edges = graph.edges || [];
  const snapOrder = {};
  (graph.snapshots || []).forEach((s, i) => { snapOrder[s.id] = i; });

  // flow_id → input reaction マップ
  FLOW_INPUT_RXN = {};
  edges.forEach(e => {
    if (e.type === 'input' && e.flow_id && e.reaction) {
      (FLOW_INPUT_RXN[e.flow_id] = FLOW_INPUT_RXN[e.flow_id] || []).push(e.reaction);
    }
  });

  // substance_id ごとにgrouping
  const bySubId = {};
  flows.forEach(f => {
    const sid = inferSubstanceId(f);
    if (!sid) return;
    (bySubId[sid] = bySubId[sid] || []).push(f);
  });

  FLOW_HISTORY_MAP = {};
  Object.entries(bySubId).forEach(([sid, flist]) => {
    // snapshot順にソート（snapshot=nullはstage=ingredient_componentとして先頭）
    const sorted = flist.slice().sort((a, b) => {
      const oa = a.snapshot ? (snapOrder[a.snapshot] ?? 99) : -1;
      const ob = b.snapshot ? (snapOrder[b.snapshot] ?? 99) : -1;
      return oa - ob;
    });
    FLOW_HISTORY_MAP[sid] = sorted.map(f => ({
      flow_id:   f.id,
      snapshot:  f.snapshot || null,
      stage:     f.stage || null,
      quantity:  f.quantity_g ?? 0,
      via:       (FLOW_INPUT_RXN[f.id] || []).length > 0 ? FLOW_INPUT_RXN[f.id] : null
    }));
  });
}

// substance node / flow からhistoryを取得
function getFlowHistory(node) {
  const sid = node?.substance_id
    || (node?.flow_ref ? (GR?.flows || []).find(f => f.id === node.flow_ref)?.substance_id : null)
    || node?.ref
    || node?.master_id;
  return sid ? (FLOW_HISTORY_MAP[sid] || null) : null;
}

// ── §B3. loadAll（統合・起動エントリポイント）───────────────
function loadAll() {
  return Promise.all([
    fetchJSON(['data/14_graph_runtime.json', 'data/graph_data.json']),
    fetchJSON('data/01_substance_master.json'),
    fetchJSON('data/13_simulation_runtime.json')
  ]).then(([graph, sm, simSpec]) => {
    GR = graph;
    if (!GR) throw new Error('data/14_graph_runtime.json が見つかりません');
    SM = sm;
    SUB_MASTER_MAP = {};
    if (SM && Array.isArray(SM.substances)) SM.substances.forEach(s => { SUB_MASTER_MAP[s.id] = s; });
    FLOW_SIM_SPEC = simSpec || null;

    // substance_id=null の補完
    (GR.flows || []).forEach(f => {
      if (!f.substance_id) f.substance_id = inferSubstanceId(f);
    });

    // flow history を事前生成
    buildFlowHistory(GR);

    // Snapshot マップ
    (GR.snapshots || []).forEach(s => { SNAP_MAP[s.id] = s; });
    buildAdjacency();
    initScene();
    buildGraph();
    if (!window.__ui_initialized__) {
      initUI();
      window.__ui_initialized__ = true;
    }
    initNav();
    animate();

    if (window.FlowEngine) {
      FLOW_SIM_RUNTIME = FlowEngine.buildBaseRuntime(GR, FLOW_SIM_SPEC);
      FlowEngine.syncGraphWithRuntime(GR, FLOW_SIM_RUNTIME);
    }

    const m = GR.meta || {};
    setEl('stat-sub',  m.substance_instance_count ?? (GR.nodes||[]).filter(n=>n.type==='substance_instance').length ?? '—');
    setEl('stat-rxn',  m.reaction_node_count       ?? (GR.nodes||[]).filter(n=>n.type==='reaction').length           ?? '—');
    setEl('stat-edge', m.edge_count                ?? (GR.edges||[]).length                                          ?? '—');
    setEl('stat-param',m.param_count               ?? (GR.params||[]).length                                         ?? '—');
  });
}

loadAll().catch(err => {
  console.error('[fatal]', err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
      background:#070a08;color:#e85353;font-family:monospace;font-size:13px;z-index:9999;padding:30px;text-align:center">
      <div>❌ データ読み込み失敗<br><br>
      <code style="color:#aaa;font-size:11px">${err.message}</code></div></div>`);
});

function getFlow(flowRef) {
  return (window.FlowEngine && GR && flowRef) ? FlowEngine.getFlow(GR, flowRef) : null;
}

function getNodeEntry(nodeOrId) {
  if (!nodeOrId) return null;
  if (typeof nodeOrId === 'string') return nodeMap[nodeOrId] || { node: (GR?.nodes || []).find(n => n.id === nodeOrId) };
  return { node: nodeOrId };
}

function getNodeQuantity(nodeOrId) {
  const entry = getNodeEntry(nodeOrId);
  const node = entry && entry.node;
  if (!node) return 0;
  const flow = node.flow_ref ? getFlow(node.flow_ref) : null;
  if (flow && typeof flow.quantity_g === 'number') return flow.quantity_g;
  if (typeof node.amount_g === 'number') return node.amount_g;
  if (typeof node.state?.mass_g === 'number') return node.state.mass_g;
  return 0;
}

function formatQty(v) {
  return `${Number(v || 0).toFixed(3)}g`;
}

function edgeFlowId(edge) {
  if (edge?.flow_id) return edge.flow_id;
  const src = nodeMap[edge?.source]?.node;
  const tgt = nodeMap[edge?.target]?.node;
  return tgt?.flow_ref || src?.flow_ref || null;
}

function edgeFlowQuantity(edge) {
  const fid = edgeFlowId(edge);
  if (window.FlowEngine && GR && fid) return FlowEngine.getFlowQuantity(GR, fid);
  return 0;
}

function flowRadius(quantity) {
  const q = Math.max(0, Number(quantity) || 0);
  return Math.max(0.55, Math.min(7.5, 0.85 + Math.sqrt(q) * 0.08));
}

function nodeBaseScale(node) {
  const q = getNodeQuantity(node);
  const factor = Math.max(0.85, Math.min(1.9, 0.85 + Math.log10(q + 1) * 0.45));
  return factor;
}

function syncSimulationHUD() {
  const env = FLOW_SIM_RUNTIME?.current_environment || GR?.global_state || {};
  const snapshotId = FLOW_SIM_RUNTIME?.current_snapshot || activeSnapshot;
  const snap = snapshotId && SNAP_MAP[snapshotId] ? SNAP_MAP[snapshotId] : null;
  const lines = [
    `温度: ${Number(env.temperature_c ?? env.temperature ?? 24).toFixed(1)}℃`,
    `時間: ${Math.round(Number(env.time_sec || 0))} s`,
    `水分活性: ${Number(env.water_activity ?? 0.95).toFixed(3)}`,
    snap ? `スナップショット: ${snap.label_ja}` : 'スナップショット: runtime'
  ];
  const box = document.getElementById('sim-status');
  if (box) box.innerHTML = lines.map(v => `<div>${v}</div>`).join('');
  window.dispatchEvent(new CustomEvent('bread-flow-runtime', { detail: { graph: GR, runtime: FLOW_SIM_RUNTIME, environment: env, snapshot: snap } }));
}

function refreshFlowVisuals() {
  allMeshes.forEach(({ mesh, node }) => {
    const baseScale = nodeBaseScale(node);
    mesh.userData.baseScale = baseScale;
  });
  lineMeshes.forEach((entry) => {
    const qty = edgeFlowQuantity(entry.edge);
    const radius = flowRadius(qty);
    const scale = entry.baseRadius ? radius / entry.baseRadius : 1;
    if (entry.line?.scale) {
      entry.line.scale.set(scale, 1, scale);
    }
    entry.currentRadius = radius;
  });
  syncSimulationHUD();
}

function createEdgeCylinder(start, end, color, opacity, radius) {
  const dir = end.clone().sub(start);
  const len = Math.max(1, dir.length());
  const geo = new THREE.CylinderGeometry(radius, radius, len, 8, 1, true);
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(start.clone().add(end).multiplyScalar(0.5));
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return { mesh, mat, length: len };
}

function buildGraph() {
  const { scene } = SCENE_OBJ;
  allMeshes = [];
  lineMeshes = [];
  nodeMap = {};

  const ringDefs = [
    { po: 0,   col: STEP_COLORS.ingredients,            r: 500 },
    { po: 0.5, col: STEP_COLORS.ingredient_component,   r: 390 },
    { po: 1,   col: STEP_COLORS.mixing,                 r: 300 },
    { po: 2,   col: STEP_COLORS.fermentation_1,         r: 300 },
    { po: 3,   col: STEP_COLORS.dividing_bench_shaping, r: 300 },
    { po: 4,   col: STEP_COLORS.proof,                  r: 300 },
    { po: 5,   col: STEP_COLORS.baking,                 r: 300 },
  ];
  ringDefs.forEach(({ po, col, r }) => {
    addRing(scene, r, getStageY(po) - 50, col, .13);
    if (po >= 1) addRing(scene, 180, getStageY(po), col, .06);
  });
  const axG = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, BASE_Y + 100, 0),
    new THREE.Vector3(0, getStageY(5) - 120, 0)
  ]);
  scene.add(new THREE.Line(axG, new THREE.LineBasicMaterial({ color: 0x1a3322, transparent: true, opacity: .4 })));

  const byType = { raw_material: [], ingredient_component: [], substance_instance: [], reaction: [] };
  (GR.nodes || []).forEach(n => {
    const t = n.type || 'substance_instance';
    if (!byType[t]) byType[t] = [];
    byType[t].push(n);
  });

  function placeNodes(nodeList, getPos, getColor, getSize, getShape) {
    nodeList.forEach((n, idx) => {
      const { x, y, z } = getPos(n, idx, nodeList.length);
      const col = getColor(n);
      const size = getSize(n);
      const shape = getShape(n);
      let geo;
      if (shape === 'sphere') geo = new THREE.SphereGeometry(size, 16, 10);
      else if (shape === 'octa') geo = new THREE.OctahedronGeometry(size, 0);
      else if (shape === 'tetra') geo = new THREE.TetrahedronGeometry(size, 0);
      else geo = new THREE.SphereGeometry(size, 8, 6);
      const isVol = !!n.is_volatile;
      const mat = new THREE.MeshPhongMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: isVol ? .45 : (n.type === 'reaction' ? .32 : .10),
        shininess: n.type === 'reaction' ? 90 : 45,
        transparent: true,
        opacity: n.orphan ? 0.35 : 1
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.userData = {
        id: n.id,
        type: n.type,
        node: n,
        stage: n.stage || 'mixing',
        process_order: n.process_order || 0,
        originalColor: col,
        snapshot: n.snapshot,
        flow_ref: n.flow_ref || null,
        baseScale: nodeBaseScale(n)
      };
      scene.add(mesh);
      if (isVol && n.type === 'substance_instance') {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(size + 4, .7, 6, 24),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .3 })
        );
        ring.position.copy(mesh.position);
        ring.rotation.x = Math.PI / 2 + (sr(n.id + 'rx') - .5) * .9;
        scene.add(ring);
      }
      const entry = { mesh, node: n, type: n.type, stage: n.stage || 'mixing' };
      allMeshes.push(entry);
      nodeMap[n.id] = entry;
    });
  }

  placeNodes(byType.raw_material || [],
    (n, i, total) => {
      const a = (i / total) * Math.PI * 2;
      const r = 500 + (sr(n.id) - .5) * 75;
      return { x: Math.cos(a) * r, y: getStageY(0) + 40 + (sr(n.id + 'y') - .5) * 28, z: Math.sin(a) * r };
    },
    () => STEP_COLORS.ingredients,
    () => 15,
    () => 'octa'
  );

  const compByRaw = {};
  (byType.ingredient_component || []).forEach(c => {
    (compByRaw[c.raw_parent] = compByRaw[c.raw_parent] || []).push(c);
  });
  placeNodes(byType.ingredient_component || [],
    (n) => {
      const siblings = compByRaw[n.raw_parent] || [];
      const idx = siblings.indexOf(n);
      const rawEntry = nodeMap[n.raw_parent];
      const baseAngle = rawEntry
        ? Math.atan2(rawEntry.mesh.position.z, rawEntry.mesh.position.x)
        : (Object.keys(compByRaw).indexOf(n.raw_parent) / Math.max(1, Object.keys(compByRaw).length)) * Math.PI * 2;
      const spread = Math.PI * .4;
      const angle = baseAngle + (siblings.length > 1 ? (idx / (siblings.length - 1) - .5) * spread : 0);
      const r = 390 + (sr(n.id) - .5) * 60;
      return { x: Math.cos(angle) * r, y: getStageY(.5) - 10 + (sr(n.id + 'y') - .5) * 30, z: Math.sin(angle) * r };
    },
    () => STEP_COLORS.ingredient_component,
    () => 5,
    () => 'octa'
  );

  const instByStage = {};
  (byType.substance_instance || []).forEach(n => {
    const s = n.stage || 'mixing';
    (instByStage[s] = instByStage[s] || []).push(n);
  });
  Object.entries(instByStage).forEach(([stage, insts]) => {
    placeNodes(insts,
      (n, i, total) => {
        const po = STAGE_PO[stage] ?? 1;
        const a = (i / total) * Math.PI * 2;
        const r = 300 + (sr(n.id) - .5) * 105;
        return { x: Math.cos(a) * r, y: getStageY(po) - 50 + (sr(n.id + 'y') - .5) * 44, z: Math.sin(a) * r };
      },
      () => STEP_COLORS[stage] || 0x4a8060,
      (n) => n.is_volatile ? 8 : 5,
      () => 'sphere'
    );
  });

  const rxnByStage = {};
  (byType.reaction || []).forEach(n => {
    const s = n.stage || 'mixing';
    (rxnByStage[s] = rxnByStage[s] || []).push(n);
  });
  Object.entries(rxnByStage).forEach(([stage, rxns]) => {
    placeNodes(rxns,
      (n, i, total) => {
        const po = STAGE_PO[stage] ?? 1;
        const a = (i / total) * Math.PI * 2 + Math.PI / total;
        const r = 180 + ((i % 3) - 1) * 26;
        return { x: Math.cos(a) * r, y: getStageY(po) + (sr(n.id + 'y') - .5) * 22, z: Math.sin(a) * r };
      },
      (n) => n.orphan ? 0x444444 : (STEP_COLORS[stage] || 0x666666),
      () => 9,
      () => 'octa'
    );
  });

  const EDGE_STYLE = {
    mass_flow:        { col: 0x88aaff, opacity: .20 },
    flow_split:       { col: 0x89a9ff, opacity: .24 },
    input:            { col: 0xff8844, opacity: .38 },
    output:           { col: 0x44ccdd, opacity: .38 },
    ingredient_input: { col: 0x8b6a3e, opacity: .32 },
  };

  (GR.edges || []).forEach(e => {
    const se = nodeMap[e.source], te = nodeMap[e.target];
    if (!se || !te) return;
    const style = EDGE_STYLE[e.type] || { col: 0x333333, opacity: .12 };
    const start = se.mesh.position.clone();
    const end = te.mesh.position.clone();
    const radius = flowRadius(edgeFlowQuantity(e));
    const tube = createEdgeCylinder(start, end, style.col, style.opacity, radius);
    scene.add(tube.mesh);
    lineMeshes.push({ line: tube.mesh, edge: e, mat: tube.mat, originalColor: style.col, baseOpacity: style.opacity, baseRadius: radius });
  });

  refreshFlowVisuals();
}

// trace() は上部 §10.4 (v8.4) の定義を使用
// FlowEngine.traceFlow() によるflow-base展開は使用しない（暴走防止）

function applyHighlight() {
  allMeshes.forEach(({ mesh }) => {
    const ud = mesh.userData;
    const baseScale = ud.baseScale || 1;
    const inTr = traceSet ? traceSet.has(ud.id) : true;
    const vis = isVisible(ud);
    const isSel = ud.id === selectedId;
    if (!vis) {
      mesh.material.opacity = 0.02;
      mesh.material.emissiveIntensity = 0;
      mesh.scale.setScalar(baseScale * 0.85);
      return;
    }
    if (!inTr && traceSet) {
      mesh.material.opacity = 0.05;
      mesh.material.emissiveIntensity = 0;
      mesh.scale.setScalar(baseScale * 0.88);
    } else if (isSel) {
      mesh.material.color.setHex(0xffffff);
      mesh.material.emissive.setHex(0xffffff);
      mesh.material.emissiveIntensity = 0.80;
      mesh.material.opacity = 1;
      mesh.scale.setScalar(baseScale * 1.38);
    } else {
      const col = ud.originalColor, isVol = ud.node?.is_volatile;
      mesh.material.color.setHex(col);
      mesh.material.emissive.setHex(col);
      let ei;
      if (inTr && traceSet) {
        const inUp = traceUpSet && traceUpSet.has(ud.id);
        const inDn = traceDnSet && traceDnSet.has(ud.id);
        if (ud.type === 'reaction') ei = .55;
        else if (inUp && inDn) ei = isVol ? .60 : .28;
        else if (inUp) ei = isVol ? .55 : .24;
        else if (inDn) ei = isVol ? .65 : .32;
        else ei = isVol ? .50 : .20;
      } else ei = isVol ? .40 : .10;
      mesh.material.emissiveIntensity = ei;
      mesh.material.opacity = ud.node?.orphan ? 0.45 : 1;
      mesh.scale.setScalar(baseScale);
    }
  });

  lineMeshes.forEach(({ edge, mat, originalColor, baseOpacity, line, currentRadius, baseRadius }) => {
    const edgeVisible = isEdgeVisible(edge);
    const scale = baseRadius ? (currentRadius || baseRadius) / baseRadius : 1;
    if (line?.scale) line.scale.set(scale, 1, scale);
    if (traceSet) {
      const both = edgeVisible && traceSet.has(edge.source) && traceSet.has(edge.target);
      mat.opacity = both ? Math.min(.96, baseOpacity * 2.25) : .015;
      if (both) {
        if (edge.type === 'input') mat.color.setHex(0xff8844);
        else if (edge.type === 'output') mat.color.setHex(0x44ccdd);
        else if (edge.type === 'ingredient_input') mat.color.setHex(0xc89a63);
        else if (edge.type === 'flow_split' || edge.type === 'mass_flow') mat.color.setHex(0x88aaff);
        else mat.color.setHex(0x888888);
      } else mat.color.setHex(originalColor);
    } else {
      mat.color.setHex(originalColor);
      if (!edgeVisible) mat.opacity = 0.01;
      else if (activeSnapshot !== 'all') {
        const inSnap = edge.snapshot === activeSnapshot || edge.from_snapshot === activeSnapshot || edge.to_snapshot === activeSnapshot;
        mat.opacity = inSnap ? Math.min(.95, baseOpacity * 2.1) : Math.max(.05, baseOpacity * .8);
      } else mat.opacity = baseOpacity;
    }
  });
}

function selectNode(id, node, type) {
  selectedId = id;
  const { combined, upstream, downstream } = trace(id);
  traceSet = combined;
  traceUpSet = upstream;
  traceDnSet = downstream;
  let icon = '🔍', msg = '';
  const qty = getNodeQuantity(node);
  if (type === 'raw_material') {
    icon = '🔶';
    msg = `${node?.name || id}  ${formatQty(qty)}  ▼下流 ${Math.max(0, downstream.size - 1)} フロー`;
  } else if (type === 'ingredient_component') {
    icon = '🟤';
    msg = `${node?.name || id}  ${formatQty(qty)}  ▼成分波及 ${Math.max(0, downstream.size - 1)}`;
  } else if (type === 'reaction') {
    const ins = (bwdMap[id] || []).filter(e => e.type === 'input').length;
    const outs = (fwdMap[id] || []).filter(e => e.type === 'output').length;
    icon = '🔷';
    msg = `${node?.name || id}  入力 ${ins} / 出力 ${outs} / 関連フロー ${Math.max(0, combined.size - 1)}`;
  } else {
    icon = node?.stage === 'baking' ? '🔴' : '🔵';
    msg = `${node?.name || id}  ${formatQty(qty)}  ▲${Math.max(0, upstream.size - 1)}  ▼${Math.max(0, downstream.size - 1)}`;
  }
  traceOrigin = { id, node, type, traceSet: new Set(combined), traceUpSet: new Set(upstream), traceDnSet: new Set(downstream), msg, icon };
  navStack = [];
  applyHighlight();
  showTraceBar(msg, icon);
  updateDetail(node, type);
}

function detailSub(panel, n) {
  const stage = n.stage || 'mixing';
  const bc = STEP_COLORS_CSS[stage] || '#4a8060';
  const smE = SUB_MASTER_MAP[n.ref || n.master_id || n.id] || {};
  const hasBack = navStack.length > 0;
  const snapBadgeHTML = snapBadge(n.snapshot);
  const nodeId = n.id;
  const inEdges = (bwdMap[nodeId] || []).filter(e => ['ingredient_input','input','output','mass_flow','flow_split'].includes(e.type));
  const outEdges = (fwdMap[nodeId] || []).filter(e => ['ingredient_input','input','output','mass_flow','flow_split'].includes(e.type));
  const qty = getNodeQuantity(n);
  const flow = n.flow_ref ? getFlow(n.flow_ref) : null;
  const env = FLOW_SIM_RUNTIME?.current_environment || flow?.state || GR?.global_state || {};
  const makeLink = (nid, label) => `<span style="cursor:pointer;color:var(--accent2);font-size:9px" onclick="_jumpTo('${nid}')">${label}</span>`;
  const makeEdgeLine = (edge, dir) => {
    const peerId = dir === 'in' ? edge.source : edge.target;
    const peer = nodeMap[peerId]?.node;
    if (!peer) return '';
    const q = edgeFlowQuantity(edge);
    return `<div style="font-size:9px;color:var(--text3);margin-bottom:2px">
      <span style="color:${edgeBadgeColor(edge.type, dir)}">${edgeArrow(edge.type, dir)}</span>
      ${makeLink(peerId, peer.name || peerId.slice(0, 20))}
      <span style="color:var(--text3);font-size:8px">[${edge.type}] ${formatQty(q)}</span>
    </div>`;
  };
  const physHTML = smE.id ? `<div class="detail-section"><div class="detail-section-title">物性 / センサー</div>
    <div style="font-size:9px;color:var(--text2);line-height:1.8">
    ${smE.physical?.molecular_weight ? `分子量: ${smE.physical.molecular_weight} g/mol<br>` : ''}
    ${smE.sensory?.odor_threshold_ppm != null ? `臭気閾値: ${smE.sensory.odor_threshold_ppm} ppm<br>` : ''}
    ${smE.sensory?.descriptors?.length ? `香り: ${smE.sensory.descriptors.join(', ')}<br>` : ''}
    </div></div>` : '';

  // §B2 flow history（工程横断トレース）
  const hist = getFlowHistory(n);
  const histHTML = hist && hist.length > 1 ? `<div class="detail-section">
    <div class="detail-section-title">工程履歴 (${hist.length} スナップショット)</div>
    ${hist.filter(h => h.snapshot).map(h => {
      const snap = SNAP_MAP[h.snapshot] || {};
      const stageCol = STEP_COLORS_CSS[snap.stage || h.stage] || '#555';
      const viaLinks = (h.via || []).map(rxnId => {
        const rxnNodeId = `node-RXN-${rxnId}-${h.snapshot}`;
        return `<span style="cursor:pointer;color:var(--accent3);font-size:8px" onclick="_jumpTo('${rxnNodeId}')">[${rxnId}]</span>`;
      }).join(' ');
      return `<div style="font-size:9px;color:var(--text3);margin-bottom:3px;display:flex;align-items:baseline;gap:4px">
        <span style="color:${stageCol};font-size:8px">●</span>
        <span style="color:var(--text2)">${snap.label_ja || h.stage || h.snapshot}</span>
        <span style="color:var(--accent)">${formatQty(h.quantity)}</span>
        ${viaLinks ? `<span style="color:var(--text3)">via</span> ${viaLinks}` : ''}
      </div>`;
    }).join('')}
  </div>` : '';

  panel.innerHTML = `<div class="detail-card">
    ${hasBack ? _backBtnHTML() : ''}
    <div class="detail-id">${n.id}</div>
    <div class="detail-name">${n.name}</div>
    ${n.formula ? `<div class="detail-formula">${n.formula}</div>` : ''}
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      <span class="badge" style="background:${bc};color:#070a08">${STEP_LABELS[stage] || stage}</span>
      ${snapBadgeHTML}
      ${n.is_volatile ? `<span style="font-size:9px;color:#e8b553;padding:2px 6px;border:1px solid #e8b553;border-radius:2px">★ 香気</span>` : ''}
    </div>
    <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:10px;color:var(--text3)">
      <div>現在量 <span style="color:var(--accent)">${formatQty(qty)}</span></div>
      <div>flow_ref <span style="color:var(--accent2)">${n.flow_ref || '—'}</span></div>
      <div>温度 <span style="color:var(--accent2)">${Number(env.temperature_c ?? env.temperature ?? 24).toFixed(1)}℃</span></div>
      <div>水分活性 <span style="color:var(--accent2)">${Number(env.water_activity ?? 0.95).toFixed(3)}</span></div>
    </div>
    ${histHTML}
    ${physHTML}
    ${(inEdges.length || outEdges.length) ? `<div class="detail-section"><div class="detail-section-title">接続フロー</div>${inEdges.slice(0, 5).map(e => makeEdgeLine(e, 'in')).join('')}${outEdges.slice(0, 5).map(e => makeEdgeLine(e, 'out')).join('')}</div>` : ''}
  </div>`;
}

function detailRxn(panel, r) {
  const col = STEP_COLORS_CSS[r.stage] || '#666';
  const hasBack = navStack.length > 0;
  const snapBadgeHTML = snapBadge(r.snapshot);
  const inputs = (bwdMap[r.id] || []).filter(e => e.type === 'input').map(e => nodeMap[e.source]?.node).filter(Boolean);
  const outputs = (fwdMap[r.id] || []).filter(e => e.type === 'output').map(e => nodeMap[e.target]?.node).filter(Boolean);
  const env = FLOW_SIM_RUNTIME?.current_environment || GR?.global_state || {};
  panel.innerHTML = `<div class="detail-card">
    ${hasBack ? _backBtnHTML() : ''}
    <div class="detail-id">${r.id}${r.orphan ? ' <span style="color:#888;font-size:8px">孤立</span>' : ''}</div>
    <div class="detail-name">${r.name}</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      <span class="badge" style="background:${col};color:#070a08">${STEP_LABELS[r.stage] || r.stage || ''}</span>
      ${snapBadgeHTML}
    </div>
    ${r.equation ? `<div style="font-size:10px;color:var(--text2);margin:8px 0;border-left:2px solid ${col};padding-left:8px;line-height:1.6">${r.equation}</div>` : ''}
    <div style="font-size:10px;color:var(--text3);line-height:1.8">runtime 温度: <span style="color:var(--accent2)">${Number(env.temperature_c ?? env.temperature ?? 24).toFixed(1)}℃</span> / 時間: <span style="color:var(--accent2)">${Math.round(Number(env.time_sec || 0))} s</span></div>
    ${inputs.length ? `<div class="detail-section"><div class="detail-section-title">▶ 入力物質 (${inputs.length})</div>${inputs.slice(0, 8).map(s => `<div style="font-size:10px;color:var(--text2);margin-bottom:3px;cursor:pointer;padding:2px 4px;border-radius:2px" onclick="_jumpTo('${s.id}')"><span style="color:${STEP_COLORS_CSS[s.stage] || '#888'};font-size:8px">●</span> ${s.name}<span style="color:var(--text3);margin-left:auto;float:right">${formatQty(getNodeQuantity(s))}</span></div>`).join('')}</div>` : ''}
    ${outputs.length ? `<div class="detail-section"><div class="detail-section-title">✦ 出力物質 (${outputs.length})</div>${outputs.slice(0, 8).map(s => `<div style="font-size:10px;color:${s.is_volatile ? 'var(--accent3)' : 'var(--accent2)'};margin-bottom:3px;cursor:pointer;padding:2px 4px;border-radius:2px" onclick="_jumpTo('${s.id}')">${s.is_volatile ? '★' : '●'} ${s.name}<span style="color:var(--text3);margin-left:auto;float:right">${formatQty(getNodeQuantity(s))}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

function detailRaw(panel, rm) {
  const hasBack = navStack.length > 0;
  const col = STEP_COLORS_CSS.ingredients;
  const dnCount = trace(rm.id).downstream.size - 1;
  const comps = (GR.nodes || []).filter(n => n.type === 'ingredient_component' && n.raw_parent === rm.id);
  panel.innerHTML = `<div class="detail-card">
    ${hasBack ? _backBtnHTML() : ''}
    <div class="detail-id">${rm.id}</div>
    <div class="detail-name">${rm.name}</div>
    <span class="badge" style="background:${col};color:#070a08">原材料</span>
    <div style="margin-top:10px;font-size:10px;color:var(--text3)">現在量: <span style="color:var(--accent)">${formatQty(getNodeQuantity(rm))}</span></div>
    <div style="margin-top:4px;font-size:10px;color:var(--text3)">下流フロー数: <span style="color:var(--accent2)">${dnCount}</span></div>
    ${comps.length ? `<div class="detail-section"><div class="detail-section-title">成分一覧 (${comps.length})</div>${comps.map(c => `<div style="font-size:10px;color:#c89050;margin-bottom:3px;cursor:pointer" onclick="_jumpTo('${c.id}')">▸ ${c.name || c.substance_ref} <span style="color:var(--accent2)">${formatQty(getNodeQuantity(c))}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

function detailComp(panel, comp) {
  const hasBack = navStack.length > 0;
  const col = STEP_COLORS_CSS.ingredient_component;
  const dnCount = trace(comp.id).downstream.size - 1;
  panel.innerHTML = `<div class="detail-card">
    ${hasBack ? _backBtnHTML() : ''}
    <div class="detail-id">${comp.id}</div>
    <div class="detail-name">${comp.name}</div>
    <span class="badge" style="background:${col};color:#070a08">成分分解</span>
    <div style="font-size:10px;color:var(--text3);margin-top:8px">原材料: <span style="color:var(--accent2)">${comp.raw_parent}</span></div>
    <div style="font-size:10px;color:var(--text3)">投入量: <span style="color:var(--accent)">${formatQty(getNodeQuantity(comp))}</span></div>
    <div style="font-size:10px;color:var(--text3)">下流フロー数: <span style="color:var(--accent2)">${dnCount}</span></div>
  </div>`;
}

function updateDetail(node, type) {
  const panel = document.getElementById('detail-panel');
  if (!panel) return;
  if (!node) {
    navStack = [];
    panel.innerHTML = `<div class="detail-empty">
      ノードをクリックすると詳細表示<br><br>
      <b style="color:var(--text2)">Flow Runtime v4.0</b><br>
      🔶 原材料 / 🟤 成分 / 🔵 物質 / 🔷 反応<br>
      量は node.state ではなく <code>flow.quantity_g</code> を基準に更新されます。<br>
      エッジ太さは flow 量に連動し、温度・時間・水分スライダーで再計算されます。<br><br>
      <div id="sim-status" style="font-size:10px;color:var(--text3);line-height:1.7"></div>
    </div>`;
    syncSimulationHUD();
    return;
  }
  if (type === 'reaction') detailRxn(panel, node);
  else if (type === 'raw_material') detailRaw(panel, node);
  else if (type === 'ingredient_component') detailComp(panel, node);
  else detailSub(panel, node);
}

function applyBreadSimulationStep(overrides) {
  if (!window.FlowEngine || !GR) return null;
  if (!FLOW_SIM_RUNTIME) FLOW_SIM_RUNTIME = FlowEngine.buildBaseRuntime(GR, FLOW_SIM_SPEC);
  FLOW_SIM_RUNTIME = FlowEngine.simulateStep(GR, FLOW_SIM_RUNTIME, overrides || {});
  FlowEngine.syncGraphWithRuntime(GR, FLOW_SIM_RUNTIME);
  refreshFlowVisuals();
  applyHighlight();
  if (selectedId && nodeMap[selectedId]) updateDetail(nodeMap[selectedId].node, nodeMap[selectedId].type);
  else updateDetail(null);
  return FLOW_SIM_RUNTIME;
}

window.applyBreadSimulationStep = applyBreadSimulationStep;
window.simulateStep = applyBreadSimulationStep;
// ==========================================================================


// ==== v1.0 static causal model enhancements =================================
(function () {
  function unionInto(target, source) {
    (source || []).forEach((v) => target.add(v));
    return target;
  }

  function getReactionMetaByNode(node) {
    const rid = node?.ref || node?.id;
    return (GR?.reactions || []).find((r) => r.id === rid) || null;
  }

  function getSnapshotMeta(id) {
    return id ? ((GR?.snapshots || []).find((s) => s.id === id) || null) : null;
  }

  function getProcessName(pid) {
    if (!pid) return '—';
    const hit = (FLOW_SIM_SPEC?.process_instances || []).find((p) => p.id === pid)
      || (GR?.snapshots || []).find((s) => s.process_instance_id === pid)
      || (GR?.reactions || []).find((r) => r.process_instance_id === pid);
    return hit?.name_ja || hit?.name || pid;
  }

  function traceFlow(flowId) {
    if (!window.FlowEngine || !GR || !flowId) {
      return { flowIds: new Set(), reactionIds: new Set(), nodeIds: new Set(), combined: new Set(), upstream: new Set(), downstream: new Set() };
    }
    const result = FlowEngine.traceFlow(GR, flowId);
    const nodeIds = new Set(result.nodeIds || []);
    const upstream = new Set();
    const downstream = new Set();
    (result.upstreamFlowIds || []).forEach((fid) => {
      const flow = FlowEngine.getFlow(GR, fid);
      if (flow?.origin_node) upstream.add(flow.origin_node);
    });
    (result.downstreamFlowIds || []).forEach((fid) => {
      const flow = FlowEngine.getFlow(GR, fid);
      if (flow?.origin_node) downstream.add(flow.origin_node);
    });
    (result.upstreamReactionIds || []).forEach((rid) => {
      (GR.nodes || []).filter((n) => n.type === 'reaction' && n.ref === rid).forEach((n) => upstream.add(n.id));
    });
    (result.downstreamReactionIds || []).forEach((rid) => {
      (GR.nodes || []).filter((n) => n.type === 'reaction' && n.ref === rid).forEach((n) => downstream.add(n.id));
    });
    return Object.assign({}, result, { nodeIds, combined: nodeIds, upstream, downstream });
  }

  function traceReactionNode(node) {
    const reaction = getReactionMetaByNode(node) || {};
    const total = {
      flowIds: new Set(),
      reactionIds: new Set([reaction.id || node?.ref || node?.id]),
      nodeIds: new Set([node.id]),
      combined: new Set([node.id]),
      upstream: new Set([node.id]),
      downstream: new Set([node.id])
    };
    const linked = [...(reaction.input_flows || []), ...(reaction.output_flows || [])];
    linked.forEach((fid) => {
      const partial = traceFlow(fid);
      unionInto(total.flowIds, partial.flowIds || []);
      unionInto(total.reactionIds, partial.reactionIds || []);
      unionInto(total.nodeIds, partial.nodeIds || []);
      unionInto(total.combined, partial.combined || []);
      unionInto(total.upstream, partial.upstream || []);
      unionInto(total.downstream, partial.downstream || []);
    });
    return total;
  }

  const __baseApplyHighlight = applyHighlight;
  applyHighlight = function (result) {
    // result が渡された場合のみグローバルを更新する
    // selectNode() はグローバルに直接書き込むため result なしで呼ばれる
    if (result && result.combined) {
      traceSet    = result.combined ? new Set(result.combined) : null;
      traceUpSet  = result.upstream ? new Set(result.upstream) : null;
      traceDnSet  = result.downstream ? new Set(result.downstream) : null;
    }
    return __baseApplyHighlight();
  };

  function buildTraceMessage(node, type, result) {
    if (type === 'reaction') {
      const reaction = getReactionMetaByNode(node) || {};
      return `🔷 ${node?.name || node?.id} / ${getProcessName(reaction.process_instance_id)} / flow ${result.flowIds?.size || 0} / reaction ${result.reactionIds?.size || 0}`;
    }
    const flow = node?.flow_ref ? FlowEngine?.getFlow?.(GR, node.flow_ref) : null;
    const trans = flow?.transition || {};
    return `🔵 ${node?.name || node?.id} / ${getProcessName(flow?.process_instance_id)} / ${trans.change_type || 'trace'} / upstream ${Math.max(0, (result.upstream?.size || 1) - 1)} / downstream ${Math.max(0, (result.downstream?.size || 1) - 1)}`;
  }

  onNodeClick = function (node) {
    if (!node) return;
    // 反応ノード・物質ノード・RAW/COMP いずれも selectNode() に委譲して
    // 反応一覧クリックとツリークリックのトレース結果を完全一致させる
    selectNode(node.id, node, node.type);
  };

  const __baseCanvasClick = onCanvasClick;
  onCanvasClick = function (e) {
    if (_cm) return;
    const hit = raycast(e);
    if (!hit) {
      if (traceOrigin) _restoreTraceOrigin();
      else clearSel();
      return;
    }
    const { node } = hit.object.userData;
    onNodeClick(node);
    hideTT();
  };

  function appendProcessPanel(node, type) {
    const panel = document.getElementById('detail-panel');
    if (!panel || !node) return;
    let flow = node.flow_ref ? FlowEngine?.getFlow?.(GR, node.flow_ref) : null;
    let reaction = type === 'reaction' ? getReactionMetaByNode(node) : null;
    const pid = reaction?.process_instance_id || flow?.process_instance_id || node?.process_instance_id;
    const transition = flow?.transition || node?.transition || {};
    const snap = getSnapshotMeta(flow?.snapshot_id || node?.snapshot);
    const nextStep = snap?.next_step || '—';
    const html = `
      <div class="detail-section" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px">
        <div class="detail-section-title">Process / Change</div>
        <div style="font-size:10px;color:var(--text2);line-height:1.8">
          <div>process: <span style="color:var(--accent2)">${getProcessName(pid)}</span></div>
          <div>process_instance_id: <span style="color:var(--text3)">${pid || '—'}</span></div>
          <div>change_type: <span style="color:var(--accent3)">${transition.change_type || reaction?.process_subtype || '—'}</span></div>
          <div>change_detail: <span style="color:var(--text3)">${transition.change_detail || reaction?.name_ja || reaction?.name || '—'}</span></div>
          <div>next_step: <span style="color:var(--accent2)">${nextStep}</span></div>
        </div>
      </div>`;
    panel.insertAdjacentHTML('beforeend', html);
  }

  const __baseUpdateDetail = updateDetail;
  updateDetail = function (node, type) {
    __baseUpdateDetail(node, type);
    if (node) appendProcessPanel(node, type);
  };

  window.traceFlow = traceFlow;
  window.traceByProcess = function (processInstanceId) {
    return window.FlowEngine ? FlowEngine.traceByProcess(GR, processInstanceId) : null;
  };
  window.traceTransition = function (flowId) {
    return window.FlowEngine ? FlowEngine.traceTransition(GR, flowId) : null;
  };
  window.compareSnapshots = function (snapA, snapB) {
    return window.FlowEngine ? FlowEngine.compareSnapshots(GR, snapA, snapB) : null;
  };
})();
