// ============================================================
// progression.js — 街の発展・プレイヤー強化・動物アバター・納品依頼
// お金と資源を増やす明確な目的と報酬ループを提供
// ============================================================

const TOWN_LEVELS = [
  {
    level: 1,
    name: "開拓の村",
    icon: "🪧",
    cost: { coin: 8, wood: 3, stone: 2 },
    visualSummary: "砂利舗装道路＆道標が整備される",
    effectSummary: "60秒ごとに街配当 +1🪙 ／ 資源再生 +15%",
    dividendCoins: 1,
    respawnSpeedMult: 1.15,
    buildingSpeedMult: 1.0,
    gatherBonus: 0,
  },
  {
    level: 2,
    name: "花と憩いの町",
    icon: "💐",
    cost: { coin: 15, wood: 4, herb: 3 },
    visualSummary: "石畳道路・花壇プランター・ベンチ・水路が登場",
    effectSummary: "60秒ごとに街配当 +2🪙 ／ 全建物の生産速度 +20%",
    dividendCoins: 2,
    respawnSpeedMult: 1.2,
    buildingSpeedMult: 1.2,
    gatherBonus: 0,
  },
  {
    level: 3,
    name: "活気ある市場街",
    icon: "🏮",
    cost: { coin: 25, wood: 5, stone: 4, fish: 2 },
    visualSummary: "舗装道路・街灯・広場の市場屋台が並ぶ",
    effectSummary: "60秒ごとに街配当 +4🪙 ／ 採集量 +1ボーナス",
    dividendCoins: 4,
    respawnSpeedMult: 1.25,
    buildingSpeedMult: 1.25,
    gatherBonus: 1,
  },
  {
    level: 4,
    name: "祝祭と輝きの都市",
    icon: "⛲",
    cost: { coin: 40, stone: 6, herb: 5, fish: 4 },
    visualSummary: "光センサー道路・広場噴水・祭提灯・ソーラー屋根",
    effectSummary: "60秒ごとに街配当 +6🪙 ／ 全建物生産 +40%・再生 +35%",
    dividendCoins: 6,
    respawnSpeedMult: 1.35,
    buildingSpeedMult: 1.4,
    gatherBonus: 1,
  },
  {
    level: 5,
    name: "未来の理想郷",
    icon: "🕰️",
    cost: { coin: 60, wood: 8, stone: 8, herb: 6, fish: 6 },
    visualSummary: "未来モビリティ道路＆中央時計台が完成！",
    effectSummary: "60秒ごとに街配当 +10🪙 ／ 称号「🏆 街の開拓王」獲得",
    dividendCoins: 10,
    respawnSpeedMult: 1.5,
    buildingSpeedMult: 1.6,
    gatherBonus: 2,
  },
];

const PLAYER_UPGRADES = {
  boots: {
    id: "boots",
    name: "俊足ブーツ",
    icon: "👟",
    tiers: [
      { level: 1, cost: { coin: 6, herb: 2 }, effect: "移動速度 +25%", speedMult: 1.25 },
      { level: 2, cost: { coin: 14, herb: 4 }, effect: "移動速度 +50%", speedMult: 1.5 },
    ],
  },
  pickaxe: {
    id: "pickaxe",
    name: "熟練のつるはし",
    icon: "⛏️",
    tiers: [
      { level: 1, cost: { coin: 10, wood: 3, stone: 2 }, effect: "採集量 +1・クールダウン短縮", gatherBonus: 1, cooldownMult: 0.75, radiusBonus: 10 },
      { level: 2, cost: { coin: 22, stone: 5, fish: 2 }, effect: "採集量 +2・採集範囲拡大", gatherBonus: 2, cooldownMult: 0.55, radiusBonus: 25 },
    ],
  },
  craftsman: {
    id: "craftsman",
    name: "建築マスター",
    icon: "🏗️",
    tiers: [
      { level: 1, cost: { coin: 12, wood: 4, stone: 2 }, effect: "自分の建物生産速度 1.5倍", buildSpeedMult: 1.5 },
      { level: 2, cost: { coin: 25, wood: 6, stone: 4 }, effect: "自分の建物生産速度 2.0倍", buildSpeedMult: 2.0 },
    ],
  },
  merchant: {
    id: "merchant",
    name: "商人の才覚",
    icon: "💰",
    tiers: [
      { level: 1, cost: { coin: 15, fish: 3 }, effect: "取引約定ごとに +1🪙 ボーナス", tradeBonusCoins: 1 },
      { level: 2, cost: { coin: 30, fish: 5, herb: 4 }, effect: "取引約定ごとに +2🪙 ボーナス", tradeBonusCoins: 2 },
    ],
  },
};

