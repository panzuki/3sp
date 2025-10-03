const width = 1200;
const groupSpacingY = 350;
const charSpacing = 8;
const circleRadius = 8;

const svg = d3.select("#chart");
const chartGroup = svg.append("g");
// ツールチップのセレクションを簡略化（HTMLに存在すると仮定）
const tooltip = d3.select("body").select(".tooltip") || d3.select("body").append("div").attr("class", "tooltip");

const groupLabels = {
    'chart1': '原材料',
    'chart2': 'ミキシング (反応)',
    'chart3': 'ミキシング後 (物質)',
    'chart4': '発酵 (反応)',
    'chart5': '発酵後 (物質'),
};
const groupColors = {
    'chart1': '#a8e6cf', 
    'chart2': '#ff8b94', 
    'chart3': '#dcedc1', 
    'chart4': '#b59fff', 
    'chart5': '#ffe3b5', 
};

const fileNames = Object.keys(groupLabels).map(key => `csv/${key}.csv`);
const processGroups = new Set(['chart2', 'chart4']);

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
    
    // ノードの生成とデータマップの構築
    allData.forEach(d => {
        if (!d.番号) return;
        const groupIndex = validDatasets.findIndex(dataset => dataset.includes(d)) + 1;
        const groupName = `chart${groupIndex}`;
        const id = `${groupName}-${d.番号}`;
        const isProcess = processGroups.has(groupName);

        const name = d['物質名'] || d['反応名'] || d['構成物質名'] || d.番号;
        if (!name) return;
        
        // 消滅ノードの判定（ロジック維持）
        const isExtinct = (groupIndex % 2 === 1 && groupIndex > 1) 
                          ? (d.番号 && allData.some(item => 
                                item.引き継ぎ番号 && item.引き継ぎ番号.includes(`×${d.番号}`)
                            ))
                          : false;

        const node = { id, name, group: groupName, number: d.番号, isProcess, isExtinct, data: d, groupIndex };
        nodes.push(node);
        nodeMap.set(id, node);
    });
    
    // リンクの生成
    allData.forEach(d => {
        const groupIndex = validDatasets.findIndex(dataset => dataset.includes(d)) + 1;
        const groupName = `chart${groupIndex}`;
        const currentNodeId = `${groupName}-${d.番号}`;
        const currentNode = nodeMap.get(currentNodeId);
        if (!currentNode || !d.引き継ぎ番号) return;
        
        const cleanText = d.引き継ぎ番号.replace(/^"|"$/g, '');
        // 正規表現を簡潔化し、符号の前に分割する
        const parts = cleanText.split(/(?=[+\-×]?[MR]?\d+[a-z]?)/g).map(p => p.trim()).filter(p => p && p !== ',');

        parts.forEach(part => {
            let actualPart = part.replace(/^[+\-×]/, '');
            let isExtinct = part.startsWith('×');
            let linkType = part.startsWith('-') ? 'consumed' : (part.startsWith('+') ? 'generated' : 'direct');

            const reactionMatch = actualPart.match(/([MR]\d+[a-z]?)(?:\((.*?)\))?/);
            
            if (reactionMatch) {
                // Reaction Link
                const reactionIdNumber = reactionMatch[1]; 
                const sourceMaterials = reactionMatch[2] ? reactionMatch[2].split(',').map(s => s.trim()).filter(s => s) : [];
                
                const reactionGroupName = `chart${groupIndex - 1}`;
                const reactionNodeId = `${reactionGroupName}-${reactionIdNumber}`;
                const reactionNode = nodeMap.get(reactionNodeId);
                
                if (reactionNode) {
                    // Reaction to Product
                    links.push({ source: reactionNode.id, target: currentNode.id, type: 'generated', isExtinct });
                    
                    // Reactants to Reaction
                    sourceMaterials.forEach(matId => {
                        const sourceGroupName = `chart${groupIndex - 2}`;
                        const sourceNodeId = `${sourceGroupName}-${matId}`;
                        const sourceNode = nodeMap.get(sourceNodeId);
                        
                        if (sourceNode) {
                            const type = sourceNode.isExtinct ? 'extinct-link' : 'consumed';
                            links.push({ source: sourceNode.id, target: reactionNode.id, type: type, isExtinct: sourceNode.isExtinct });
                        }
                    });
                }
            } else if (actualPart.match(/^(\d+[a-z]?)$/)) {
                // Direct Link
                const sourceNumber = actualPart;
                const sourceGroupName = `chart${groupIndex - 2}`;
                const sourceNodeId = `${sourceGroupName}-${sourceNumber}`;
                const sourceNode = nodeMap.get(sourceNodeId);
                
                if (sourceNode) {
                    // Direct link type の設定 (consumed/extinct-link を優先)
                    let finalType = linkType === 'direct' ? 'direct' : (isExtinct ? 'extinct-link' : linkType);
                    links.push({ source: sourceNode.id, target: currentNode.id, type: finalType, isExtinct });
                }
            }
        });
    });
    
    // リンクの重複排除 (ロジック維持)
    const uniqueLinks = new Map();
    links.forEach(link => {
        const key = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
        if (!uniqueLinks.has(key)) {
            uniqueLinks.set(key, link);
        }
    });
    const finalLinks = Array.from(uniqueLinks.values());
    
    const groupData = d3.groups(nodes, d => d.group);

    if (groupData.length === 0) {
        console.error("有効なデータからグループが生成されませんでした。");
        return;
    }

    // 座標計算と描画ロジックは変更なし (省略していましたが、最終コードには含めます)
    const totalHeight = groupData.length * groupSpacingY + 200;
    svg.attr("height", totalHeight).attr("width", width);
    chartGroup.attr("transform", `translate(${width / 2}, 50)`);

    groupData.forEach(([group, groupNodes], i) => {
        const center = { x: 0, y: i * groupSpacingY };
        if (groupNodes[0] && groupNodes[0].isProcess) {
            const nodeSpacing = 15;
            const totalHeight = groupNodes.length * nodeSpacing;
            groupNodes.forEach((node, j) => {
                node.x = center.x;
                node.y = center.y - (totalHeight / 2) + j * nodeSpacing;
            });
        } else {
            const radius = 200;
            const textRadius = 140;
            const angleStep = 2 * Math.PI / groupNodes.length;
            
            groupNodes.forEach((node, j) => {
                const angle = j * angleStep;
                
                node.textX = center.x + textRadius * Math.cos(angle);
                node.textY = center.y + textRadius * Math.sin(angle);
                
                const totalTextLength = (node.name ? node.name.length : 0);
                const textHalfLength = totalTextLength / 2 * charSpacing;
                const pointOffsetFromText = 5 + circleRadius;
                const circleRadiusFromCenter = textRadius + textHalfLength + pointOffsetFromText;
                
                node.circleX = center.x + circleRadiusFromCenter * Math.cos(angle);
                node.circleY = center.y + circleRadiusFromCenter * Math.sin(angle);
                
                node.angle = angle;
            });
        }
    });

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

            if (sourceNode.isProcess) {
                const textLength = (sourceNode.name ? sourceNode.name.length : 0);
                sourceX = sourceNode.x + (textLength * 5) / 2;
                sourceY = sourceNode.y;
            } else {
                sourceX = sourceNode.circleX;
                sourceY = sourceNode.circleY;
            }

            if (targetNode.isProcess) {
                const textLength = (targetNode.name ? targetNode.name.length : 0);
                targetX = targetNode.x - (textLength * 5) / 2;
                targetY = targetNode.y;
            } else {
                targetX = targetNode.circleX;
                targetY = targetNode.circleY;
            }
            
            const dx = targetX - sourceX;
            const dy = targetY - sourceY;

            const isClose = Math.sqrt(dx * dx + dy * dy) < 100;

            if (isClose) {
                return `M${sourceX},${sourceY} L${targetX},${targetY}`;
            } else {
                return `M${sourceX},${sourceY}
                        C${sourceX + dx / 2},${sourceY}
                         ${targetX - dx / 2},${targetY}
                         ${targetX},${targetY}`;
            }
        });

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
            const textLength = nodeName.length;
            nodeElement.append("rect")
                .attr("class", "node-click-area")
                .attr("x", - (textLength * 5) / 2 - 10)
                .attr("y", -10)
                .attr("width", textLength * 5 + 20)
                .attr("height", 20);

            nodeElement.append("text")
                .attr("class", "chart-node-label")
                .attr("x", 0)
                .attr("y", 0)
                .text(nodeName);
        } else {
            nodeElement.append("circle")
                .attr("class", "node-click-area")
                .attr("cx", d => d.circleX)
                .attr("cy", d => d.circleY)
                .attr("r", 20);

            if (d.isExtinct) {
                nodeElement.append("text")
                    .attr("class", "extinct-x")
                    .attr("x", d => d.circleX)
                    .attr("y", d => d.circleY)
                    .text("×");
            } else {
                nodeElement.append("circle")
                    .attr("class", "node-circle")
                    .attr("r", circleRadius)
                    .attr("fill", d => groupColors[d.group])
                    .attr("cx", d => d.circleX)
                    .attr("cy", d => d.circleY);
            }
            
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

    chartGroup.selectAll(".group-label")
        .data(groupData)
        .enter().append("text")
        .attr("class", "group-label")
        .attr("x", 0)
        .attr("y", d => d[1].length > 0 ? d[1][0].y - 150 : 0) 
        .text(d => groupLabels[d[0]]);

    // 💡 ハイライトとインタラクション処理
    d3.selectAll(".node")
        .on("mouseover", (event, d) => {
            tooltip.style("opacity", 1)
                .html(`<strong>${d.name}</strong><br>番号: ${d.number}${d.isExtinct ? '<br>***消滅***' : ''}<br><span style="font-size: 8px;">ID: ${d.id}</span>`)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 20) + "px");
        })
        .on("mouseout", () => {
            tooltip.style("opacity", 0);
        })
        .on("click", (event, d) => {
            const isAlreadyHighlighted = d3.select(event.currentTarget).classed("highlight-node");

            d3.selectAll(".node").classed("faded", false).classed("highlight-node", false);
            d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false);

            if (!isAlreadyHighlighted) {
                const relatedNodeIds = new Set();
                const relatedLinkIds = new Set();
                
                relatedNodeIds.add(d.id);
                
                const findPath = (nodeId, direction, isInitialCall = true) => {
                    if (relatedNodeIds.has(nodeId) && !isInitialCall) return;
                    relatedNodeIds.add(nodeId);

                     if (direction === 'forward') {
                        finalLinks.filter(link => link.source === nodeId).forEach(link => {
                            const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                            relatedLinkIds.add(linkKey);
                            findPath(link.target, 'forward', false);
                        });
                    } else if (direction === 'backward') {
                        finalLinks.filter(link => link.target === nodeId).forEach(link => {
                            const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                            relatedLinkIds.add(linkKey);
                            findPath(link.source, 'backward', false);
                        });
                    }
                };
                
                if (d.isProcess) {
                    finalLinks.forEach(link => {
                        if (link.source === d.id) { 
                            relatedLinkIds.add(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`);
                            relatedNodeIds.add(link.target);
                        }
                        if (link.target === d.id) { 
                            relatedLinkIds.add(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`);
                            relatedNodeIds.add(link.source);
                        }
                    });
                } else {
                    findPath(d.id, 'forward');
                    findPath(d.id, 'backward');
                }

                d3.selectAll(".node").classed("faded", node => !relatedNodeIds.has(node.id));
                d3.select(event.currentTarget).classed("highlight-node", true);
                d3.selectAll(".node").filter(node => relatedNodeIds.has(node.id) && node.id !== d.id).classed("highlight-node", true);
                
                linkElements.classed("faded", link => !relatedLinkIds.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`));
                
                linkElements.filter(link => relatedLinkIds.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`))
                    .classed("highlight-link", true)
                    .classed("generated", link => link.type === "generated" && !link.isExtinct)
                    .classed("consumed", link => link.type === "consumed" && !link.isExtinct)
                    .classed("direct", link => link.type === "direct" && !link.isExtinct)
                    .classed("extinct-link", link => link.isExtinct); 
            }
        });
    
    d3.select("body").on("click", function(event) {
        if (!event.target.closest(".node")) {
            d3.selectAll(".node").classed("faded", false).classed("highlight-node", false);
            d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false);
        }
    });

}).catch(error => {
    console.error("D3.jsの処理中に予期せぬエラーが発生しました。", error);
});
