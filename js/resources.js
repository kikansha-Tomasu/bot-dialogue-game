const BASE_RESOURCE_TYPES = ["wood", "stone", "herb", "fish"];
const CROP_ITEM_TYPES = [
  "carrot", "wheat", "cabbage", "tomato",
  "corn", "rice", "pumpkin", "strawberry",
];
const DISH_ITEM_TYPES = [
  "carrot_salad", "herb_bread", "tomato_soup",
  "onigiri_bento", "pumpkin_pie", "strawberry_tart",
];
const TRADABLE_ITEM_TYPES = [
  ...BASE_RESOURCE_TYPES,
  ...CROP_ITEM_TYPES,
  ...DISH_ITEM_TYPES,
];
const ITEM_CATEGORY_DEFS = [
  { id: "resource", label: "⛏ 資源", items: BASE_RESOURCE_TYPES },
  { id: "crop",     label: "🌾 作物", items: CROP_ITEM_TYPES },
  { id: "dish",     label: "🍳 料理", items: DISH_ITEM_TYPES },
];

const RESOURCE_EMOJI = {
  wood: "🪵", stone: "🪨", herb: "🌿", fish: "🐟", coin: "🪙",
  carrot: "🥕", wheat: "🌾", cabbage: "🥬", tomato: "🍅",
  corn: "🌽", rice: "🍙", pumpkin: "🎃", strawberry: "🍓",
  carrot_salad: "🥗", herb_bread: "🍞", tomato_soup: "🍲",
  onigiri_bento: "🍱", pumpkin_pie: "🥧", strawberry_tart: "🎂",
};
const RESOURCE_LABEL = {
  wood: "木材", stone: "石", herb: "薬草", fish: "魚", coin: "コイン",
  carrot: "ニンジン", wheat: "小麦", cabbage: "キャベツ", tomato: "トマト",
  corn: "トウモロコシ", rice: "お米", pumpkin: "カボチャ", strawberry: "イチゴ",
  carrot_salad: "キャロットサラダ", herb_bread: "ハーブパン", tomato_soup: "トマト魚介スープ",
  onigiri_bento: "焼きおにぎり弁当", pumpkin_pie: "パンプキンパイ", strawberry_tart: "ストロベリータルト",
};
const RESOURCE_SHORT_LABEL = {
  wood: "木材", stone: "石", herb: "薬草", fish: "魚", coin: "コイン",
  carrot: "ニンジン", wheat: "小麦", cabbage: "キャベツ", tomato: "トマト",
  corn: "コーン", rice: "お米", pumpkin: "カボチャ", strawberry: "イチゴ",
  carrot_salad: "サラダ", herb_bread: "パン", tomato_soup: "スープ",
  onigiri_bento: "弁当", pumpkin_pie: "パイ", strawberry_tart: "タルト",
};
const ITEM_CHART_COLOR = {
  wood: "#6D4C1F", stone: "#666666", herb: "#2E6B1E", fish: "#2566A8",
  carrot: "#D86218", wheat: "#B8860B", cabbage: "#3B8C3E", tomato: "#C62828",
  corn: "#C99700", rice: "#546E7A", pumpkin: "#C75B12", strawberry: "#C2185B",
  carrot_salad: "#43A047", herb_bread: "#8D5524", tomato_soup: "#D84315",
  onigiri_bento: "#5D4037", pumpkin_pie: "#E65100", strawberry_tart: "#AD1457",
};

// 資源ごとの高コントラスト配色（どの地形タイル上でも埋もれないメダル表示用）
const RESOURCE_THEME = {
  wood:  { ring: "#B86B1E", fill: "#FFF5E4", bar: "#E08A2E" },
  stone: { ring: "#546E7A", fill: "#F2F6FA", bar: "#78909C" },
  herb:  { ring: "#2E7D32", fill: "#EBFBEE", bar: "#4CAF50" },
  fish:  { ring: "#1565C0", fill: "#E8F4FD", bar: "#29B6F6" },
};