const AVATAR_CATALOG = [
  { id: "base_04",   name: "スタンダード",         icon: "🧑", folder: "characters/base_04",   costCoins: 0 },
  { id: "animal_01", name: "ワンコパーカー",       icon: "🐶", folder: "characters/animal_01", costCoins: 12 },
  { id: "animal_02", name: "ネコワンピース",       icon: "🐱", folder: "characters/animal_02", costCoins: 16 },
  { id: "animal_03", name: "ウサギオーバーオール", icon: "🐰", folder: "characters/animal_03", costCoins: 20 },
  { id: "animal_04", name: "ペンギンパーカー",     icon: "🐧", folder: "characters/animal_04", costCoins: 25 },
];

const QUEST_POOL = [
  { id: "q_wood_1",  title: "街の補修資材",     cost: { wood: 2 },           rewardCoins: 6 },
  { id: "q_stone_1", title: "石畳の修繕",       cost: { stone: 2 },          rewardCoins: 7 },
  { id: "q_herb_1",  title: "薬草茶の仕入れ",   cost: { herb: 2 },           rewardCoins: 6 },
  { id: "q_fish_1",  title: "食堂の新鮮な魚",   cost: { fish: 1 },           rewardCoins: 6 },
  { id: "q_mix_1",   title: "大工道具セット",   cost: { wood: 2, stone: 1 }, rewardCoins: 10 },
  { id: "q_mix_2",   title: "特製ハーブ魚料理", cost: { herb: 2, fish: 1 },  rewardCoins: 11 },
  { id: "q_mix_3",   title: "広場の美化資材",   cost: { wood: 2, herb: 2 },  rewardCoins: 11 },
  { id: "q_mix_4",   title: "釣り堀の石組み",   cost: { stone: 2, fish: 1 }, rewardCoins: 12 },
];

// シーズン優勝の目標総資産（総資産 150🪙 到達 または 街Lv.5 到達でシーズン優勝）
const VICTORY_TARGET_ASSETS = 150;

class ProgressionManager {
  constructor(player) {
    this.player = player;
    this.townLevel = 0; // 0〜5
    this.upgrades = { boots: 0, pickaxe: 0, craftsman: 0, merchant: 0 };
    this.unlockedAvatars = ["base_04"];
    this.activeAvatar = "base_04";
    this.completedQuestsCount = 0;
    this.totalCoinsEarned = 0;
    this.totalTradesCompleted = 0;
    this.dividendTimer = 60;
    this.activeQuest = this._pickNextQuest(null);
    this.seasonWinner = null;
    this.victoryModalDismissed = false;

    this.isOpen = false;
    this._activeTab = "town";
    this.onChange = null;
    this.onTownUpgrade = null;
    this.onAvatarChange = null;
    this.onDividend = null;
    this.onSeasonVictory = null;
  }

