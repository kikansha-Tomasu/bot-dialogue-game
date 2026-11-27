// ============================================================
// farming.js — 農業プログレッション（8種作物×4成長ステージ）＆料理クラフト
// 収穫・調理では固定コインを付与せず、作物・料理アイテムを所持品へ追加する
// 売却してコインを得るには取引板（OrderBook）に注文を出し約定させる必要がある
// ============================================================

const CROP_CATALOG = {
  carrot: {
    id: "carrot",
    name: "ニンジン",
    emoji: "🥕",
    tier: 1,
    minTownLevel: 0,
    unlockCoinThreshold: 0,
    cost: { wood: 1 },
    stageTime: 8, // 8秒×3段階 = 24秒で収穫可能
    harvestAmount: 1,
    bonusResource: "herb",
    bonusAmount: 1,
  },
  wheat: {
    id: "wheat",
    name: "小麦",
    emoji: "🌾",
    tier: 1,
    minTownLevel: 0,
    unlockCoinThreshold: 0,
    cost: { herb: 1 },
    stageTime: 9, // 27秒
    harvestAmount: 1,
    bonusResource: "wood",
    bonusAmount: 1,
  },
  cabbage: {
    id: "cabbage",
    name: "キャベツ",
    emoji: "🥬",
    tier: 2,
    minTownLevel: 1,
    unlockCoinThreshold: 60,
    cost: { wood: 1, herb: 1 },
    stageTime: 10, // 30秒
    harvestAmount: 1,
    bonusResource: "herb",
    bonusAmount: 1,
  },
  tomato: {
    id: "tomato",
    name: "トマト",
    emoji: "🍅",
    tier: 2,
    minTownLevel: 1,
    unlockCoinThreshold: 60,
    cost: { herb: 1, stone: 1 },
    stageTime: 11, // 33秒
    harvestAmount: 1,
    bonusResource: "fish",
    bonusAmount: 1,
  },
  corn: {
    id: "corn",
    name: "トウモロコシ",
    emoji: "🌽",
    tier: 3,
    minTownLevel: 2,
    unlockCoinThreshold: 75,
    cost: { wood: 2 },
    stageTime: 12, // 36秒
    harvestAmount: 1,
    bonusResource: "wood",
    bonusAmount: 1,
  },
  rice: {
    id: "rice",
    name: "お米",
    emoji: "🍙",
    tier: 3,
    minTownLevel: 2,
    unlockCoinThreshold: 75,
    cost: { fish: 1, herb: 1 },
    stageTime: 13, // 39秒
    harvestAmount: 1,
    bonusResource: "stone",
    bonusAmount: 1,
  },
  pumpkin: {
    id: "pumpkin",
    name: "カボチャ",
    emoji: "🎃",
    tier: 4,
    minTownLevel: 3,
    unlockCoinThreshold: 95,
    cost: { stone: 2, herb: 1 },
    stageTime: 14, // 42秒
    harvestAmount: 1,
    bonusResource: "stone",
    bonusAmount: 1,
  },
  strawberry: {
    id: "strawberry",
    name: "イチゴ",
    emoji: "🍓",
    tier: 4,
    minTownLevel: 3,
    unlockCoinThreshold: 95,
    cost: { herb: 2, fish: 1 },
    stageTime: 15, // 45秒
    harvestAmount: 1,
    bonusResource: "fish",
    bonusAmount: 1,
  },
};

// 各マップの農地8区画（建物・道路・森・池と重ならないタイル座標 [col, row]）
const MAP_FARM_PLOTS = {
  central_plaza: [
    [3, 3], [4, 3], [6, 3], [7, 3],
    [3, 6], [4, 6], [6, 6], [7, 6],
  ],
  shopping_street: [
    [2, 3], [4, 3], [8, 3], [10, 3],
    [2, 4], [4, 4], [8, 4], [10, 4],
  ],
  forest_hamlet: [
    [3, 4], [4, 4], [7, 4], [8, 4],
    [3, 7], [4, 7], [7, 7], [8, 7],
  ],
  farm_riverside: [
    [1, 1], [2, 1], [3, 1], [4, 1],
    [1, 7], [2, 7], [9, 7], [10, 7],
  ],
};

const MAX_PLOTS_PER_CHAR = 2;

