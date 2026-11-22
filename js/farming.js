// ============================================================
// farming.js — 農業プログレッション（8種作物×4成長ステージ・ライバル農地競争）
// ============================================================

const CROP_CATALOG = {
  carrot: {
    id: "carrot",
    name: "ニンジン",
    emoji: "🥕",
    tier: 1,
    minTownLevel: 0,
    unlockCoinThreshold: 0,
    cost: { coin: 2 },
    stageTime: 8, // 8秒×3段階 = 24秒で収穫可能
    rewardCoins: 5,
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
    cost: { coin: 3 },
    stageTime: 9, // 27秒
    rewardCoins: 7,
    bonusResource: "wood",
    bonusAmount: 1,
  },
  cabbage: {
    id: "cabbage",
    name: "キャベツ",
    emoji: "🥬",
    tier: 2,
    minTownLevel: 1,
    unlockCoinThreshold: 14,
    cost: { coin: 4, herb: 1 },
    stageTime: 10, // 30秒
    rewardCoins: 10,
    bonusResource: "herb",
    bonusAmount: 2,
  },
  tomato: {
    id: "tomato",
    name: "トマト",
    emoji: "🍅",
    tier: 2,
    minTownLevel: 1,
    unlockCoinThreshold: 16,
    cost: { coin: 5, herb: 1 },
    stageTime: 11, // 33秒
    rewardCoins: 12,
    bonusResource: "fish",
    bonusAmount: 1,
  },
  corn: {
    id: "corn",
    name: "トウモロコシ",
    emoji: "🌽",
    tier: 3,
    minTownLevel: 2,
    unlockCoinThreshold: 22,
    cost: { coin: 7, wood: 1 },
    stageTime: 12, // 36秒
    rewardCoins: 16,
    bonusResource: "wood",
    bonusAmount: 2,
  },
  rice: {
    id: "rice",
    name: "お米",
    emoji: "🍙",
    tier: 3,
    minTownLevel: 2,
    unlockCoinThreshold: 25,
    cost: { coin: 8, fish: 1 },
    stageTime: 13, // 39秒
    rewardCoins: 19,
    bonusResource: "stone",
    bonusAmount: 2,
  },
  pumpkin: {
    id: "pumpkin",
    name: "カボチャ",
    emoji: "🎃",
    tier: 4,
    minTownLevel: 3,
    unlockCoinThreshold: 35,
    cost: { coin: 11, stone: 1, herb: 1 },
    stageTime: 14, // 42秒
    rewardCoins: 26,
    bonusResource: "stone",
    bonusAmount: 2,
  },
  strawberry: {
    id: "strawberry",
    name: "イチゴ",
    emoji: "🍓",
    tier: 4,
    minTownLevel: 3,
    unlockCoinThreshold: 40,
    cost: { coin: 14, herb: 2 },
    stageTime: 15, // 45秒
    rewardCoins: 34,
    bonusResource: "fish",
    bonusAmount: 2,
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

// 収穫した作物ストック＋基本資源で作れる高付加価値の料理クラフトレシピ
const COOKING_RECIPES = {
  carrot_salad: {
    id: "carrot_salad",
    name: "新鮮キャロットサラダ",
    emoji: "🥗",
    crops: { carrot: 1 },
    resources: { herb: 1 },
    rewardCoins: 9,
    desc: "採れたてニンジンと薬草の爽やかサラダ",
  },
  herb_bread: {
    id: "herb_bread",
    name: "焼きたてハーブパン",
    emoji: "🍞",
    crops: { wheat: 1 },
    resources: { wood: 1, herb: 1 },
    rewardCoins: 14,
    desc: "小麦と香草を薪窯で焼き上げた芳醇なパン",
  },
  tomato_soup: {
    id: "tomato_soup",
    name: "彩りトマト魚介スープ",
    emoji: "🍲",
    crops: { tomato: 1, cabbage: 1 },
    resources: { fish: 1 },
    rewardCoins: 22,
    desc: "完熟トマトとキャベツ・鮮魚の特製スープ",
  },
  onigiri_bento: {
    id: "onigiri_bento",
    name: "特製焼きおにぎり弁当",
    emoji: "🍱",
    crops: { rice: 1, corn: 1 },
    resources: { fish: 1 },
    rewardCoins: 30,
    desc: "ツヤツヤのお米と焼きトウモロコシ・焼き魚の弁当",
  },
  pumpkin_pie: {
    id: "pumpkin_pie",
    name: "黄金パンプキンパイ",
    emoji: "🥧",
    crops: { pumpkin: 1, wheat: 1 },
    resources: { wood: 1 },
    rewardCoins: 38,
    desc: "濃厚カボチャを贅沢に使った黄金色のパイ",
  },
  strawberry_tart: {
    id: "strawberry_tart",
    name: "至高のストロベリータルト",
    emoji: "🎂",
    crops: { strawberry: 1, wheat: 1 },
    resources: { herb: 2 },
    rewardCoins: 50,
    desc: "最高級イチゴをふんだんに飾った至高のスイーツ",
  },
};

class FarmManager {
  constructor() {
    this.plots = [];
    this.mapId = "central_plaza";
    this.selectedCropId = "carrot";
    this.pantry = {};      // charId -> { carrot: 0, wheat: 0, ... }
    this.cookedCount = {}; // charId -> 料理作成回数
    this.onChange = null;
    this.onHarvest = null;
    this.onCook = null;
    this.initForMap("central_plaza", false);
  }

  getPantry(charId) {
    if (!this.pantry[charId]) {
      this.pantry[charId] = {
        carrot: 0, wheat: 0, cabbage: 0, tomato: 0,
        corn: 0, rice: 0, pumpkin: 0, strawberry: 0,
      };
    }
    return this.pantry[charId];
  }

  addPantryCrop(charId, cropId, amount = 1) {
    if (!charId || !CROP_CATALOG[cropId] || amount <= 0) return;
    const p = this.getPantry(charId);
    p[cropId] = (p[cropId] || 0) + amount;
  }

  getCookedCount(charId) {
    return this.cookedCount[charId] || 0;
  }

  canCook(char, recipeId) {
    if (!char || !char.inventory) return { ok: false, reason: "キャラクターが不正です" };
    const recipe = COOKING_RECIPES[recipeId];
    if (!recipe) return { ok: false, reason: "不明なレシピです" };
    const pantry = this.getPantry(char.id);
    for (const [cropId, need] of Object.entries(recipe.crops || {})) {
      if ((pantry[cropId] || 0) < need) {
        return { ok: false, reason: `収穫した${CROP_CATALOG[cropId]?.name || cropId}が足りません` };
      }
    }
    if (!inventoryCanAfford(char.inventory, recipe.resources || {})) {
      return { ok: false, reason: "料理に必要な資源が足りません" };
    }
    return { ok: true, recipe };
  }

  cookRecipe(char, recipeId) {
    const check = this.canCook(char, recipeId);
    if (!check.ok) return check;
    const recipe = check.recipe;
    const pantry = this.getPantry(char.id);

    if (!inventoryDeduct(char.inventory, recipe.resources || {})) {
      return { ok: false, reason: "資源が足りません" };
    }
    for (const [cropId, need] of Object.entries(recipe.crops || {})) {
      pantry[cropId] = Math.max(0, (pantry[cropId] || 0) - need);
    }

    inventoryAdd(char.inventory, "coin", recipe.rewardCoins);
    this.cookedCount[char.id] = (this.cookedCount[char.id] || 0) + 1;

    const result = { ok: true, recipe, rewardCoins: recipe.rewardCoins };
    if (this.onCook) this.onCook(char, result);
    if (this.onChange) this.onChange();
    return result;
  }

  // AIライバル用：作れる中で最も報酬が高い料理を自動クラフト
  tryAICook(char) {
    const available = Object.values(COOKING_RECIPES)
      .filter(r => this.canCook(char, r.id).ok)
      .sort((a, b) => b.rewardCoins - a.rewardCoins);
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
      return { ok: false, reason: "種まきに必要なコインまたは資源が足りません" };
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

  harvestPlot(plotId, harvester) {
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
    const rewardCoins = crop?.rewardCoins || 5;
    const bonusResource = crop?.bonusResource || null;
    const bonusAmount = crop?.bonusAmount || 0;

    inventoryAdd(harvester.inventory, "coin", rewardCoins);
    if (bonusResource && bonusAmount > 0) {
      inventoryAdd(harvester.inventory, bonusResource, bonusAmount);
    }
    // 収穫した作物を料理用パントリーにも +1 ストック
    if (crop) {
      this.addPantryCrop(harvester.id, crop.id, 1);
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
      rewardCoins,
      bonusResource,
      bonusAmount,
    };
    if (this.onHarvest) this.onHarvest(harvester, result);
    if (this.onChange) this.onChange();
    return result;
  }

  harvestAllRipeForChar(char) {
    const ripe = this.getRipePlotsByOwner(char.id);
    const results = [];
    for (const p of ripe) {
      const res = this.harvestPlot(p.id, char);
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

  // 栽培中の農地資産評価額（総資産ランキングに反映）
  getFarmAssetValue(ownerId) {
    let value = 0;
    for (const p of this.plots) {
      if (p.ownerId !== ownerId || !p.cropId) continue;
      const crop = CROP_CATALOG[p.cropId];
      if (!crop) continue;
      // 成長段階に応じて投資額〜収穫価値の 40%〜100% を資産計上
      const stageFactor = [0.4, 0.6, 0.8, 1.0][p.stage] || 0.4;
      value += crop.rewardCoins * stageFactor;
    }
    return value;
  }

  buildSummaryForAI(char) {
    const myPlots = this.getPlotsByOwner(char.id);
    const emptyCount = this.getEmptyPlots().length;
    const myStr = myPlots.length
      ? myPlots.map(p => {
          const c = CROP_CATALOG[p.cropId];
          return `${c.emoji}${c.name}(Stage ${p.stage}/3${p.stage >= 3 ? "・収穫可能!" : ""})`;
        }).join(", ")
      : "なし";

    const rivalPlots = this.plots.filter(p => p.cropId && p.ownerId !== char.id);
    const rivalStr = rivalPlots.length
      ? rivalPlots.map(p => {
          const c = CROP_CATALOG[p.cropId];
          return `${p.ownerName}:${c.emoji}${c.name}(Stage ${p.stage}/3)`;
        }).join(", ")
      : "なし";

    return `自分の農地(${myPlots.length}/${MAX_PLOTS_PER_CHAR}): ${myStr} ／ ライバルの農地: ${rivalStr} ／ 空き農地: ${emptyCount}区画`;
  }

  serialize() {
    return {
      selectedCropId: this.selectedCropId,
      pantry: JSON.parse(JSON.stringify(this.pantry || {})),
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
    if (data.pantry && typeof data.pantry === "object") {
      this.pantry = {};
      for (const [cid, items] of Object.entries(data.pantry)) {
        const clean = this.getPantry(cid);
        if (items && typeof items === "object") {
          for (const cropKey of Object.keys(CROP_CATALOG)) {
            const n = Math.floor(Number(items[cropKey]) || 0);
            if (n >= 0) clean[cropKey] = n;
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