  // ライバル間で最初に目標資産（150🪙）または街Lv.5に到達した勝者を判定
  checkSeasonVictory(rankedChars = []) {
    if (this.seasonWinner) return this.seasonWinner;

    if (this.townLevel >= TOWN_LEVELS.length) {
      const playerEntry = rankedChars.find(r => r.char.id === this.player.id);
      this.seasonWinner = {
        id: this.player.id,
        name: this.player.name,
        emoji: this.player.emoji || "⭐",
        color: this.player.color || "#FFD700",
        reason: "街の発展 Lv.5「未来の理想郷」達成！",
        totalAssets: playerEntry ? playerEntry.asset.total : (this.player.inventory.coin || 0),
        timestamp: Date.now(),
      };
      if (this.onSeasonVictory) this.onSeasonVictory(this.seasonWinner, rankedChars);
      return this.seasonWinner;
    }

    const top = rankedChars[0];
    if (top && top.asset.total >= VICTORY_TARGET_ASSETS) {
      this.seasonWinner = {
        id: top.char.id,
        name: top.char.name,
        emoji: top.char.emoji || "🏆",
        color: top.char.color || "#FFD700",
        reason: `目標総資産 ${VICTORY_TARGET_ASSETS}🪙 を最初に突破！`,
        totalAssets: top.asset.total,
        timestamp: Date.now(),
      };
      if (this.onSeasonVictory) this.onSeasonVictory(this.seasonWinner, rankedChars);
      return this.seasonWinner;
    }

    return null;
  }

  _pickNextQuest(prevId) {
    const pool = QUEST_POOL.filter(q => q.id !== prevId);
    // 進行度に合わせて単一資源→複合資源もバランスよく出現
    const maxIdx = this.completedQuestsCount < 2 ? Math.min(4, pool.length) : pool.length;
    const chosen = pool[Math.floor(Math.random() * maxIdx)] || QUEST_POOL[0];
    return { ...chosen, cost: { ...chosen.cost } };
  }

  // ── 効果の算出（ゲームループから参照） ─────────────────────

  getTownSpec() {
    if (this.townLevel <= 0) {
      return {
        level: 0,
        name: "はじまりの広場",
        icon: "🏕️",
        dividendCoins: 0,
        respawnSpeedMult: 1.0,
        buildingSpeedMult: 1.0,
        gatherBonus: 0,
      };
    }
    return TOWN_LEVELS[Math.min(this.townLevel, TOWN_LEVELS.length) - 1];
  }

  getNextTownSpec() {
    if (this.townLevel >= TOWN_LEVELS.length) return null;
    return TOWN_LEVELS[this.townLevel];
  }

  getPlayerSpeedMultiplier() {
    const lv = this.upgrades.boots || 0;
    if (lv <= 0) return 1.0;
    return PLAYER_UPGRADES.boots.tiers[lv - 1]?.speedMult || 1.0;
  }

  getPlayerGatherAmount() {
    const pickLv = this.upgrades.pickaxe || 0;
    const pickBonus = pickLv > 0 ? (PLAYER_UPGRADES.pickaxe.tiers[pickLv - 1]?.gatherBonus || 0) : 0;
    return 1 + pickBonus + (this.getTownSpec().gatherBonus || 0);
  }

  getPlayerGatherCooldownMultiplier() {
    const pickLv = this.upgrades.pickaxe || 0;
    return pickLv > 0 ? (PLAYER_UPGRADES.pickaxe.tiers[pickLv - 1]?.cooldownMult || 1.0) : 1.0;
  }

  getPlayerGatherRadiusBonus() {
    const pickLv = this.upgrades.pickaxe || 0;
    return pickLv > 0 ? (PLAYER_UPGRADES.pickaxe.tiers[pickLv - 1]?.radiusBonus || 0) : 0;
  }

  getBuildingSpeedMultiplier(ownerId) {
    // 各キャラクターはライバルのため、プレイヤーの投資・強化ボーナスはプレイヤー自身にのみ適用
    if (ownerId !== this.player.id) return 1.0;
    let mult = this.getTownSpec().buildingSpeedMult || 1.0;
    const lv = this.upgrades.craftsman || 0;
    if (lv > 0) mult *= (PLAYER_UPGRADES.craftsman.tiers[lv - 1]?.buildSpeedMult || 1.0);
    return mult;
  }

