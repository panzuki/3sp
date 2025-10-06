const width = 1200;
const groupSpacingY = 350;
const charSpacing = 10;
const circleRadius = 8;

const svg = d3.select("#chart");
const chartGroup = svg.append("g");
const tooltip = d3.select("body").append("div").attr("class", "tooltip");

const groupLabels = {
    'chart1': '原材料', 'chart2': 'ミキシング (反応)', 'chart3': 'ミキシング後 (物質)',
    'chart4': '発酵 (反応)', 'chart5': '発酵後 (物質)',
    //'chart6': '分割・成形 (反応)',
    //'chart7': '成形後 (物質)', 'chart8': '二次発酵 (反応)', 'chart9': '二次発酵後 (物質)',
    //'chart10': '焼成 (反応)', 'chart11': '製品 (物質)',
};

const groupColors = {
    'chart1': '#a8e6cf', 'chart2': '#ff8b94', 'chart3': '#dcedc1',
    'chart4': '#b59fff', 'chart5': '#ffe3b5', 
    //'chart6': '#8be9fd',
    //'chart7': '#ff79c6', 'chart8': '#f1fa8c', 'chart9': '#50fa7b',
    //'chart10': '#ffb86c', 'chart11': '#bd93f9',
};

const processGroups = new Set(['chart2', 'chart4']);