// 収穫・購入した作物＋基本資源でクラフトできる料理レシピ（完成品は所持品へ追加・取引板で売買）
const COOKING_RECIPES = {
  carrot_salad: {
    id: "carrot_salad",
    name: "キャロットサラダ",
    emoji: "🥗",
    tier: 1,
    crops: { carrot: 1 },
    resources: { herb: 1 },
    desc: "採れたてニンジンと薬草の爽やかサラダ",
  },
  herb_bread: {
    id: "herb_bread",
    name: "ハーブパン",
    emoji: "🍞",
    tier: 1,
    crops: { wheat: 1 },
    resources: { wood: 1, herb: 1 },
    desc: "小麦と香草を薪窯で焼き上げた芳醇なパン",
  },
  tomato_soup: {
    id: "tomato_soup",
    name: "トマト魚介スープ",
    emoji: "🍲",
    tier: 2,
    crops: { tomato: 1, cabbage: 1 },
    resources: { fish: 1 },
    desc: "完熟トマトとキャベツ・鮮魚の特製スープ",
  },
  onigiri_bento: {
    id: "onigiri_bento",
    name: "焼きおにぎり弁当",
    emoji: "🍱",
    tier: 3,
    crops: { rice: 1, corn: 1 },
    resources: { fish: 1 },
    desc: "ツヤツヤのお米と焼きトウモロコシ・焼き魚の弁当",
  },
  pumpkin_pie: {
    id: "pumpkin_pie",
    name: "パンプキンパイ",
    emoji: "🥧",
    tier: 4,
    crops: { pumpkin: 1, wheat: 1 },
    resources: { wood: 1 },
    desc: "濃厚カボチャを贅沢に使った黄金色のパイ",
  },
  strawberry_tart: {
    id: "strawberry_tart",
    name: "ストロベリータルト",
    emoji: "🎂",
    tier: 4,
    crops: { strawberry: 1, wheat: 1 },
    resources: { herb: 2 },
    desc: "最高級イチゴをふんだんに飾った至高のスイーツ",
  },
};

class FarmManager {
  constructor() {
    this.plots = [];
    this.mapId = "central_plaza";
    this.selectedCropId = "carrot";
    this.cookedCount = {}; // charId -> 料理作成回数
    this.onChange = null;
    this.onHarvest = null;
    this.onCook = null;
    this.initForMap("central_plaza", false);
  }

  // 所持品内の作物ストック一覧を返す
  getCropStock(char) {
    const stock = {};
    for (const cropId of Object.keys(CROP_CATALOG)) {
      stock[cropId] = char?.inventory?.[cropId] || 0;
    }
    return stock;
  }

  // 所持品内の完成料理ストック一覧を返す
  getDishStock(char) {
    const stock = {};
    for (const dishId of Object.keys(COOKING_RECIPES)) {
      stock[dishId] = char?.inventory?.[dishId] || 0;
    }
    return stock;
  }

  getCookedCount(charId) {
    return this.cookedCount[charId] || 0;
  }

  canCook(char, recipeId) {
    if (!char || !char.inventory) return { ok: false, reason: "キャラクターが不正です" };
    const recipe = COOKING_RECIPES[recipeId];
    if (!recipe) return { ok: false, reason: "不明なレシピです" };
    for (const [cropId, need] of Object.entries(recipe.crops || {})) {
      if ((char.inventory[cropId] || 0) < need) {
        return { ok: false, reason: `${CROP_CATALOG[cropId]?.name || cropId}が足りません` };
      }
    }
    if (!inventoryCanAfford(char.inventory, recipe.resources || {})) {
      return { ok: false, reason: "料理に必要な資源が足りません" };
    }
    return { ok: true, recipe };
  }

  // 料理を作成して所持品へ追加する（固定コイン報酬なし：売却は取引板で行う）
  cookRecipe(char, recipeId) {
    const check = this.canCook(char, recipeId);
    if (!check.ok) return check;
    const recipe = check.recipe;

    const totalCost = { ...(recipe.resources || {}) };
    for (const [cropId, need] of Object.entries(recipe.crops || {})) {
      totalCost[cropId] = (totalCost[cropId] || 0) + need;
    }
    if (!inventoryDeduct(char.inventory, totalCost)) {
      return { ok: false, reason: "食材または資源が足りません" };
    }

    inventoryAdd(char.inventory, recipe.id, 1);
    this.cookedCount[char.id] = (this.cookedCount[char.id] || 0) + 1;

    const result = { ok: true, recipe, dishId: recipe.id, dishAmount: 1 };
    if (this.onCook) this.onCook(char, result);
    if (this.onChange) this.onChange();
    return result;
  }