  getFarmSpeedMultiplier(ownerId) {
    if (ownerId !== this.player.id) return 1.0;
    const townBonus = (this.getTownSpec().buildingSpeedMult || 1.0);
    const craftLv = this.upgrades.craftsman || 0;
    const craftBonus = craftLv > 0 ? (1 + craftLv * 0.15) : 1.0;
    return townBonus * craftBonus;
  }

  getRespawnSpeedMultiplier() {
    return this.getTownSpec().respawnSpeedMult || 1.0;
  }

  getTradeBonusCoins() {
    const lv = this.upgrades.merchant || 0;
    return lv > 0 ? (PLAYER_UPGRADES.merchant.tiers[lv - 1]?.tradeBonusCoins || 0) : 0;
  }

  getTitle() {
    if (this.townLevel >= 5) return "🏆 街の開拓王";
    if (this.townLevel >= 3) return "🌟 敏腕街づくり師";
    if (this.completedQuestsCount >= 3 || this.townLevel >= 1) return "🧭 頼れる開拓者";
    return "🌱 見習い旅人";
  }

  // ── プレイヤー操作 ────────────────────────────────────────

  upgradeTown() {
    const next = this.getNextTownSpec();
    if (!next) return { ok: false, reason: "すでに最大レベル（Lv.5）です" };
    if (!inventoryDeduct(this.player.inventory, next.cost)) {
      return { ok: false, reason: "コインまたは資源が足りません" };
    }
    this.townLevel = next.level;
    this.dividendTimer = 60;
    if (this.onTownUpgrade) this.onTownUpgrade(next);
    if (this.onChange) this.onChange();
    return { ok: true, spec: next };
  }

  buyUpgrade(upgradeId) {
    const def = PLAYER_UPGRADES[upgradeId];
    if (!def) return { ok: false, reason: "不明な強化項目です" };
    const curLv = this.upgrades[upgradeId] || 0;
    const nextTier = def.tiers[curLv];
    if (!nextTier) return { ok: false, reason: "すでに最大強化済みです" };
    if (!inventoryDeduct(this.player.inventory, nextTier.cost)) {
      return { ok: false, reason: "コインまたは資源が足りません" };
    }
    this.upgrades[upgradeId] = nextTier.level;
    if (this.onChange) this.onChange();
    return { ok: true, upgrade: def, tier: nextTier };
  }

  unlockOrEquipAvatar(avatarId) {
    const item = AVATAR_CATALOG.find(a => a.id === avatarId);
    if (!item) return { ok: false, reason: "不明なアバターです" };

    const alreadyUnlocked = this.unlockedAvatars.includes(avatarId);
    if (!alreadyUnlocked) {
      if (!inventoryDeduct(this.player.inventory, { coin: item.costCoins })) {
        return { ok: false, reason: `コインが足りません（必要 🪙×${item.costCoins}）` };
      }
      this.unlockedAvatars.push(avatarId);
    }

    this.activeAvatar = avatarId;
    if (this.onAvatarChange) this.onAvatarChange(item);
    if (this.onChange) this.onChange();
    return { ok: true, item, newlyUnlocked: !alreadyUnlocked };
  }

  completeActiveQuest() {
    const q = this.activeQuest;
    if (!q) return { ok: false, reason: "現在の依頼がありません" };
    if (!inventoryDeduct(this.player.inventory, q.cost)) {
      return { ok: false, reason: "納品に必要な資源が足りません" };
    }
    inventoryAdd(this.player.inventory, "coin", q.rewardCoins);
    this.completedQuestsCount++;
    this.totalCoinsEarned += q.rewardCoins;
    const completed = q;
    this.activeQuest = this._pickNextQuest(q.id);
    if (this.onChange) this.onChange();
    return { ok: true, completed, nextQuest: this.activeQuest };
  }

  onPlayerTradeExecuted() {
    this.totalTradesCompleted++;
    const bonus = this.getTradeBonusCoins();
    if (bonus > 0) {
      inventoryAdd(this.player.inventory, "coin", bonus);
      this.totalCoinsEarned += bonus;
    }
    if (this.onChange) this.onChange();
    return bonus;
  }

