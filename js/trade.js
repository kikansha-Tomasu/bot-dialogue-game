const TRADE_RESOURCES = ["wood", "stone", "herb", "fish"];

class OrderBook {
  constructor() {
    this.orders      = [];
    this._nextId     = 1;
    this.isOpen      = false;
    this._player     = null;
    this._activeTab  = "limit";
    this._marketSide = "buy";
    this.onExecute   = null;
    this.onChange    = null;

    this._activeResource = "wood";
    this._activeIndicators = new Set(["ma5", "ma10"]);
    this.priceHistory = { wood: [], stone: [], herb: [], fish: [] };
    this.tradeHistory = [];

    if (typeof document !== "undefined") {
      this._panel = document.getElementById("orderbook-panel");
      this._list  = document.getElementById("orderbook-list");
      if (this._panel) this._setupHandlers();
    } else {
      this._panel = null;
      this._list  = null;
    }
  }

  // ─── 公開 API ────────────────────────────────────

  open(player) {
    this._player = player;
    this.isOpen  = true;
    this.pruneInvalidOrders();
    this._panel?.classList.remove("hidden");
    this._renderList();
    this._renderChart();
    this._refreshMarketRate();
    this._refreshLimitPreview();
  }

  close() {
    this.isOpen = false;
    this._panel?.classList.add("hidden");
  }

  refresh() {
    this.pruneInvalidOrders();
    if (this.isOpen) {
      this._renderList();
      this._renderChart();
      this._refreshMarketRate();
      this._refreshLimitPreview();
    }
  }

  // 既存注文で予約中の数量を算出（同じコイン・資源の二重発注を防止）
  getReservedAmount(charId, type) {
    return this.orders
      .filter(o => o.posterId === charId && o.sellType === type)
      .reduce((sum, o) => sum + o.sellAmount, 0);
  }

  getAvailableBalance(char, type) {
    if (!char || !char.inventory) return 0;
    return Math.max(0, (char.inventory[type] || 0) - this.getReservedAmount(char.id, type));
  }

  // 在庫消費などにより履行不能になった板注文を自動除去
  pruneInvalidOrders(excludeOrderId = null) {
    const before = this.orders.length;
    this.orders = this.orders.filter(o => {
      if (o.id === excludeOrderId) return true;
      if (o.sellAmount <= 0 || o.buyAmount <= 0) return false;
      const have = o.posterRef?.inventory?.[o.sellType] || 0;
      return have >= o.sellAmount;
    });
    if (this.orders.length !== before && this.onChange) {
      this.onChange();
    }
  }

  // 指値注文を板に追加（整数数量・コイン対資源ペア・利用可能残高チェック・自動マッチング）
  postOrder(poster, sellType, sellAmount, buyType, buyAmount) {
    if (!poster || !poster.inventory) return null;
    if (!Number.isInteger(sellAmount) || !Number.isInteger(buyAmount)) return null;
    if (sellAmount <= 0 || buyAmount <= 0) return null;
    if (sellType === buyType) return null;
    if (sellType !== "coin" && buyType !== "coin") return null;

    const resourceType = sellType === "coin" ? buyType : sellType;
    if (!TRADE_RESOURCES.includes(resourceType)) return null;

    this.pruneInvalidOrders();

    if (this.getAvailableBalance(poster, sellType) < sellAmount) return null;

    const dup = this.orders.find(o =>
      o.posterId === poster.id && o.sellType === sellType && o.buyType === buyType
    );
    if (dup) return null;

    const side = sellType === "coin" ? "buy" : "sell";
    const unitPrice = side === "buy"
      ? sellAmount / buyAmount
      : buyAmount / sellAmount;

    const order = {
      id: this._nextId++,
      posterId: poster.id,
      posterName: poster.name,
      posterColor: poster.color,
      posterRef: poster,
      sellType,
      sellAmount,
      buyType,
      buyAmount,
      resourceType,
      side,
      unitPrice,
      _wasFullyMatched: false,
      _matchedCount: 0,
    };
    this.orders.push(order);

    this._tryMatchOrders(order);
    if (this.onChange) this.onChange();
    if (this.isOpen) {
      this._renderList();
      this._renderChart();
      this._refreshMarketRate();
      this._refreshLimitPreview();
    }
    return order;
  }

  // セーブデータからの注文復元（マッチング発火・通知を行わず板へ戻す）
  restoreOrder(poster, sellType, sellAmount, buyType, buyAmount) {
    if (!poster || !poster.inventory) return null;
    if (!Number.isInteger(sellAmount) || !Number.isInteger(buyAmount)) return null;
    if (sellAmount <= 0 || buyAmount <= 0) return null;
    if (sellType === buyType || (sellType !== "coin" && buyType !== "coin")) return null;
    const resourceType = sellType === "coin" ? buyType : sellType;
    if (!TRADE_RESOURCES.includes(resourceType)) return null;
    if (this.getAvailableBalance(poster, sellType) < sellAmount) return null;

    const side = sellType === "coin" ? "buy" : "sell";
    const unitPrice = side === "buy" ? sellAmount / buyAmount : buyAmount / sellAmount;
    const order = {
      id: this._nextId++,
      posterId: poster.id,
      posterName: poster.name,
      posterColor: poster.color,
      posterRef: poster,
      sellType,
      sellAmount,
      buyType,
      buyAmount,
      resourceType,
      side,
      unitPrice,
      _wasFullyMatched: false,
      _matchedCount: 0,
    };
    this.orders.push(order);
    return order;
  }