const fileNames = Object.keys(groupLabels).map(key => `csv/${key}.csv`);

    // D3.jsでCSVファイルを読み込み
    Promise.all(fileNames.map(url => d3.csv(url).catch(() => null))).then(datasets => {
        const validDatasets = datasets.filter(d => d !== null);
        if (validDatasets.length === 0) {
            console.error("CSVファイルが読み込まれませんでした。");
            return;
        }

        const nodes = [];
        const links = [];
        const nodeMap = new Map();
        const allData = validDatasets.flat();
        const uniqueIdCounters = new Map();
        
        // --- 1. ノードの生成とデータマップの構築 ---
        allData.forEach(d => {
            if (!d.番号) return;
            const groupIndex = validDatasets.findIndex(dataset => dataset.includes(d)) + 1;
            const groupName = `chart${groupIndex}`;
            
            const isProcess = processGroups.has(groupName);

            // ノードIDの生成ロジック (同じ番号でも異なるグループでユニーク化)
            let id;
            // 反応ノード（RやM）は、通常はユニーク番号なのでそのまま利用
            if (isProcess && (d.番号.match(/^[MR]\d+[a-z]?$/))) {
                id = `${groupName}-${d.番号}`;
            } 
            else {
                // 物質ノード（奇数チャート）やその他のプロセスノードは連番を付与してユニーク化
                const key = `${groupName}-${d.番号}`;
                const count = uniqueIdCounters.get(key) || 0;
                id = `${key}-${count}`;
                uniqueIdCounters.set(key, count + 1);
            }

            const name = d['物質名'] || d['反応名'] || d['構成物質名'] || d.番号;
            if (!name) return;
            
            // 消滅ノードの判定（次のチャートで×がついているか）
            const isExtinct = (groupIndex % 2 === 1 && groupIndex > 1) 
                              ? (d.次工程への引き継ぎ && d.次工程への引き継ぎ.includes('×'))
                              : false;

            const node = { id, name, group: groupName, number: d.番号, isProcess, isExtinct, data: d };
            nodes.push(node);
            nodeMap.set(id, node);
        });
        
        // --- 2. リンクの生成 ---
        allData.forEach(d => {
            const originalNumber = d.番号;
            const currentGroupIndex = validDatasets.findIndex(dataset => dataset.includes(d)) + 1;
            const currentGroupName = `chart${currentGroupIndex}`;

            // リンクの抽出元は、物質ノードの場合は '次工程への引き継ぎ'、反応ノードの場合は '生成物' や '引き継ぎ番号'
            let linkText = d['次工程（表4）への引き継ぎ'] || d['引き継ぎ番号'] || d['生成物'];
            if (!originalNumber || !linkText) return;
            
            const cleanText = linkText.replace(/^"|"$/g, '').trim();
            
            // リンクの接続先を決定するためのノードリスト (同じ番号を持つ全てのノード)
            const currentNodes = nodes.filter(n => n.number === originalNumber);
            if (currentNodes.length === 0) return;
            
            const parts = cleanText.split(/,(?![^()]*\))|(?=[+-]?[MR]\d+[a-z]?)/g).map(p => p.trim()).filter(p => p);
            
            parts.forEach(part => {
                const isExtinct = part.startsWith('×');
                const actualPart = isExtinct ? part.substring(1) : part;

                const reactionMatch = actualPart.match(/([+-]?[MR]\d+[a-z]?)(?:\((.*?)\))?/);
                
                if (reactionMatch) {
                    // ケース 1: 反応 M1(A,B) or R1
                    const reactionIdNumber = reactionMatch[1].replace(/^[+-]/, '');
                    const sourceMaterials = reactionMatch[2] ? reactionMatch[2].split(',').map(s => s.trim()) : [];
                    
                    const reactionNodes = nodes.filter(n => n.number === reactionIdNumber);
                    
                    reactionNodes.forEach(reactionNode => {
                        currentNodes.forEach(currentNode => {
                            // Reaction to Product (Generated) - 物質の生成
                            if (reactionMatch[1].startsWith('+') || reactionMatch[1].match(/^[MR]\d/)) {
                                links.push({ source: reactionNode.id, target: currentNode.id, type: 'generated', isExtinct });
                            }
                            // Product to Reaction (Consumed) - 物質の消費（ここでは使わないが、双方向リンクのため維持）
                            // links.push({ source: currentNode.id, target: reactionNode.id, type: 'consumed', isExtinct });
                        });
                        
                        // Reactants to Reaction (Consumed) - 原料の消費
                        sourceMaterials.forEach(matId => {
                            const sourceNodes = nodes.filter(n => n.number === matId);
                            
                            sourceNodes.forEach(sourceNode => {
                                const sourceIsExtinct = sourceNode.isExtinct;
                                links.push({ source: sourceNode.id, target: reactionNode.id, type: 'consumed', isExtinct: sourceIsExtinct });
                            });
                        });
                    });
                } else if (actualPart.match(/^[0-9-]+$/)) {
                    // ケース 2: Direct Link (例: 3-1, 19)
                    const sourceNodes = nodes.filter(n => n.number === actualPart);
                    
                    sourceNodes.forEach(sourceNode => {
                        currentNodes.forEach(currentNode => {
                            links.push({ source: sourceNode.id, target: currentNode.id, type: 'direct', isExtinct });
                        });
                    });
                }
            });
        });
        
        // 重複リンクの排除
        const uniqueLinks = new Map();
        links.forEach(link => {
            const key = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
            if (!uniqueLinks.has(key)) {
                uniqueLinks.set(key, link);
            }
        });
        const finalLinks = Array.from(uniqueLinks.values());
        
        // --- 3. レイアウトと描画 ---
        
        const groupData = d3.groups(nodes, d => d.group);

        const totalHeight = groupData.length * groupSpacingY + 200;
        svg.attr("height", totalHeight).attr("width", width);
        chartGroup.attr("transform", `translate(${width / 2}, 50)`);

        // レイアウト計算
        groupData.forEach(([group, groupNodes], i) => {
            const center = { x: 0, y: i * groupSpacingY };
            if (groupNodes[0] && groupNodes[0].isProcess) {
                // プロセスノードは中心に縦に配置
                const nodeSpacing = 15;
                const totalHeight = groupNodes.length * nodeSpacing;
                groupNodes.forEach((node, j) => {
                    node.x = center.x;
                    node.y = center.y - (totalHeight / 2) + j * nodeSpacing;
                });
            } else {
                // 物質ノードは円形に配置
                const radius = 200;
                const textRadius = 140;
                const angleStep = 2 * Math.PI / groupNodes.length;
                
                groupNodes.forEach((node, j) => {
                    const angle = j * angleStep;
                    
                    node.textX = center.x + textRadius * Math.cos(angle);
                    node.textY = center.y + textRadius * Math.sin(angle);
                    
                    const totalTextLength = (node.name ? node.name.length : 0);
                    const textHalfLength = totalTextLength / 2 * charSpacing * 0.5; // 縦書き文字の幅を考慮
                    const pointOffsetFromText = 5 + circleRadius;
                    const circleRadiusFromCenter = textRadius + textHalfLength + pointOffsetFromText;
                    
                    node.circleX = center.x + circleRadiusFromCenter * Math.cos(angle);
                    node.circleY = center.y + circleRadiusFromCenter * Math.sin(angle);
                    
                    node.angle = angle;
                });
            }
        });

        // リンクの描画
        const linkElements = chartGroup.append("g")
            .attr("class", "links")
            .selectAll("path")
            .data(finalLinks)
            .enter().append("path")
            .attr("class", d => `link ${d.type} ${d.isExtinct ? 'extinct-link' : ''}`)
            .attr("d", d => {
                const sourceNode = nodeMap.get(d.source);
                const targetNode = nodeMap.get(d.target);
                if (!sourceNode || !targetNode) return;

                let sourceX, sourceY, targetX, targetY;

                // リンク始点の調整
                if (sourceNode.isProcess) {
                    const textLength = (sourceNode.name ? sourceNode.name.length : 0);
                    sourceX = sourceNode.x + (textLength * 5) / 2 + 5; // プロセスノードの右端から
                    sourceY = sourceNode.y;
                } else {
                    sourceX = sourceNode.circleX;
                    sourceY = sourceNode.circleY;
                }

                // リンク終点の調整
                if (targetNode.isProcess) {
                    const textLength = (targetNode.name ? targetNode.name.length : 0);
                    targetX = targetNode.x - (textLength * 5) / 2 - 5; // プロセスノードの左端へ
                    targetY = targetNode.y;
                } else {
                    targetX = targetNode.circleX;
                    targetY = targetNode.circleY;
                }
                
                const dx = targetX - sourceX;
                const dy = targetY - sourceY;

                const isSameGroup = sourceNode.group === targetNode.group;

                if (isSameGroup) {
                    // 同じグループ内のノード間のリンク (ほとんど発生しないはず)
                    return `M${sourceX},${sourceY} L${targetX},${targetY}`;
                } else {
                    // 異なるグループ間のリンク（湾曲したパス）
                    const ctlY = sourceY + dy / 3;
                    return `M${sourceX},${sourceY} C${sourceX},${ctlY} ${targetX},${ctlY} ${targetX},${targetY}`;
                }
            });

        // ノードグループの描画
        const nodeElements = chartGroup.selectAll(".node-group")
            .data(groupData)
            .enter().append("g")
            .attr("class", "node-group")
            .selectAll(".node")
            .data(d => d[1])
            .enter().append("g")
            .attr("class", d => `node ${d.isExtinct ? 'extinct-node' : ''}`) 
            .attr("id", d => d.id) 
            .attr("transform", d => d.isProcess ? `translate(${d.x},${d.y})` : null);

        nodeElements.each(function(d) {
            const nodeElement = d3.select(this);
            const nodeName = d.name || d.number;
            if (!nodeName) return;

            if (d.isProcess) {
                // プロセスノード (矩形)
                const textLength = nodeName.length;
                nodeElement.append("rect")
                    .attr("class", "node-click-area")
                    .attr("x", - (textLength * 6) / 2 - 10)
                    .attr("y", -12)
                    .attr("width", textLength * 6 + 20)
                    .attr("height", 24);

                nodeElement.append("text")
                    .attr("class", "chart-node-label")
                    .attr("x", 0)
                    .attr("y", 4)
                    .text(nodeName);
            } else {
                // 物質ノード (円形)
                
                // クリック可能な透明な領域
                nodeElement.append("circle")
                    .attr("class", "node-click-area")
                    .attr("cx", d => d.circleX)
                    .attr("cy", d => d.circleY)
                    .attr("r", 20);

                if (d.isExtinct) {
                    // 消滅ノードのX印
                    nodeElement.append("text")
                        .attr("class", "extinct-x")
                        .attr("x", d => d.circleX)
                        .attr("y", d => d.circleY + 4)
                        .text("×");
                } else {
                    // 通常ノードの円
                    nodeElement.append("circle")
                        .attr("class", "node-circle")
                        .attr("r", circleRadius)
                        .attr("fill", d => groupColors[d.group])
                        .attr("cx", d => d.circleX)
                        .attr("cy", d => d.circleY);
                }
                
                // ノード名（縦書き風に表示）
                const nodeText = nodeName;
                const angle = d.angle;
                const textElement = nodeElement.append("text")
                    .attr("class", "node-label")
                    .attr("text-anchor", "middle")
                    .attr("transform", `translate(${d.textX}, ${d.textY}) rotate(${angle * 180 / Math.PI + 90})`);
                    
                const totalHeight = (nodeText.length > 0 ? nodeText.length - 1 : 0) * charSpacing;
                const startY = -totalHeight / 2;

                for (let i = 0; i < nodeText.length; i++) {
                    textElement.append("tspan")
                        .attr("x", 0)
                        .attr("y", startY + i * charSpacing)
                        .text(nodeText[i]);
                }
            }
        });

        // グループラベルの描画
        chartGroup.selectAll(".group-label")
            .data(groupData)
            .enter().append("text")
            .attr("class", "group-label")
            .attr("x", 0)
            .attr("y", (d, i) => i * groupSpacingY - 160) // 各グループの中心より上に配置
            .text(d => groupLabels[d[0]]);

        // --- 4. クリックイベント処理 (全経路追跡ロジック) ---
        
        d3.selectAll(".node")
            .on("mouseover", (event, d) => {
                // ツールチップ表示
                tooltip.style("opacity", 1)
                    .html(`<strong>${d.name}</strong><br>番号: ${d.number}${d.isExtinct ? '<br>***消滅***' : ''}<br><span style="font-size: 8px;">ID: ${d.id}</span>`)
                    .style("left", (event.pageX + 10) + "px")
                    .style("top", (event.pageY - 20) + "px");
            })
            .on("mouseout", () => {
                // ツールチップ非表示
                tooltip.style("opacity", 0);
            })
            .on("click", (event, d) => {
                const isAlreadyHighlighted = d3.select(event.currentTarget).classed("highlight-node");

                // ハイライトのリセット
                d3.selectAll(".node").classed("faded", false).classed("highlight-node", false);
                d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false);

                if (!isAlreadyHighlighted) {
                    const relatedNodeIds = new Set();
                    const relatedLinkKeys = new Set();
                    
                    // クリックされたノードから両方向に全経路を探索する関数 (BFSを使用)
                    const exploreAllPaths = (startNodeId) => {
                        const nodeQueue = [startNodeId];
                        const visited = new Set();
                        
                        while (nodeQueue.length > 0) {
                            const nodeId = nodeQueue.shift();
                            if (visited.has(nodeId)) continue;
                            visited.add(nodeId);
                            relatedNodeIds.add(nodeId);

                            // 1. 下流 (forward) へのリンクを探索
                            finalLinks.filter(link => link.source === nodeId).forEach(link => {
                                const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                                relatedLinkKeys.add(linkKey);
                                if (!visited.has(link.target)) {
                                    nodeQueue.push(link.target);
                                }
                            });

                            // 2. 上流 (backward) へのリンクを探索
                            finalLinks.filter(link => link.target === nodeId).forEach(link => {
                                const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                                relatedLinkKeys.add(linkKey);
                                if (!visited.has(link.source)) {
                                    nodeQueue.push(link.source);
                                }
                            });
                        }
                    };

                    // 全経路探索を実行
                    exploreAllPaths(d.id);

                    // ノードのハイライト/フェード
                    d3.selectAll(".node").classed("faded", node => !relatedNodeIds.has(node.id));
                    d3.select(event.currentTarget).classed("highlight-node", true);
                    d3.selectAll(".node").filter(node => relatedNodeIds.has(node.id) && node.id !== d.id).classed("highlight-node", true);
                    
                    // リンクのハイライト/クラス分け
                    linkElements.classed("faded", link => !relatedLinkKeys.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`));
                    
                    linkElements.filter(link => relatedLinkKeys.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`))
                        .classed("highlight-link", true)
                        .classed("generated", link => link.type === "generated" && !link.isExtinct)
                        .classed("consumed", link => link.type === "consumed" && !link.isExtinct)
                        .classed("direct", link => link.type === "direct" && !link.isExtinct)
                        .classed("extinct-link", link => link.isExtinct); 
                }
            });
        
        // グラフ外をクリックした際のリセット処理
        d3.select("body").on("click", function(event) {
            if (!event.target.closest(".node")) {
                d3.selectAll(".node").classed("faded", false).classed("highlight-node", false);
                d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false);
            }
        });

    }).catch(error => {
    console.error("D3.jsの処理中に予期せぬエラーが発生しました。", error);
    });
