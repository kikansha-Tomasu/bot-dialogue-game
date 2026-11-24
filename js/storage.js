// ============================================================
// storage.js — ゲーム状態・取引履歴の自動セーブ＆復元（localStorage）
// ============================================================

const SAVE_STORAGE_KEY = "botGame.save.v1";
const SAVE_SCHEMA_VERSION = 1;

class SaveManager {
  constructor(storage = null) {
    this._storage = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    this._saveTimer = null;
  }

  hasSave() {
    if (!this._storage) return false;
    try {
      return Boolean(this._storage.getItem(SAVE_STORAGE_KEY));
    } catch (_) {
      return false;
    }
  }

  saveImmediate(state) {
    if (!this._storage || !state) return false;
    try {
      const payload = {
        version: SAVE_SCHEMA_VERSION,
        savedAt: Date.now(),
        ...state,
      };
      this._storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn("[SaveManager] 保存に失敗しました:", err.message);
      return false;
    }
  }

  scheduleSave(getStateFn, delayMs = 400) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const state = typeof getStateFn === "function" ? getStateFn() : null;
      if (state) this.saveImmediate(state);
    }, delayMs);
  }

  load() {
    if (!this._storage) return null;
    try {
      const raw = this._storage.getItem(SAVE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || parsed.version !== SAVE_SCHEMA_VERSION) {
        return null;
      }
      return parsed;
    } catch (err) {
      console.warn("[SaveManager] 読み込みに失敗しました（初期化します）:", err.message);
      return null;
    }
  }

  clear() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this._storage) return false;
    try {
      this._storage.removeItem(SAVE_STORAGE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  static captureGameState(game) {
    const w = Math.max(1, game.canvas?.width || 800);
    const h = Math.max(1, game.canvas?.height || 600);

    return {
      mapId: game.mapRenderer?.getCurrentMapId?.() || "central_plaza",
      characters: (game.characters || []).map(c => ({
        id: c.id,
        fx: Math.max(0.02, Math.min(0.98, c.x / w)),
        fy: Math.max(0.02, Math.min(0.98, c.y / h)),
        inventory: { ...c.inventory },
        spriteFolder: c.spriteFolder,
        conversationHistory: (c.conversationHistory || []).slice(-10),
      })),
      buildings: (game.buildingManager?.placed || []).map(b => ({
        type: b.type,
        fx: Math.max(0.02, Math.min(0.98, b.x / w)),
        fy: Math.max(0.02, Math.min(0.98, b.y / h)),
        builderId: b.builderId,
        builderColor: b.builderColor,
        generateTimer: b.generateTimer,
      })),
      orderBook: {
        priceHistory: game.orderBook?.priceHistory || {},
        tradeHistory: (game.orderBook?.tradeHistory || []).slice(-25),
        orders: (game.orderBook?.orders || []).map(o => ({
          posterId: o.posterId,
          sellType: o.sellType,
          sellAmount: o.sellAmount,
          buyType: o.buyType,
          buyAmount: o.buyAmount,
        })),
      },
      progression: game.progression?.serialize?.() || null,
      farming: game.farmManager?.serialize?.() || null,
    };
  }

  static applyGameState(game, saved) {
    if (!saved || typeof saved !== "object") return false;
    const w = Math.max(1, game.canvas?.width || 800);
    const h = Math.max(1, game.canvas?.height || 600);

    // キャラクター在庫・位置・アバター・会話履歴復元
    const allItemKeys = typeof TRADABLE_ITEM_TYPES !== "undefined"
      ? ["coin", ...TRADABLE_ITEM_TYPES]
      : ["coin", "wood", "stone", "herb", "fish"];
    if (Array.isArray(saved.characters)) {
      for (const sc of saved.characters) {
        const target = (game.characters || []).find(c => c.id === sc.id);
        if (!target) continue;
        if (sc.inventory && typeof sc.inventory === "object") {
          for (const key of allItemKeys) {
            if (!(key in sc.inventory)) continue;
            const val = Number(sc.inventory[key]);
            if (Number.isFinite(val) && val >= 0) target.inventory[key] = Math.floor(val);
          }
        }
        if (Number.isFinite(sc.fx) && Number.isFinite(sc.fy)) {
          target.x = sc.fx * w;
          target.y = sc.fy * h;
        }
        if (typeof sc.spriteFolder === "string" && sc.spriteFolder !== target.spriteFolder) {
          target.setSpriteFolder?.(sc.spriteFolder);
        }
        if (Array.isArray(sc.conversationHistory)) {
          target.conversationHistory = sc.conversationHistory.slice(-10);
        }
      }
    }

    // 建物復元
    if (Array.isArray(saved.buildings) && game.buildingManager) {
      game.buildingManager.placed = [];
      for (const sb of saved.buildings) {
        const recipe = BUILDING_RECIPES[sb.type];
        const benefit = BUILDING_BENEFITS[sb.type];
        if (!recipe) continue;
        const interval = benefit?.interval || 999;
        game.buildingManager.placed.push({
          type: sb.type,
          x: (Number(sb.fx) || 0.5) * w,
          y: (Number(sb.fy) || 0.5) * h,
          emoji: recipe.emoji,
          name: recipe.name,
          builderId: sb.builderId || "player",
          builderColor: sb.builderColor || "#FFD700",
          interval,
          generateTimer: Number.isFinite(sb.generateTimer) ? Math.max(1, Math.min(interval, sb.generateTimer)) : interval,
          flashTimer: 0,
          lastGenType: null,
        });
      }
    }

    // 取引履歴・価格履歴・板注文復元
    if (saved.orderBook && game.orderBook) {
      const ph = saved.orderBook.priceHistory;
      const tradableKeys = typeof TRADABLE_ITEM_TYPES !== "undefined"
        ? TRADABLE_ITEM_TYPES
        : ["wood", "stone", "herb", "fish"];
      if (ph && typeof ph === "object") {
        for (const res of tradableKeys) {
          if (Array.isArray(ph[res])) {
            game.orderBook.priceHistory[res] = ph[res]
              .map(Number)
              .filter(v => Number.isFinite(v) && v > 0)
              .slice(-30);
          }
        }
      }
      if (Array.isArray(saved.orderBook.tradeHistory)) {
        game.orderBook.tradeHistory = saved.orderBook.tradeHistory.slice(-25);
      }
      if (Array.isArray(saved.orderBook.orders)) {
        game.orderBook.orders = [];
        for (const so of saved.orderBook.orders) {
          const poster = (game.characters || []).find(c => c.id === so.posterId);
          if (!poster) continue;
          const sellAmt = Math.floor(Number(so.sellAmount));
          const buyAmt = Math.floor(Number(so.buyAmount));
          if (sellAmt > 0 && buyAmt > 0) {
            // 復元時はマッチングを発火させず板へ戻す
            game.orderBook.restoreOrder(poster, so.sellType, sellAmt, so.buyType, buyAmt);
          }
        }
      }
    }

    // 街の発展・強化・アバター・依頼復元
    if (saved.progression && game.progression) {
      game.progression.deserialize(saved.progression);
      const avatarDef = AVATAR_CATALOG.find(a => a.id === game.progression.activeAvatar);
      if (avatarDef && game.player?.setSpriteFolder) {
        game.player.setSpriteFolder(avatarDef.folder);
      }
    }

    // 農業プログレッション区画の復元
    if (saved.farming && game.farmManager) {
      game.farmManager.deserialize(saved.farming, game.characters || []);
    }

    return true;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SAVE_STORAGE_KEY, SAVE_SCHEMA_VERSION, SaveManager };
}