  // 指値注文を成立させる（テイカーが呼ぶ）
  executeOrder(orderId, executor) {
    this.pruneInvalidOrders();
    const idx = this.orders.findIndex(o => o.id === orderId);
    if (idx === -1) return null;
    const o = this.orders[idx];
    if (!executor || o.posterId === executor.id) return null;
    if ((executor.inventory[o.buyType]     || 0) < o.buyAmount)  return null;
    if ((o.posterRef.inventory[o.sellType] || 0) < o.sellAmount) return null;

    const isBuyOrder = o.sellType === "coin";
    const snapshot = {
      id: o.id,
      posterId: o.posterId,
      posterName: o.posterName,
      posterColor: o.posterColor,
      posterRef: o.posterRef,
      sellType: o.sellType,
      sellAmount: o.sellAmount,
      buyType: o.buyType,
      buyAmount: o.buyAmount,
      resourceType: isBuyOrder ? o.buyType : o.sellType,
      resourceQty: isBuyOrder ? o.buyAmount : o.sellAmount,
      coinQty: isBuyOrder ? o.sellAmount : o.buyAmount,
    };

    executor.inventory[o.buyType]      -= o.buyAmount;
    inventoryAdd(executor.inventory,    o.sellType, o.sellAmount);
    o.posterRef.inventory[o.sellType]  -= o.sellAmount;
    inventoryAdd(o.posterRef.inventory, o.buyType,  o.buyAmount);

    this.orders.splice(idx, 1);

    this._recordTrade(
      snapshot.resourceType,
      snapshot.coinQty,
      snapshot.resourceQty,
      isBuyOrder ? o.posterName : executor.name,
      isBuyOrder ? executor.name : o.posterName
    );
    this.pruneInvalidOrders();
    if (this.onChange) this.onChange();
    if (this.isOpen) {
      this._renderList();
      this._renderChart();
      this._refreshMarketRate();
      this._refreshLimitPreview();
    }
    return snapshot;
  }

  // 注文を取消す
  cancelOrder(orderId, requesterId) {
    const idx = this.orders.findIndex(o => o.id === orderId && o.posterId === requesterId);
    if (idx === -1) return false;
    this.orders.splice(idx, 1);
    if (this.onChange) this.onChange();
    if (this.isOpen) {
      this._renderList();
      this._renderChart();
      this._refreshMarketRate();
      this._refreshLimitPreview();
    }
    return true;
  }

