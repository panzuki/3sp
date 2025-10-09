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
    
    const uniqueIdCounters = new Map();
    
    allData.forEach(d => {
        if (!d.番号) return;
        const groupIndex = validDatasets.findIndex(dataset => dataset.includes(d)) + 1;
        const groupName = `chart${groupIndex}`;
        
        const isProcess = processGroups.has(groupName);

        let id;
        if (isProcess && groupName === 'chart4' && d.番号.match(/^R\d+$/)) {
            id = `${groupName}-${d.番号}`;
        } else if (isProcess && groupName === 'chart2' && d.番号.match(/^M\d+$/)) {
            id = `${groupName}-${d.番号}`;
        } 
        else {
            const key = `${groupName}-${d.番号}`;
            const count = uniqueIdCounters.get(key) || 0;
            id = `${key}-${count}`;
            uniqueIdCounters.set(key, count + 1);
        }

        const name = d['物質名'] || d['反応名'] || d['構成物質名'] || d.番号;
        if (!name) return;
        
        const isExtinct = (groupIndex % 2 === 1 && groupIndex > 1) 
                          ? ( (d.次工程への引き継ぎ && d.次工程への引き継ぎ.includes('×')) || 
                              (d.引き継ぎ番号 && d.引き継ぎ番号.trim().startsWith('×'))    
                            )
                          : false;

        const isNew = (groupIndex % 2 === 1 && groupIndex > 1) 
                      ? (d.引き継ぎ番号 && (d.引き継ぎ番号.match(/^\+?[MR]\d+/)))
                      : false;

        const node = { id, name, group: groupName, number: d.番号, isProcess, isExtinct, isNew, data: d };
        nodes.push(node);
        nodeMap.set(id, node);
    });
    
    allData.forEach(d => {
        const originalNumber = d.番号;
        
        let linkText = d['次工程（表4）への引き継ぎ'] || d['引き継ぎ番号'] || d['生成物'];
        if (!originalNumber || !linkText) return;

        const cleanText = linkText.replace(/^"|"$/g, '').trim();
        
        const currentNodes = nodes.filter(n => n.number === originalNumber);
        if (currentNodes.length === 0) return;
        
        const parts = cleanText.split(/,(?![^()]*\))|(?=[+-]?[MR]\d+[a-z]?)/g).map(p => p.trim()).filter(p => p);
        
        parts.forEach(part => {
            const isExtinct = part.startsWith('×');
            const actualPart = isExtinct ? part.substring(1) : part;

            const reactionMatch = actualPart.match(/([+-]?[MR]\d+[a-z]?)(?:\((.*?)\))?/);
            if (reactionMatch) {
                const reactionIdNumber = reactionMatch[1].replace(/^[+-]/, '');
                const sourceMaterials = reactionMatch[2] ? reactionMatch[2].split(',').map(s => s.trim()) : [];
                
                const reactionNodes = nodes.filter(n => n.number === reactionIdNumber);
                
                reactionNodes.forEach(reactionNode => {
                    currentNodes.forEach(currentNode => {
                        if (reactionMatch[1].startsWith('+') || reactionMatch[1].match(/^[MR]\d/)) {
                            links.push({ source: reactionNode.id, target: currentNode.id, type: 'generated', isExtinct });
                        }
                    });
                    
                    sourceMaterials.forEach(matId => {
                        const sourceNodes = nodes.filter(n => n.number === matId);
                        
                        sourceNodes.forEach(sourceNode => {
                            const sourceIsExtinct = sourceNode.isExtinct;
                            links.push({ source: sourceNode.id, target: reactionNode.id, type: 'consumed', isExtinct: sourceIsExtinct });
                        });
                    });
                });
            } else if (actualPart.match(/^[0-9-]+$/)) {
                const sourceNodes = nodes.filter(n => n.number === actualPart);
                
                sourceNodes.forEach(sourceNode => {
                    currentNodes.forEach(currentNode => {
                        links.push({ source: sourceNode.id, target: currentNode.id, type: 'direct', isExtinct });
                    });
                });
            }
        });
    });
    
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
                const textHalfLength = totalTextLength / 2 * charSpacing * 0.5;
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
                sourceX = sourceNode.x + (textLength * 5) / 2 + 5;
                sourceY = sourceNode.y;
            } else {
                sourceX = sourceNode.circleX;
                sourceY = sourceNode.circleY;
            }

            if (targetNode.isProcess) {
                const textLength = (targetNode.name ? targetNode.name.length : 0);
                targetX = targetNode.x - (textLength * 5) / 2 - 5;
                targetY = targetNode.y;
            } else {
                targetX = targetNode.circleX;
                targetY = targetNode.circleY;
            }
            
            const dx = targetX - sourceX;
            const dy = targetY - sourceY;

            const isSameGroup = sourceNode.group === targetNode.group;

            if (isSameGroup) {
                 return `M${sourceX},${sourceY} L${targetX},${targetY}`;
            } else {
                const ctlY = sourceY + dy / 3;
                return `M${sourceX},${sourceY} C${sourceX},${ctlY} ${targetX},${ctlY} ${targetX},${targetY}`;
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
            
            nodeElement.append("circle")
                .attr("class", "node-click-area")
                .attr("cx", d => d.circleX)
                .attr("cy", d => d.circleY)
                .attr("r", 20);

            if (d.isExtinct) {
                nodeElement.append("text")
                    .attr("class", "extinct-x")
                    .attr("x", d => d.circleX)
                    .attr("y", d => d.circleY + 4)
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
        .attr("y", (d, i) => i * groupSpacingY - 160)
        .text(d => groupLabels[d[0]]);

    d3.selectAll(".node")
        .on("mouseover", (event, d) => {
            tooltip.style("opacity", 1)
                .html(`<strong>${d.name}</strong><br>番号: ${d.number}${d.isExtinct ? '<br>***消滅***' : ''}${d.isNew ? '<br>***新規生成***' : ''}<br><span style="font-size: 8px;">ID: ${d.id}</span>`)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 20) + "px");
        })
        .on("mouseout", () => {
            tooltip.style("opacity", 0);
        })
        .on("click", (event, d) => {
            const isAlreadyHighlighted = d3.select(event.currentTarget).classed("highlight-node") || d3.select(event.currentTarget).classed("highlight-extinct-node");

            d3.selectAll(".node").classed("faded", false).classed("highlight-node", false).classed("highlight-extinct-node", false).classed("highlight-text-new", false).classed("highlight-text-extinct", false);
            d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false).classed("highlight-extinct-link", false).classed("highlight-extinct-consumed", false);
            d3.selectAll(".extinct-x").style("font-size", "12px");
            tooltip.style("opacity", 0);

            if (!isAlreadyHighlighted) {
                const relatedNodeIds = new Set();
                const relatedLinkKeys = new Set();
                
                relatedNodeIds.add(d.id);
                
                const findPath = (nodeId, direction, isInitialCall = true) => {
                    if (relatedNodeIds.has(nodeId) && !isInitialCall) {
                        return;
                    }
                    relatedNodeIds.add(nodeId);

                     if (direction === 'forward') {
                        finalLinks.filter(link => link.source === nodeId).forEach(link => {
                            const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                            relatedLinkKeys.add(linkKey);
                            findPath(link.target, 'forward', false);
                        });
                    } else if (direction === 'backward') {
                        finalLinks.filter(link => link.target === nodeId).forEach(link => {
                            const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                            relatedLinkKeys.add(linkKey);
                            findPath(link.source, 'backward', false);
                        });
                    }
                };
                
                if (d.isProcess) {
                    finalLinks.forEach(link => {
                        if (link.source === d.id) {
                            relatedLinkKeys.add(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`);
                            relatedNodeIds.add(link.target);
                        }
                        if (link.target === d.id) {
                            relatedLinkKeys.add(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`);
                            relatedNodeIds.add(link.source);
                        }
                    });
                } else {
                    const chartNum = parseInt(d.group.replace('chart', ''));
                    
                    if (chartNum === 1 || chartNum === 3) {
                        findPath(d.id, 'forward');
                        findPath(d.id, 'backward'); 
                    } else if (chartNum % 2 === 1 && chartNum > 1) {
                        findPath(d.id, 'backward');
                        finalLinks.filter(link => link.source === d.id).forEach(link => {
                            const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                            relatedLinkKeys.add(linkKey);
                            relatedNodeIds.add(link.target);
                        });
                    }
                }

                d3.selectAll(".node").classed("faded", node => !relatedNodeIds.has(node.id));
                
                d3.selectAll(".node").filter(node => relatedNodeIds.has(node.id))
                    .each(function(node) {
                        const element = d3.select(this);
                        
                        if (node.isExtinct) {
                            element.classed("highlight-extinct-node", true)
                                   .classed("highlight-text-extinct", true);
                            element.select(".extinct-x").text("×").style("font-size", "18px");
                        } else if (node.isNew) {
                            element.classed("highlight-node", true)
                                   .classed("highlight-text-new", true);
                        } else {
                            element.classed("highlight-node", true);
                        }
                    });
                
                linkElements.classed("faded", link => !relatedLinkKeys.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`));
                
                linkElements.filter(link => relatedLinkKeys.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`))
                    .classed("highlight-link", true)
                    .classed("highlight-extinct-link", link => link.isExtinct && link.type === "generated")
                    .classed("highlight-extinct-consumed", link => link.isExtinct && (link.type === "consumed" || link.type === "direct")) 
                    
                    .classed("generated", link => link.type === "generated" && !link.isExtinct)
                    .classed("consumed", link => link.type === "consumed" && !link.isExtinct)
                    .classed("direct", link => link.type === "direct" && !link.isExtinct);              


                
                tooltip.style("opacity", 1)
                    .html(`<strong>${d.name}</strong><br>番号: ${d.number}${d.isExtinct ? '<br>***消滅***' : ''}${d.isNew ? '<br>***新規生成***' : ''}<br><span style="font-size: 8px;">ID: ${d.id}</span>`)
                    .style("left", (event.pageX + 10) + "px")
                    .style("top", (event.pageY - 20) + "px");
            }
        });
    
    d3.select("body").on("click", function(event) {
        if (!event.target.closest(".node")) {
            d3.selectAll(".node").classed("faded", false).classed("highlight-node", false).classed("highlight-extinct-node", false).classed("highlight-text-new", false).classed("highlight-text-extinct", false);
            d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false).classed("highlight-extinct-link", false).classed("highlight-extinct-consumed", false);
            d3.selectAll(".extinct-x").style("font-size", "12px");
            tooltip.style("opacity", 0);
        }
    });

}).catch(error => {
console.error("D3.jsの処理中に予期せぬエラーが発生しました。", error);
});