  // AIライバル用：作れる料理を市場価格（未成立時はティア順）を参考にクラフト
  tryAICook(char, priceHistory = null) {
    const scoreRecipe = (r) => {
      const hist = priceHistory?.[r.id];
      if (hist && hist.length > 0) return hist[hist.length - 1];
      return (r.tier || 1) * 5;
    };
    const available = Object.values(COOKING_RECIPES)
      .filter(r => this.canCook(char, r.id).ok)
      .sort((a, b) => scoreRecipe(b) - scoreRecipe(a));
    if (!available.length) return null;
    const res = this.cookRecipe(char, available[0].id);
    return res.ok ? res : null;
  }

  initForMap(mapId = "central_plaza", preserveActive = true) {
    this.mapId = MAP_FARM_PLOTS[mapId] ? mapId : "central_plaza";
    const coords = MAP_FARM_PLOTS[this.mapId];
    const prevPlots = preserveActive ? this.plots : [];

    this.plots = coords.map(([col, row], idx) => {
      const prev = prevPlots[idx];
      return {
        id: `plot_${idx + 1}`,
        index: idx,
        col,
        row,
        ownerId: prev?.ownerId || null,
        ownerName: prev?.ownerName || null,
        ownerColor: prev?.ownerColor || null,
        cropId: prev?.cropId || null,
        stage: prev?.cropId ? (prev.stage ?? 0) : 0, // 0:種まき, 1:発芽, 2:成長, 3:収穫可能
        stageTimer: prev?.cropId ? (prev.stageTimer ?? 8) : 0,
        stageDuration: prev?.cropId ? (prev.stageDuration ?? 8) : 0,
      };
    });
  }

  isCropUnlocked(cropId, char, townLevel = 0) {
    const crop = CROP_CATALOG[cropId];
    if (!crop) return false;
    if (townLevel >= crop.minTownLevel) return true;
    const coins = char?.inventory?.coin || 0;
    return coins >= crop.unlockCoinThreshold;
  }

  getAvailableCrops(char, townLevel = 0) {
    return Object.values(CROP_CATALOG).filter(c => this.isCropUnlocked(c.id, char, townLevel));
  }

  getPlotsByOwner(ownerId) {
    return this.plots.filter(p => p.ownerId === ownerId && p.cropId);
  }

  getRipePlotsByOwner(ownerId) {
    return this.plots.filter(p => p.ownerId === ownerId && p.cropId && p.stage >= 3);
  }

  getEmptyPlots() {
    return this.plots.filter(p => !p.cropId);
  }

  getPlotWorldCenter(plot, canvasW, canvasH, mapWidth = 12, mapHeight = 10) {
    const tileW = canvasW / mapWidth;
    const tileH = canvasH / mapHeight;
    return {
      x: (plot.col + 0.5) * tileW,
      y: (plot.row + 0.5) * tileH,
    };
  }

  canPlant(char, cropId, townLevel = 0) {
    if (!char || !char.inventory) return { ok: false, reason: "キャラクターが不正です" };
    const crop = CROP_CATALOG[cropId];
    if (!crop) return { ok: false, reason: "不明な作物です" };
    if (!this.isCropUnlocked(cropId, char, townLevel)) {
      return { ok: false, reason: `街Lv.${crop.minTownLevel}（または🪙${crop.unlockCoinThreshold}以上）で解放されます` };
    }
    const owned = this.getPlotsByOwner(char.id);
    if (owned.length >= MAX_PLOTS_PER_CHAR) {
      return { ok: false, reason: `農地は1人あたり最大${MAX_PLOTS_PER_CHAR}区画までです（収穫すると空きます）` };
    }
    const empty = this.getEmptyPlots();
    if (empty.length === 0) {
      return { ok: false, reason: "空き農地がありません（ライバルが使用中）" };
    }
    if (!inventoryCanAfford(char.inventory, crop.cost)) {
      return { ok: false, reason: "種まきに必要な資源が足りません" };
    }
    return { ok: true, crop };
  }

  plantCrop(char, cropId, plotId = null, townLevel = 0, canvasW = 800, canvasH = 600, mapW = 12, mapH = 10) {
    const check = this.canPlant(char, cropId, townLevel);
    if (!check.ok) return check;
    const crop = check.crop;

    let targetPlot = plotId
      ? this.plots.find(p => p.id === plotId && !p.cropId)
      : null;

    if (!targetPlot) {
      const empties = this.getEmptyPlots();
      empties.sort((a, b) => {
        const pa = this.getPlotWorldCenter(a, canvasW, canvasH, mapW, mapH);
        const pb = this.getPlotWorldCenter(b, canvasW, canvasH, mapW, mapH);
        return Math.hypot(pa.x - char.x, pa.y - char.y) - Math.hypot(pb.x - char.x, pb.y - char.y);
      });
      targetPlot = empties[0];
    }

    if (!targetPlot) return { ok: false, reason: "空き農地がありません" };
    if (!inventoryDeduct(char.inventory, crop.cost)) {
      return { ok: false, reason: "コストが足りません" };
    }

    targetPlot.ownerId = char.id;
    targetPlot.ownerName = char.name;
    targetPlot.ownerColor = char.color || "#FFD700";
    targetPlot.cropId = crop.id;
    targetPlot.stage = 0;
    targetPlot.stageDuration = crop.stageTime;
    targetPlot.stageTimer = crop.stageTime;

    if (this.onChange) this.onChange();
    return { ok: true, plot: targetPlot, crop };
  }