  // 成行シミュレーション（複数注文の板寄せ計算）
  simulateMarketOrder(side, resourceType, amount, excludeId) {
    this.pruneInvalidOrders();
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, maxFillable: 0, totalCoins: 0, plan: [], reason: "数量は1以上の整数を入力してください" };
    }

    if (side === "buy") {
      const candidates = this.orders
        .filter(o =>
          o.sellType === resourceType &&
          o.buyType === "coin" &&
          o.posterId !== excludeId &&
          (o.posterRef.inventory[o.sellType] || 0) >= o.sellAmount
        )
        .sort((a, b) => a.unitPrice - b.unitPrice || a.id - b.id);

      let remaining = amount;
      let totalCost = 0;
      let maxFillable = 0;
      const plan = [];

      for (const o of candidates) {
        maxFillable += o.sellAmount;
        if (remaining <= 0) continue;
        const takeQty = Math.min(remaining, o.sellAmount);
        const sliceCost = takeQty === o.sellAmount
          ? o.buyAmount
          : Math.max(1, Math.ceil(o.unitPrice * takeQty - 1e-9));
        plan.push({ order: o, takeQty, coinQty: sliceCost });
        totalCost += sliceCost;
        remaining -= takeQty;
      }

      if (maxFillable === 0) {
        return { ok: false, maxFillable: 0, totalCoins: 0, plan: [], reason: `${RESOURCE_LABEL[resourceType]}の売り注文がありません` };
      }
      if (remaining > 0) {
        return {
          ok: false,
          maxFillable,
          totalCoins: totalCost,
          plan,
          reason: `${RESOURCE_LABEL[resourceType]}の売り残高が不足しています（最大 ×${maxFillable} まで購入可能）`,
        };
      }
      return { ok: true, maxFillable, totalCoins: totalCost, plan };
    }

    // side === "sell"
    const candidates = this.orders
      .filter(o =>
        o.buyType === resourceType &&
        o.sellType === "coin" &&
        o.posterId !== excludeId &&
        (o.posterRef.inventory.coin || 0) >= o.sellAmount
      )
      .sort((a, b) => b.unitPrice - a.unitPrice || a.id - b.id);

    let remaining = amount;
    let totalReceive = 0;
    let maxFillable = 0;
    const plan = [];

    for (const o of candidates) {
      maxFillable += o.buyAmount;
      if (remaining <= 0) continue;
      const takeQty = Math.min(remaining, o.buyAmount);
      const sliceReceive = takeQty === o.buyAmount
        ? o.sellAmount
        : Math.floor(o.unitPrice * takeQty + 1e-9);
      if (sliceReceive <= 0) continue;
      plan.push({ order: o, takeQty, coinQty: sliceReceive });
      totalReceive += sliceReceive;
      remaining -= takeQty;
    }

    if (maxFillable === 0) {
      return { ok: false, maxFillable: 0, totalCoins: 0, plan: [], reason: `${RESOURCE_LABEL[resourceType]}の買い注文がありません` };
    }
    if (remaining > 0 || totalReceive <= 0) {
      return {
        ok: false,
        maxFillable,
        totalCoins: totalReceive,
        plan,
        reason: totalReceive <= 0
          ? "受け取れるコインがありません"
          : `${RESOURCE_LABEL[resourceType]}の買い残高が不足しています（最大 ×${maxFillable} まで売却可能）`,
      };
    }
    return { ok: true, maxFillable, totalCoins: totalReceive, plan };
  }

  // 成行買い：板の最安値から複数注文に跨って即約定
  executeMarketBuy(player, receiveType, wantAmount) {
    const sim = this.simulateMarketOrder("buy", receiveType, wantAmount, player.id);
    if (!sim.ok) return { ok: false, reason: sim.reason };

    if ((player.inventory.coin || 0) < sim.totalCoins) {
      return { ok: false, reason: `コインが足りません（必要 🪙×${sim.totalCoins}）` };
    }

    // 念のため全スライスの相手在庫を再確認
    for (const { order, takeQty } of sim.plan) {
      if ((order.posterRef.inventory[receiveType] || 0) < takeQty) {
        return { ok: false, reason: "注文の在庫が変化しました。再度お試しください" };
      }
    }

    const fills = [];
    for (const { order, takeQty, coinQty } of sim.plan) {
      const snapshot = {
        id: order.id,
        posterId: order.posterId,
        posterName: order.posterName,
        posterColor: order.posterColor,
        posterRef: order.posterRef,
        sellType: receiveType,
        sellAmount: takeQty,
        buyType: "coin",
        buyAmount: coinQty,
        resourceType: receiveType,
        resourceQty: takeQty,
        coinQty,
      };

      player.inventory.coin                -= coinQty;
      inventoryAdd(player.inventory,         receiveType, takeQty);
      order.posterRef.inventory[receiveType] -= takeQty;
      inventoryAdd(order.posterRef.inventory, "coin", coinQty);

      const remRes = order.sellAmount - takeQty;
      if (remRes <= 0) {
        this.orders = this.orders.filter(o => o.id !== order.id);
      } else {
        order.sellAmount = remRes;
        order.buyAmount  = Math.max(1, Math.round(remRes * order.unitPrice));
      }

      this._recordTrade(receiveType, coinQty, takeQty, player.name, order.posterName);
      fills.push(snapshot);
    }

    this.pruneInvalidOrders();
    if (this.onChange) this.onChange();
    if (this.isOpen) {
      this._renderList();
      this._renderChart();
      this._refreshMarketRate();
      this._refreshLimitPreview();
    }
    return {
      ok: true,
      order: fills[0],
      fills,
      fillAmount: wantAmount,
      cost: sim.totalCoins,
      payType: "coin",
    };
  }

  // 成行売り：板の最高値から複数注文に跨って即約定
  executeMarketSell(player, giveType, giveAmount) {
    if ((player.inventory[giveType] || 0) < giveAmount) {
      return { ok: false, reason: `${RESOURCE_LABEL[giveType]}が足りません` };
    }

    const sim = this.simulateMarketOrder("sell", giveType, giveAmount, player.id);
    if (!sim.ok) return { ok: false, reason: sim.reason };

    for (const { order, coinQty } of sim.plan) {
      if ((order.posterRef.inventory.coin || 0) < coinQty) {
        return { ok: false, reason: "注文のコイン残高が変化しました。再度お試しください" };
      }
    }

    const fills = [];
    for (const { order, takeQty, coinQty } of sim.plan) {
      const snapshot = {
        id: order.id,
        posterId: order.posterId,
        posterName: order.posterName,
        posterColor: order.posterColor,
        posterRef: order.posterRef,
        sellType: "coin",
        sellAmount: coinQty,
        buyType: giveType,
        buyAmount: takeQty,
        resourceType: giveType,
        resourceQty: takeQty,
        coinQty,
      };

      player.inventory[giveType]      -= takeQty;
      inventoryAdd(player.inventory,    "coin", coinQty);
      order.posterRef.inventory.coin  -= coinQty;
      inventoryAdd(order.posterRef.inventory, giveType, takeQty);

      const remRes = order.buyAmount - takeQty;
      if (remRes <= 0) {
        this.orders = this.orders.filter(o => o.id !== order.id);
      } else {
        order.buyAmount  = remRes;
        order.sellAmount = Math.max(1, Math.min(order.sellAmount - coinQty, Math.round(remRes * order.unitPrice)));
      }

      this._recordTrade(giveType, coinQty, takeQty, order.posterName, player.name);
      fills.push(snapshot);
    }

    this.pruneInvalidOrders();
    if (this.onChange) this.onChange();
    if (this.isOpen) {
      this._renderList();
      this._renderChart();
      this._refreshMarketRate();
      this._refreshLimitPreview();
    }
    return {
      ok: true,
      order: fills[0],
      fills,
      receiveAmount: sim.totalCoins,
      receiveType: "coin",
    };
  }

  // 指値同士の自動マッチング（価格交差・部分約定・指値単価維持）
  _tryMatchOrders(newOrder) {
    const isCoinSell = newOrder.sellType === "coin";

    const candidates = this.orders
      .filter(o =>
        o.id !== newOrder.id &&
        o.posterId !== newOrder.posterId &&
        o.sellType === newOrder.buyType &&
        o.buyType  === newOrder.sellType
      )
      .sort((a, b) =>
        isCoinSell
          ? (a.unitPrice - b.unitPrice || a.id - b.id)
          : (b.unitPrice - a.unitPrice || a.id - b.id)
      );

    let anyMatch = false;

    for (const ex of candidates) {
      const newResQty = isCoinSell ? newOrder.buyAmount : newOrder.sellAmount;
      if (newResQty <= 0) break;

      const buyUnitPrice  = isCoinSell ? newOrder.unitPrice : ex.unitPrice;
      const sellUnitPrice = isCoinSell ? ex.unitPrice       : newOrder.unitPrice;
      if (buyUnitPrice + 1e-9 < sellUnitPrice) break;

      const exResQty = isCoinSell ? ex.sellAmount : ex.buyAmount;
      const resourceQty = Math.min(newResQty, exResQty);
      if (resourceQty <= 0) continue;

      // 既存注文（メイカー）の単価で約定コイン量を決定
      let coinQty;
      if (isCoinSell) {
        coinQty = resourceQty === ex.sellAmount
          ? ex.buyAmount
          : Math.max(1, Math.ceil(ex.unitPrice * resourceQty - 1e-9));
        if (coinQty > newOrder.sellAmount) continue;
      } else {
        coinQty = resourceQty === ex.buyAmount
          ? ex.sellAmount
          : Math.floor(ex.unitPrice * resourceQty + 1e-9);
        if (coinQty <= 0) continue;
        if (coinQty < Math.floor(newOrder.unitPrice * resourceQty - 1e-9)) continue;
      }

      const newPays = isCoinSell ? "coin"          : newOrder.sellType;
      const newQty  = isCoinSell ? coinQty         : resourceQty;
      const exPays  = isCoinSell ? ex.sellType     : "coin";
      const exQty   = isCoinSell ? resourceQty     : coinQty;
      if ((newOrder.posterRef.inventory[newPays] || 0) < newQty) continue;
      if ((ex.posterRef.inventory[exPays]        || 0) < exQty)  continue;

      // 更新前の正確な約定スナップショットを作成（onExecute の ×0 バグを解消）
      const tradeSnapshot = {
        id: ex.id,
        posterId: ex.posterId,
        posterName: ex.posterName,
        posterColor: ex.posterColor,
        posterRef: ex.posterRef,
        sellType: ex.sellType,
        sellAmount: exQty,
        buyType: ex.buyType,
        buyAmount: newQty,
        resourceType: newOrder.resourceType,
        resourceQty,
        coinQty,
      };

      // 資源・コインの移動
      newOrder.posterRef.inventory[newPays] -= newQty;
      inventoryAdd(
        newOrder.posterRef.inventory,
        isCoinSell ? newOrder.buyType : "coin",
        isCoinSell ? resourceQty : coinQty
      );
      ex.posterRef.inventory[exPays] -= exQty;
      inventoryAdd(
        ex.posterRef.inventory,
        isCoinSell ? "coin" : ex.buyType,
        isCoinSell ? coinQty : resourceQty
      );

      this._recordTrade(
        newOrder.resourceType,
        coinQty,
        resourceQty,
        isCoinSell ? newOrder.posterName : ex.posterName,
        isCoinSell ? ex.posterName : newOrder.posterName
      );

      // 残量を指値単価を維持したまま更新
      const remNewRes = newResQty - resourceQty;
      if (remNewRes <= 0) {
        newOrder.buyAmount  = 0;
        newOrder.sellAmount = 0;
      } else if (isCoinSell) {
        newOrder.buyAmount  = remNewRes;
        newOrder.sellAmount = Math.max(1, Math.min(newOrder.sellAmount - coinQty, Math.round(remNewRes * newOrder.unitPrice)));
      } else {
        newOrder.sellAmount = remNewRes;
        newOrder.buyAmount  = Math.max(1, Math.round(remNewRes * newOrder.unitPrice));
      }

      const remExRes = exResQty - resourceQty;
      if (remExRes <= 0) {
        this.orders = this.orders.filter(o => o.id !== ex.id);
      } else if (isCoinSell) {
        ex.sellAmount = remExRes;
        ex.buyAmount  = Math.max(1, Math.round(remExRes * ex.unitPrice));
      } else {
        ex.buyAmount  = remExRes;
        ex.sellAmount = Math.max(1, Math.min(ex.sellAmount - coinQty, Math.round(remExRes * ex.unitPrice)));
      }

      anyMatch = true;
      newOrder._matchedCount++;
      if (this.onExecute) this.onExecute(tradeSnapshot, newOrder.posterRef);
    }

    if (newOrder.buyAmount <= 0 || newOrder.sellAmount <= 0) {
      this.orders = this.orders.filter(o => o.id !== newOrder.id);
      newOrder._wasFullyMatched = true;
    }

    if (anyMatch) {
      this.pruneInvalidOrders();
      if (this.isOpen) {
        this._renderList();
        this._renderChart();
        this._refreshMarketRate();
        this._refreshLimitPreview();
      }
    }
  }

  // AI 用：板上の成立可能な注文を約定（プレイヤー注文を優先しつつ他AI注文も対象）
  tryAIExecute(aiChar, preferResource = null) {
    this.pruneInvalidOrders();
    const candidates = this.orders.filter(o =>
      o.posterId !== aiChar.id &&
      (aiChar.inventory[o.buyType] || 0) >= o.buyAmount &&
      (o.posterRef.inventory[o.sellType] || 0) >= o.sellAmount
    );
    if (!candidates.length) return null;

    // プレイヤー注文と指定資源を優先、次いで有利な価格順
    candidates.sort((a, b) => {
      const aPlayer = a.posterId === "player" ? 1 : 0;
      const bPlayer = b.posterId === "player" ? 1 : 0;
      if (aPlayer !== bPlayer) return bPlayer - aPlayer;
      if (preferResource) {
        const aPref = a.resourceType === preferResource ? 1 : 0;
        const bPref = b.resourceType === preferResource ? 1 : 0;
        if (aPref !== bPref) return bPref - aPref;
      }
      // 売られている資源を買うなら安い方、買い注文へ売るなら高い方
      const aScore = a.side === "sell" ? -a.unitPrice : a.unitPrice;
      const bScore = b.side === "sell" ? -b.unitPrice : b.unitPrice;
      return bScore - aScore;
    });

    for (const o of candidates) {
      const executed = this.executeOrder(o.id, aiChar);
      if (executed) return executed;
    }
    return null;
  }

  // 最良売り気配（買い成行レート確認用）
  getBestAsk(receiveType, excludeId) {
    return this.orders
      .filter(o =>
        o.sellType === receiveType &&
        o.buyType === "coin" &&
        o.posterId !== excludeId &&
        (o.posterRef.inventory[o.sellType] || 0) >= o.sellAmount
      )
      .sort((a, b) => a.unitPrice - b.unitPrice || a.id - b.id)[0] || null;
  }

  // 最良買い気配（売り成行レート確認用）
  getBestBid(giveType, excludeId) {
    return this.orders
      .filter(o =>
        o.buyType === giveType &&
        o.sellType === "coin" &&
        o.posterId !== excludeId &&
        (o.posterRef.inventory.coin || 0) >= o.sellAmount
      )
      .sort((a, b) => b.unitPrice - a.unitPrice || a.id - b.id)[0] || null;
  }

  // ─── テクニカル指標 ──────────────────────────────────

  _calcSMA(data, period) {
    const result = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      result[i] = slice.reduce((a, b) => a + b, 0) / period;
    }
    return result;
  }

  _calcBollinger(data, period) {
    const mid = this._calcSMA(data, period);
    const upper = new Array(data.length).fill(null);
    const lower = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const mean = mid[i];
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      upper[i] = mean + 2 * sd;
      lower[i] = mean - 2 * sd;
    }
    return { upper, middle: mid, lower };
  }

  _calcRSI(data, period) {
    if (data.length < period + 1) return null;
    const slice = data.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const diff = slice[i] - slice[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    if (gains === 0 && losses === 0) return 50;
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
  }

  getIndicatorSummary(resourceType) {
    const hist = this.priceHistory[resourceType];
    const emoji = RESOURCE_EMOJI[resourceType];
    const label = RESOURCE_LABEL[resourceType];
    if (!hist || hist.length === 0) return `  ${emoji}${label}: 取引履歴なし`;

    const latest = hist[hist.length - 1];
    const parts = [`直近${latest.toFixed(2)}コイン/個`];

    if (hist.length >= 5) {
      const ma5 = hist.slice(-5).reduce((a, b) => a + b, 0) / 5;
      parts.push(`MA5=${ma5.toFixed(2)}(${latest > ma5 ? "↑" : "↓"})`);
    }
    if (hist.length >= 10) {
      const ma10 = hist.slice(-10).reduce((a, b) => a + b, 0) / 10;
      parts.push(`MA10=${ma10.toFixed(2)}`);
    }
    if (hist.length >= 20) {
      const bb = this._calcBollinger(hist, 20);
      const lastIdx = hist.length - 1;
      if (bb.upper[lastIdx] !== null) {
        const pos = latest > bb.upper[lastIdx] ? "上限超え" :
                    latest < bb.lower[lastIdx] ? "下限超え" : "バンド内";
        parts.push(`BB(${pos})`);
      }
    }
    if (hist.length >= 15) {
      const rsi = this._calcRSI(hist, 14);
      if (rsi !== null) {
        const rsiLabel = rsi > 70 ? "買われ過ぎ" : rsi < 30 ? "売られ過ぎ" : "中立";
        parts.push(`RSI=${rsi.toFixed(0)}(${rsiLabel})`);
      }
    }

    return `  ${emoji}${label}: ${parts.join(", ")}`;
  }

  // ─── 内部処理 ─────────────────────────────────────

  _recordTrade(resourceType, coinAmount, resourceAmount, buyerName = "", sellerName = "") {
    if (!this.priceHistory[resourceType] || resourceAmount <= 0) return;
    const unitPrice = coinAmount / resourceAmount;
    this.priceHistory[resourceType].push(unitPrice);
    if (this.priceHistory[resourceType].length > 30) {
      this.priceHistory[resourceType].shift();
    }
    this.tradeHistory.push({
      time: Date.now(),
      resourceType,
      resourceQty: resourceAmount,
      coinQty: coinAmount,
      unitPrice,
      buyerName,
      sellerName,
    });
    if (this.tradeHistory.length > 25) {
      this.tradeHistory.shift();
    }
    if (this.isOpen) {
      this._renderChart();
      this._renderRecentTrades();
    }
  }

  _renderRecentTrades() {
    if (typeof document === "undefined") return;
    const el = document.getElementById("recent-trades-strip");
    if (!el) return;
    const filtered = this.tradeHistory
      .filter(t => t.resourceType === this._activeResource)
      .slice(-3)
      .reverse();
    if (!filtered.length) {
      el.innerHTML = "";
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    const items = filtered.map(t => {
      const p = t.unitPrice.toFixed(2).replace(/\.?0+$/, "");
      return `<span class="trade-hist-chip">${RESOURCE_EMOJI[t.resourceType]}×${t.resourceQty} @🪙${p}</span>`;
    }).join("");
    el.innerHTML = `<span class="trade-hist-label">直近約定:</span>${items}`;
  }

  _updateRsiDisplay(data) {
    if (typeof document === "undefined") return;
    const rsiEl = document.getElementById("rsi-value");
    if (!rsiEl) return;

    if (!this._activeIndicators.has("rsi")) {
      rsiEl.textContent = "";
      rsiEl.className = "";
      return;
    }

    const rsi = this._calcRSI(data, 14);
    if (rsi !== null) {
      const label = rsi > 70 ? "⚠ 買われ過ぎ" : rsi < 30 ? "⚠ 売られ過ぎ" : "中立";
      rsiEl.textContent = `RSI(14): ${rsi.toFixed(1)}（${label}）`;
      rsiEl.className = rsi > 70 ? "rsi-high" : rsi < 30 ? "rsi-low" : "";
    } else {
      rsiEl.textContent = `RSI(14): データ不足（あと${Math.max(0, 15 - data.length)}約定）`;
      rsiEl.className = "rsi-insufficient";
    }
  }

  _renderChart() {
    if (typeof document === "undefined") return;
    const canvas  = document.getElementById("price-chart");
    const emptyEl = document.getElementById("price-chart-empty");
    if (!canvas || !emptyEl) return;

    const data = this.priceHistory[this._activeResource] || [];
    // データ件数に関わらずRSI表示を常に最新資源へ同期（タブ切替時の残留バグを解消）
    this._updateRsiDisplay(data);

    const _indVals = [];
    let _ma5 = null, _ma10 = null, _bb = null;
    if (data.length >= 2) {
      if (this._activeIndicators.has("ma5")  && data.length >= 5)  { _ma5  = this._calcSMA(data, 5);  _ma5.filter(v => v !== null).forEach(v => _indVals.push(v)); }
      if (this._activeIndicators.has("ma10") && data.length >= 10) { _ma10 = this._calcSMA(data, 10); _ma10.filter(v => v !== null).forEach(v => _indVals.push(v)); }
      if (this._activeIndicators.has("bb")   && data.length >= 20) { _bb   = this._calcBollinger(data, 20); [..._bb.upper, ..._bb.lower].filter(v => v !== null).forEach(v => _indVals.push(v)); }
    }

    if (data.length === 0) {
      canvas.style.display = "none";
      emptyEl.classList.remove("hidden");
      return;
    }

    canvas.style.display = "block";
    emptyEl.classList.add("hidden");

    const wrap = canvas.parentElement;
    const W = wrap?.clientWidth  || 452;
    const H = wrap?.clientHeight || 96;
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);

    const COLORS = { wood: "#6D4C1F", stone: "#666666", herb: "#2E6B1E", fish: "#2566A8" };
    const color  = COLORS[this._activeResource] || "#5A8A44";
    const pad = { top: 8, right: 12, bottom: 18, left: 40 };
    const cW = W - pad.left - pad.right;
    const cH = H - pad.top  - pad.bottom;

    if (data.length === 1) {
      const price = data[0];
      const cy = pad.top + cH / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, cy);
      ctx.lineTo(W - pad.right, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(W - pad.right, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = "#5C4033";
      ctx.font = "10px 'Segoe UI', Meiryo, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(price.toFixed(1), pad.left - 4, cy);
      ctx.textBaseline = "bottom";
      ctx.fillText("直近1約定", W - pad.right, H - 2);
      return;
    }

    const min = Math.min(...data, ..._indVals);
    const max = Math.max(...data, ..._indVals);
    const range = max - min || 1;

    const xOf = i => pad.left + (i / (data.length - 1)) * cW;
    const yOf = v => pad.top  + (1 - (v - min) / range) * cH;

    // グラデーション塗り
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
    grad.addColorStop(0, color + "48");
    grad.addColorStop(1, color + "08");
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(xOf(i), yOf(data[i]));
    ctx.lineTo(xOf(data.length - 1), pad.top + cH);
    ctx.lineTo(xOf(0), pad.top + cH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 価格ライン
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(data[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(xOf(i), yOf(data[i]));
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = "round";
    ctx.stroke();

    // 最終値ドット
    ctx.beginPath();
    ctx.arc(xOf(data.length - 1), yOf(data[data.length - 1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // テクニカル指標オーバーレイ
    const drawInd = (vals, indColor, dash = []) => {
      ctx.save();
      ctx.strokeStyle = indColor;
      ctx.lineWidth = 1.4;
      ctx.setLineDash(dash);
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      vals.forEach((v, i) => {
        if (v === null) { started = false; return; }
        if (!started) { ctx.moveTo(xOf(i), yOf(v)); started = true; }
        else ctx.lineTo(xOf(i), yOf(v));
      });
      ctx.stroke();
      ctx.restore();
    };
    if (_ma5)  drawInd(_ma5,  "#D48806");
    if (_ma10) drawInd(_ma10, "#0277BD", [4, 3]);
    if (_bb) {
      drawInd(_bb.upper,  "rgba(131,56,236,0.75)", [3, 3]);
      drawInd(_bb.lower,  "rgba(131,56,236,0.75)", [3, 3]);
      drawInd(_bb.middle, "rgba(131,56,236,0.45)", [2, 4]);
    }

    // Y軸ラベル（最大・最小）
    ctx.fillStyle = "#5C4033";
    ctx.font = "10px 'Segoe UI', Meiryo, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText(max.toFixed(1), pad.left - 4, pad.top);
    ctx.textBaseline = "bottom";
    ctx.fillText(min.toFixed(1), pad.left - 4, pad.top + cH);

    // 件数・直近値ラベル
    const last = data[data.length - 1];
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`直近 ${last.toFixed(2)}🪙（${data.length}約定）`, W - pad.right, H - 2);
  }

  _setupHandlers() {
    document.getElementById("orderbook-close")
      ?.addEventListener("click", () => this.close());

    // タブ切替
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._activeTab = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach(b => {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        document.getElementById("tab-limit")?.classList.toggle("hidden", this._activeTab !== "limit");
        document.getElementById("tab-market")?.classList.toggle("hidden", this._activeTab !== "market");
        this._refreshMarketRate();
        this._refreshLimitPreview();
      });
    });

    // 成行：買い/売り切替
    document.querySelectorAll(".market-side-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._marketSide = btn.dataset.side;
        document.querySelectorAll(".market-side-btn").forEach(b => {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        document.getElementById("market-buy-form")?.classList.toggle("hidden", this._marketSide !== "buy");
        document.getElementById("market-sell-form")?.classList.toggle("hidden", this._marketSide !== "sell");
        this._refreshMarketRate();
      });
    });

    // 指値フォーム：片方を資源にしたらもう片方を自動でコインに合わせる（誤入力防止）
    const sellSel = document.getElementById("post-sell-type");
    const buySel  = document.getElementById("post-buy-type");
    sellSel?.addEventListener("change", () => {
      if (sellSel.value !== "coin" && buySel && buySel.value !== "coin") {
        buySel.value = "coin";
      } else if (sellSel.value === "coin" && buySel && buySel.value === "coin") {
        buySel.value = this._activeResource;
      }
      this._refreshLimitPreview();
    });
    buySel?.addEventListener("change", () => {
      if (buySel.value !== "coin" && sellSel && sellSel.value !== "coin") {
        sellSel.value = "coin";
      } else if (buySel.value === "coin" && sellSel && sellSel.value === "coin") {
        sellSel.value = this._activeResource;
      }
      this._refreshLimitPreview();
    });
    ["post-sell-amount", "post-buy-amount"].forEach(id => {
      document.getElementById(id)?.addEventListener("input", () => this._refreshLimitPreview());
    });

    // 指値注文を出す
    document.getElementById("post-order-btn")
      ?.addEventListener("click", () => this._postFromForm());

    // 成行注文を実行
    document.getElementById("market-buy-btn")
      ?.addEventListener("click", () => this._runMarket("buy"));
    document.getElementById("market-sell-btn")
      ?.addEventListener("click", () => this._runMarket("sell"));

    // レート表示をリアルタイム更新
    ["market-buy-type", "market-buy-amount", "market-sell-type", "market-sell-amount"].forEach(id => {
      document.getElementById(id)?.addEventListener("input", () => this._refreshMarketRate());
      document.getElementById(id)?.addEventListener("change", () => this._refreshMarketRate());
    });

    // 資源タブ切替（フォームの対象資源も自然に連動）
    document.querySelectorAll(".resource-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this._activeResource = btn.dataset.resource;
        document.querySelectorAll(".resource-tab-btn").forEach(b => {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        this._syncFormsToResource(this._activeResource);
        this._renderList();
        this._renderChart();
        this._refreshMarketRate();
        this._refreshLimitPreview();
      });
    });

    // テクニカル指標トグル
    document.querySelectorAll(".ind-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const ind = btn.dataset.ind;
        const active = !this._activeIndicators.has(ind);
        if (active) this._activeIndicators.add(ind);
        else this._activeIndicators.delete(ind);
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", String(active));
        if (this.isOpen) this._renderChart();
      });
    });
  }

  _syncFormsToResource(resource) {
    if (typeof document === "undefined") return;
    const mBuy  = document.getElementById("market-buy-type");
    const mSell = document.getElementById("market-sell-type");
    const pSell = document.getElementById("post-sell-type");
    const pBuy  = document.getElementById("post-buy-type");
    if (mBuy)  mBuy.value  = resource;
    if (mSell) mSell.value = resource;
    if (pSell && pBuy) {
      if (pSell.value === "coin") pBuy.value = resource;
      else pSell.value = resource;
    }
  }

  _refreshLimitPreview() {
    if (typeof document === "undefined") return;
    const previewEl = document.getElementById("limit-unit-preview");
    if (!previewEl) return;

    const sellType   = document.getElementById("post-sell-type")?.value;
    const sellAmount = parseInt(document.getElementById("post-sell-amount")?.value, 10) || 0;
    const buyType    = document.getElementById("post-buy-type")?.value;
    const buyAmount  = parseInt(document.getElementById("post-buy-amount")?.value, 10) || 0;

    if (!sellType || !buyType || sellType === buyType || (sellType !== "coin" && buyType !== "coin") || sellAmount <= 0 || buyAmount <= 0) {
      previewEl.textContent = "売る・買うの一方を 🪙 コイン にして数量を入力してください";
      return;
    }

    const isBuy = sellType === "coin";
    const resType = isBuy ? buyType : sellType;
    const unit = isBuy ? (sellAmount / buyAmount) : (buyAmount / sellAmount);
    const avail = this._player ? this.getAvailableBalance(this._player, sellType) : 0;
    const sideLabel = isBuy ? "買い指値" : "売り指値";
    previewEl.textContent = `${sideLabel}: 単価 🪙${unit.toFixed(2)}/${RESOURCE_LABEL[resType]}（利用可能 ${RESOURCE_EMOJI[sellType]}×${avail}）`;
  }

  _postFromForm() {
    const sellType   = document.getElementById("post-sell-type").value;
    const sellAmount = parseInt(document.getElementById("post-sell-amount").value, 10) || 0;
    const buyType    = document.getElementById("post-buy-type").value;
    const buyAmount  = parseInt(document.getElementById("post-buy-amount").value, 10) || 0;
    const statusEl   = document.getElementById("post-status");

    if (sellType === buyType)
      return this._showStatus(statusEl, "同じ素材は交換できません", false);
    if (sellType !== "coin" && buyType !== "coin")
      return this._showStatus(statusEl, "資源同士の交換はできません（一方はコインを選んでください）", false);
    if (sellAmount <= 0 || buyAmount <= 0)
      return this._showStatus(statusEl, "1以上の数量を入力してください", false);
    if (this.getAvailableBalance(this._player, sellType) < sellAmount)
      return this._showStatus(statusEl, `利用可能な${RESOURCE_LABEL[sellType]}が足りません（既存注文で予約中を含む）`, false);

    const order = this.postOrder(this._player, sellType, sellAmount, buyType, buyAmount);
    if (!order) {
      return this._showStatus(statusEl, "同じ組み合わせの注文がすでにあります", false);
    }
    if (order._wasFullyMatched) {
      this._showStatus(statusEl, "✅ 注文が即座に全量約定しました！", true);
    } else if (order._matchedCount > 0) {
      this._showStatus(statusEl, "✅ 一部約定し、残量を板に出しました！", true);
    } else {
      this._showStatus(statusEl, "📌 板に指値注文を出しました！", true);
    }
  }

  _runMarket(side) {
    const statusEl = document.getElementById("post-status");

    if (side === "buy") {
      const receiveType = document.getElementById("market-buy-type").value;
      const wantAmount  = parseInt(document.getElementById("market-buy-amount").value, 10) || 0;
      if (wantAmount <= 0) return this._showStatus(statusEl, "1以上の数量を入力してください", false);

      const res = this.executeMarketBuy(this._player, receiveType, wantAmount);
      if (res.ok) {
        this._showStatus(
          statusEl,
          `✅ ${RESOURCE_EMOJI[res.payType]}×${res.cost} → ${RESOURCE_EMOJI[receiveType]}×${wantAmount}`,
          true
        );
        if (this.onExecute) {
          res.fills.forEach(fill => this.onExecute(fill, this._player));
        }
      } else {
        this._showStatus(statusEl, `❌ ${res.reason}`, false);
      }
    } else {
      const giveType   = document.getElementById("market-sell-type").value;
      const giveAmount = parseInt(document.getElementById("market-sell-amount").value, 10) || 0;
      if (giveAmount <= 0) return this._showStatus(statusEl, "1以上の数量を入力してください", false);

      const res = this.executeMarketSell(this._player, giveType, giveAmount);
      if (res.ok) {
        this._showStatus(
          statusEl,
          `✅ ${RESOURCE_EMOJI[giveType]}×${giveAmount} → ${RESOURCE_EMOJI[res.receiveType]}×${res.receiveAmount}`,
          true
        );
        if (this.onExecute) {
          res.fills.forEach(fill => this.onExecute(fill, this._player));
        }
      } else {
        this._showStatus(statusEl, `❌ ${res.reason}`, false);
      }
    }
  }

  _refreshMarketRate() {
    if (typeof document === "undefined" || !this.isOpen || this._activeTab !== "market") return;
    const pid = this._player?.id;

    if (this._marketSide === "buy") {
      const type   = document.getElementById("market-buy-type")?.value;
      const amount = parseInt(document.getElementById("market-buy-amount")?.value, 10) || 1;
      const rateEl = document.getElementById("market-buy-rate");
      if (!rateEl || !type) return;

      const sim = this.simulateMarketOrder("buy", type, amount, pid);
      if (!sim.ok) {
        rateEl.textContent = sim.maxFillable > 0
          ? `板残高不足: 最大 ${RESOURCE_EMOJI[type]}×${sim.maxFillable} まで購入可能`
          : "最良レート: 売り注文なし";
        rateEl.className = "market-rate no-rate";
      } else {
        const avg = (sim.totalCoins / amount).toFixed(2);
        rateEl.textContent =
          `見積: 🪙×${sim.totalCoins} で ${RESOURCE_EMOJI[type]}×${amount} を購入（平均 🪙${avg}/個）`;
        rateEl.className = "market-rate has-rate";
      }
    } else {
      const type   = document.getElementById("market-sell-type")?.value;
      const amount = parseInt(document.getElementById("market-sell-amount")?.value, 10) || 1;
      const rateEl = document.getElementById("market-sell-rate");
      if (!rateEl || !type) return;

      const sim = this.simulateMarketOrder("sell", type, amount, pid);
      if (!sim.ok) {
        rateEl.textContent = sim.maxFillable > 0
          ? `板残高不足: 最大 ${RESOURCE_EMOJI[type]}×${sim.maxFillable} まで売却可能`
          : "最良レート: 買い注文なし";
        rateEl.className = "market-rate no-rate";
      } else {
        const avg = (sim.totalCoins / amount).toFixed(2);
        rateEl.textContent =
          `見積: ${RESOURCE_EMOJI[type]}×${amount} → 🪙×${sim.totalCoins} 受取（平均 🪙${avg}/個）`;
        rateEl.className = "market-rate has-rate";
      }
    }
  }

  _showStatus(el, msg, ok) {
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok ? "var(--c-successText, #245C1A)" : "var(--c-dangerText, #B71C1C)";
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => { el.textContent = ""; }, 3500);
  }

  _escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _renderList() {
    if (!this._list) return;
    this.pruneInvalidOrders();
    this._renderRecentTrades();

    const filtered = this.orders.filter(o =>
      o.sellType === this._activeResource || o.buyType === this._activeResource
    );

    if (!filtered.length) {
      this._list.innerHTML = `<div class="order-empty">${RESOURCE_EMOJI[this._activeResource]} ${RESOURCE_LABEL[this._activeResource]} の注文はまだありません</div>`;
      return;
    }

    const rows = filtered.map(o => {
      const isBuy = o.buyType === this._activeResource;
      return { o, isBuy, price: o.unitPrice };
    }).sort((a, b) => b.price - a.price || a.o.id - b.o.id);

    const fmtPrice = p => p.toFixed(2).replace(/\.?0+$/, "");

    const header = `<div class="order-header">
      <span class="col-sell-qty">売量</span>
      <span class="col-price">価格 / 注文者</span>
      <span class="col-buy-qty">買量</span>
      <span>操作</span>
    </div>`;

    const items = rows.map(({ o, isBuy, price }) => {
      const isOwn   = this._player && o.posterId === this._player.id;
      const canExec = !isOwn && this._player &&
        (this._player.inventory[o.buyType] || 0) >= o.buyAmount &&
        (o.posterRef.inventory[o.sellType] || 0) >= o.sellAmount;

      const sellQty = !isBuy ? `<b>${o.sellAmount}</b>` : `<span class="col-empty">—</span>`;
      const buyQty  = isBuy  ? `<b>${o.buyAmount}</b>`  : `<span class="col-empty">—</span>`;
      const safeName = this._escapeHtml(o.posterName);
      const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(o.posterColor || "") ? o.posterColor : "#555";

      const btn = isOwn
        ? `<button type="button" class="order-btn cancel-btn" data-id="${o.id}">取消</button>`
        : `<button type="button" class="order-btn execute-btn" data-id="${o.id}"
             ${canExec ? "" : "disabled"}>${canExec ? "成立" : "残高不足"}</button>`;

      return `<div class="order-item${isOwn ? " own-order" : ""}${isBuy ? " buy-order" : " sell-order"}">
        <span class="col-sell-qty">${sellQty}</span>
        <span class="col-price">
          <span>🪙${fmtPrice(price)}</span>
          <span class="col-poster" style="color:${safeColor}">${safeName}</span>
        </span>
        <span class="col-buy-qty">${buyQty}</span>
        ${btn}
      </div>`;
    }).join("");

    this._list.innerHTML = header + items;

    this._list.querySelectorAll(".execute-btn:not([disabled])").forEach(btn => {
      btn.addEventListener("click", () => {
        const executed = this.executeOrder(parseInt(btn.dataset.id, 10), this._player);
        if (executed && this.onExecute) this.onExecute(executed, this._player);
      });
    });
    this._list.querySelectorAll(".cancel-btn").forEach(btn => {
      btn.addEventListener("click", () =>
        this.cancelOrder(parseInt(btn.dataset.id, 10), this._player.id));
    });
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { TRADE_RESOURCES, OrderBook };
}
