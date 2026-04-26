(function (global) {
  const CACHE_KEY = '__flow_engine_index_v2__';

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function uniq(arr) {
    return Array.from(new Set((arr || []).filter(Boolean)));
  }

  function getIndex(graph) {
    if (!graph[CACHE_KEY]) {
      const nodeById = {};
      const flowById = {};
      const reactionById = {};
      const flowToNode = {};
      const reactionToNodes = {};
      const flowsBySnapshot = {};
      const reactionsByProcess = {};
      const snapshotsById = {};
      (graph.nodes || []).forEach((node) => {
        nodeById[node.id] = node;
        if (node.flow_ref) flowToNode[node.flow_ref] = node.id;
        if (node.type === 'reaction' && node.ref) {
          reactionToNodes[node.ref] = reactionToNodes[node.ref] || [];
          reactionToNodes[node.ref].push(node.id);
        }
      });
      (graph.flows || []).forEach((flow) => {
        flowById[flow.id] = flow;
        if (flow.snapshot_id || flow.snapshot) {
          const sid = flow.snapshot_id || flow.snapshot;
          flowsBySnapshot[sid] = flowsBySnapshot[sid] || [];
          flowsBySnapshot[sid].push(flow.id);
        }
      });
      (graph.reactions || []).forEach((reaction) => {
        reactionById[reaction.id] = reaction;
        const pid = reaction.process_instance_id;
        if (pid) {
          reactionsByProcess[pid] = reactionsByProcess[pid] || [];
          reactionsByProcess[pid].push(reaction.id);
        }
      });
      (graph.snapshots || []).forEach((snap) => {
        snapshotsById[snap.id] = snap;
      });
      graph[CACHE_KEY] = { nodeById, flowById, reactionById, flowToNode, reactionToNodes, flowsBySnapshot, reactionsByProcess, snapshotsById };
    }
    return graph[CACHE_KEY];
  }

  function getFlow(graph, flowId) {
    return getIndex(graph).flowById[flowId] || null;
  }

  function getReaction(graph, reactionId) {
    return getIndex(graph).reactionById[reactionId] || null;
  }

  function getFlowByNode(graph, nodeOrId) {
    const idx = getIndex(graph);
    const node = typeof nodeOrId === 'string' ? idx.nodeById[nodeOrId] : nodeOrId;
    return node && node.flow_ref ? idx.flowById[node.flow_ref] || null : null;
  }

  function getFlowQuantity(graph, flowId) {
    const flow = getFlow(graph, flowId);
    return flow ? num(flow.quantity_g, 0) : 0;
  }

  function toNodeResult(graph, result) {
    const idx = getIndex(graph);
    const nodeIds = new Set();
    result.flowIds.forEach((fid) => {
      const nodeId = idx.flowToNode[fid];
      if (nodeId) nodeIds.add(nodeId);
    });
    result.reactionIds.forEach((rid) => {
      (idx.reactionToNodes[rid] || []).forEach((nid) => nodeIds.add(nid));
    });
    result.nodeIds = nodeIds;
    result.combined = new Set([...result.flowIds, ...result.reactionIds]);
    return result;
  }

  function traceFlow(graph, flowId) {
    const idx = getIndex(graph);
    const seed = idx.flowById[flowId];
    const result = {
      seed_flow_id: flowId,
      flowIds: new Set(),
      reactionIds: new Set(),
      upstreamFlowIds: new Set(),
      downstreamFlowIds: new Set(),
      upstreamReactionIds: new Set(),
      downstreamReactionIds: new Set(),
    };
    if (!seed) return toNodeResult(graph, result);

    const upFlowVisited = new Set();
    const downFlowVisited = new Set();
    const upReactionVisited = new Set();
    const downReactionVisited = new Set();

    function walkUp(fid) {
      if (!fid || upFlowVisited.has(fid)) return;
      upFlowVisited.add(fid);
      result.flowIds.add(fid);
      result.upstreamFlowIds.add(fid);
      const flow = idx.flowById[fid];
      if (!flow) return;
      const producer = flow.produced_by;
      if (producer && idx.reactionById[producer] && !upReactionVisited.has(producer)) {
        upReactionVisited.add(producer);
        result.reactionIds.add(producer);
        result.upstreamReactionIds.add(producer);
        (idx.reactionById[producer].input_flows || []).forEach(walkUp);
      }
      (flow.parent_flows || []).forEach(walkUp);
    }

    function walkDown(fid) {
      if (!fid || downFlowVisited.has(fid)) return;
      downFlowVisited.add(fid);
      result.flowIds.add(fid);
      result.downstreamFlowIds.add(fid);
      const flow = idx.flowById[fid];
      if (!flow) return;
      (flow.consumed_in || []).forEach((rid) => {
        if (rid && idx.reactionById[rid] && !downReactionVisited.has(rid)) {
          downReactionVisited.add(rid);
          result.reactionIds.add(rid);
          result.downstreamReactionIds.add(rid);
          (idx.reactionById[rid].output_flows || []).forEach(walkDown);
        }
      });
      (flow.downstream_flows || []).forEach(walkDown);
    }

    walkUp(flowId);
    walkDown(flowId);
    return toNodeResult(graph, result);
  }

  function traceByProcess(graph, processInstanceId) {
    const idx = getIndex(graph);
    const result = {
      process_instance_id: processInstanceId,
      flowIds: new Set(),
      reactionIds: new Set(),
      snapshotIds: new Set(),
    };
    const reactionIds = idx.reactionsByProcess[processInstanceId] || [];
    reactionIds.forEach((rid) => {
      result.reactionIds.add(rid);
      const reaction = idx.reactionById[rid] || {};
      [...(reaction.input_flows || []), ...(reaction.output_flows || [])].forEach((fid) => {
        result.flowIds.add(fid);
        const flow = idx.flowById[fid];
        const sid = flow && (flow.snapshot_id || flow.snapshot);
        if (sid) result.snapshotIds.add(sid);
      });
    });
    return result;
  }

  function traceTransition(graph, flowId) {
    const idx = getIndex(graph);
    const flow = idx.flowById[flowId];
    if (!flow) return null;
    return {
      flow_id: flowId,
      transition: deepClone(flow.transition || {}),
      parent_flows: deepClone(flow.parent_flows || []),
      downstream_flows: deepClone(flow.downstream_flows || []),
      produced_by: flow.produced_by || null,
      consumed_in: deepClone(flow.consumed_in || []),
      process_instance_id: flow.process_instance_id || null,
      snapshot_id: flow.snapshot_id || flow.snapshot || null,
    };
  }

  function compareSnapshots(graph, snapA, snapB) {
    const idx = getIndex(graph);
    const a = new Set(idx.flowsBySnapshot[snapA] || []);
    const b = new Set(idx.flowsBySnapshot[snapB] || []);
    const added = [];
    const removed = [];
    const common = [];
    b.forEach((fid) => { if (!a.has(fid)) added.push(fid); else common.push(fid); });
    a.forEach((fid) => { if (!b.has(fid)) removed.push(fid); });
    const changed = common.filter((fid) => {
      const flow = idx.flowById[fid] || {};
      return !!(flow.transition && flow.transition.change_type && flow.transition.change_type !== 'carry_forward');
    });
    return { snapshot_a: snapA, snapshot_b: snapB, added, removed, common, changed };
  }

  function classifyFlow(flow) {
    const name = String(flow.name || flow.substance_id || '').toLowerCase();
    if (/water|水/.test(name)) return 'water';
    if (/co2|二酸化炭素/.test(name)) return 'co2';
    if (/ethanol|エタノール/.test(name)) return 'ethanol';
    if (/ester|エステル|volatile|香/.test(name)) return 'volatile';
    if (/sucrose|glucose|fructose|maltose|糖/.test(name)) return 'sugar';
    if (/melanoidin|メラノイジン|brown|褐/.test(name)) return 'maillard';
    if (/yeast|酵母/.test(name)) return 'yeast';
    if (/protein|gluten|タンパク|ペプチド|アミノ酸/.test(name)) return 'protein';
    return 'default';
  }

  function buildBaseRuntime(graph, simRuntime) {
    const frames = (simRuntime && simRuntime.time_series) || [];
    const firstFrame = frames[0] || { environment: graph.global_state || {}, flows: [] };
    return {
      current_environment: deepClone(firstFrame.environment || graph.global_state || {}),
      current_snapshot: firstFrame.snapshot_id || ((graph.snapshots || [])[0] || {}).id || null,
      current_flows: deepClone(graph.flows || []),
      frame_mode: simRuntime && simRuntime.frame_mode ? simRuntime.frame_mode : 'direct',
      reaction_log: [],
      process_log: [],
    };
  }

  function applyReaction(flow, env, context) {
    const nextFlow = Object.assign({}, flow, { state: Object.assign({}, flow.state || {}) });
    const temp = num(env.temperature_c != null ? env.temperature_c : env.temperature, 24);
    const timeSec = num(env.time_sec, 0);
    const waterActivity = clamp(num(env.water_activity, 0.95), 0.05, 1.0);
    const fermentationWindow = clamp(timeSec / 13500, 0, 1);
    const kind = classifyFlow(nextFlow);
    let quantity = num(nextFlow.quantity_g, 0);
    let reactionTag = 'steady';

    if (kind === 'sugar') {
      const rate = clamp((temp >= 20 && temp <= 38 ? 0.06 : 0.02) * fermentationWindow * waterActivity, 0, 0.3);
      quantity *= (1 - rate);
      reactionTag = 'fermentation_substrate_consumption';
    } else if (kind === 'co2') {
      const rate = clamp((temp >= 20 && temp <= 38 ? 0.22 : 0.08) * fermentationWindow * waterActivity, 0, 0.45);
      quantity *= (1 + rate);
      reactionTag = 'gas_generation';
    } else if (kind === 'ethanol') {
      const rate = clamp((temp >= 20 && temp <= 36 ? 0.18 : 0.05) * fermentationWindow * waterActivity, 0, 0.4);
      quantity *= (1 + rate);
      reactionTag = 'ethanol_generation';
    } else if (kind === 'maillard') {
      const rate = temp > 140 ? clamp((temp - 140) / 120, 0, 1.0) * 0.45 : 0;
      quantity *= (1 + rate);
      reactionTag = 'maillard_progress';
    } else if (kind === 'protein') {
      const rate = clamp((temp >= 25 && temp <= 55 ? 0.05 : 0.015) * waterActivity, 0, 0.12);
      quantity *= (1 + rate * 0.25);
      reactionTag = 'network_reorganization';
    } else if (kind === 'volatile') {
      const rate = temp > 90 ? clamp((temp - 90) / 130, 0, 1.0) * 0.22 : 0.03 * fermentationWindow;
      quantity *= (1 + rate);
      reactionTag = temp > 90 ? 'bake_release' : 'fermentation_aroma_build';
    }

    nextFlow.quantity_g = Number(Math.max(quantity, 0).toFixed(6));
    nextFlow.state.temperature_c = temp;
    nextFlow.state.temperature = temp;
    nextFlow.state.water_activity = waterActivity;
    nextFlow.state.time_sec = timeSec;
    nextFlow.state.last_reaction = reactionTag;
    if (context && Array.isArray(context.reaction_log)) {
      context.reaction_log.push({ flow_id: nextFlow.id, reaction: reactionTag, quantity_g: nextFlow.quantity_g });
    }
    return nextFlow;
  }

  function applyProcess(flow, env, context) {
    const nextFlow = Object.assign({}, flow, { state: Object.assign({}, flow.state || {}) });
    const temp = num(env.temperature_c != null ? env.temperature_c : env.temperature, 24);
    const hydrationDelta = num(env.hydration_delta, 0);
    const moistureFactor = 1 + hydrationDelta * 0.01;
    const waterActivity = clamp(num(env.water_activity, 0.95), 0.05, 1.0);
    const timeSec = num(env.time_sec, 0);
    const kind = classifyFlow(nextFlow);
    let quantity = num(nextFlow.quantity_g, 0);
    let processTag = 'hold';

    if (kind === 'water') {
      const evap = temp > 100 ? clamp((temp - 100) / 150, 0, 0.75) : 0;
      quantity *= clamp(waterActivity * moistureFactor * (1 - evap), 0.18, 1.8);
      processTag = temp > 100 ? 'evaporation' : 'hydration_balance';
    } else if (kind === 'yeast') {
      const grow = temp >= 24 && temp <= 35 ? clamp(timeSec / 13500, 0, 1) * 0.16 : -0.12;
      quantity *= clamp(1 + grow, 0.45, 1.28);
      processTag = temp >= 24 && temp <= 35 ? 'yeast_growth' : 'thermal_stress';
    } else if (kind === 'volatile') {
      const release = temp > 120 ? clamp((temp - 120) / 120, 0, 1.0) * 0.35 : 0.02;
      quantity *= clamp(1 - release * 0.18, 0.52, 1.3);
      processTag = temp > 120 ? 'volatile_release' : 'volatile_retention';
    } else if (kind === 'co2') {
      const expansion = temp > 35 ? clamp((temp - 35) / 140, 0, 1.0) * 0.28 : 0;
      quantity *= (1 + expansion);
      processTag = expansion > 0 ? 'gas_expansion' : 'gas_hold';
    } else if (kind === 'default' || kind === 'protein') {
      const structuralGain = clamp((waterActivity - 0.55) * 0.18 + (temp >= 20 && temp <= 45 ? 0.06 : 0), -0.08, 0.18);
      quantity *= clamp(1 + structuralGain, 0.8, 1.22);
      processTag = 'matrix_adjustment';
    }

    nextFlow.quantity_g = Number(Math.max(quantity, 0).toFixed(6));
    nextFlow.state.temperature_c = temp;
    nextFlow.state.temperature = temp;
    nextFlow.state.water_activity = waterActivity;
    nextFlow.state.time_sec = timeSec;
    nextFlow.state.last_process = processTag;
    if (context && Array.isArray(context.process_log)) {
      context.process_log.push({ flow_id: nextFlow.id, process: processTag, quantity_g: nextFlow.quantity_g });
    }
    return nextFlow;
  }

  function syncGraphWithRuntime(graph, runtime) {
    const idx = getIndex(graph);
    const nextFlows = runtime.current_flows || [];
    nextFlows.forEach((flowState) => {
      const graphFlow = idx.flowById[flowState.id];
      if (!graphFlow) return;
      graphFlow.quantity_g = num(flowState.quantity_g, 0);
      graphFlow.state = Object.assign({}, graphFlow.state || {}, flowState.state || {}, runtime.current_environment || {});
      const nodeId = idx.flowToNode[graphFlow.id];
      const node = nodeId ? idx.nodeById[nodeId] : null;
      if (!node) return;
      node.state = Object.assign({}, node.state || {}, { mass_g: graphFlow.quantity_g }, runtime.current_environment || {});
      if (node.type === 'substance_instance' || node.type === 'raw_material' || node.type === 'ingredient_component') {
        node.amount_g = graphFlow.quantity_g;
      }
    });
    graph.global_state = Object.assign({}, graph.global_state || {}, runtime.current_environment || {});
    return graph;
  }

  function simulateStep(graph, runtime, overrides) {
    const nextRuntime = runtime ? deepClone(runtime) : buildBaseRuntime(graph, null);
    const env = Object.assign({}, nextRuntime.current_environment || {}, overrides || {});
    const temp = num(env.temperature_c != null ? env.temperature_c : env.temperature, 24);
    const waterActivity = clamp(num(env.water_activity, 0.95), 0.05, 1.0);
    const timeSec = num(env.time_sec, 0);
    const hydrationDelta = num(env.hydration_delta, 0);
    const frames = (graph.snapshots || []).slice().sort((a, b) => num(a.time_sec, 0) - num(b.time_sec, 0));
    let currentSnapshot = frames.length ? frames[0].id : null;
    frames.forEach((snap) => {
      if (timeSec >= num(snap.time_sec, 0)) currentSnapshot = snap.id;
    });
    nextRuntime.reaction_log = [];
    nextRuntime.process_log = [];
    const context = { reaction_log: nextRuntime.reaction_log, process_log: nextRuntime.process_log };
    const baseFlows = deepClone(graph.flows || []);
    nextRuntime.current_flows = baseFlows.map((flow) => {
      const reacted = applyReaction(flow, { temperature_c: temp, temperature: temp, water_activity: waterActivity, time_sec: timeSec, hydration_delta: hydrationDelta }, context);
      return applyProcess(reacted, { temperature_c: temp, temperature: temp, water_activity: waterActivity, time_sec: timeSec, hydration_delta: hydrationDelta }, context);
    });
    nextRuntime.current_environment = Object.assign({}, env, { temperature_c: temp, temperature: temp, water_activity: waterActivity, time_sec: timeSec });
    nextRuntime.current_snapshot = currentSnapshot;
    return nextRuntime;
  }

  global.FlowEngine = {
    applyProcess,
    applyReaction,
    buildBaseRuntime,
    compareSnapshots,
    getFlow,
    getFlowByNode,
    getFlowQuantity,
    getReaction,
    traceByProcess,
    traceFlow,
    traceTransition,
    simulateStep,
    syncGraphWithRuntime,
  };
})(window);