// マップごとの資源ノード相対配置（割合 0.0〜1.0）
const MAP_RESOURCE_LAYOUTS = {
  central_plaza: [
    ["w1", "wood",  0.07, 0.12, 4],
    ["w2", "wood",  0.91, 0.14, 4],
    ["w3", "wood",  0.06, 0.86, 4],
    ["w4", "wood",  0.88, 0.88, 4],
    ["w5", "wood",  0.35, 0.08, 3],
    ["w6", "wood",  0.65, 0.08, 3],
    ["s1", "stone", 0.22, 0.44, 5],
    ["s2", "stone", 0.78, 0.56, 5],
    ["s3", "stone", 0.45, 0.28, 4],
    ["h1", "herb",  0.20, 0.35, 4],
    ["h2", "herb",  0.75, 0.65, 4],
    ["h3", "herb",  0.14, 0.62, 3],
    ["f1", "fish",  0.16, 0.75, 3],
  ],
  shopping_street: [
    ["w1", "wood",  0.08, 0.82, 4],
    ["w2", "wood",  0.90, 0.82, 4],
    ["w3", "wood",  0.06, 0.20, 3],
    ["w4", "wood",  0.92, 0.20, 3],
    ["s1", "stone", 0.28, 0.40, 5],
    ["s2", "stone", 0.72, 0.40, 5],
    ["s3", "stone", 0.50, 0.18, 4],
    ["h1", "herb",  0.22, 0.90, 4],
    ["h2", "herb",  0.52, 0.90, 4],
    ["h3", "herb",  0.78, 0.90, 4],
    ["f1", "fish",  0.18, 0.62, 3],
    ["f2", "fish",  0.82, 0.62, 3],
  ],
  forest_hamlet: [
    ["w1", "wood",  0.10, 0.14, 5],
    ["w2", "wood",  0.88, 0.14, 5],
    ["w3", "wood",  0.10, 0.84, 5],
    ["w4", "wood",  0.88, 0.84, 5],
    ["w5", "wood",  0.50, 0.10, 4],
    ["s1", "stone", 0.26, 0.36, 4],
    ["s2", "stone", 0.74, 0.64, 4],
    ["h1", "herb",  0.22, 0.66, 4],
    ["h2", "herb",  0.76, 0.34, 4],
    ["h3", "herb",  0.50, 0.84, 4],
    ["f1", "fish",  0.46, 0.54, 4],
    ["f2", "fish",  0.54, 0.54, 4],
  ],
  farm_riverside: [
    ["w1", "wood",  0.06, 0.16, 4],
    ["w2", "wood",  0.92, 0.16, 4],
    ["w3", "wood",  0.06, 0.84, 4],
    ["w4", "wood",  0.92, 0.86, 4],
    ["s1", "stone", 0.36, 0.46, 4],
    ["s2", "stone", 0.72, 0.42, 4],
    ["h1", "herb",  0.22, 0.24, 5],
    ["h2", "herb",  0.22, 0.78, 5],
    ["h3", "herb",  0.82, 0.78, 5],
    ["f1", "fish",  0.54, 0.16, 4],
    ["f2", "fish",  0.54, 0.82, 4],
  ],
};

class WorldResource {
  constructor(id, type, x, y, maxAmount) {
    this.id = id;
    this.type = type;
    this.x = x;
    this.y = y;
    this.maxAmount = maxAmount;
    this.amount = maxAmount;
    this.respawnTimer = 0;
    this.RESPAWN_TIME = 180;
  }

  gather(n = 1) {
    if (this.amount <= 0) return 0;
    const got = Math.min(n, this.amount);
    this.amount -= got;
    if (this.amount <= 0) this.respawnTimer = this.RESPAWN_TIME;
    return got;
  }

  update(dt, speedMult = 1.0) {
    if (this.amount <= 0) {
      this.respawnTimer -= dt * speedMult;
      if (this.respawnTimer <= 0) {
        this.respawnTimer = 0;
        this.amount = this.maxAmount;
      }
    }
  }

  get isEmpty() { return this.amount <= 0; }