  // 毎フレーム更新：街発展の定期配当を配布
  update(dt) {
    const dividend = this.getTownSpec().dividendCoins || 0;
    if (dividend <= 0) return 0;
    this.dividendTimer -= dt;
    if (this.dividendTimer > 0) return 0;

    this.dividendTimer = 60;
    inventoryAdd(this.player.inventory, "coin", dividend);
    this.totalCoinsEarned += dividend;
    if (this.onDividend) this.onDividend(dividend, this.getTownSpec());
    if (this.onChange) this.onChange();
    return dividend;
  }

  // ── シリアライズ／復元 ────────────────────────────────────

  serialize() {
    return {
      townLevel: this.townLevel,
      upgrades: { ...this.upgrades },
      unlockedAvatars: [...this.unlockedAvatars],
      activeAvatar: this.activeAvatar,
      completedQuestsCount: this.completedQuestsCount,
      totalCoinsEarned: this.totalCoinsEarned,
      totalTradesCompleted: this.totalTradesCompleted,
      dividendTimer: this.dividendTimer,
      activeQuest: this.activeQuest ? { ...this.activeQuest, cost: { ...this.activeQuest.cost } } : null,
      seasonWinner: this.seasonWinner ? { ...this.seasonWinner } : null,
      victoryModalDismissed: Boolean(this.victoryModalDismissed),
    };
  }

  deserialize(data) {
    if (!data || typeof data !== "object") return;
    if (data.seasonWinner && typeof data.seasonWinner === "object" && data.seasonWinner.id) {
      this.seasonWinner = { ...data.seasonWinner };
    }
    this.victoryModalDismissed = Boolean(data.victoryModalDismissed);
    const lv = Number(data.townLevel);
    this.townLevel = Number.isInteger(lv) ? Math.max(0, Math.min(TOWN_LEVELS.length, lv)) : 0;

    for (const key of Object.keys(PLAYER_UPGRADES)) {
      const val = Number(data.upgrades?.[key] || 0);
      const maxLv = PLAYER_UPGRADES[key].tiers.length;
      this.upgrades[key] = Number.isInteger(val) ? Math.max(0, Math.min(maxLv, val)) : 0;
    }

    if (Array.isArray(data.unlockedAvatars)) {
      const validIds = new Set(AVATAR_CATALOG.map(a => a.id));
      const clean = data.unlockedAvatars.filter(id => validIds.has(id));
      if (!clean.includes("base_04")) clean.unshift("base_04");
      this.unlockedAvatars = clean;
    }
    if (typeof data.activeAvatar === "string" && this.unlockedAvatars.includes(data.activeAvatar)) {
      this.activeAvatar = data.activeAvatar;
    }
    this.completedQuestsCount = Math.max(0, Number(data.completedQuestsCount) || 0);
    this.totalCoinsEarned = Math.max(0, Number(data.totalCoinsEarned) || 0);
    this.totalTradesCompleted = Math.max(0, Number(data.totalTradesCompleted) || 0);
    if (Number.isFinite(Number(data.dividendTimer)) && Number(data.dividendTimer) > 0) {
      this.dividendTimer = Math.min(60, Number(data.dividendTimer));
    }
    if (data.activeQuest && data.activeQuest.cost && data.activeQuest.rewardCoins) {
      this.activeQuest = {
        id: String(data.activeQuest.id || "q_saved"),
        title: String(data.activeQuest.title || "納品依頼"),
        cost: { ...data.activeQuest.cost },
        rewardCoins: Math.max(1, Number(data.activeQuest.rewardCoins) || 6),
      };
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TOWN_LEVELS,
    PLAYER_UPGRADES,
    AVATAR_CATALOG,
    QUEST_POOL,
    VICTORY_TARGET_ASSETS,
    ProgressionManager,
  };
}
