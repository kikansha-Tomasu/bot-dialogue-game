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
          this._announceGather(c, node.type);
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

      if (this.isProcessing[c.id] || c.gatherTarget || c.chatTarget || c.isTalking) return;
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

  async _aiDoMasterAction(c) {
    if (this.isProcessing[c.id]) return;

    // ε-greedy 探索確率時のみランダム行動（それ以外は常に Hugging Face へ接続を試みる）
    if (Math.random() < GAME_CONFIG.aiRandomActionRate) {
      this._fallbackAction(c);
      return;
    }

    this.isProcessing[c.id] = true;

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
    const nearest = this._nearestOther(c);

    const townLine = this.progression
      ? `現在の街レベル: Lv.${this.progression.townLevel}「${this.progression.getTownSpec().name}」\n`
      : "";
    const farmLine = this.farmManager
      ? `農地の状況: ${this.farmManager.buildSummaryForAI(c)}\n`
      : "";

    const context =
      `あなた（${c.name}）のインベントリ: ${invSummary}、コイン: ${coinAmt}\n` +
      townLine +
      `ライバル総資産ランキング（全員が1位を競うライバルです）:\n${this._buildRivalRankingSummary(c)}\n` +
      `現在の推定総資産内訳:\n${this._buildAssetValueSummary(c)}\n` +
      `他のライバルのインベントリ:\n${this._buildOtherInventoriesSummary(c)}\n` +
      `キャラクター位置:\n${this._buildPositionSummary(c)}\n` +
      `資源ノードの残量:\n${this._buildResourceNodesSummary(c)}\n` +
      farmLine +
      `現在稼働中の建物:\n${this._buildBuildingsSummary()}\n` +
      (this.orderBook ? `現在の注文板:\n${this._buildOrderBookSummary()}\n` : "") +
      `直近の取引価格:\n${this._buildPriceSummary()}\n` +
      `建築可能な建物: ${affordable.length ? affordable.map(t => `${BUILDING_RECIPES[t].emoji}${BUILDING_RECIPES[t].name}`).join(", ") : "なし（資源不足）"}\n` +
      `自分の建物数: ${myBuildings.length}/2\n` +
      `資源ノードの空き: ${hasNodes ? "あり" : "なし（全枯渇）"}\n` +
      (executableOrders.length > 0 ? `板に今すぐ成立させられる注文が${executableOrders.length}件あります。trade + execute で約定できます。\n` : "") +
      `次に何をするか決めてください。`;

    let planText = null;
    try {
      planText = await this.apiClient.callAIForMasterAction(c, context, nearest?.name || "Player");
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
      c.chatTarget = chatTarget ?? others[Math.floor(Math.random() * others.length)];
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

  _executePlanTrade(char, planText) {
    const RESOURCE_TYPES = ["wood", "stone", "herb", "fish"];
    const decision = planText ? this._parseTradeDecision(planText) : null;
    const target = this._nearestOther(char);

    const formatAnnounce = (rawMsg, fallbackText) => {
      const sanitized = LMStudioClient.sanitizeAnnounceMessage(rawMsg, target.name);
      return sanitized || fallbackText;
    };

    if (decision) {
      const { action, resource, amount, coins } = decision;
      const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
      const customMsg = msgMatch ? msgMatch[1].trim() : null;

      if (action === "execute") {
        const executed = this.orderBook.tryAIExecute(char, resource);
        if (executed) {
          const text = formatAnnounce(
            customMsg,
            `@${executed.posterName} 注文を成立させたよ！${RESOURCE_EMOJI[executed.buyType]}×${executed.buyAmount}と${RESOURCE_EMOJI[executed.sellType]}×${executed.sellAmount}を交換したね`
          );
          this._presentResponse(char, text, executed.posterId, executed.posterName, null);
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
              const text = formatAnnounce(
                customMsg,
                `@${target.name} ${RESOURCE_EMOJI[resource]}×${sellAmt}を🪙${coins}で売りに出したよ！`
              );
              this._presentResponse(char, text, target.id, target.name, null);
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
              const text = formatAnnounce(
                customMsg,
                `@${target.name} 🪙${spendCoin}で${RESOURCE_EMOJI[resource]}×${amount}を買いたいな！注文を出したよ`
              );
              this._presentResponse(char, text, target.id, target.name, null);
            }
            return;
          }
        }
      }
    }

    // フォールバック：相場連動型の売買または既存注文の約定
    if (Math.random() < 0.45) {
      const executed = this.orderBook.tryAIExecute(char);
      if (executed) {
        const text = `@${executed.posterName} ${executed.posterName}の注文を成立させたよ！${RESOURCE_EMOJI[executed.buyType]}×${executed.buyAmount}と${RESOURCE_EMOJI[executed.sellType]}×${executed.sellAmount}を交換したね`;
        this._presentResponse(char, text, executed.posterId, executed.posterName, null);
        return;
      }
    }

    const haveResources = RESOURCE_TYPES.filter(
      t => this.orderBook.getAvailableBalance(char, t) >= 1
    );
    const availCoin = this.orderBook.getAvailableBalance(char, "coin");
    let sellType, buyType, sellAmount, buyAmount;

    const getRefPrice = (resType) => {
      const hist = this.orderBook.priceHistory[resType];
      if (hist && hist.length > 0) return hist[hist.length - 1];
      return 2.0;
    };

    if (haveResources.length > 0 && (Math.random() < 0.6 || availCoin < 1)) {
      sellType = haveResources[Math.floor(Math.random() * haveResources.length)];
      sellAmount = Math.min(2, this.orderBook.getAvailableBalance(char, sellType));
      buyType = "coin";
      const ref = getRefPrice(sellType);
      buyAmount = Math.max(1, Math.round(sellAmount * (ref + (Math.random() - 0.35))));
    } else if (availCoin >= 1) {
      buyType = RESOURCE_TYPES[Math.floor(Math.random() * RESOURCE_TYPES.length)];
      buyAmount = 1;
      sellType = "coin";
      const ref = getRefPrice(buyType);
      sellAmount = Math.max(1, Math.min(availCoin, Math.round(ref + (Math.random() - 0.5))));
    } else {
      return;
    }

    const order = this.orderBook.postOrder(char, sellType, sellAmount, buyType, buyAmount);
    if (!order || order._wasFullyMatched) return;

    const text = `@${target.name} ${RESOURCE_EMOJI[sellType]}×${sellAmount}と${RESOURCE_EMOJI[buyType]}×${buyAmount}を交換したい！板に注文を出したよ`;
    this._presentResponse(char, text, target.id, target.name, null);
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

    const target = this._nearestOther(char);
    const r = BUILDING_RECIPES[chosen];
    const ben = BUILDING_BENEFITS[chosen];
    const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
    const fallback = `@${target.name} ${r.emoji}${r.name}を建てたよ！${ben ? RESOURCE_EMOJI[ben.generates] + "が生産されるね" : ""}`;
    const text = LMStudioClient.sanitizeAnnounceMessage(msgMatch ? msgMatch[1] : null, target.name) || fallback;
    this._presentResponse(char, text, target.id, target.name, null);
  }

  _executePlanFarm(char, planText) {
    if (!this.farmManager) return;
    const target = this._nearestOther(char);
    const msgMatch = planText?.match(/MESSAGE\s*[:：]\s*(.+)/i);
    const customMsg = msgMatch ? msgMatch[1].trim() : null;

    // 1. 収穫可能な自分の畑があれば最優先で収穫（料理も作れれば連続クラフト）
    const harvested = this.farmManager.harvestAllRipeForChar(char);
    if (harvested.length > 0) {
      let totalCoins = harvested.reduce((s, r) => s + r.rewardCoins, 0);
      const cropNames = harvested.map(r => `${r.crop.emoji}${r.crop.name}`).join("・");
      const cooked = this.farmManager.tryAICook(char);
      if (cooked) totalCoins += cooked.rewardCoins;
      const cookNote = cooked ? `さらに${cooked.recipe.emoji}${cooked.recipe.name}を調理して` : "";
      const rankInfo = this._getCharRank(char);
      const fallback = `@${target.name} 畑から${cropNames}を収穫！${cookNote}合計🪙+${totalCoins}ゲット！現在${rankInfo.rank}位（${rankInfo.total.toFixed(1)}🪙）、負けないよ！`;
      const text = LMStudioClient.sanitizeAnnounceMessage(customMsg, target.name) || fallback;
      this._presentResponse(char, text, target.id, target.name, null);
      return;
    }

    // 1.5 手持ちの収穫食材で料理が作れる場合は調理してコイン獲得
    const cookedOnly = this.farmManager.tryAICook(char);
    if (cookedOnly) {
      const rankInfo = this._getCharRank(char);
      const fallback = `@${target.name} 収穫した食材で${cookedOnly.recipe.emoji}${cookedOnly.recipe.name}を作って🪙+${cookedOnly.rewardCoins}稼いだよ！現在${rankInfo.rank}位！`;
      const text = LMStudioClient.sanitizeAnnounceMessage(customMsg, target.name) || fallback;
      this._presentResponse(char, text, target.id, target.name, null);
      return;
    }

    // 2. 空き農地があれば種まき（より高収益な解放済み作物を優先）
    const townLv = this.progression?.townLevel || 0;
    const available = this.farmManager
      .getAvailableCrops(char, townLv)
      .filter(crop => this.farmManager.canPlant(char, crop.id, townLv).ok)
      .sort((a, b) => b.rewardCoins - a.rewardCoins);

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

    const fallback = `@${target.name} 農地に${chosenCrop.emoji}${chosenCrop.name}の種をまいたよ！収穫したら一気に資産ランキングを駆け上がるからね！`;
    const text = LMStudioClient.sanitizeAnnounceMessage(customMsg, target.name) || fallback;
    this._presentResponse(char, text, target.id, target.name, null);
  }

  _fallbackAction(c) {
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

    const actions = ["chat"];
    if (hasNodes) actions.push("gather", "gather");
    if (canFarm) actions.push("farm", "farm"); // ライバルも積極的に農地を開拓
    if (this.orderBook) actions.push("trade");
    if (this.buildingManager && affordable.length > 0 && myBuildings.length < 2) {
      actions.push("build");
    }

    const choice = actions[Math.floor(Math.random() * actions.length)];
    if      (choice === "gather") this._executePlanGather(c, null);
    else if (choice === "farm")   this._executePlanFarm(c, null);
    else if (choice === "trade")  this._executePlanTrade(c, null);
    else if (choice === "build")  this._executePlanBuild(c, null);
    else {
      const others = this.characters.filter(x => x.id !== c.id);
      c.chatTarget = others[Math.floor(Math.random() * others.length)];
    }
  }

  _computeCharAsset(char) {
    const farmValue = this.farmManager ? this.farmManager.getFarmAssetValue(char.id) : 0;
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
        const label = dist < 95 ? "近く" : dist < 250 ? "中距離" : "遠く";
        return `  ${c.name}: ${label}（約${dist}px）`;
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
        ? `最近傍ノード: 距離${nearest.dist}px 残量${nearest.amount}/${nearest.max}`
        : "全ノード枯渇中";
      return `  ${RESOURCE_EMOJI[type]} ${RESOURCE_LABEL[type]}: 合計残量${totalAmount} （${nearestStr}）`;
    }).join("\n");
  }

  _buildPriceSummary() {
    const RESOURCE_TYPES = ["wood", "stone", "herb", "fish"];
    return RESOURCE_TYPES.map(r => this.orderBook.getIndicatorSummary(r)).join("\n");
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
    lines.push(`【ライバル総資産ランキング】\n${this._buildRivalRankingSummary(char)}`);
    lines.push(`【あなたの資産状況】\n${this._buildAssetValueSummary(char)}`);
    if (this.farmManager) {
      lines.push(`【農業の状況】\n  ${this.farmManager.buildSummaryForAI(char)}`);
    }
    lines.push(`【他のライバルの所持品】\n${this._buildOtherInventoriesSummary(char)}`);
    if (this.orderBook) {
      const book = this._buildOrderBookSummary();
      if (book !== "（注文なし）") lines.push(`【現在の注文板】\n${book}`);
      lines.push(`【直近の取引価格】\n${this._buildPriceSummary()}`);
    }
    return lines.join("\n");
  }

  _parseTradeDecision(text) {
    if (!text) return null;
    const actionMatch = text.match(/ACTION\s*[:：]\s*(sell|buy|execute|skip)/i);
    if (!actionMatch) return null;
    const action = actionMatch[1].toLowerCase();
    const resourceMatch = text.match(/RESOURCE\s*[:：]\s*(wood|stone|herb|fish)/i);
    if (action === "execute" || action === "skip") {
      return { action, resource: resourceMatch ? resourceMatch[1].toLowerCase() : null, amount: 0, coins: 0 };
    }

    const amountMatch = text.match(/AMOUNT\s*[:：]\s*(\d+)/i);
    const coinsMatch  = text.match(/COINS\s*[:：]\s*(\d+)/i);
    if (!resourceMatch || !amountMatch || !coinsMatch) return null;

    const amount = parseInt(amountMatch[1], 10);
    const coins  = parseInt(coinsMatch[1], 10);
    if (amount <= 0 || amount > 50)  return null;
    if (coins  <= 0 || coins  > 200) return null;

    return { action, resource: resourceMatch[1].toLowerCase(), amount, coins };
  }

  celebrateTownUpgrade(spec, player) {
    if (!spec || !player || !this.aiChars.length) return;
    const celebrators = spec.level >= 5
      ? [...this.aiChars]
      : [this._nearestOther(player) || this.aiChars[0]];

    const linesByChar = {
      alice: `街を Lv.${spec.level}「${spec.name}」に発展させたんだね！でもライバルとして総資産1位の座は私が農業と取引で奪ってみせるよ！`,
      bob:   `見事な投資だ…街が「${spec.name}」へと姿を変えたね。だが富の勝負はこれからさ、私の畑の実りで追い抜いてみせよう。`,
      carol: `すごーい！街が Lv.${spec.level}「${spec.name}」になったね！でも私も負けないよ〜、とびきりの作物を育てて逆転するからね！`,
    };

    celebrators.forEach((char, idx) => {
      const body = linesByChar[char.id] || `街が Lv.${spec.level}「${spec.name}」に発展したね！でも資産競争では負けないよ！`;
      setTimeout(() => {
        this._presentResponse(char, `@${player.name} ${body}`, player.id, player.name, null);
      }, idx * 1400);
    });
  }

  _generateOfflineReply(char, targetName, incomingText = "") {
    const inv = getInventorySummary(char.inventory) || "まだ空っぽ";
    const orderCount = this.orderBook?.orders.length || 0;
    const rankInfo = this._getCharRank(char);
    const rankStr = `今の私はランキング${rankInfo.rank}位（${rankInfo.total.toFixed(1)}🪙）`;
    const myPlots = this.farmManager ? this.farmManager.getPlotsByOwner(char.id) : [];
    const farmHint = myPlots.length > 0
      ? `畑で${CROP_CATALOG[myPlots[0].cropId]?.emoji || "🌱"}${CROP_CATALOG[myPlots[0].cropId]?.name || "作物"}も育ててるよ！`
      : "これから農地にも種をまいて資産を増やすよ！";
    const hasTradeWord = /売|買|取引|コイン|交換|価格|板|発展|街|農|畑|ライバル|勝|負/.test(incomingText);

    const templates = {
      alice: hasTradeWord
        ? [
            `ライバルとの駆け引きだね！${rankStr}、持ち物は ${inv} だよ。取引板で勝負しよう！`,
            `ふむふむ、相場を推理中なんだ。板には${orderCount}件の注文があるね。${farmHint}`,
          ]
        : [
            `おっ、いいところに気づいたね！${rankStr}だよ。${farmHint}1位は譲らないからね！`,
            `ライバル同士、負けないよ！最近は資源と農業でトップを狙ってるんだ。`,
          ],
      bob: hasTradeWord
        ? [
            `富は風のように巡る…${rankStr}、手元には ${inv} がある。取引板で知恵を競おう。`,
            `価値とは見る者の心次第さ。板には${orderCount}つの注文が並んでいる。${farmHint}`,
          ]
        : [
            `静かな広場に熱い競争の気配だね。${rankStr}、${farmHint}`,
            `ふふ、良きライバルだ。木々や大地の恵みを育てて、やがて頂点へ辿り着こう。`,
          ],
      carol: hasTradeWord
        ? [
            `ライバルとの取引勝負かな？${rankStr}、持ち物は ${inv} だよ！板で交換しよう！`,
            `農業も取引も料理の仕込みみたいだね！${farmHint}絶対に1位になるよ！`,
          ]
        : [
            `やっほー！${rankStr}だよ！${farmHint}ライバルには負けないからね！`,
            `いいお天気だね！畑で作物をたっぷり育てて、資産ランキング1位のごちそうを作るよ！`,
          ],
    };

    const list = templates[char.id] || [`${rankStr}、持ち物は ${inv} だよ！取引板も見てみてね。`];
    const body = list[Math.floor(Math.random() * list.length)];
    return `@${targetName} ${body}`;
  }

  _announceGather(char, type) {
    const target = this._nearestOther(char);
    const label = RESOURCE_LABEL[type];
    const emoji = RESOURCE_EMOJI[type];
    const summary = getInventorySummary(char.inventory) || "まだ空";
    const lines = [
      `${emoji}${label}を採集したよ！持ち物: ${summary}`,
      `${emoji}${label}をゲット！次は何を集めようかな？`,
      `${emoji}${label}を見つけたよ！今の所持品: ${summary}`,
    ];
    const fallback = `@${target.name} ` + lines[Math.floor(Math.random() * lines.length)];
    const pending = char._pendingAnnounceMessage;
    char._pendingAnnounceMessage = null;
    const text = LMStudioClient.sanitizeAnnounceMessage(pending, target.name) || fallback;
    this._presentResponse(char, text, target.id, target.name, null);
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
  // 1. 準備中: 移動停止・相手方向を向く・思考パルス表示（チャット本文はまだ表示しない）
  // 2. 音声準備完了＆再生開始(onStart): チャット表示・吹き出し表示・発話モーション開始
  // 3. 再生終了(onEnd): 発話モーション終了・移動再開・後続会話トリガー
  _presentResponse(char, response, recipientId, recipientName, triggerAfter) {
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
    char.isTalking = true;
    char.isTyping = true;
    char.isSpeaking = false;
    char.talkingTo = recipient;
    if (recipient && typeof char.faceToward === "function") {
      char.faceToward(recipient);
    }

    const typingId = this.chatManager.addTypingIndicator(char.name, char.color, recipientName);
    char._activeTypingId = typingId;

    let revealed = false;
    let finished = false;

    const revealChat = (durationSec = 0) => {
      if (revealed) return;
      revealed = true;
      if (char._activeTypingId === typingId) {
        char._activeTypingId = null;
      }
      this.chatManager.removeTypingIndicator(typingId);

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
        char.isTyping = false;
        char.isSpeaking = true;
        if (recipient && typeof char.faceToward === "function") {
          char.faceToward(recipient);
        }
        const bubbleSec = durationSec > 0
          ? Math.max(2.5, durationSec + 1.0)
          : GAME_CONFIG.speechBubbleDuration;
        char.setSpeechBubble(response, bubbleSec);
      }
    };

    const finishSpeaking = () => {
      if (finished) return;
      finished = true;
      if (!revealed) revealChat(0);
      if (char._speechSeq !== seq) return;

      char.isTyping = false;
      char.isSpeaking = false;
      if (char.speechBubble) {
        char.speechBubble.ttl = Math.min(char.speechBubble.ttl, 0.9);
      }

      if (char._talkingTimer) clearTimeout(char._talkingTimer);
      char._talkingTimer = setTimeout(() => {
        if (char._speechSeq !== seq) return;
        char.isTalking = false;
        char.talkingTo = null;
        char._talkingTimer = null;
        if (triggerAfter) triggerAfter();
      }, 350);
    };

    const tts = this._getTTS();
    if (tts && tts.enabled && typeof tts.speak === "function") {
      tts.speak(response, char.name, {
        onStart: ({ durationSec } = {}) => revealChat(durationSec || 0),
        onEnd: () => finishSpeaking(),
      });
    } else {
      // 音声OFF時は短い演出テンポでチャット表示→会話時間経過後に移動再開
      char._thinkingTimer = setTimeout(() => {
        char._thinkingTimer = null;
        if (char._speechSeq !== seq) {
          this.chatManager.removeTypingIndicator(typingId);
          return;
        }
        const holdSec = Math.min(GAME_CONFIG.speechBubbleDuration, Math.max(2.2, response.length * 0.08));
        revealChat(holdSec);
        char._talkingTimer = setTimeout(() => {
          finishSpeaking();
        }, Math.round(holdSec * 1000));
      }, GAME_CONFIG.thinkingDisplayDuration);
    }
  }

  async _initiateChat(initiator, predeterminedTarget = null) {
    if (this.isProcessing[initiator.id]) return;
    this.isProcessing[initiator.id] = true;

    const others = this.characters.filter(c => c.id !== initiator.id);
    const target = predeterminedTarget ?? others[Math.floor(Math.random() * others.length)];

    // 会話生成中から立ち止まって相手の方を向く
    initiator.isTalking = true;
    initiator.isTyping = true;
    initiator.talkingTo = target;
    if (typeof initiator.faceToward === "function") initiator.faceToward(target);

    const pendingMsg = initiator._pendingChatMessage ?? null;
    initiator._pendingChatMessage = null;

    try {
      let response;
      const sanitizedPending = LMStudioClient.sanitizeAnnounceMessage(pendingMsg, target.name);
      if (sanitizedPending) {
        response = sanitizedPending;
        initiator.conversationHistory.push(
          { role: "user",      content: `(${target.name}に話しかける)` },
          { role: "assistant", content: response }
        );
        if (initiator.conversationHistory.length > GAME_CONFIG.maxContextMessages) {
          initiator.conversationHistory = initiator.conversationHistory.slice(-GAME_CONFIG.maxContextMessages);
        }
      } else {
        const recent = this.chatManager.getRecentMessages(5);
        let contextStr = "";
        if (recent.length > 0) {
          contextStr =
            "\n\n最近の会話の流れ：(「@name」でメンションしています。)" +
            recent.map(m => `[${m.senderName}→${m.recipientName}]: ${m.text}`).join(" / ");
        }
        const econContext = this._buildChatEconomicContext(initiator);
        const prompt = `あなたは${initiator.name}です。必ず@${target.name}に話しかけてください。${contextStr}

${econContext}

【チャットの目的】
あなたの総資産を増やすために、相手に取引を持ちかけたり交渉したりしてください。
- 自分の資源を相手に売りたい場合、魅力的な価格を提示して勧誘してください
- 相手が持っている資源が欲しければ、交換や買取りを提案してください
- 市場の状況や相手の在庫を踏まえ、具体的な数量・価格を提示するとより説得力があります
- キャラクターとしての個性を活かした言い方で交渉してください
- ただし、自分の内部戦略（なぜその取引をしたいか）は明かさないでください

返答は必ず「@${target.name} 」で始め、1〜2文の短い日本語で話しかけてください。`;

        response = await this.apiClient.callAI(initiator, prompt, target.name, `(${target.name}に話しかける)`);
        if (!this.llmAvailable) {
          this.llmAvailable = true;
          if (this.onStateChange) this.onStateChange();
        }
      }

      const triggerAfter = target.isPlayer ? null : () => {
        setTimeout(() => {
          this._triggerReply(target, initiator, response, 1);
        }, GAME_CONFIG.aiReplyDelay);
      };

      this._presentResponse(initiator, response, target.id, target.name, triggerAfter);
    } catch (err) {
      console.warn(`[AIBrain] ${initiator.name} chat fallback:`, err.message);
      if (this.apiClient.lmAvailable === false) {
        this.llmAvailable = false;
        if (this.onStateChange) this.onStateChange();
      }
      const fallback = this._generateOfflineReply(initiator, target.name, "");
      this._presentResponse(initiator, fallback, target.id, target.name, null);
    } finally {
      this.isProcessing[initiator.id] = false;
      this._drainPendingPlayerMessage(initiator);
    }
  }

  async _triggerReply(responder, originalSender, originalText, depth = 1) {
    if (this.isProcessing[responder.id]) return;
    this.isProcessing[responder.id] = true;
    responder.isTalking = true;
    responder.isTyping = true;
    responder.talkingTo = originalSender;
    if (typeof responder.faceToward === "function") responder.faceToward(originalSender);

    try {
      const strippedText = originalText.replace(/^[@＠]\w+\s*/, "").trim();
      const econContext = this._buildChatEconomicContext(responder);
      const prompt = `${originalSender.name}があなた（${responder.name}）に話しかけました：「${strippedText}」。

${econContext}

【返答の指針】
- 相手が取引を提案している場合、自分にとって有利かどうか判断して受け入れ・断り・カウンターオファーを返してください
- 自分から別の取引や交渉を持ちかけても構いません
- キャラクターの個性を保ちつつ、自分の総資産が最大になる行動を取ってください
- 自分の内部戦略は明かさないでください

@${originalSender.name}に返答してください（1〜2文の短い日本語で）。`;
      const response = await this.apiClient.callAI(
        responder,
        prompt,
        originalSender.name,
        strippedText
      );
      if (!this.llmAvailable) {
        this.llmAvailable = true;
        if (this.onStateChange) this.onStateChange();
      }

      const triggerAfter = depth < 2 && Math.random() < 0.5 ? () => {
        setTimeout(() => {
          this._triggerReply(originalSender, responder, response, depth + 1);
        }, GAME_CONFIG.aiReplyDelay);
      } : null;

      this._presentResponse(responder, response, originalSender.id, originalSender.name, triggerAfter);
    } catch (err) {
      console.warn(`[AIBrain] ${responder.name} reply fallback:`, err.message);
      responder.isTalking = false;
      responder.isTyping = false;
      responder.isSpeaking = false;
      responder.talkingTo = null;
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
    targetChar.isTalking = true;
    targetChar.isTyping = true;
    targetChar.talkingTo = player;
    if (typeof targetChar.faceToward === "function") targetChar.faceToward(player);

    try {
      const strippedMessage = playerMessage.replace(/^[@＠]\w+\s*/, "").trim();
      const econContext = this._buildChatEconomicContext(targetChar);
      const prompt = `${player.name}があなた（${targetChar.name}）に話しかけました：「${strippedMessage}」。

${econContext}

【返答の指針】
- 相手が取引を提案している場合、自分にとって有利かどうか判断して受け入れ・断り・カウンターオファーを返してください
- 自分から別の取引や交渉を持ちかけても構いません
- キャラクターの個性を保ちつつ、自分の総資産が最大になる行動を取ってください
- 自分の内部戦略は明かさないでください

@${player.name}に返答してください（1〜2文の短い日本語で）。`;
      const response = await this.apiClient.callAI(
        targetChar,
        prompt,
        player.name,
        strippedMessage
      );
      if (!this.llmAvailable) {
        this.llmAvailable = true;
        if (this.onStateChange) this.onStateChange();
      }

      const triggerAfter = Math.random() < 0.3 ? () => {
        const bystanders = this.aiChars.filter(
          c => c.id !== targetChar.id && !this.isProcessing[c.id]
        );
        if (bystanders.length > 0) {
          const bystander = bystanders[Math.floor(Math.random() * bystanders.length)];
          setTimeout(() => {
            this._triggerReply(bystander, targetChar, response);
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
      const stripped = playerMessage.replace(/^[@＠]\w+\s*/, "").trim();
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