  draw(ctx, highlight = false, isClosest = false) {
    const x = Math.round(this.x);
    const y = Math.round(this.y);
    const theme = RESOURCE_THEME[this.type] || RESOURCE_THEME.wood;

    ctx.save();
    if (this.isEmpty) {
      // 枯渇・再生待ち状態も何が再生中か一目で分かるプレート表示
      const progress = Math.max(0, Math.min(1, 1 - this.respawnTimer / this.RESPAWN_TIME));
      const remSec = Math.max(1, Math.ceil(this.respawnTimer));

      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(32, 20, 14, 0.82)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.strokeStyle = "#90C060";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.globalAlpha = 0.55;
      ctx.font = "14px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(RESOURCE_EMOJI[this.type], x, y - 2);
      ctx.globalAlpha = 1;

      ctx.font = "bold 9px 'Segoe UI', sans-serif";
      ctx.fillStyle = "#D7E8B5";
      ctx.fillText(`${remSec}s`, x, y + 10);
      ctx.restore();
      return;
    }

    // 1. 採集可能範囲のパルス外輪
    if (highlight) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 190);
      ctx.beginPath();
      ctx.arc(x, y, 22 + pulse * 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 215, 0, 0.28)";
      ctx.fill();
      ctx.strokeStyle = isClosest ? "#FFD700" : "rgba(255, 215, 0, 0.85)";
      ctx.lineWidth = isClosest ? 3 : 2;
      ctx.stroke();
    }

    // 2. 高コントラストの円形メダル台座（地形に埋もれない明るい背景＋影＋太枠）
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.48)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fillStyle = theme.fill;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.strokeStyle = isClosest ? "#FFD700" : theme.ring;
    ctx.lineWidth = 3;
    ctx.stroke();

    // 内側の細い白縁で立体感を強調
    ctx.beginPath();
    ctx.arc(x, y, 15.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 3. 大きめの資源アイコン
    ctx.font = "21px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(RESOURCE_EMOJI[this.type], x, y + 0.5);

    // 4. 下部の高視認ラベル＋残量ゲージピル（「木材 4/4」）
    const labelText = `${RESOURCE_LABEL[this.type]} ${this.amount}/${this.maxAmount}`;
    ctx.font = "bold 10px 'Segoe UI', 'Meiryo', sans-serif";
    const pillW = Math.max(46, ctx.measureText(labelText).width + 12);
    const pillH = 17;
    const px = x - pillW / 2;
    const py = y + 19;

    ctx.fillStyle = "rgba(28, 16, 10, 0.92)";
    ctx.beginPath();
    ctx.roundRect(px, py, pillW, pillH, 5);
    ctx.fill();
    ctx.strokeStyle = theme.ring;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // ピル下部の残量カラーバー
    const barW = pillW - 8;
    const barH = 2.5;
    const barX = px + 4;
    const barY = py + pillH - 4;
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = theme.bar;
    ctx.fillRect(barX, barY, barW * (this.amount / this.maxAmount), barH);

    ctx.fillStyle = "#FFFDF7";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(labelText, x, py + 7);

    // 5. 最寄りの採集可能ノードに目立つ [E] 採集バナー
    if (isClosest) {
      const callout = "⛏ [E] 採集";
      ctx.font = "bold 10.5px 'Segoe UI', 'Meiryo', sans-serif";
      const badgeW = ctx.measureText(callout).width + 12;
      const badgeH = 18;
      const bbx = x - badgeW / 2;
      const bby = y - 38;
      ctx.fillStyle = "#2C1810";
      ctx.beginPath();
      ctx.roundRect(bbx, bby, badgeW, badgeH, 5);
      ctx.fill();
      ctx.strokeStyle = "#FFD700";
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.fillStyle = "#FFD700";
      ctx.fillText(callout, x, bby + badgeH / 2 + 0.5);
    }
    ctx.restore();
  }
}

class ResourceManager {
  constructor() { this.nodes = []; }

  init(w, h, mapId = "central_plaza") {
    const layout = MAP_RESOURCE_LAYOUTS[mapId] || MAP_RESOURCE_LAYOUTS.central_plaza;
    this.nodes = layout.map(([id, type, fx, fy, maxAmt]) =>
      new WorldResource(id, type, w * fx, h * fy, maxAmt)
    );
  }

  scalePositions(oldW, oldH, newW, newH) {
    if (oldW <= 0 || oldH <= 0) return;
    const sx = newW / oldW;
    const sy = newH / oldH;
    this.nodes.forEach(n => {
      n.x *= sx;
      n.y *= sy;
    });
  }

  snapToWalkable(navGrid) {
    if (!navGrid || !navGrid.isReady()) return;
    this.nodes.forEach(n => {
      if (navGrid.isPointBlocked(n.x, n.y, 10)) {
        const pt = navGrid.findNearestWalkablePoint(n.x, n.y);
        if (pt) {
          n.x = pt.x;
          n.y = pt.y;
        }
      }
    });
  }

  update(dt, respawnSpeedMult = 1.0) {
    this.nodes.forEach(n => n.update(dt, respawnSpeedMult));
  }

  draw(ctx, playerPos = null, gatherRadius = 0) {
    let closestId = null;
    if (playerPos && gatherRadius > 0) {
      const nearby = this.getNearby(playerPos.x, playerPos.y, gatherRadius);
      if (nearby.length > 0) closestId = nearby[0].id;
    }
    this.nodes.forEach(n => {
      const inRange = !!(playerPos && gatherRadius > 0 && !n.isEmpty &&
        Math.hypot(n.x - playerPos.x, n.y - playerPos.y) < gatherRadius);
      n.draw(ctx, inRange, n.id === closestId);
    });
  }

  getNearby(x, y, r) {
    return this.nodes
      .filter(n => !n.isEmpty && Math.hypot(n.x - x, n.y - y) < r)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  }

  getNearest(x, y) {
    return this.nodes
      .filter(n => !n.isEmpty)
      .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0] || null;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    BASE_RESOURCE_TYPES,
    CROP_ITEM_TYPES,
    DISH_ITEM_TYPES,
    TRADABLE_ITEM_TYPES,
    ITEM_CATEGORY_DEFS,
    RESOURCE_EMOJI,
    RESOURCE_LABEL,
    RESOURCE_SHORT_LABEL,
    ITEM_CHART_COLOR,
    RESOURCE_THEME,
    MAP_RESOURCE_LAYOUTS,
    WorldResource,
    ResourceManager,
  };
}
