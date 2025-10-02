const width = 1200;
const groupSpacingY = 350;
const charSpacing = 8;
const circleRadius = 8;

const svg = d3.select("#chart");
const chartGroup = svg.append("g");
const tooltip = d3.select("body").select(".tooltip");

const groupLabels = {
    'chart1': '原材料',
    'chart2': 'ミキシング (反応)',
    'chart3': 'ミキシング後 (物質)',
    'chart4': '発酵 (反応)',
    'chart5': '発酵後 (物質)',
    // 必要に応じて、chart6 以降を追加してください
};
const groupColors = {
    'chart1': '#a8e6cf', 
    'chart2': '#ff8b94', 
    'chart3': '#dcedc1', 
    'chart4': '#b59fff', 
    'chart5': '#ffe3b5', 
    // 必要に応じて、chart6 以降の色を追加してください
};

const fileNames = Object.keys(groupLabels).map(key => `csv/${key}.csv`);
// 反応グループ（偶数番号）を指定
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

        // IDはグループ名と元の番号のみで生成 (元の表の番号がユニークであることを前提とする)
        const id = `${groupName}-${d.番号}`;

        const name = d['物質名'] || d['反応名'] || d['構成物質名'] || d.番号;
        if (!name) return;
        
        // 消滅ノードの判定（物質グループで、引き継ぎ番号に自分の番号が「×」付きで含まれていたら消滅）
        const isExtinct = (groupIndex % 2 === 1 && groupIndex > 1) 
                          ? (d.番号 && allData.some(item => 
                                item.引き継ぎ番号 && 
                                // Chart Indexが自分より2つ大きいグループ（次の物質グループ）のデータ行をチェック
                                validDatasets.findIndex(dataset => dataset.includes(item)) + 1 === groupIndex + 2 &&
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
        
        // リンクテキストを符号(+,-,×)の直前で分割する正規表現
        const parts = cleanText.split(/,(?=[+-]?\d+[a-z]?|[+-]?[MR]\d+[a-z]?)|(?=×\d+[a-z]?)|(?=×[MR]\d+[a-z]?)/g)
            .map(p => p.trim())
            .filter(p => p && p !== ',');

        parts.forEach(part => {
            let actualPart = part;
            let isExtinct = false;
            let linkType = 'generated'; // デフォルトは生成

            // 符号と×の検出
            if (part.startsWith('×')) {
                isExtinct = true;
                actualPart = part.substring(1);
                linkType = 'extinct-link'; // 消滅リンク専用のタイプ
            } else if (part.startsWith('-')) {
                actualPart = part.substring(1);
                linkType = 'consumed'; // 消費
            } else if (part.startsWith('+')) {
                actualPart = part.substring(1);
                linkType = 'generated'; // 生成
            }
            // 符号がない場合はそのまま続行し、下のロジックで判定

            const reactionMatch = actualPart.match(/([MR]\d+[a-z]?)(?:\((.*?)\))?/);

            if (reactionMatch) {
                // 1. Reaction Link: RまたはMを介したリンク
                const reactionIdNumber = reactionMatch[1]; 
                const sourceMaterials = reactionMatch[2] ? reactionMatch[2].split(',').map(s => s.trim()).filter(s => s) : [];
                
                const reactionGroupName = `chart${groupIndex - 1}`;
                const reactionNodeId = `${reactionGroupName}-${reactionIdNumber}`;
                const reactionNode = nodeMap.get(reactionNodeId);
                
                if (reactionNode) {
                    // Reaction to Product: ターゲット(currentNode)が生成/消費されるリンク
                    links.push({ source: reactionNode.id, target: currentNode.id, type: linkType, isExtinct });
                    
                    // Reactants to Reaction: 反応物(sourceMaterials)が消費されるリンク
                    sourceMaterials.forEach(matId => {
                        // 反応物ノードは Reaction ノードのさらに一つ前のグループにある
                        const sourceGroupName = `chart${groupIndex - 2}`;
                        const sourceNodeId = `${sourceGroupName}-${matId}`;
                        const sourceNode = nodeMap.get(sourceNodeId);
                        
                        if (sourceNode) {
                            // 反応物から反応へのリンクは常に 'consumed' または 'extinct'
                            const type = sourceNode.isExtinct ? 'extinct-link' : 'consumed';
                            links.push({ 
                                source: sourceNode.id, 
                                target: reactionNode.id, 
                                type: type, 
                                isExtinct: sourceNode.isExtinct 
                            });
                        }
                    });
                }
            } else if (actualPart.match(/^(\d+[a-z]?)$/)) {
                // 2. Direct Link: 反応を通さない物質間移動 (Chart3 -> Chart5 のようなリンク)
                const sourceNumber = actualPart;

                // 修正されたロジック: 一つ前の物質グループ (groupIndex - 2) のノードを探す
                const prevMaterialGroupIndex = groupIndex - 2;
                
                let sourceNode = null;
                if (prevMaterialGroupIndex >= 1) {
                    const sourceGroupName = `chart${prevMaterialGroupIndex}`;
                    const potentialId = `${sourceGroupName}-${sourceNumber}`;
                    sourceNode = nodeMap.get(potentialId);
                }
                
                if (sourceNode) {
                    // 物質間移動は 'direct'とし、消費(-)または消滅(×)の場合はそれぞれ 'consumed', 'extinct-link' を優先。
                    if (linkType === 'generated') linkType = 'direct'; 
                    
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

    // SVGサイズとグループ配置
    const totalHeight = groupData.length * groupSpacingY + 200;
    svg.attr("height", totalHeight).attr("width", width);
    chartGroup.attr("transform", `translate(${width / 2}, 50)`);

    // ノードの座標計算
    groupData.forEach(([group, groupNodes], i) => {
        const center = { x: 0, y: i * groupSpacingY };
        if (groupNodes[0] && groupNodes[0].isProcess) {
            // プロセスノード（長方形配置）
            const nodeSpacing = 15;
            const totalHeight = groupNodes.length * nodeSpacing;
            groupNodes.forEach((node, j) => {
                node.x = center.x;
                node.y = center.y - (totalHeight / 2) + j * nodeSpacing;
            });
        } else {
            // 物質ノード（円形配置）
            const radius = 200;
            const textRadius = 140;
            const angleStep = 2 * Math.PI / groupNodes.length;
            
            groupNodes.forEach((node, j) => {
                const angle = j * angleStep;
                
                node.textX = center.x + textRadius * Math.cos(angle);
                node.textY = center.y + textRadius * Math.sin(angle);
                
                const totalTextLength = (node.name ? node.name.length : 0);
                const charWidth = 5; // 全角文字の幅を適当に推定
                const textHalfLength = totalTextLength * charWidth / 2;
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

            // ソース座標の決定
            if (sourceNode.isProcess) {
                const textLength = (sourceNode.name ? sourceNode.name.length : 0);
                sourceX = sourceNode.x + (textLength * 5) / 2; // プロセスノードの右端から出る
                sourceY = sourceNode.y;
            } else {
                sourceX = sourceNode.circleX;
                sourceY = sourceNode.circleY;
            }

            // ターゲット座標の決定
            if (targetNode.isProcess) {
                const textLength = (targetNode.name ? targetNode.name.length : 0);
                targetX = targetNode.x - (textLength * 5) / 2; // プロセスノードの左端に入る
                targetY = targetNode.y;
            } else {
                targetX = targetNode.circleX;
                targetY = targetNode.circleY;
            }
            
            const dx = targetX - sourceX;
            const dy = targetY - sourceY;

            const isClose = Math.sqrt(dx * dx + dy * dy) < 100;

            if (isClose) {
                // 近い場合は直線
                return `M${sourceX},${sourceY} L${targetX},${targetY}`;
            } else {
                // 遠い場合はS字カーブ
                return `M${sourceX},${sourceY}
                        C${sourceX + dx / 2},${sourceY}
                         ${targetX - dx / 2},${targetY}
                         ${targetX},${targetY}`;
            }
        });

    // ノードの描画
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
            // プロセスノード（長方形とテキスト）
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
            // 物質ノード（円とテキスト）
            nodeElement.append("circle")
                .attr("class", "node-click-area")
                .attr("cx", d => d.circleX)
                .attr("cy", d => d.circleY)
                .attr("r", 20);

            if (d.isExtinct) {
                // 消滅ノード
                nodeElement.append("text")
                    .attr("class", "extinct-x")
                    .attr("x", d => d.circleX)
                    .attr("y", d => d.circleY)
                    .text("×");
            } else {
                // 通常ノード
                nodeElement.append("circle")
                    .attr("class", "node-circle")
                    .attr("r", circleRadius)
                    .attr("fill", d => groupColors[d.group])
                    .attr("cx", d => d.circleX)
                    .attr("cy", d => d.circleY);
            }
            
            // ノードラベル (縦書き風)
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
        // ノードグループのY座標より少し上に配置
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

            // 全てのリセット
            d3.selectAll(".node").classed("faded", false).classed("highlight-node", false);
            d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false);

            if (!isAlreadyHighlighted) {
                const relatedNodeIds = new Set();
                const relatedLinkIds = new Set();
                
                relatedNodeIds.add(d.id);
                
                // 再帰的にパスを探索する関数
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
                    // 反応ノードの場合、インプットとアウトプットのみをハイライト
                    finalLinks.forEach(link => {
                        if (link.source === d.id || link.target === d.id) {
                            const linkKey = `${link.source}-${link.target}-${link.type}-${link.isExtinct}`;
                            relatedLinkIds.add(linkKey);
                            relatedNodeIds.add(link.source);
                            relatedNodeIds.add(link.target);
                        }
                    });
                } else {
                    // 物質ノードの場合、順方向/逆方向のパスをたどる
                    const chartNum = parseInt(d.group.replace('chart', ''));
                    
                    // Chart1 (原材料) からは順方向のみ
                    if (chartNum === 1) {
                        findPath(d.id, 'forward');
                    } 
                    // Chart5 のような最終物質からは逆方向のみ
                    else if (chartNum % 2 === 1 && chartNum > 1) {
                        findPath(d.id, 'backward');
                    }
                    // Chart3 のような中間物質からは両方向をたどる
                    else if (chartNum % 2 === 1 && chartNum > 1 && chartNum < Object.keys(groupLabels).length) {
                        findPath(d.id, 'forward');
                        findPath(d.id, 'backward');
                    }
                }

                // ノードのハイライト/フェード
                d3.selectAll(".node").classed("faded", node => !relatedNodeIds.has(node.id));
                d3.select(event.currentTarget).classed("highlight-node", true);
                d3.selectAll(".node").filter(node => relatedNodeIds.has(node.id) && node.id !== d.id).classed("highlight-node", true);
                
                // リンクのハイライト/フェードと色の決定
                linkElements.classed("faded", link => !relatedLinkIds.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`));
                
                linkElements.filter(link => relatedLinkIds.has(`${link.source}-${link.target}-${link.type}-${link.isExtinct}`))
                    .classed("highlight-link", true)
                    .classed("generated", link => link.type === "generated")
                    .classed("consumed", link => link.type === "consumed")
                    .classed("direct", link => link.type === "direct")
                    .classed("extinct-link", link => link.type === "extinct-link"); 
            }
        });
    
    // SVG外のクリックでリセット
    d3.select("body").on("click", function(event) {
        if (!event.target.closest(".node")) {
            d3.selectAll(".node").classed("faded", false).classed("highlight-node", false);
            d3.selectAll(".link").classed("faded", false).classed("highlight-link", false).classed("generated", false).classed("consumed", false).classed("direct", false).classed("extinct-link", false);
        }
    });

}).catch(error => {
    console.error("D3.jsの処理中に予期せぬエラーが発生しました。", error);
});