  // 収穫：固定コイン報酬なし。作物アイテムと副産物資源を所持品へ追加する
  harvestPlot(plotId, harvester, harvestBonus = 0) {
    if (!harvester || !harvester.inventory) return { ok: false, reason: "キャラクターが不正です" };
    const plot = this.plots.find(p => p.id === plotId);
    if (!plot || !plot.cropId) return { ok: false, reason: "作物が植えられていません" };
    if (plot.ownerId !== harvester.id) {
      return { ok: false, reason: `${plot.ownerName}の農地は収穫できません` };
    }
    if (plot.stage < 3) {
      return { ok: false, reason: `まだ成長中です（Stage ${plot.stage}/3）` };
    }

    const crop = CROP_CATALOG[plot.cropId];
    const harvestAmount = Math.max(1, (crop?.harvestAmount || 1) + Math.max(0, Math.floor(Number(harvestBonus) || 0)));
    const bonusResource = crop?.bonusResource || null;
    const bonusAmount = crop?.bonusAmount || 0;

    if (crop) {
      inventoryAdd(harvester.inventory, crop.id, harvestAmount);
    }
    if (bonusResource && bonusAmount > 0) {
      inventoryAdd(harvester.inventory, bonusResource, bonusAmount);
    }

    plot.ownerId = null;
    plot.ownerName = null;
    plot.ownerColor = null;
    plot.cropId = null;
    plot.stage = 0;
    plot.stageTimer = 0;
    plot.stageDuration = 0;

    const result = {
      ok: true,
      plot,
      crop,
      harvestAmount,
      bonusResource,
      bonusAmount,
    };
    if (this.onHarvest) this.onHarvest(harvester, result);
    if (this.onChange) this.onChange();
    return result;
  }

  harvestAllRipeForChar(char, harvestBonus = 0) {
    const ripe = this.getRipePlotsByOwner(char.id);
    const results = [];
    for (const p of ripe) {
      const res = this.harvestPlot(p.id, char, harvestBonus);
      if (res.ok) results.push(res);
    }
    return results;
  }

  // 毎フレーム更新：成長ステージを 0 → 1 → 2 → 3 へ進める
  update(dt, getSpeedMultFn = null) {
    const ripeEvents = [];
    let changed = false;

    for (const p of this.plots) {
      if (!p.cropId || p.stage >= 3) continue;
      const mult = typeof getSpeedMultFn === "function" ? (getSpeedMultFn(p.ownerId) || 1.0) : 1.0;
      p.stageTimer -= dt * mult;
      if (p.stageTimer <= 0) {
        p.stage += 1;
        changed = true;
        if (p.stage >= 3) {
          p.stage = 3;
          p.stageTimer = 0;
          ripeEvents.push({ plot: p, crop: CROP_CATALOG[p.cropId] });
        } else {
          p.stageTimer = p.stageDuration || CROP_CATALOG[p.cropId]?.stageTime || 8;
        }
      }
    }

    if (changed && this.onChange) this.onChange();
    return ripeEvents;
  }

  // プレイヤーやAIの近くにある「収穫可能な自分の畑」を探す
  getNearbyRipePlot(x, y, radius, ownerId, canvasW, canvasH, mapW = 12, mapH = 10) {
    const candidates = this.getRipePlotsByOwner(ownerId)
      .map(p => {
        const pt = this.getPlotWorldCenter(p, canvasW, canvasH, mapW, mapH);
        return { plot: p, dist: Math.hypot(pt.x - x, pt.y - y), pt };
      })
      .filter(item => item.dist <= radius)
      .sort((a, b) => a.dist - b.dist);
    return candidates[0]?.plot || null;
  }

