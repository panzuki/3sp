const width = 1200;
        const groupSpacingY = 350;
        const charSpacing = 8;
        const circleRadius = 8;

        const svg = d3.select("#chart");
        const chartGroup = svg.append("g");
        const tooltip = d3.select("body").append("div")
            .attr("class", "tooltip");

        const groupLabels = {
            'chart1': '原材料',
            'chart2': 'ミキシング (反応)',
            'chart3': 'ミキシング後 (物質)',
            'chart4': '発酵 (反応)',
            'chart5': '発酵後 (物質)',
        };
        const groupColors = {
            'chart1': '#a8e6cf', 
            'chart2': '#ff8b94', 
            'chart3': '#dcedc1', 
            'chart4': '#b59fff', 
            'chart5': '#ffe3b5', 
        };
        
        const fileNames = Object.keys(groupLabels).map(key => `csv/${key}.csv`);
        const processGroups = new Set(['chart2', 'chart4', 'chart6', 'chart8', 'chart10']);

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
                
                const isProcess = processGroups.has(groupName);

                // IDはグループ名と元の番号のみで生成 (ユニークを前提とする)
                const id = `${groupName}-${d.番号}`;

                const name = d['物質名'] || d['反応名'] || d['構成物質名'] || d.番号;
                if (!name) return;
                
                // 消滅ノードの判定
                const isExtinct = (groupIndex % 2 === 1 && groupIndex > 1) 
                                  ? (d.番号 && allData.some(item => 
                                        item.引き継ぎ番号 && 
                                        // ×が元の番号の直前に付いている場合をチェック
                                        item.引き継ぎ番号.includes(`×${d.番号}`)
                                    ))
                                  : false;

                const node = { id, name, group: groupName, number: d.番号, isProcess, isExtinct, data: d };
                nodes.push(node);
                nodeMap.set(id, node);
            });
            
            // リンクの生成
            allData.forEach(d => {
                const originalNumber = d.番号;
                if (!originalNumber || !d.引き継ぎ番号) return;
                const groupIndex = validDatasets.findIndex(dataset => dataset.includes(d)) + 1;
                const groupName = `chart${groupIndex}`;
                
                const currentNodeId = `${groupName}-${originalNumber}`;
                const currentNode = nodeMap.get(currentNodeId);
                if (!currentNode) return;
                
                const cleanText = d.引き継ぎ番号.replace(/^"|"$/g, '');
                
                // 💡 修正ポイント: リンクテキストを符号(+,-,×)の直前で分割する正規表現を強化
                const parts = cleanText.split(/,(?=[+-M×R])|(?=[+-]M\d)|(?=×R\d)|(?=,)|(?=,R\d)/g)
                    .map(p => p.trim())
                    .filter(p => p && p !== ','); // ','だけの要素は除く

                parts.forEach(part => {
                    let symbol = '+'; // デフォルトは生成
                    let actualPart = part;
                    let isExtinct = false;
                    let linkType = 'generated'; // デフォルト

                    // 符号と×の検出
                    if (part.startsWith('×')) {
                        isExtinct = true;
                        actualPart = part.substring(1);
                        linkType = 'extinct-link'; // 消滅リンク専用のタイプ
                    } else if (part.startsWith('-')) {
                        symbol = '-';
                        actualPart = part.substring(1);
                        linkType = 'consumed'; // 消費
                    } else if (part.startsWith('+')) {
                        symbol = '+';
                        actualPart = part.substring(1);
                        linkType = 'generated'; // 生成
                    }

                    // 数字で始まる場合は、直リンク（物質から物質）
                    if (actualPart.match(/^\d/)) {
                         linkType = 'direct';
                    }
                    
                    const reactionMatch = actualPart.match(/([+-]?[MR]\d+[a-z]?)(?:\((.*?)\))?/);

                    if (reactionMatch) {
                        const reactionIdNumber = reactionMatch[1].replace(/^[+-]/, ''); // 符号を除去
                        const sourceMaterials = reactionMatch[2] ? reactionMatch[2].split(',').map(s => s.trim()).filter(s => s) : [];
                        
                        const reactionGroupName = `chart${groupIndex - 1}`;
                        const reactionNodeId = `${reactionGroupName}-${reactionIdNumber}`;
                        const reactionNode = nodeMap.get(reactionNodeId);
                        
                        if (reactionNode) {
                            // Reaction to Product: ターゲット(currentNode)が生成/消費されるリンク
                            // linkTypeはcurrentNodeの引き継ぎ番号の符号によって決まる
                            links.push({ source: reactionNode.id, target: currentNode.id, type: linkType, isExtinct });
                            
                            // Reactants to Reaction: 反応物(sourceMaterials)が消費されるリンク
                            sourceMaterials.forEach(matId => {
                                const sourceGroupName = `chart${groupIndex - 2}`;
                                const sourceNodeId = `${sourceGroupName}-${matId}`;
                                const sourceNode = nodeMap.get(sourceNodeId);
                                
                                if (sourceNode) {
                                    // 反応物から反応へのリンクは常に 'consumed' または 'extinct'
                                    const isConsumedOrExtinct = sourceNode.isExtinct;
                                    links.push({ 
                                        source: sourceNode.id, 
                                        target: reactionNode.id, 
                                        type: isConsumedOrExtinct ? 'extinct-link' : 'consumed', 
                                        isExtinct: isConsumedOrExtinct 
                                    });
                                }
                            });
                        }
                    } else if (actualPart.match(/^(\d+[a-z]?)$/)) {
                        // Direct Link (反応を通さない物質間移動)
                        // リンクタイプはcurrentNodeの引き継ぎ番号の符号によって決まる
                        const sourceGroupName = `chart${groupIndex - 2}`; 
                        const sourceNodeId = `${sourceGroupName}-${actualPart}`;
                        const sourceNode = nodeMap.get(sourceNodeId);
                        
                        if (sourceNode) {
                             links.push({ source: sourceNode.id, target: currentNode.id, type: linkType, isExtinct });
                        }
                    }
                });
            });
            
            // リンクの重複排除
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

            const totalHeight = groupData.length * groupSpacingY + 200;
            svg.attr("height", totalHeight).attr("width", width);
            chartGroup.attr("transform", `translate(${width / 2}, 50)`);

            // ノードの座標計算 (変更なし)
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
                            if (relatedNodeIds.has(nodeId) && !isInitialCall) {
                                return;
                            }
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
                            // 化学反応ノードの場合、インプットとアウトプットのみをハイライト
                            finalLinks.forEach(link => {
                                if (link.source === d.id) { // 生成物
                                    relatedLinkIds.add(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`);
                                    relatedNodeIds.add(link.target);
                                }
                                if (link.target === d.id) { // 消費物
                                    relatedLinkIds.add(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`);
                                    relatedNodeIds.add(link.source);
                                }
                            });
                        } else {
                            // 物質ノードの場合
                            const chartNum = parseInt(d.group.replace('chart', ''));
                            
                            if (chartNum === 1) {
                                findPath(d.id, 'forward');
                            } else if (chartNum % 2 === 1 && chartNum > 1) {
                                findPath(d.id, 'backward');
                            }
                        }

                        d3.selectAll(".node").classed("faded", node => !relatedNodeIds.has(node.id));
                        d3.select(event.currentTarget).classed("highlight-node", true);
                        d3.selectAll(".node").filter(node => relatedNodeIds.has(node.id) && node.id !== d.id).classed("highlight-node", true);
                        
                        linkElements.classed("faded", link => !relatedLinkIds.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`));
                        
                        linkElements.filter(link => relatedLinkIds.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`))
                            .classed("highlight-link", true)
                            // 💡 修正ポイント: link.typeが'consumed'の場合は水色
                            .classed("generated", link => link.type === "generated")
                            .classed("consumed", link => link.type === "consumed")
                            .classed("direct", link => link.type === "direct")
                            .classed("extinct-link", link => link.type === "extinct-link"); 
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
         
