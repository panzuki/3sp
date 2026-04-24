(function (global) {
  const CACHE_KEY = '__flow_engine_index__';

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

  function getIndex(graph) {
    if (!graph[CACHE_KEY]) {
      const nodeById = {};
      const flowById = {};
      const flowToNode = {};
      const flowAdjOut = {};
      const flowAdjIn = {};
      const reactionIn = {};
      const reactionOut = {};

      (graph.nodes || []).forEach((node) => {
        nodeById[node.id] = node;
        if (node.flow_ref) {
          flowToNode[node.flow_ref] = node.id;
        }
      });
      (graph.flows || []).forEach((flow) => {
        flowById[flow.id] = flow;
        flowAdjOut[flow.id] = flowAdjOut[flow.id] || [];
        flowAdjIn[flow.id] = flowAdjIn[flow.id] || [];
      });

      (graph.edges || []).forEach((edge) => {
        const sourceNode = nodeById[edge.source] || {};
        const targetNode = nodeById[edge.target] || {};
        if (targetNode.type === 'reaction') {
          reactionIn[targetNode.id] = reactionIn[targetNode.id] || [];
          if (sourceNode.flow_ref) reactionIn[targetNode.id].push(sourceNode.flow_ref);
        }
        if (sourceNode.type === 'reaction') {
          reactionOut[sourceNode.id] = reactionOut[sourceNode.id] || [];
          if (targetNode.flow_ref) reactionOut[sourceNode.id].push(targetNode.flow_ref);
        }
        if (sourceNode.flow_ref && targetNode.flow_ref) {
          flowAdjOut[sourceNode.flow_ref] = flowAdjOut[sourceNode.flow_ref] || [];
          flowAdjIn[targetNode.flow_ref] = flowAdjIn[targetNode.flow_ref] || [];
          flowAdjOut[sourceNode.flow_ref].push(targetNode.flow_ref);
          flowAdjIn[targetNode.flow_ref].push(sourceNode.flow_ref);
        }
      });

      Object.keys(reactionIn).forEach((reactionId) => {
        const ins = reactionIn[reactionId] || [];
        const outs = reactionOut[reactionId] || [];
        ins.forEach((srcFlow) => {
          outs.forEach((dstFlow) => {
            flowAdjOut[srcFlow] = flowAdjOut[srcFlow] || [];
            flowAdjIn[dstFlow] = flowAdjIn[dstFlow] || [];
            flowAdjOut[srcFlow].push(dstFlow);
            flowAdjIn[dstFlow].push(srcFlow);
          });
        });
      });

      graph[CACHE_KEY] = { nodeById, flowById, flowToNode, flowAdjOut, flowAdjIn, reactionIn, reactionOut };
    }
    return graph[CACHE_KEY];
  }

  function getFlow(graph, flowId) {
    return getIndex(graph).flowById[flowId] || null;
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

  function traceFlow(graph, flowId) {
    const idx = getIndex(graph);
    const combined = new Set();
    const upstream = new Set();
    const downstream = new Set();

    function walkOut(start) {
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        if (downstream.has(current)) continue;
        downstream.add(current);
        combined.add(current);
        (idx.flowAdjOut[current] || []).forEach((nextFlow) => {
          if (!downstream.has(nextFlow)) queue.push(nextFlow);
        });
      }
    }

    function walkIn(start) {
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        if (upstream.has(current)) continue;
        upstream.add(current);
        combined.add(current);
        (idx.flowAdjIn[current] || []).forEach((prevFlow) => {
          if (!upstream.has(prevFlow)) queue.push(prevFlow);
        });
      }
    }

    if (!flowId || !idx.flowById[flowId]) {
      return { combined, upstream, downstream };
    }
    walkIn(flowId);
    walkOut(flowId);
    return { combined, upstream, downstream };
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
      graphFlow.quantity_g = num(flowState.quantity_g, graphFlow.quantity_g || 0);
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
    getFlow,
    getFlowByNode,
    getFlowQuantity,
    traceFlow,
    simulateStep,
    syncGraphWithRuntime,
  };
})(window);