  // 栽培中の農地資産評価額（取引板の直近約定価格のみ参照・未約定なら0）
  getFarmAssetValue(ownerId, priceHistory = null) {
    let value = 0;
    for (const p of this.plots) {
      if (p.ownerId !== ownerId || !p.cropId) continue;
      const hist = priceHistory?.[p.cropId];
      const marketPrice = hist && hist.length > 0 ? hist[hist.length - 1] : 0;
      if (marketPrice <= 0) continue;
      const stageFactor = [0.4, 0.6, 0.8, 1.0][p.stage] || 0.4;
      value += marketPrice * stageFactor;
    }
    return value;
  }

  buildSummaryForAI(char) {
    const stageLabels = ["種まき直後", "芽が出たところ", "ぐんぐん成長中", "収穫どき！"];
    const myPlots = this.getPlotsByOwner(char.id);
    const emptyCount = this.getEmptyPlots().length;
    const myStr = myPlots.length
      ? myPlots.map(p => {
          const c = CROP_CATALOG[p.cropId];
          return `${c.emoji}${c.name}（${stageLabels[p.stage] || "成長中"}）`;
        }).join("・")
      : "なし";

    const rivalPlots = this.plots.filter(p => p.cropId && p.ownerId !== char.id);
    const rivalStr = rivalPlots.length
      ? rivalPlots.map(p => {
          const c = CROP_CATALOG[p.cropId];
          return `${p.ownerName}の${c.emoji}${c.name}（${stageLabels[p.stage] || "成長中"}）`;
        }).join("・")
      : "なし";

    return `自分の畑(${myPlots.length}/${MAX_PLOTS_PER_CHAR}): ${myStr} ／ みんなの畑: ${rivalStr} ／ 空いている畑: ${emptyCount}区画`;
  }

  serialize() {
    return {
      selectedCropId: this.selectedCropId,
      cookedCount: { ...this.cookedCount },
      plots: this.plots.map(p => ({
        index: p.index,
        ownerId: p.ownerId,
        ownerName: p.ownerName,
        ownerColor: p.ownerColor,
        cropId: p.cropId,
        stage: p.stage,
        stageTimer: p.stageTimer,
        stageDuration: p.stageDuration,
      })),
    };
  }

  deserialize(data, characters = []) {
    if (!data || typeof data !== "object") return;
    if (typeof data.selectedCropId === "string" && CROP_CATALOG[data.selectedCropId]) {
      this.selectedCropId = data.selectedCropId;
    }
    // 旧セーブデータの pantry が残っていれば所持品へ安全に移行
    if (data.pantry && typeof data.pantry === "object") {
      for (const [cid, items] of Object.entries(data.pantry)) {
        const owner = characters.find(c => c.id === cid);
        if (!owner || !owner.inventory || !items || typeof items !== "object") continue;
        for (const cropKey of Object.keys(CROP_CATALOG)) {
          const n = Math.floor(Number(items[cropKey]) || 0);
          if (n > 0 && !(owner.inventory[cropKey] > 0)) {
            owner.inventory[cropKey] = n;
          }
        }
      }
    }
    if (data.cookedCount && typeof data.cookedCount === "object") {
      this.cookedCount = {};
      for (const [cid, cnt] of Object.entries(data.cookedCount)) {
        const n = Math.floor(Number(cnt) || 0);
        if (n >= 0) this.cookedCount[cid] = n;
      }
    }
    if (!Array.isArray(data.plots)) return;

    for (const sp of data.plots) {
      const target = this.plots[sp.index];
      if (!target) continue;
      if (!sp.cropId || !CROP_CATALOG[sp.cropId]) {
        target.ownerId = null;
        target.ownerName = null;
        target.ownerColor = null;
        target.cropId = null;
        target.stage = 0;
        target.stageTimer = 0;
        target.stageDuration = 0;
        continue;
      }
      const owner = characters.find(c => c.id === sp.ownerId);
      const crop = CROP_CATALOG[sp.cropId];
      target.ownerId = sp.ownerId;
      target.ownerName = owner?.name || sp.ownerName || sp.ownerId;
      target.ownerColor = owner?.color || sp.ownerColor || "#FFD700";
      target.cropId = crop.id;
      target.stage = Math.max(0, Math.min(3, Math.floor(Number(sp.stage) || 0)));
      target.stageDuration = crop.stageTime;
      target.stageTimer = Number.isFinite(Number(sp.stageTimer))
        ? Math.max(0, Math.min(crop.stageTime, Number(sp.stageTimer)))
        : crop.stageTime;
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CROP_CATALOG,
    COOKING_RECIPES,
    MAP_FARM_PLOTS,
    MAX_PLOTS_PER_CHAR,
    FarmManager,
  };
}
