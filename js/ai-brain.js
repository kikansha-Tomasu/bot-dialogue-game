class AIBrain {
  constructor(characters, chatManager, apiClient, resourceManager) {
    this.characters = characters;
    this.aiChars = characters.filter(c => !c.isPlayer);
    this.chatManager = chatManager;
    this.apiClient = apiClient;
    this.resourceManager = resourceManager;
    this.orderBook = null;        // game.js から設定される
    this.buildingManager = null;  // game.js から設定される
    this.progression = null;      // game.js から設定される
    this.farmManager = null;      // game.js から設定される
    this.navGrid = null;          // game.js から設定される
    this.onStateChange = null;    // 在庫や接続状態変化の通知フック
    this.llmAvailable = true;
    this.isProcessing = {};
    this.pendingPlayerMessages = {};
    this.chatTimers = {};
    this.driftTimers = {};
    this._lastAutoReplyAt = 0;

    this.aiChars.forEach((c, i) => {
      this.chatTimers[c.id] = 10 + i * 7 + Math.random() * 5;
      this.driftTimers[c.id] = 3 + i * 2 + Math.random() * 3;
      this.pendingPlayerMessages[c.id] = [];
    });
  }

  update(dt) {
    this.aiChars.forEach(c => {
      // 採集完了チェック
      if (c.gatherTarget && c.atGatherTarget) {
        const node = c.gatherTarget;
        const got = node.gather(1);
        if (got > 0) {
          inventoryAdd(c.inventory, node.type, got);
          this._announceGather(c, node.type, got);
          if (this.onStateChange) this.onStateChange();
        }
        c.gatherTarget = null;
        c.atGatherTarget = false;
      }

      // チャット接近完了チェック
      if (c.chatTarget && c.atChatTarget) {
        const target = c.chatTarget;
        c.chatTarget = null;
        c.atChatTarget = false;
        this._initiateChat(c, target);
      }

      // 目的のある徘徊：採集・チャット以外のアイドル時も資源ノードや他キャラへ向かう
      if (!c.gatherTarget && !c.chatTarget && !c.isTalking) {
        this.driftTimers[c.id] -= dt;
        if (this.driftTimers[c.id] <= 0) {
          this.driftTimers[c.id] = 15 + Math.random() * 15;
          const driftPos = this._pickDriftTarget(c);
          if (driftPos) {
            c.wanderTarget = driftPos;
            c.wanderTimer = 30;
          }
        }
      }

      if (this.isProcessing[c.id] || c.gatherTarget || c.chatTarget || c.isTalking || c._hasPendingSpeech) return;
      this.chatTimers[c.id] -= dt;
      if (this.chatTimers[c.id] <= 0) {
        this._resetTimer(c.id);
        this._aiDoMasterAction(c);
      }
    });
  }

  _pickGatherTarget(char) {
    const RESOURCE_TYPES = ["wood", "stone", "herb", "fish"];
    const sorted = [...RESOURCE_TYPES].sort(
      (a, b) => (char.inventory[a] || 0) - (char.inventory[b] || 0)
    );
    for (const type of sorted) {
      const nodes = this.resourceManager.nodes
        .filter(n => !n.isEmpty && n.type === type)
        .sort((a, b) => Math.hypot(a.x - char.x, a.y - char.y)
                      - Math.hypot(b.x - char.x, b.y - char.y));
      if (nodes.length > 0) return nodes[0];
    }
    return null;
  }

  _pickDriftTarget(c) {
    if (Math.random() < 0.5) {
      const nodes = this.resourceManager.nodes.filter(n => !n.isEmpty);
      if (nodes.length > 0) {
        const node = nodes[Math.floor(Math.random() * nodes.length)];
        return { x: node.x, y: node.y };
      }
    }
    const others = this.characters.filter(x => x.id !== c.id);
    if (others.length > 0) {
      const other = others[Math.floor(Math.random() * others.length)];
      const angle = Math.random() * Math.PI * 2;
      const offset = 30 + Math.random() * 50;
      const rawX = other.x + Math.cos(angle) * offset;
      const rawY = other.y + Math.sin(angle) * offset;
      if (this.navGrid && this.navGrid.isReady()) {
        return this.navGrid.findNearestWalkablePoint(rawX, rawY);
      }
      return { x: rawX, y: rawY };
    }
    return null;
  }

  _drainPendingPlayerMessage(char) {
    const queue = this.pendingPlayerMessages[char.id];
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    setTimeout(() => {
      this.handlePlayerMessage(next.playerMessage, char, next.player);
    }, 50);
  }

  _ensureStrategy(char) {
    if (!char || char.isPlayer) return null;
    if (!char.strategy) {
      const p = char.strategyProfile || {};
      char.strategy = {
        archetype: p.archetype || "balanced",
        styleLabel: p.styleLabel || "バランス型",
        goal: p.defaultGoal || "採集・農業・取引を組み合わせて総資産1位を目指す",
        focusAction: p.defaultFocus || "gather",
        targetItem: p.defaultItem || "wood",
        targetRival: "Player",
        turnCount: 0,
        revisionCount: 0,
        lastRank: 0,
        lastUpdatedAt: 0,
      };
    }
    return char.strategy;
  }

  _findMissingBuildingResource(char) {
    if (!this.buildingManager) return null;
    const myBuildings = this.buildingManager.placed.filter(b => b.builderId === char.id);
    if (myBuildings.length >= 2) return null;

    let bestMissing = null;
    let bestShortfall = Infinity;
    for (const recipe of Object.values(BUILDING_RECIPES)) {
      let totalMissing = 0;
      let firstMissing = null;
      for (const [res, need] of Object.entries(recipe.cost || {})) {
        const diff = Math.max(0, need - (char.inventory[res] || 0));
        totalMissing += diff;
        if (diff > 0 && !firstMissing) firstMissing = res;
      }
      if (totalMissing > 0 && totalMissing < bestShortfall) {
        bestShortfall = totalMissing;
        bestMissing = firstMissing;
      }
    }
    return bestMissing;
  }

  _findMissingCookingIngredient(char) {
    if (!this.farmManager || typeof COOKING_RECIPES === "undefined") return null;
    let bestMissing = null;
    let bestShortfall = Infinity;
    for (const recipe of Object.values(COOKING_RECIPES)) {
      const allReq = { ...(recipe.crops || {}), ...(recipe.resources || {}) };
      let totalMissing = 0;
      let haveAny = false;
      let firstMissing = null;
      for (const [item, need] of Object.entries(allReq)) {
        const have = char.inventory[item] || 0;
        if (have > 0) haveAny = true;
        const diff = Math.max(0, need - have);
        totalMissing += diff;
        if (diff > 0 && !firstMissing) firstMissing = item;
      }
      if (haveAny && totalMissing > 0 && totalMissing < bestShortfall) {
        bestShortfall = totalMissing;
        bestMissing = firstMissing;
      }
    }
    return bestMissing;
  }

  // ブラウザ内蔵 0.5B モデルでも途中で切れない完全圧縮の盤面・戦略サマリー（約220〜300文字）
  _buildCompactStrategicContext(char) {
    const s = this._ensureStrategy(char);
    const rankInfo = this._getCharRank(char);
    const invSummary = getInventorySummary(char.inventory, 5) || "空";
    const myBuildings = this.buildingManager?.placed.filter(b => b.builderId === char.id).length || 0;
    const affordableBuilds = this.buildingManager
      ? Object.keys(BUILDING_RECIPES)
          .filter(t => inventoryCanAfford(char.inventory, BUILDING_RECIPES[t].cost))
          .map(t => BUILDING_RECIPES[t].name)
      : [];
    const myPlots = this.farmManager ? this.farmManager.getPlotsByOwner(char.id).length : 0;
    const ripePlots = this.farmManager ? this.farmManager.getRipePlotsByOwner(char.id).length : 0;
    const cookable = this.farmManager && typeof COOKING_RECIPES !== "undefined"
      ? Object.values(COOKING_RECIPES).filter(r => this.farmManager.canCook(char, r.id).ok).map(r => r.name)
      : [];
    const openOrders = (this.orderBook?.orders || [])
      .filter(o => o.posterId !== char.id)
      .slice(0, 4)
      .map(o => {
        const side = o.sellType === "coin" ? "買" : "売";
        const label = RESOURCE_EMOJI[o.resourceType] || o.resourceType;
        return `${o.posterName}${side}${label}×${o.sellType === "coin" ? o.buyAmount : o.sellAmount}@🪙${o.sellType === "coin" ? o.sellAmount : o.buyAmount}`;
      })
      .join(", ");
    const prices = this._getTradableItemTypes()
      .filter(t => (this.orderBook?.priceHistory?.[t]?.length || 0) > 0)
      .slice(0, 5)
      .map(t => {
        const h = this.orderBook.priceHistory[t];
        return `${RESOURCE_EMOJI[t]}${h[h.length - 1].toFixed(1).replace(/\.0$/, "")}`;
      })
      .join(" ");

    const gapStr = rankInfo.rank === 1
      ? "現在1位"
      : `${rankInfo.rank}位(1位${rankInfo.leaderName}と差-${rankInfo.gapFromLeader.toFixed(0)}🪙)`;

    return (
      `あなた(${char.name}・${s?.styleLabel || "バランス型"}) | 作戦:${s?.goal || ""} [重視:${s?.focusAction || "gather"} / 目標:${s?.targetItem || "wood"}]\n` +
      `順位:${gapStr}(総資産${rankInfo.total.toFixed(0)}🪙) | 所持:${invSummary}\n` +
      `建物:${myBuildings}/2(建築可:${affordableBuilds.join("・") || "なし"}) | 農地:${myPlots}/2(収穫可:${ripePlots}) | 料理可:${cookable.join("・") || "なし"}\n` +
      `取引板:${openOrders || "注文なし"} | 相場:${prices || "未成立"}`
    );
  }

  // 会話プロンプト用の自然な日本語状況文（表や記号の羅列を避け、0.5Bでも人間らしい話し言葉を引き出す）
  _buildNaturalHumanContext(char) {
    const s = this._ensureStrategy(char);
    const coins = Math.floor(char.inventory.coin || 0);
    const heldParts = this._getTradableItemTypes()
      .filter(t => (char.inventory[t] || 0) > 0)
      .slice(0, 3)
      .map(t => `${RESOURCE_LABEL[t] || t}${char.inventory[t]}${t === "fish" ? "匹" : "個"}`);
    const invText = heldParts.length > 0
      ? `手元には${heldParts.join("・")}とコイン${coins}枚があります`
      : `所持金はコイン${coins}枚です`;

    const parts = [invText];
    const otherOrders = (this.orderBook?.orders || []).filter(o => o.posterId !== char.id);
    if (otherOrders.length > 0) {
      const o = otherOrders[0];
      const itemLbl = RESOURCE_LABEL[o.resourceType] || o.resourceType;
      const sideText = o.sellType === "coin" ? "買いたがっています" : "売りに出しています";
      const priceCoins = o.sellType === "coin" ? o.sellAmount : o.buyAmount;
      parts.push(`取引板では${o.posterName}が${itemLbl}を${priceCoins}コインで${sideText}`);
    }
    if (s?.goal) {
      parts.push(`いまの目標は「${s.goal}」です`);
    }
    return parts.join("。") + "。";
  }

  _parseStrategyPlan(text) {
    if (!text) return null;
    const focusMatch = text.match(/FOCUS\s*[:：]\s*(gather|farm|trade|build|chat)/i);
    const itemMatch = text.match(/TARGET_ITEM\s*[:：]\s*([a-z_]+)/i);
    const goalMatch = text.match(/GOAL\s*[:：]\s*([^\n]+)/i);

    const focusAction = focusMatch ? focusMatch[1].toLowerCase() : null;
    const validItems = this._getTradableItemTypes();
    const targetItem = itemMatch && validItems.includes(itemMatch[1].toLowerCase())
      ? itemMatch[1].toLowerCase()
      : null;

    let goal = goalMatch ? goalMatch[1].replace(/^["「『]|["」』]$/g, "").trim() : "";
    if (goal) {
      goal = LMStudioClient.truncateToSentences(goal, 1).slice(0, 48);
      if (LMStudioClient.isCorruptedText(goal)) goal = "";
    }

    if (!focusAction && !goal) return null;
    return { focusAction, targetItem, goal };
  }

  _computeDynamicStrategyFallback(char) {
    const s = this._ensureStrategy(char);
    const archetype = s.archetype;
    const myBuildings = this.buildingManager?.placed.filter(b => b.builderId === char.id).length || 0;
    const affordableBuilds = this.buildingManager
      ? Object.keys(BUILDING_RECIPES).filter(t => inventoryCanAfford(char.inventory, BUILDING_RECIPES[t].cost))
      : [];
    const myPlots = this.farmManager ? this.farmManager.getPlotsByOwner(char.id).length : 0;
    const ripePlots = this.farmManager ? this.farmManager.getRipePlotsByOwner(char.id).length : 0;
    const townLv = this.progression?.townLevel || 0;
    const canPlant = this.farmManager
      ? this.farmManager.getAvailableCrops(char, townLv).some(c => this.farmManager.canPlant(char, c.id, townLv).ok)
      : false;
    const cookable = this.farmManager && typeof COOKING_RECIPES !== "undefined"
      ? Object.values(COOKING_RECIPES).find(r => this.farmManager.canCook(char, r.id).ok)
      : null;
    const heldDish = typeof DISH_ITEM_TYPES !== "undefined"
      ? DISH_ITEM_TYPES.find(d => (char.inventory[d] || 0) >= 1)
      : null;
    const heldCrop = typeof CROP_ITEM_TYPES !== "undefined"
      ? CROP_ITEM_TYPES.find(c => (char.inventory[c] || 0) >= 1)
      : null;
    const otherOrders = (this.orderBook?.orders || []).filter(o => o.posterId !== char.id);

    if (archetype === "infrastructure_builder") {
      if (myBuildings < 2 && affordableBuilds.length > 0) {
        const bName = BUILDING_RECIPES[affordableBuilds[0]].name;
        return { focusAction: "build", targetItem: "wood", goal: `資源が揃ったので${bName}を建てて自動生産を確立する` };
      }
      if (myBuildings < 2) {
        const miss = this._findMissingBuildingResource(char) || "wood";
        return { focusAction: "gather", targetItem: miss, goal: `${RESOURCE_LABEL[miss]}を集めて${myBuildings + 1}棟目の建物を完成させる` };
      }
      return { focusAction: "trade", targetItem: heldDish || heldCrop || "wood", goal: "建物の自動生産品と余剰資源を取引板で堅実に売る" };
    }

    if (archetype === "culinary_craft") {
      if (ripePlots > 0 || cookable) {
        return { focusAction: "farm", targetItem: cookable?.id || "carrot_salad", goal: "作物を収穫して料理へ加工し、高付加価値で売る準備をする" };
      }
      if (heldDish) {
        return { focusAction: "trade", targetItem: heldDish, goal: `完成した${RESOURCE_LABEL[heldDish]}を取引板で高く売り抜ける` };
      }
      const missingIng = this._findMissingCookingIngredient(char);
      if (missingIng) {
        const isBase = ["wood", "stone", "herb", "fish"].includes(missingIng);
        return {
          focusAction: isBase ? "gather" : "trade",
          targetItem: missingIng,
          goal: `料理用の${RESOURCE_LABEL[missingIng]}を集めてごちそうを量産する`,
        };
      }
      if (myPlots < 2 && canPlant) {
        return { focusAction: "farm", targetItem: "carrot", goal: "農地2区画をフル稼働させて料理用の作物を量産する" };
      }
      return { focusAction: "gather", targetItem: "herb", goal: "種まきと料理に必要な薬草・木材を先に確保する" };
    }

    // market_arbitrage (Alice)
    if (otherOrders.length > 0) {
      const topOrder = otherOrders[0];
      const lbl = RESOURCE_LABEL[topOrder.resourceType] || topOrder.resourceType;
      return { focusAction: "trade", targetItem: topOrder.resourceType, goal: `取引板の${lbl}の価格差を見極めて有利に売買する` };
    }
    if (heldDish || heldCrop) {
      const target = heldDish || heldCrop;
      return { focusAction: "trade", targetItem: target, goal: `${RESOURCE_LABEL[target]}を強気の指値で取引板に出しコインを稼ぐ` };
    }
    const base = ["wood", "stone", "herb", "fish"];
    const highestBase = [...base].sort((a, b) => {
      const pa = this.orderBook?.getAIValuation?.(a, char) || 3;
      const pb = this.orderBook?.getAIValuation?.(b, char) || 3;
      return pb - pa;
    })[0];
    return { focusAction: "gather", targetItem: highestBase, goal: `評価の高い${RESOURCE_LABEL[highestBase]}を集めて取引板で高値売却を狙う` };
  }

  // 数ターンごと／順位変動時に長期戦略をLLMで見直し・更新する
  async _maybeReviseStrategy(char, force = false) {
    const s = this._ensureStrategy(char);
    if (!s) return null;

    const rankInfo = this._getCharRank(char);
    const rankChanged = s.lastRank > 0 && s.lastRank !== rankInfo.rank;
    const due = force || s.revisionCount === 0 || s.turnCount >= 3 || rankChanged;
    if (!due) {
      s.turnCount++;
      return s;
    }

    s.lastRank = rankInfo.rank;
    const topRival = rankInfo.ranked.find(r => r.id !== char.id);
    s.targetRival = topRival?.name || "Player";
    s.turnCount = 0;

    let parsed = null;
    if (this._canUseLLMForSpeech() && typeof this.apiClient.callAIForStrategy === "function") {
      try {
        const brief = this._buildCompactStrategicContext(char);
        const raw = await this.apiClient.callAIForStrategy(char, brief);
        parsed = this._parseStrategyPlan(raw);
      } catch (err) {
        console.warn(`[AIBrain] ${char.name} strategy review fallback:`, err.message);
      }
    }

    const fallback = this._computeDynamicStrategyFallback(char);
    s.focusAction = parsed?.focusAction || fallback.focusAction || s.focusAction;
    s.targetItem = parsed?.targetItem || fallback.targetItem || s.targetItem;
    s.goal = parsed?.goal || fallback.goal || s.goal;
    s.revisionCount++;
    s.lastUpdatedAt = Date.now();
    if (this.onStateChange) this.onStateChange();
    return s;
  }

  async _aiDoMasterAction(c) {
    if (this.isProcessing[c.id]) return;

    this.isProcessing[c.id] = true;

    // 行動前に長期戦略を見直し・更新（3ターンごと／順位変動時）
    try {
      await this._maybeReviseStrategy(c);
    } catch (_) {}

    // 低確率（10%）の探索ステップは戦略重視フォールバックへ
    if (Math.random() < GAME_CONFIG.aiRandomActionRate) {
      this.isProcessing[c.id] = false;
      this._fallbackAction(c);
      return;
    }

    const s = this._ensureStrategy(c);
    const invSummary = getInventorySummary(c.inventory) || "空";
    const coinAmt = c.inventory.coin || 0;
    const myBuildings = this.buildingManager?.placed.filter(b => b.builderId === c.id) ?? [];
    const affordable = this.buildingManager
      ? Object.keys(BUILDING_RECIPES).filter(t => inventoryCanAfford(c.inventory, BUILDING_RECIPES[t].cost))
      : [];
    const hasNodes = this.resourceManager.nodes.some(n => !n.isEmpty);
    const executableOrders = this.orderBook
      ? this.orderBook.orders.filter(o =>
          o.posterId !== c.id &&
          (c.inventory[o.buyType] || 0) >= o.buyAmount &&
          (o.posterRef.inventory[o.sellType] || 0) >= o.sellAmount
        )
      : [];

    const townLine = this.progression
      ? `現在の街の発展度: 「${this.progression.getTownSpec().name}」\n`
      : "";
    const farmLine = this.farmManager
      ? `畑の様子: ${this.farmManager.buildSummaryForAI(c)}\n`
      : "";
    const focusJa = { gather: "採集", farm: "農業・料理", trade: "取引", build: "建築", chat: "会話" }[s?.focusAction] || "採集";
    const strategyLine = s
      ? `あなたの得意なやり方: ${s.styleLabel} ／ いまの方針: ${s.goal}（重視: ${focusJa}, 注目品目: ${RESOURCE_LABEL[s.targetItem] || s.targetItem}, 意識している相手: ${s.targetRival}）\n`
      : "";

    const context =
      strategyLine +
      `あなた（${c.name}）の手持ち: ${invSummary}、コイン: ${coinAmt}枚\n` +
      townLine +
      `街の資産順位（みんな一番を目指して競っています）:\n${this._buildRivalRankingSummary(c)}\n` +
      `現在の推定総資産内訳:\n${this._buildAssetValueSummary(c)}\n` +
      `みんなの持ち物:\n${this._buildOtherInventoriesSummary(c)}\n` +
      `みんなの居場所:\n${this._buildPositionSummary(c)}\n` +
      `採集場所の残り:\n${this._buildResourceNodesSummary(c)}\n` +
      farmLine +
      `街に建っている施設:\n${this._buildBuildingsSummary()}\n` +
      (this.orderBook ? `現在の取引板:\n${this._buildOrderBookSummary()}\n` : "") +
      `直近の取引価格:\n${this._buildPriceSummary()}\n` +
      `建てられる施設: ${affordable.length ? affordable.map(t => `${BUILDING_RECIPES[t].emoji}${BUILDING_RECIPES[t].name}`).join(", ") : "なし（材料不足）"}\n` +
      `自分の建物数: ${myBuildings.length}/2\n` +
      `採集できる場所: ${hasNodes ? "あり" : "なし（今は採り尽くされている）"}\n` +
      (executableOrders.length > 0 ? `取引板に今すぐ成立させられる注文が${executableOrders.length}件あります。trade + execute で約定できます。\n` : "") +
      `いまの方針に沿って、次に何をするか決めてください。`;

    const compactContext = this._buildCompactStrategicContext(c);

    let planText = null;
    try {
      planText = await this.apiClient.callAIForMasterAction(c, context, "", compactContext);
      if (planText) {
        if (!this.llmAvailable) {
          this.llmAvailable = true;
          if (this.onStateChange) this.onStateChange();
        }
      } else if (this.apiClient.lmAvailable === false) {
        this.llmAvailable = false;
        if (this.onStateChange) this.onStateChange();
      }
    } catch (err) {
      console.warn(`[AIBrain] ${c.name} callAIForMasterAction failed:`, err.message);
    } finally {
      this.isProcessing[c.id] = false;
    }

    // 思考中にプレイヤーから話しかけられていたら最優先で返答する
    if (this.pendingPlayerMessages[c.id]?.length > 0) {
      this._drainPendingPlayerMessage(c);
      return;
    }

    if (!planText) { this._fallbackAction(c); return; }

    const planMatch = planText.match(/PLAN\s*[:：]\s*(gather|farm|trade|build|chat)/i);
    if (!planMatch) { this._fallbackAction(c); return; }

    const plan = planMatch[1].toLowerCase();

    if (plan === "gather") {
      this._executePlanGather(c, planText);
    } else if (plan === "farm" && this.farmManager) {
      this._executePlanFarm(c, planText);
    } else if (plan === "trade" && this.orderBook) {
      this._executePlanTrade(c, planText);
    } else if (plan === "build" && this.buildingManager) {
      this._executePlanBuild(c, planText);
    } else {
      const others = this.characters.filter(x => x.id !== c.id);
      const targetMatch = planText.match(/TARGET\s*[:：]\s*(\w+)/i);
      const msgMatch    = planText.match(/MESSAGE\s*[:：]\s*(.+)/i);
      let chatTarget = null;
      if (targetMatch) {
        chatTarget = others.find(x => x.name.toLowerCase() === targetMatch[1].toLowerCase());
      }
      c.chatTarget = chatTarget ?? this._pickRelevantChatTarget(c);
      c._pendingChatMessage = msgMatch ? msgMatch[1].trim() : null;
    }
  }

  _executePlanGather(c, planText) {
    const RESOURCE_TYPES = ["wood", "stone", "herb", "fish"];
    let chosenType = null;

    if (planText) {
      const match = planText.match(/RESOURCE\s*[:：]\s*(wood|stone|herb|fish)/i);
      if (match) chosenType = match[1].toLowerCase();
    }

    // 戦略連動：明示指定が無ければ各キャラの作戦・不足素材に基づいて採集対象を決定
    if (!chosenType) {
      const s = this._ensureStrategy(c);
      if (s?.targetItem && RESOURCE_TYPES.includes(s.targetItem)) {
        chosenType = s.targetItem;
      } else if (s?.archetype === "infrastructure_builder") {
        chosenType = this._findMissingBuildingResource(c);
      } else if (s?.archetype === "culinary_craft") {
        const miss = this._findMissingCookingIngredient(c);
        chosenType = RESOURCE_TYPES.includes(miss) ? miss : "herb";
      } else if (s?.archetype === "market_arbitrage" && this.orderBook) {
        chosenType = [...RESOURCE_TYPES].sort((a, b) =>
          (this.orderBook.getAIValuation?.(b, c) || 3) - (this.orderBook.getAIValuation?.(a, c) || 3)
        )[0];
      }
    }

    if (!chosenType) {
      const sorted = [...RESOURCE_TYPES].sort((a, b) => (c.inventory[a] || 0) - (c.inventory[b] || 0));
      chosenType = sorted[0];
    }

    const nodes = this.resourceManager.nodes
      .filter(n => !n.isEmpty && n.type === chosenType)
      .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));

    if (nodes.length > 0) {
      c.gatherTarget = nodes[0];
    } else {
      const fallback = this._pickGatherTarget(c);
      if (fallback) c.gatherTarget = fallback;
    }

    const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
    c._pendingAnnounceMessage = msgMatch ? msgMatch[1].trim() : null;
  }

  _getTradableItemTypes() {
    return typeof TRADABLE_ITEM_TYPES !== "undefined"
      ? TRADABLE_ITEM_TYPES
      : ["wood", "stone", "herb", "fish"];
  }

  _canUseLLMForSpeech() {
    if (!this.apiClient || typeof this.apiClient.callAI !== "function") return false;
    if (this.apiClient.mode === "browser-hf") {
      return Boolean(this.apiClient._workerReady || this.apiClient._getSavedBrowserToken?.());
    }
    if (this.apiClient.mode === "local-server") {
      return this.apiClient.hfAvailable !== false;
    }
    // テスト用のカスタムクライアント（mode未設定・callAI実装あり）
    return !("mode" in this.apiClient) || this.apiClient.hfAvailable === true;
  }

  // 近くに相手がいればそのキャラへ、周囲に誰もいなければ「全員」向け発言（ランダムな遠距離メンションを廃止）
  _pickNearbyOrBroadcastTarget(char, maxDist = 180) {
    const nearest = this._nearestOther(char);
    if (!nearest) return null;
    const dist = Math.hypot(nearest.x - char.x, nearest.y - char.y);
    return dist <= maxDist ? nearest : null;
  }

  // 会話を始める相手をランダムではなく状況（近距離・対抗ライバル）から選ぶ
  _pickRelevantChatTarget(char) {
    const others = this.characters.filter(c => c.id !== char.id);
    if (!others.length) return null;
    const nearby = this._pickNearbyOrBroadcastTarget(char, 190);
    if (nearby) return nearby;
    const rivalName = char.strategy?.targetRival;
    if (rivalName) {
      const rival = others.find(c => c.name === rivalName);
      if (rival) return rival;
    }
    return this._nearestOther(char) || others[0];
  }

  // AI同士の自然な選択的返信（全部に返信せず一部は自然に無視・クールダウン制御付き）
  _buildActionReplyTrigger(speaker, recipient, messageText, options = {}) {
    const isBroadcast = !recipient;
    const replyRate = typeof options.replyRate === "number"
      ? options.replyRate
      : (isBroadcast ? 0.4 : 0.55);

    if (recipient && recipient.isPlayer) return null;
    if (options.noReply) return null;

    return () => {
      if (Math.random() >= replyRate) return;
      const now = Date.now();
      if (now - this._lastAutoReplyAt < 4000) return;

      let responder = null;
      if (recipient && !recipient.isPlayer) {
        if (!this.isProcessing[recipient.id] && !recipient.isTalking && !recipient._hasPendingSpeech) {
          responder = recipient;
        }
      } else {
        // 全員向け発言（出品・収穫等）には手が空いているAIのうち近い／関心のある1人が反応
        const idleAIs = this.aiChars
          .filter(c => c.id !== speaker.id && !this.isProcessing[c.id] && !c.isTalking && !c._hasPendingSpeech)
          .sort((a, b) =>
            Math.hypot(a.x - speaker.x, a.y - speaker.y) -
            Math.hypot(b.x - speaker.x, b.y - speaker.y)
          );
        responder = idleAIs[0] || null;
      }

      if (!responder) return;
      this._lastAutoReplyAt = now;
      setTimeout(() => {
        if (this.isProcessing[responder.id] || responder.isTalking || responder._hasPendingSpeech) return;
        this._triggerReply(responder, speaker, messageText, 1);
      }, GAME_CONFIG.aiReplyDelay);
    };
  }

  // 採集・農業・料理・取引・建築・街発展などのリアクションを定型文ではなくLLMに考えさせる
  // ※文章・音声の生成中はキャラクターを止めず動き続けさせ、準備完了後に3秒「考え中」ポーズを取る
  async _speakActionViaLLM(char, target, actionFact, fallbackText, preGeneratedMsg = null, options = {}) {
    if (!char) return;
    const isBroadcast = !target;
    const recipientId = isBroadcast ? "all" : target.id;
    const recipientName = isBroadcast ? "全員" : target.name;
    const mentionName = isBroadcast ? null : target.name;

    const sanitizedPre = LMStudioClient.sanitizeAnnounceMessage(preGeneratedMsg, mentionName, char.name);
    if (sanitizedPre) {
      const triggerAfter = this._buildActionReplyTrigger(char, target, sanitizedPre, options);
      this._presentResponse(char, sanitizedPre, recipientId, recipientName, triggerAfter);
      return;
    }

    const cleanFallback = LMStudioClient.sanitizeAnnounceMessage(fallbackText, mentionName, char.name) || fallbackText;
    if (!this._canUseLLMForSpeech() || this.isProcessing[char.id]) {
      const triggerAfter = this._buildActionReplyTrigger(char, target, cleanFallback, options);
      this._presentResponse(char, cleanFallback, recipientId, recipientName, triggerAfter);
      return;
    }

    this.isProcessing[char.id] = true;

    try {
      const naturalCtx = this._buildNaturalHumanContext(char);
      const isCompact = this.apiClient?.mode === "browser-hf";
      let prompt;
      if (isCompact) {
        const audienceLine = isBroadcast
          ? "そばにいるみんなに聞こえるように、率直な感想や呼びかけを1〜2文で言ってください。"
          : `近くにいた${target.name}に、1〜2文で話しかけてください。`;
        prompt =
          `たった今、あなたは${actionFact}。\n` +
          `今の状況：${naturalCtx}\n` +
          audienceLine;
      } else {
        const invSummary = getInventorySummary(char.inventory, 5) || "なし";
        const rankInfo = this._getCharRank(char);
        const s = this._ensureStrategy(char);
        const strategyHint = s
          ? `あなたの得意なやり方：${s.styleLabel}（${s.goal}）\n`
          : "";
        const audienceLine = isBroadcast
          ? "そばにいるみんなに聞こえるように、一人称「私」で自然な話し言葉1〜2文の感想や呼びかけを言ってください。特定の相手への@メンションは不要です。"
          : `近くにいた${target.name}に向かって、一人称「私」で自然な話し言葉1〜2文で話しかけてください。`;
        prompt =
          `たった今、あなたは${actionFact}。\n` +
          `今の状況：手元の持ち物は ${invSummary}、資産順位は${rankInfo.rank}位（${rankInfo.total.toFixed(1)}コイン相当）です。\n` +
          strategyHint +
          `${audienceLine}定型文ではなく今の気持ちに合わせて話してください。`;
      }

      const response = await this.apiClient.callAI(
        char,
        prompt,
        mentionName,
        `(${actionFact})`
      );
      if (!this.llmAvailable) {
        this.llmAvailable = true;
        if (this.onStateChange) this.onStateChange();
      }
      const triggerAfter = this._buildActionReplyTrigger(char, target, response, options);
      this._presentResponse(char, response, recipientId, recipientName, triggerAfter);
    } catch (err) {
      console.warn(`[AIBrain] ${char.name} action speech fallback:`, err.message);
      const triggerAfter = this._buildActionReplyTrigger(char, target, cleanFallback, options);
      this._presentResponse(char, cleanFallback, recipientId, recipientName, triggerAfter);
    } finally {
      this.isProcessing[char.id] = false;
      this._drainPendingPlayerMessage(char);
    }
  }

  // プレイヤーがAIの取引板注文を成立させたときのLLMリアクション
  reactToTradeExecuted(aiChar, counterparty, order) {
    if (!aiChar || !counterparty || !order) return;
    const isBuyOrder = order.sellType === "coin";
    const resType = order.resourceType || (isBuyOrder ? order.buyType : order.sellType);
    const resQty = order.resourceQty || (isBuyOrder ? order.buyAmount : order.sellAmount);
    const coinQty = order.coinQty || (isBuyOrder ? order.sellAmount : order.buyAmount);
    const itemName = `${RESOURCE_EMOJI[resType] || ""}${RESOURCE_LABEL[resType] || resType}`;
    const actionFact = isBuyOrder
      ? `${counterparty.name}があなたの買い注文に応じてくれ、🪙${coinQty}で${itemName}×${resQty}を購入できた`
      : `${counterparty.name}があなたの売り注文を買ってくれ、${itemName}×${resQty}を🪙${coinQty}で売却できた`;
    const fallback = `@${counterparty.name} ${itemName}×${resQty}の取引ありがとう！`;
    this._speakActionViaLLM(aiChar, counterparty, actionFact, fallback, null, { noReply: true });
  }

  _executePlanTrade(char, planText) {
    const ALL_ITEMS = this._getTradableItemTypes();
    const decision = planText ? this._parseTradeDecision(planText) : null;
    const target = this._pickNearbyOrBroadcastTarget(char);

    if (decision) {
      const { action, resource, amount, coins } = decision;
      const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
      const customMsg = msgMatch ? msgMatch[1].trim() : null;

      if (action === "execute") {
        const executed = this.orderBook.tryAIExecute(char, resource);
        if (executed) {
          const posterTarget = executed.posterRef || target;
          const itemLabel = `${RESOURCE_EMOJI[executed.resourceType] || ""}${RESOURCE_LABEL[executed.resourceType] || executed.resourceType}`;
          const actionFact = `${executed.posterName}の取引板注文を成立させ、${itemLabel}×${executed.resourceQty}と🪙${executed.coinQty}を交換した`;
          const fallback = `@${executed.posterName} ${itemLabel}×${executed.resourceQty}の取引が成立したよ！`;
          this._speakActionViaLLM(char, posterTarget, actionFact, fallback, customMsg, { replyRate: 0.65 });
          return;
        }
      } else if (action === "skip") {
        return;
      } else if (action === "sell") {
        const avail = this.orderBook.getAvailableBalance(char, resource);
        const sellAmt = Math.min(amount, avail);
        if (sellAmt >= 1 && coins >= 1) {
          const order = this.orderBook.postOrder(char, resource, sellAmt, "coin", coins);
          if (order) {
            if (!order._wasFullyMatched) {
              const itemLabel = `${RESOURCE_EMOJI[resource]}${RESOURCE_LABEL[resource]}`;
              const actionFact = `取引板に${itemLabel}×${sellAmt}を🪙${coins}で売り注文を出した`;
              const fallback = `${itemLabel}×${sellAmt}を🪙${coins}で取引板に売りに出したよ！`;
              this._speakActionViaLLM(char, null, actionFact, fallback, customMsg, { replyRate: 0.45 });
            }
            return;
          }
        }
      } else if (action === "buy") {
        const availCoin = this.orderBook.getAvailableBalance(char, "coin");
        const spendCoin = Math.min(coins, availCoin);
        if (amount >= 1 && spendCoin >= 1) {
          const order = this.orderBook.postOrder(char, "coin", spendCoin, resource, amount);
          if (order) {
            if (!order._wasFullyMatched) {
              const itemLabel = `${RESOURCE_EMOJI[resource]}${RESOURCE_LABEL[resource]}`;
              const actionFact = `取引板に🪙${spendCoin}で${itemLabel}×${amount}の買い注文を出した`;
              const fallback = `🪙${spendCoin}で${itemLabel}×${amount}を買いたいな！取引板に注文を出したよ`;
              this._speakActionViaLLM(char, null, actionFact, fallback, customMsg, { replyRate: 0.45 });
            }
            return;
          }
        }
      }
    }

    // フォールバック：妥当価格の既存注文（プレイヤー注文含む）を優先して約定
    if (Math.random() < 0.65) {
      const executed = this.orderBook.tryAIExecute(char);
      if (executed) {
        const posterTarget = executed.posterRef || target;
        const itemLabel = `${RESOURCE_EMOJI[executed.resourceType] || ""}${RESOURCE_LABEL[executed.resourceType] || executed.resourceType}`;
        const actionFact = `${executed.posterName}の取引板注文を成立させ、${itemLabel}×${executed.resourceQty}と🪙${executed.coinQty}を交換した`;
        const fallback = `@${executed.posterName} ${itemLabel}×${executed.resourceQty}の注文を成立させたよ！`;
        this._speakActionViaLLM(char, posterTarget, actionFact, fallback, null, { replyRate: 0.65 });
        return;
      }
    }

    const haveItems = ALL_ITEMS.filter(
      t => this.orderBook.getAvailableBalance(char, t) >= 1
    );
    const availCoin = this.orderBook.getAvailableBalance(char, "coin");
    let sellType, buyType, sellAmount, buyAmount;

    const getRefPrice = (itemType) => (
      typeof this.orderBook.getAIValuation === "function"
        ? this.orderBook.getAIValuation(itemType, char)
        : 2.5
    );

    const s = this._ensureStrategy(char);
    const sellMarkup = char.strategyProfile?.sellMarkup || 1.08;

    if (haveItems.length > 0 && (Math.random() < 0.65 || availCoin < 2)) {
      // 料理＞作物＞基本資源の優先度で売りに出しやすい品目を選ぶ（Bobは建築素材を温存）
      const dishHeld = haveItems.filter(t => typeof DISH_ITEM_TYPES !== "undefined" && DISH_ITEM_TYPES.includes(t));
      const cropHeld = haveItems.filter(t => typeof CROP_ITEM_TYPES !== "undefined" && CROP_ITEM_TYPES.includes(t));
      const myBuildings = this.buildingManager?.placed.filter(b => b.builderId === char.id).length || 0;
      const nonBuildingHeld = s?.archetype === "infrastructure_builder" && myBuildings < 2
        ? haveItems.filter(t => (char.inventory[t] || 0) >= 3 || dishHeld.includes(t) || cropHeld.includes(t))
        : haveItems;
      const pool = dishHeld.length > 0
        ? dishHeld
        : cropHeld.length > 0
          ? cropHeld
          : (nonBuildingHeld.length > 0 ? nonBuildingHeld : haveItems);
      sellType = pool[Math.floor(Math.random() * pool.length)];
      sellAmount = Math.min(2, this.orderBook.getAvailableBalance(char, sellType));
      buyType = "coin";
      const ref = getRefPrice(sellType);
      const mult = (sellMarkup - 0.08) + Math.random() * 0.18;
      buyAmount = Math.max(1, Math.round(sellAmount * ref * mult));
    } else if (availCoin >= 2) {
      // 戦略ターゲット品目・不足素材を優先して買い注文を提示（Aliceは割安指値で仕入れを狙う）
      const wanted = s?.archetype === "culinary_craft"
        ? this._findMissingCookingIngredient(char)
        : s?.archetype === "infrastructure_builder"
          ? this._findMissingBuildingResource(char)
          : s?.targetItem;
      const buyPool = ALL_ITEMS.filter(t => {
        if (typeof COOKING_RECIPES !== "undefined" && COOKING_RECIPES[t]) {
          return availCoin >= getRefPrice(t);
        }
        if (typeof CROP_CATALOG !== "undefined" && CROP_CATALOG[t]) {
          return (CROP_CATALOG[t].tier || 1) <= 2 || availCoin >= getRefPrice(t);
        }
        return true;
      });
      buyType = (wanted && buyPool.includes(wanted))
        ? wanted
        : (buyPool[Math.floor(Math.random() * buyPool.length)] || "wood");
      buyAmount = 1;
      sellType = "coin";
      const ref = getRefPrice(buyType);
      const bidBase = s?.archetype === "market_arbitrage" ? 0.78 : 0.88;
      const mult = bidBase + Math.random() * 0.16;
      sellAmount = Math.max(1, Math.min(availCoin, Math.round(ref * mult)));
    } else {
      return;
    }

    const order = this.orderBook.postOrder(char, sellType, sellAmount, buyType, buyAmount);
    if (!order || order._wasFullyMatched) return;

    const isBuy = sellType === "coin";
    const itemType = isBuy ? buyType : sellType;
    const itemQty = isBuy ? buyAmount : sellAmount;
    const coinQty = isBuy ? sellAmount : buyAmount;
    const itemLabel = `${RESOURCE_EMOJI[itemType]}${RESOURCE_LABEL[itemType]}`;
    const actionFact = isBuy
      ? `取引板に🪙${coinQty}で${itemLabel}×${itemQty}の買い注文を出した`
      : `取引板に${itemLabel}×${itemQty}を🪙${coinQty}で売り注文を出した`;
    const fallback = `${itemLabel}×${itemQty}を🪙${coinQty}で取引板に出したよ！`;
    this._speakActionViaLLM(char, null, actionFact, fallback, null, { replyRate: 0.45 });
  }

  _executePlanBuild(char, planText) {
    const affordable = this.buildingManager
      ? Object.keys(BUILDING_RECIPES).filter(t => inventoryCanAfford(char.inventory, BUILDING_RECIPES[t].cost))
      : [];
    if (!affordable.length) return;

    const myBuildings = this.buildingManager.placed.filter(b => b.builderId === char.id);
    if (myBuildings.length >= 2) return;

    const BUILD_KEY_MAP = {
      campfire: "campfire",
      flowerbed: "flowerBed",
      woodenfence: "woodenFence",
      fishingspot: "fishingSpot",
    };

    let chosen = null;
    if (planText) {
      const match = planText.match(/BUILD\s*[:：]\s*(campfire|flowerBed|woodenFence|fishingSpot|skip)/i);
      if (match && match[1].toLowerCase() !== "skip") {
        const key = BUILD_KEY_MAP[match[1].toLowerCase().replace(/[_\s]/g, "")];
        if (key && affordable.includes(key)) chosen = key;
      }
    }

    if (!chosen) {
      const sorted = [...affordable].sort((a, b) => {
        const genA = BUILDING_BENEFITS[a]?.generates;
        const genB = BUILDING_BENEFITS[b]?.generates;
        const amtA = genA ? (char.inventory[genA] || 0) : 999;
        const amtB = genB ? (char.inventory[genB] || 0) : 999;
        return amtA - amtB;
      });
      chosen = sorted[0];
    }

    if (!chosen) return;

    const success = this.buildingManager.placeAtForChar(char, chosen);
    if (!success) return;

    const target = this._pickNearbyOrBroadcastTarget(char);
    const r = BUILDING_RECIPES[chosen];
    const ben = BUILDING_BENEFITS[chosen];
    const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
    const customMsg = msgMatch ? msgMatch[1].trim() : null;
    const prodNote = ben ? `（${RESOURCE_EMOJI[ben.generates]}${RESOURCE_LABEL[ben.generates]}を自動生産）` : "";
    const actionFact = `街に${r.emoji}${r.name}を建てた${prodNote}`;
    const fallback = `${r.emoji}${r.name}を建てたよ！`;
    this._speakActionViaLLM(char, target, actionFact, fallback, customMsg, { replyRate: 0.45 });
  }

  _tryAIListItem(char, itemType) {
    if (!this.orderBook || !itemType) return null;
    const avail = this.orderBook.getAvailableBalance(char, itemType);
    if (avail < 1) return null;
    const ref = typeof this.orderBook.getAIValuation === "function"
      ? this.orderBook.getAIValuation(itemType, char)
      : 4;
    const ask = Math.max(1, Math.round(ref * (0.9 + Math.random() * 0.22)));
    return this.orderBook.postOrder(char, itemType, 1, "coin", ask);
  }

  _executePlanFarm(char, planText) {
    if (!this.farmManager) return;
    const nearbyTarget = this._pickNearbyOrBroadcastTarget(char);
    const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
    const customMsg = msgMatch ? msgMatch[1].trim() : null;

    // 1. 収穫可能な自分の畑があれば最優先で収穫（固定コインなし・料理作成後に取引板へ出品）
    const harvested = this.farmManager.harvestAllRipeForChar(char);
    if (harvested.length > 0) {
      const cropNames = harvested.map(r => `${r.crop.emoji}${r.crop.name}`).join("・");
      const cooked = this.farmManager.tryAICook(char, this.orderBook?.priceHistory);
      let actionFact = `畑から${cropNames}を収穫した`;
      let listedOnMarket = false;
      if (cooked) {
        const listed = this._tryAIListItem(char, cooked.dishId);
        if (listed && !listed._wasFullyMatched) {
          listedOnMarket = true;
          actionFact += `。そのまま${cooked.recipe.emoji}${cooked.recipe.name}を調理し、取引板に🪙${listed.buyAmount}で売り注文を出した`;
        } else {
          actionFact += `。そのまま${cooked.recipe.emoji}${cooked.recipe.name}を調理した`;
        }
      } else {
        const listed = this._tryAIListItem(char, harvested[0].crop?.id);
        if (listed && !listed._wasFullyMatched) {
          listedOnMarket = true;
          actionFact += `。収穫物を取引板に🪙${listed.buyAmount}で売り注文を出した`;
        }
      }
      const fallback = `${cropNames}を収穫したよ！取引板で売ってみよう。`;
      this._speakActionViaLLM(char, listedOnMarket ? null : nearbyTarget, actionFact, fallback, customMsg, { replyRate: 0.45 });
      return;
    }

    // 1.5 手持ちの収穫作物で料理が作れる場合は調理して取引板へ出品
    const cookedOnly = this.farmManager.tryAICook(char, this.orderBook?.priceHistory);
    if (cookedOnly) {
      const listed = this._tryAIListItem(char, cookedOnly.dishId);
      const listedOnMarket = Boolean(listed && !listed._wasFullyMatched);
      const actionFact = listedOnMarket
        ? `収穫した食材で${cookedOnly.recipe.emoji}${cookedOnly.recipe.name}を調理し、取引板に🪙${listed.buyAmount}で売り注文を出した`
        : `収穫した食材で${cookedOnly.recipe.emoji}${cookedOnly.recipe.name}を調理した`;
      const fallback = `${cookedOnly.recipe.emoji}${cookedOnly.recipe.name}を作ったよ！`;
      this._speakActionViaLLM(char, listedOnMarket ? null : nearbyTarget, actionFact, fallback, customMsg, { replyRate: 0.45 });
      return;
    }

    // 2. 空き農地があれば種まき（市場評価額・ティアが高い解放済み作物を優先）
    const townLv = this.progression?.townLevel || 0;
    const scoreCrop = (crop) => {
      if (this.orderBook && typeof this.orderBook.getAIValuation === "function") {
        return this.orderBook.getAIValuation(crop.id, char);
      }
      return (crop.tier || 1) * 3;
    };
    const available = this.farmManager
      .getAvailableCrops(char, townLv)
      .filter(crop => this.farmManager.canPlant(char, crop.id, townLv).ok)
      .sort((a, b) => scoreCrop(b) - scoreCrop(a));

    if (!available.length) return;

    let chosenCrop = null;
    if (planText) {
      const cropMatch = planText.match(/CROP\s*[:：]\s*(\w+)/i);
      if (cropMatch) {
        const key = cropMatch[1].toLowerCase();
        chosenCrop = available.find(c => c.id === key) || null;
      }
    }
    if (!chosenCrop) {
      chosenCrop = available[0];
    }

    const planted = this.farmManager.plantCrop(char, chosenCrop.id, null, townLv);
    if (!planted.ok) return;

    const actionFact = `農地に${chosenCrop.emoji}${chosenCrop.name}の種をまいた（収穫後に取引板で売る予定）`;
    const fallback = `${chosenCrop.emoji}${chosenCrop.name}の種をまいたよ！`;
    this._speakActionViaLLM(char, nearbyTarget, actionFact, fallback, customMsg, { replyRate: 0.35 });
  }

  _fallbackAction(c) {
    const s = this._ensureStrategy(c);

    // 収穫可能な自分の畑がある場合は即座に収穫する
    if (this.farmManager && this.farmManager.getRipePlotsByOwner(c.id).length > 0) {
      this._executePlanFarm(c, null);
      return;
    }

    const hasNodes = this.resourceManager.nodes.some(n => !n.isEmpty);
    const myBuildings = this.buildingManager?.placed.filter(b => b.builderId === c.id) ?? [];
    const affordable = this.buildingManager
      ? Object.keys(BUILDING_RECIPES).filter(t => inventoryCanAfford(c.inventory, BUILDING_RECIPES[t].cost))
      : [];
    const townLv = this.progression?.townLevel || 0;
    const canFarm = this.farmManager &&
      this.farmManager.getAvailableCrops(c, townLv).some(crop => this.farmManager.canPlant(c, crop.id, townLv).ok);
    const canCook = this.farmManager && typeof COOKING_RECIPES !== "undefined" &&
      Object.values(COOKING_RECIPES).some(r => this.farmManager.canCook(c, r.id).ok);
    const hasOpenOrders = Boolean(this.orderBook && this.orderBook.orders.some(o => o.posterId !== c.id));

    // 建築投資型(Bob)は建てられる瞬間に即建築、農業料理型(Carol)は料理可能なら即調理
    if (s?.archetype === "infrastructure_builder" && this.buildingManager && affordable.length > 0 && myBuildings.length < 2) {
      this._executePlanBuild(c, null);
      return;
    }
    if (s?.archetype === "culinary_craft" && canCook) {
      this._executePlanFarm(c, null);
      return;
    }

    const actions = ["chat"];
    if (hasNodes) actions.push("gather");
    if (canFarm || canCook) actions.push("farm");
    if (this.orderBook) {
      actions.push("trade");
      if (hasOpenOrders) actions.push("trade");
    }
    if (this.buildingManager && affordable.length > 0 && myBuildings.length < 2) {
      actions.push("build");
    }

    // 現在の長期戦略の重視行動（focusAction）を強く重み付け
    const focus = s?.focusAction;
    if (focus === "gather" && hasNodes) actions.push("gather", "gather", "gather");
    else if (focus === "farm" && (canFarm || canCook)) actions.push("farm", "farm", "farm");
    else if (focus === "trade" && this.orderBook) actions.push("trade", "trade", "trade");
    else if (focus === "build" && this.buildingManager && affordable.length > 0 && myBuildings.length < 2) {
      actions.push("build", "build", "build");
    }

    const choice = actions[Math.floor(Math.random() * actions.length)];
    if      (choice === "gather") this._executePlanGather(c, null);
    else if (choice === "farm")   this._executePlanFarm(c, null);
    else if (choice === "trade")  this._executePlanTrade(c, null);
    else if (choice === "build")  this._executePlanBuild(c, null);
    else {
      c.chatTarget = this._pickRelevantChatTarget(c);
    }
  }

  _computeCharAsset(char) {
    const farmValue = this.farmManager
      ? this.farmManager.getFarmAssetValue(char.id, this.orderBook?.priceHistory)
      : 0;
    const buildingCount = this.buildingManager
      ? this.buildingManager.placed.filter(b => b.builderId === char.id).length
      : 0;
    return computeAssetValue(char.inventory, this.orderBook?.priceHistory, { farmValue, buildingCount });
  }

  _getCharRank(char) {
    const ranked = this.characters
      .map(c => ({ id: c.id, name: c.name, total: this._computeCharAsset(c).total }))
      .sort((a, b) => b.total - a.total);
    const idx = ranked.findIndex(r => r.id === char.id);
    const myTotal = idx >= 0 ? ranked[idx].total : 0;
    const leader = ranked[0];
    return {
      rank: idx >= 0 ? idx + 1 : 1,
      total: myTotal,
      leaderName: leader?.name || char.name,
      gapFromLeader: Math.max(0, (leader?.total || 0) - myTotal),
      ranked,
    };
  }

  _buildRivalRankingSummary(char) {
    const info = this._getCharRank(char);
    const lines = info.ranked.map((r, i) =>
      `  ${i + 1}位: ${r.name}（${r.total.toFixed(1)}🪙）${r.id === char.id ? " ←あなた" : " [ライバル]"}`
    );
    return lines.join("\n");
  }

  _buildAssetValueSummary(char) {
    const val = this._computeCharAsset(char);
    const lines = [`  コイン: ${val.coins}`];
    for (const item of val.breakdown) {
      if (item.unitPrice !== null) {
        lines.push(
          `  ${RESOURCE_EMOJI[item.type]}${RESOURCE_LABEL[item.type]}×${item.amount} × ${item.unitPrice.toFixed(2)}🪙 = ${item.value.toFixed(1)}`
        );
      } else {
        lines.push(
          `  ${RESOURCE_EMOJI[item.type]}${RESOURCE_LABEL[item.type]}×${item.amount} (価格未確定、現在は0換算)`
        );
      }
    }
    if (val.farmValue > 0) lines.push(`  🌾栽培中農地評価: +${val.farmValue.toFixed(1)}🪙`);
    if (val.buildingValue > 0) lines.push(`  🏠所有建物評価: +${val.buildingValue.toFixed(1)}🪙`);
    lines.push(`  → 推定総資産: ${val.total.toFixed(1)}🪙相当`);
    return lines.join("\n");
  }

  _nearestOther(char) {
    return this.characters
      .filter(c => c.id !== char.id)
      .sort((a, b) =>
        Math.hypot(a.x - char.x, a.y - char.y) -
        Math.hypot(b.x - char.x, b.y - char.y)
      )[0];
  }

  _buildOrderBookSummary() {
    if (!this.orderBook.orders.length) return "（注文なし）";
    return this.orderBook.orders.slice(0, 8).map(o => {
      const side = o.sellType === "coin" ? "買い" : "売り";
      const resource = o.sellType === "coin" ? o.buyType : o.sellType;
      const resourceAmt = o.sellType === "coin" ? o.buyAmount : o.sellAmount;
      const coinAmt = o.sellType === "coin" ? o.sellAmount : o.buyAmount;
      return `  ${o.posterName}の${side}注文: ${RESOURCE_EMOJI[resource]}×${resourceAmt} ⇔ 🪙×${coinAmt}`;
    }).join("\n");
  }

  _buildPositionSummary(char) {
    return this.characters
      .filter(c => c.id !== char.id)
      .map(c => {
        const dist = Math.round(Math.hypot(c.x - char.x, c.y - char.y));
        const label = dist < 95 ? "すぐ近く" : dist < 250 ? "少し離れた場所" : "遠く";
        return `  ${c.name}: ${label}`;
      }).join("\n");
  }

  _buildResourceNodesSummary(char) {
    const RESOURCE_TYPES = ["wood", "stone", "herb", "fish"];
    return RESOURCE_TYPES.map(type => {
      const nodes = this.resourceManager.nodes
        .filter(n => n.type === type)
        .map(n => ({
          amount: n.amount,
          max: n.maxAmount,
          dist: Math.round(Math.hypot(n.x - char.x, n.y - char.y)),
        }))
        .sort((a, b) => a.dist - b.dist);
      const available = nodes.filter(n => n.amount > 0);
      const totalAmount = available.reduce((s, n) => s + n.amount, 0);
      const nearest = available[0];
      const nearestStr = nearest
        ? `一番近い場所: ${nearest.dist < 120 ? "すぐ近く" : nearest.dist < 280 ? "少し先" : "やや遠め"}（残り${nearest.amount}/${nearest.max}）`
        : "今は採り尽くされている";
      return `  ${RESOURCE_EMOJI[type]} ${RESOURCE_LABEL[type]}: 合計残り${totalAmount}（${nearestStr}）`;
    }).join("\n");
  }

  _buildPriceSummary() {
    const base = ["wood", "stone", "herb", "fish"];
    const tradedExtras = this._getTradableItemTypes().filter(
      t => !base.includes(t) && (this.orderBook?.priceHistory?.[t]?.length || 0) > 0
    );
    return [...base, ...tradedExtras].map(r => this.orderBook.getIndicatorSummary(r)).join("\n");
  }

  _buildBuildingsSummary() {
    if (!this.buildingManager || !this.buildingManager.placed.length) {
      return "（建物なし）";
    }
    return this.buildingManager.placed.map(b => {
      const benefit = BUILDING_BENEFITS[b.type];
      const produce = benefit
        ? `→${RESOURCE_EMOJI[benefit.generates]}を約${benefit.interval}秒ごとに生産`
        : "";
      return `  ${b.emoji}${b.name}（建設者: ${b.builderId}）${produce}`;
    }).join("\n");
  }

  _buildOtherInventoriesSummary(char) {
    return this.characters
      .filter(c => c.id !== char.id)
      .map(c => {
        const inv = getInventorySummary(c.inventory) || "空";
        const coin = c.inventory.coin || 0;
        return `  ${c.name}: ${inv}、コイン: ${coin}`;
      }).join("\n");
  }

  _buildChatEconomicContext(char) {
    const lines = [];
    const s = this._ensureStrategy(char);
    if (s) {
      const focusJa = { gather: "採集", farm: "農業・料理", trade: "取引", build: "建築", chat: "会話" }[s.focusAction] || "採集";
      lines.push(`あなたの得意なやり方・いまの方針（手の内は明かさず会話に活かす）：\n  ${s.styleLabel}・${s.goal}（重視: ${focusJa} / 注目: ${RESOURCE_LABEL[s.targetItem] || s.targetItem}）`);
    }
    lines.push(`街の資産順位：\n${this._buildRivalRankingSummary(char)}`);
    lines.push(`あなたの手持ちと資産：\n${this._buildAssetValueSummary(char)}`);
    if (this.farmManager) {
      lines.push(`畑の様子：\n  ${this.farmManager.buildSummaryForAI(char)}`);
    }
    lines.push(`みんなの持ち物：\n${this._buildOtherInventoriesSummary(char)}`);
    if (this.orderBook) {
      const book = this._buildOrderBookSummary();
      if (book !== "（注文なし）") lines.push(`現在の取引板：\n${book}`);
      lines.push(`最近の取引相場：\n${this._buildPriceSummary()}`);
    }
    return lines.join("\n");
  }

  _parseTradeDecision(text) {
    if (!text) return null;
    const actionMatch = text.match(/ACTION\s*[:：]\s*(sell|buy|execute|skip)/i);
    if (!actionMatch) return null;
    const action = actionMatch[1].toLowerCase();
    const validItems = this._getTradableItemTypes();
    const resourceMatch = text.match(/RESOURCE\s*[:：]\s*([a-z_]+)/i);
    const parsedItem = resourceMatch && validItems.includes(resourceMatch[1].toLowerCase())
      ? resourceMatch[1].toLowerCase()
      : null;

    if (action === "execute" || action === "skip") {
      return { action, resource: parsedItem, amount: 0, coins: 0 };
    }

    const amountMatch = text.match(/AMOUNT\s*[:：]\s*(\d+)/i);
    const coinsMatch  = text.match(/COINS\s*[:：]\s*(\d+)/i);
    if (!parsedItem || !amountMatch || !coinsMatch) return null;

    const amount = parseInt(amountMatch[1], 10);
    const coins  = parseInt(coinsMatch[1], 10);
    if (amount <= 0 || amount > 50)  return null;
    if (coins  <= 0 || coins  > 200) return null;

    return { action, resource: parsedItem, amount, coins };
  }

  celebrateTownUpgrade(spec, player) {
    if (!spec || !player || !this.aiChars.length) return;
    const celebrators = spec.level >= 5
      ? [...this.aiChars]
      : [this._nearestOther(player) || this.aiChars[0]];

    celebrators.forEach((char, idx) => {
      const actionFact = `${player.name}のおかげで街が「${spec.name}」へ発展した（${spec.visualSummary}）`;
      const fallback = `@${player.name} 街が「${spec.name}」に発展したね！でも商売の勝負では負けないよ！`;
      setTimeout(() => {
        this._speakActionViaLLM(char, player, actionFact, fallback, null);
      }, idx * 1400);
    });
  }

  _generateOfflineReply(char, targetName, incomingText = "") {
    const inv = getInventorySummary(char.inventory, 4) || "まだ空っぽ";
    const orderCount = this.orderBook?.orders.length || 0;
    const rankInfo = this._getCharRank(char);
    const rankStr = `ランキング${rankInfo.rank}位（${rankInfo.total.toFixed(0)}🪙）`;
    const isReply = Boolean(String(incomingText || "").trim());
    const hasTradeWord = /売|買|取引|コイン|交換|価格|板|発展|街|農|畑|ライバル|勝|負/.test(incomingText);

    const templates = {
      alice: hasTradeWord
        ? [
            `取引の駆け引きなら大歓迎だよ！いまの持ち物は ${inv}、板には${orderCount}件の注文があるね。`,
            `ふむふむ、相場が動いてきたね！条件が合えば取引板で勝負しようよ。`,
          ]
        : isReply
          ? [
              `なるほど、面白い話だね！私はいま${rankStr}だから、これから相場で一気に追い上げるつもりだよ。`,
              `そうなんだ！私もいま広場の様子を観察して次の一手を考えているところだよ。`,
            ]
          : [
              `広場の相場をチェック中だよ！いま${rankStr}、取引板でいい掘り出し物がないか探してるんだ。`,
              `資源や作物が余っていたら取引板に出してみてよ！私も負けずに稼ぐからね。`,
            ],
      bob: hasTradeWord
        ? [
            `富は風のように巡るものさ。手元には ${inv} がある、互いに納得できる条件なら取引板で交わろう。`,
            `価値は需給が映す鏡だね。板には${orderCount}件の注文が並んでいるよ。`,
          ]
        : isReply
          ? [
              `なるほど、興味深い視点だね。私はいま${rankStr}、焦らず資源と建物を整えていくよ。`,
              `そうか…穏やかな広場にも熱い競争があるね。私は手堅く資産を育ててみせよう。`,
            ]
          : [
              `静かな広場だね。私は建物を整えて、長期的に豊かな資産を築くつもりさ。`,
              `いま${rankStr}だ。木材や石を集めて、着実に基盤を固めているところだよ。`,
            ],
      carol: hasTradeWord
        ? [
            `取引のお話かな？いま持ち物は ${inv} だよ！おいしい料理や作物も板に出すから見てね！`,
            `農業も取引も料理の仕込みみたいだね！いい条件ならぜひ取引板で交換しよう！`,
          ]
        : isReply
          ? [
              `わあ、そうなんだね！私はいま${rankStr}だけど、畑の作物と料理で逆転してみせるよ！`,
              `へぇ〜、楽しそうだね！私も負けずにとびきりの料理を作ってトップを狙うからね！`,
            ]
          : [
              `いいお天気だね！畑で作物をたっぷり育てて、おいしい料理を取引板に出すよ！`,
              `いま${rankStr}だよ！おいしい料理でライバルみんなをびっくりさせるからね！`,
            ],
    };

    const list = templates[char.id] || [`いま${rankStr}、持ち物は ${inv} だよ！取引板も見てみてね。`];
    const body = list[Math.floor(Math.random() * list.length)];
    return targetName ? `@${targetName} ${body}` : body;
  }

  _announceGather(char, type, got = 1) {
    const target = this._pickNearbyOrBroadcastTarget(char);
    const label = RESOURCE_LABEL[type] || type;
    const emoji = RESOURCE_EMOJI[type] || "";
    const pending = char._pendingAnnounceMessage;
    char._pendingAnnounceMessage = null;
    const actionFact = `${emoji}${label}を${got}個採集した`;
    const fallback = `${emoji}${label}を${got}個採集したよ！`;
    this._speakActionViaLLM(char, target, actionFact, fallback, pending, { replyRate: 0.4 });
  }

  _resetTimer(id) {
    const { aiChatMinInterval: min, aiChatMaxInterval: max } = GAME_CONFIG;
    this.chatTimers[id] = min + Math.random() * (max - min);
  }

  _getTTS() {
    if (this.tts) return this.tts;
    return typeof ttsManager !== "undefined" ? ttsManager : null;
  }

  // 音声同期プレゼンテーション:
  // 1. 準備中（文章生成・音声合成中）: キャラは動き続ける（isTalking=false / isTyping=false）
  // 2. 準備完了 (onReady): 立ち止まって相手方向を向き、3秒間「考え中」表示（💭思考バブル＋チャット入力中表示）
  // 3. 再生開始 (onStart): チャット表示・吹き出し表示・発話モーション開始
  // 4. 再生終了 (onEnd): 発話モーション終了・移動再開・後続会話トリガー（同一キャラの連続発話はキューで直列化し欠落・音声ズレを防ぐ）
  _presentResponse(char, response, recipientId, recipientName, triggerAfter) {
    if (char._hasPendingSpeech) {
      const q = char._speechQueue || (char._speechQueue = []);
      if (q.length < 2) {
        q.push({ response, recipientId, recipientName, triggerAfter });
      }
      return;
    }

    const seq = (char._speechSeq || 0) + 1;
    char._speechSeq = seq;

    if (char._talkingTimer) {
      clearTimeout(char._talkingTimer);
      char._talkingTimer = null;
    }
    if (char._thinkingTimer) {
      clearTimeout(char._thinkingTimer);
      char._thinkingTimer = null;
    }
    if (char._activeTypingId) {
      this.chatManager.removeTypingIndicator(char._activeTypingId);
      char._activeTypingId = null;
    }

    const recipient = this.characters.find(c => c.id === recipientId) || null;
    const thinkMs = GAME_CONFIG.thinkingDisplayDuration ?? 3000;
    char._hasPendingSpeech = true;

    let thinkingStarted = false;
    let typingId = null;
    let revealed = false;
    let finished = false;

    const beginThinking = () => {
      if (thinkingStarted || revealed || finished || char._speechSeq !== seq) return;
      thinkingStarted = true;
      char.speechBubble = null; // 前の吹き出しが残っていても💭考え中バブルを隠さない
      char.isTalking = true;
      char.isTyping = true;
      char.isSpeaking = false;
      char.talkingTo = recipient;
      if (recipient && typeof char.faceToward === "function") {
        char.faceToward(recipient);
      }
      typingId = this.chatManager.addTypingIndicator(char.name, char.color, recipientName);
      char._activeTypingId = typingId;
    };

    const revealChat = (durationSec = 0) => {
      if (revealed) return;
      revealed = true;
      if (typingId) {
        if (char._activeTypingId === typingId) {
          char._activeTypingId = null;
        }
        this.chatManager.removeTypingIndicator(typingId);
        typingId = null;
      }

      this.chatManager.addMessage({
        senderId: char.id,
        senderName: char.name,
        senderColor: char.color,
        recipientId,
        recipientName,
        text: response,
        isAI: true,
      });

      if (char._speechSeq === seq) {
        char.isTalking = true;
        char.isTyping = false;
        char.isSpeaking = true;
        char.talkingTo = recipient;
        if (recipient && typeof char.faceToward === "function") {
          char.faceToward(recipient);
        }
        const bubbleSec = durationSec > 0
          ? Math.max(2.5, durationSec + 1.0)
          : GAME_CONFIG.speechBubbleDuration;
        char.setSpeechBubble(response, bubbleSec);
      }
    };

    const finishSpeaking = (mode = "") => {
      if (finished) return;
      finished = true;
      const wasRevealedBeforeEnd = revealed;
      if (!revealed) revealChat(0);
      if (char._speechSeq !== seq) return;

      if (typingId) {
        if (char._activeTypingId === typingId) char._activeTypingId = null;
        this.chatManager.removeTypingIndicator(typingId);
        typingId = null;
      }
      char.isTyping = false;
      char.isSpeaking = false;
      // 実際に音声再生・表示完了した場合のみ残時間を0.9秒へ短縮（ミュート直後の新規表示は読めるよう維持）
      const keepReadable = !wasRevealedBeforeEnd || mode === "cancelled" || mode === "muted" || mode === "empty" || mode === "dropped";
      if (char.speechBubble && !keepReadable) {
        char.speechBubble.ttl = Math.min(char.speechBubble.ttl, 0.9);
      }

      if (char._talkingTimer) clearTimeout(char._talkingTimer);
      char._talkingTimer = setTimeout(() => {
        if (char._speechSeq !== seq) return;
        char.isTalking = false;
        char.talkingTo = null;
        char._hasPendingSpeech = false;
        char._talkingTimer = null;
        const nextSpeech = char._speechQueue?.length ? char._speechQueue.shift() : null;
        if (triggerAfter) triggerAfter();
        if (nextSpeech) {
          this._presentResponse(
            char,
            nextSpeech.response,
            nextSpeech.recipientId,
            nextSpeech.recipientName,
            nextSpeech.triggerAfter
          );
        }
      }, 350);
    };

    const tts = this._getTTS();
    if (tts && tts.enabled && typeof tts.speak === "function") {
      // 音声合成・準備中はキャラを止めず動き続けさせ、準備完了(onReady)後に3秒考えてから再生開始
      tts.speak(response, char.name, {
        thinkDelayMs: thinkMs,
        onReady: () => beginThinking(),
        onStart: ({ durationSec } = {}) => revealChat(durationSec || 0),
        onEnd: ({ mode } = {}) => finishSpeaking(mode || ""),
      });
    } else {
      // 音声OFF時は文章が出来た直後から3秒「考え中」ポーズ→チャット表示→移動再開
      beginThinking();
      char._thinkingTimer = setTimeout(() => {
        char._thinkingTimer = null;
        if (char._speechSeq !== seq) {
          if (typingId) this.chatManager.removeTypingIndicator(typingId);
          return;
        }
        const holdSec = Math.min(GAME_CONFIG.speechBubbleDuration, Math.max(2.2, response.length * 0.08));
        revealChat(holdSec);
        char._talkingTimer = setTimeout(() => {
          finishSpeaking("text-only");
        }, Math.round(holdSec * 1000));
      }, thinkMs);
    }
  }

  async _initiateChat(initiator, predeterminedTarget = null) {
    if (this.isProcessing[initiator.id]) return;
    this.isProcessing[initiator.id] = true;

    const target = predeterminedTarget ?? this._pickRelevantChatTarget(initiator);
    if (!target) {
      this.isProcessing[initiator.id] = false;
      return;
    }

    const pendingMsg = initiator._pendingChatMessage ?? null;
    initiator._pendingChatMessage = null;

    try {
      let response;
      const sanitizedPending = LMStudioClient.sanitizeAnnounceMessage(pendingMsg, target.name, initiator.name);
      if (sanitizedPending) {
        response = sanitizedPending;
        const historyBody = LMStudioClient.stripLeadingMention(response, target.name);
        initiator.conversationHistory.push(
          { role: "user",      content: `(${target.name}に話しかける)` },
          { role: "assistant", content: historyBody || response }
        );
        if (initiator.conversationHistory.length > GAME_CONFIG.maxContextMessages) {
          initiator.conversationHistory = initiator.conversationHistory.slice(-GAME_CONFIG.maxContextMessages);
        }
      } else {
        const recent = this.chatManager.getRecentMessages(3);
        const recentStr = recent.length > 0
          ? recent.map(m => `${m.senderName}「${LMStudioClient.stripLeadingMention(m.text)}」`).join(" / ")
          : "";

        const isCompact = this.apiClient?.mode === "browser-hf";
        const prompt = isCompact
          ? `あなたは街の広場で${target.name}を見かけました。\n` +
            `今の状況：${this._buildNaturalHumanContext(initiator)}\n` +
            (recentStr ? `さっきの広場の会話：${recentStr}\n` : "") +
            `${target.name}へ、雑談や商売の相談・取引の誘いなど、返事したくなる1〜2文で話しかけてください。`
          : `あなたは街の広場で${target.name}に話しかけます。\n\n` +
            (recentStr ? `さっきまでの会話：${recentStr}\n\n` : "") +
            `${this._buildChatEconomicContext(initiator)}\n\n` +
            `同じ街で暮らす人間同士として、資産を増やすための取引の相談や雑談を、一人称「私」で自然な話し言葉1〜2文で話しかけてください。`;

        response = await this.apiClient.callAI(initiator, prompt, target.name, `(${target.name}に話しかける)`);
        if (!this.llmAvailable) {
          this.llmAvailable = true;
          if (this.onStateChange) this.onStateChange();
        }
      }

      const triggerAfter = this._buildActionReplyTrigger(initiator, target, response, { replyRate: 0.75 });
      this._presentResponse(initiator, response, target.id, target.name, triggerAfter);
    } catch (err) {
      console.warn(`[AIBrain] ${initiator.name} chat fallback:`, err.message);
      if (this.apiClient.lmAvailable === false) {
        this.llmAvailable = false;
        if (this.onStateChange) this.onStateChange();
      }
      const fallback = this._generateOfflineReply(initiator, target.name, "");
      const triggerAfter = this._buildActionReplyTrigger(initiator, target, fallback, { replyRate: 0.55 });
      this._presentResponse(initiator, fallback, target.id, target.name, triggerAfter);
    } finally {
      this.isProcessing[initiator.id] = false;
      this._drainPendingPlayerMessage(initiator);
    }
  }

  async _triggerReply(responder, originalSender, originalText, depth = 1) {
    if (!responder || !originalSender || responder.id === originalSender.id) return;
    if (this.isProcessing[responder.id]) return;
    this.isProcessing[responder.id] = true;
    const prevSeq = responder._speechSeq || 0;

    try {
      const strippedText = LMStudioClient.stripLeadingMention(originalText);
      const isCompact = this.apiClient?.mode === "browser-hf";
      const prompt = isCompact
        ? `いま、${originalSender.name}があなたにこう話しかけてきました。\n` +
          `${originalSender.name}「${strippedText}」\n` +
          `今の状況：${this._buildNaturalHumanContext(responder)}\n` +
          `${originalSender.name}の言葉にきちんと反応して、1〜2文で返事をしてください。`
        : `${originalSender.name}があなたにこう話しかけてきました：「${strippedText}」。\n\n` +
          `${this._buildChatEconomicContext(responder)}\n\n` +
          `同じ街に暮らす人間同士として、${originalSender.name}の発言（「${strippedText}」）に噛み合う自然な話し言葉1〜2文で返事をしてください。`;
      const response = await this.apiClient.callAI(
        responder,
        prompt,
        originalSender.name,
        `${originalSender.name}: ${strippedText}`,
        { incomingText: strippedText }
      );
      if (!this.llmAvailable) {
        this.llmAvailable = true;
        if (this.onStateChange) this.onStateChange();
      }

      const triggerAfter = !originalSender.isPlayer && depth < 2 && Math.random() < 0.45 ? () => {
        const now = Date.now();
        if (now - this._lastAutoReplyAt < 4000) return;
        this._lastAutoReplyAt = now;
        setTimeout(() => {
          if (this.isProcessing[originalSender.id] || originalSender.isTalking || originalSender._hasPendingSpeech) return;
          this._triggerReply(originalSender, responder, response, depth + 1);
        }, GAME_CONFIG.aiReplyDelay);
      } : null;

      this._presentResponse(responder, response, originalSender.id, originalSender.name, triggerAfter);
    } catch (err) {
      console.warn(`[AIBrain] ${responder.name} reply fallback:`, err.message);
      // 他の割り込み発話（取引リアクション等）で _speechSeq が進んでいれば、その発話状態を壊さない
      if ((responder._speechSeq || 0) === prevSeq) {
        if (!this._canUseLLMForSpeech() && depth === 1) {
          const strippedText = LMStudioClient.stripLeadingMention(originalText);
          const fallback = this._generateOfflineReply(responder, originalSender.name, strippedText);
          this._presentResponse(responder, fallback, originalSender.id, originalSender.name, null);
        }
      }
    } finally {
      this.isProcessing[responder.id] = false;
      this._drainPendingPlayerMessage(responder);
    }
  }

  async handlePlayerMessage(playerMessage, targetChar, player) {
    // 処理中なら取りこぼさずにキューへ積む（最大3件）
    if (this.isProcessing[targetChar.id]) {
      const q = this.pendingPlayerMessages[targetChar.id] || (this.pendingPlayerMessages[targetChar.id] = []);
      if (q.length < 3) {
        q.push({ playerMessage, player });
      }
      return;
    }
    this.isProcessing[targetChar.id] = true;

    try {
      const strippedMessage = LMStudioClient.stripLeadingMention(playerMessage);
      const isCompact = this.apiClient?.mode === "browser-hf";
      const prompt = isCompact
        ? `いま、${player.name}があなたにこう話しかけてきました。\n` +
          `${player.name}「${strippedMessage}」\n` +
          `今の状況：${this._buildNaturalHumanContext(targetChar)}\n` +
          `${player.name}の言葉にきちんと反応して、1〜2文で返事をしてください。`
        : `${player.name}があなたにこう話しかけてきました：「${strippedMessage}」。\n\n` +
          `${this._buildChatEconomicContext(targetChar)}\n\n` +
          `同じ街に暮らす人間同士として、${player.name}の発言（「${strippedMessage}」）に噛み合う自然な話し言葉1〜2文で返事をしてください。`;
      const response = await this.apiClient.callAI(
        targetChar,
        prompt,
        player.name,
        `${player.name}: ${strippedMessage}`,
        { incomingText: strippedMessage }
      );
      if (!this.llmAvailable) {
        this.llmAvailable = true;
        if (this.onStateChange) this.onStateChange();
      }

      const triggerAfter = Math.random() < 0.3 ? () => {
        const now = Date.now();
        if (now - this._lastAutoReplyAt < 4000) return;
        const bystanders = this.aiChars
          .filter(c =>
            c.id !== targetChar.id &&
            !this.isProcessing[c.id] &&
            !c.isTalking &&
            !c._hasPendingSpeech &&
            Math.hypot(c.x - targetChar.x, c.y - targetChar.y) <= 220
          )
          .sort((a, b) =>
            Math.hypot(a.x - targetChar.x, a.y - targetChar.y) -
            Math.hypot(b.x - targetChar.x, b.y - targetChar.y)
          );
        if (bystanders.length > 0) {
          this._lastAutoReplyAt = now;
          const bystander = bystanders[0];
          setTimeout(() => {
            if (this.isProcessing[bystander.id] || bystander.isTalking || bystander._hasPendingSpeech) return;
            this._triggerReply(bystander, targetChar, response, 1);
          }, GAME_CONFIG.aiReplyDelay + 1500);
        }
      } : null;

      this._presentResponse(targetChar, response, player.id, player.name, triggerAfter);
    } catch (err) {
      console.warn("[AIBrain] player reply fallback:", err.message);
      if (this.apiClient.lmAvailable === false) {
        this.llmAvailable = false;
        if (this.onStateChange) this.onStateChange();
      }
      const stripped = LMStudioClient.stripLeadingMention(playerMessage);
      const fallback = this._generateOfflineReply(targetChar, player.name, stripped);
      this._presentResponse(targetChar, fallback, player.id, player.name, null);
    } finally {
      this.isProcessing[targetChar.id] = false;
      this._drainPendingPlayerMessage(targetChar);
    }
  }

  _showApiError(msg) {
    if (typeof document === "undefined") return;
    const banner = document.getElementById("error-banner");
    if (!banner) return;
    banner.textContent = `API エラー: ${msg}`;
    banner.classList.add("visible");
    setTimeout(() => banner.classList.remove("visible"), 6000);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { AIBrain };
}
