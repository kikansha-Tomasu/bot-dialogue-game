const BUILDING_RECIPES = {
  campfire:    { name: "焚き火", cost: { wood: 3, stone: 1 }, emoji: "🔥" },
  flowerBed:   { name: "花壇",   cost: { herb: 2 },           emoji: "🌸" },
  woodenFence: { name: "木の柵", cost: { wood: 5 },           emoji: "🪵" },
  fishingSpot: { name: "釣り場", cost: { wood: 2, fish: 1 },  emoji: "🎣" },
};

// 建築物が定期的に生産するリソース
const BUILDING_BENEFITS = {
  campfire:    { generates: "stone", interval: 60, label: "焚き火" },
  flowerBed:   { generates: "herb",  interval: 50, label: "花壇" },
  woodenFence: { generates: "wood",  interval: 80, label: "木の柵" },
  fishingSpot: { generates: "fish",  interval: 70, label: "釣り場" },
};

class BuildingManager {
  constructor(player) {
    this.player = player;
    this.placed = [];
    this.isMenuOpen = false;
    this.pendingType = null;
    this.onChange = null;
  }

  toggleMenu() {
    this.isMenuOpen = !this.isMenuOpen;
    this.pendingType = null;
    if (this.isMenuOpen) this._openPanel();
    else this._closePanel();
  }

  closeMenu() {
    this.isMenuOpen = false;
    this._closePanel();
  }

  cancelPlacement() {
    this.pendingType = null;
  }

  getBuildingsByOwner(ownerId) {
    return this.placed.filter(b => b.builderId === ownerId);
  }

  scalePositions(oldW, oldH, newW, newH) {
    if (oldW <= 0 || oldH <= 0) return;
    const sx = newW / oldW;
    const sy = newH / oldH;
    this.placed.forEach(b => {
      b.x *= sx;
      b.y *= sy;
    });
  }

  refreshPanel() {
    if (this.isMenuOpen) this._openPanel();
  }

  _openPanel() {
    if (typeof document === "undefined") return;
    const list = document.getElementById("build-list");
    if (!list) return;

    const myOwned = this.getBuildingsByOwner(this.player.id);
    list.innerHTML = Object.entries(BUILDING_RECIPES).map(([type, r]) => {
      const canBuild = inventoryCanAfford(this.player.inventory, r.cost);
      const benefit = BUILDING_BENEFITS[type];
      const ownedCount = myOwned.filter(b => b.type === type).length;
      const costStr = Object.entries(r.cost)
        .map(([t, n]) => {
          const have = this.player.inventory[t] || 0;
          const ok = have >= n;
          return `<span class="cost-chip ${ok ? "cost-ok" : "cost-short"}">${RESOURCE_EMOJI[t]} ${have}/${n}</span>`;
        })
        .join(" ");
      const effectStr = benefit
        ? `${RESOURCE_EMOJI[benefit.generates]} ${RESOURCE_LABEL[benefit.generates]}を${benefit.interval}秒ごとに生産`
        : "";
      const ownedBadge = ownedCount > 0
        ? `<span class="build-owned-badge">所有 ×${ownedCount}</span>`
        : "";
      return `<button type="button" class="build-item${canBuild ? "" : " build-disabled"}" data-type="${type}" ${canBuild ? "" : "disabled aria-disabled=\"true\""}>
        <div class="build-item-top">
          <span class="build-item-name">${r.emoji} ${r.name}</span>
          ${ownedBadge}
        </div>
        <div class="build-item-cost">必要資源: ${costStr}</div>
        ${effectStr ? `<div class="build-item-effect">効果: ${effectStr}</div>` : ""}
      </button>`;
    }).join("");

    list.querySelectorAll(".build-item:not([disabled])").forEach(el => {
      el.addEventListener("click", () => {
        this.pendingType = el.dataset.type;
        this._closePanel();
        this.isMenuOpen = false;
      });
    });

    document.getElementById("build-panel")?.classList.remove("hidden");
  }

  _closePanel() {
    if (typeof document === "undefined") return;
    document.getElementById("build-panel")?.classList.add("hidden");
  }

  selectRecipe(type) { this.pendingType = type; }

  // 既存建物と重ならない座標を探す（重なりによる視認性低下を防止）
  _findNonOverlappingPos(baseX, baseY, minDist = 48) {
    const offsets = [
      [0, 0], [46, 0], [-46, 0], [0, 46], [0, -46],
      [42, 42], [-42, 42], [42, -42], [-42, -42],
      [72, 0], [-72, 0], [0, 72], [0, -72],
    ];
    for (const [dx, dy] of offsets) {
      const tx = baseX + dx;
      const ty = baseY + dy;
      const overlaps = this.placed.some(b => Math.hypot(b.x - tx, b.y - ty) < minDist);
      if (!overlaps) return { x: tx, y: ty };
    }
    return { x: baseX + (Math.random() - 0.5) * 40, y: baseY + (Math.random() - 0.5) * 40 };
  }

  placeAtForChar(char, type) {
    const recipe = BUILDING_RECIPES[type];
    if (!recipe) return false;
    if (!inventoryDeduct(char.inventory, recipe.cost)) return false;
    const interval = BUILDING_BENEFITS[type]?.interval || 999;
    const pos = this._findNonOverlappingPos(char.x, char.y);
    this.placed.push({
      type,
      x: pos.x,
      y: pos.y,
      emoji: recipe.emoji,
      name: recipe.name,
      builderId: char.id,
      builderName: char.name || char.id,
      builderColor: char.color || "#C4A060",
      interval,
      generateTimer: interval,
      flashTimer: 0,
      lastGenType: null,
    });
    if (this.onChange) this.onChange();
    return true;
  }

  placeAt(x, y) {
    if (!this.pendingType) return false;
    const recipe = BUILDING_RECIPES[this.pendingType];
    if (!recipe) return false;
    if (!inventoryDeduct(this.player.inventory, recipe.cost)) {
      this.pendingType = null;
      return false;
    }
    const interval = BUILDING_BENEFITS[this.pendingType]?.interval || 999;
    const pos = this._findNonOverlappingPos(x, y, 40);
    this.placed.push({
      type: this.pendingType,
      x: pos.x,
      y: pos.y,
      emoji: recipe.emoji,
      name: recipe.name,
      builderId: this.player.id,
      builderName: this.player.name || "Player",
      builderColor: this.player.color || "#FFD700",
      interval,
      generateTimer: interval,
      flashTimer: 0,
      lastGenType: null,
    });
    this.pendingType = null;
    this.isMenuOpen = false;
    if (this.onChange) this.onChange();
    return true;
  }

  // 毎フレーム呼ぶ。生産が発生したら { building, type, recipient } を返す
  update(dt, characters, getSpeedMultFn = null) {
    const events = [];
    this.placed.forEach(b => {
      if (b.flashTimer > 0) b.flashTimer -= dt;
      const benefit = BUILDING_BENEFITS[b.type];
      if (!benefit) return;
      const mult = typeof getSpeedMultFn === "function" ? (getSpeedMultFn(b.builderId) || 1.0) : 1.0;
      b.generateTimer -= dt * mult;
      if (b.generateTimer > 0) return;

      b.generateTimer = benefit.interval;

      const recipient = characters.find(c => c.id === b.builderId)
        ?? [...characters].sort((a, z) => Math.hypot(a.x - b.x, a.y - b.y) - Math.hypot(z.x - b.x, z.y - b.y))[0];
      if (!recipient) return;

      inventoryAdd(recipient.inventory, benefit.generates, 1);
      b.flashTimer = 1.8;
      b.lastGenType = benefit.generates;
      events.push({ building: b, type: benefit.generates, recipient });
    });
    if (events.length > 0 && this.onChange) this.onChange();
    return events;
  }

  draw(ctx, previewPos = null) {
    this.placed.forEach(b => {
      const x = Math.round(b.x);
      const y = Math.round(b.y);
      const benefit = BUILDING_BENEFITS[b.type];
      const genEmoji = benefit ? RESOURCE_EMOJI[benefit.generates] : "";
      const ownerColor = b.builderColor || "#FFD700";
      const ownerLabel = b.builderName || (b.builderId === "player" ? "Player" : b.builderId);
      const pulse = b.flashTimer > 0
        ? 1.0 + 0.18 * Math.sin(Date.now() / 130)
        : 1.0;

      ctx.save();

      // 1. 資源ノード（円形）と明確に区別できる角丸スクエアの建築台座（42x42）
      const size = Math.round(42 * pulse);
      const half = size / 2;

      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.52)";
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = "#FFF7E0";
      ctx.beginPath();
      ctx.roundRect(x - half, y - half, size, size, 9);
      ctx.fill();
      ctx.restore();

      // 所有者カラーの太枠
      ctx.strokeStyle = ownerColor;
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.roundRect(x - half, y - half, size, size, 9);
      ctx.stroke();

      // 上部ルーフ帯（建造物らしさを強調）
      ctx.fillStyle = ownerColor;
      ctx.beginPath();
      ctx.roundRect(x - half, y - half, size, 9, [8, 8, 0, 0]);
      ctx.fill();

      // 2. 建物メインアイコン
      ctx.font = `${Math.round(23 * pulse)}px serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(b.emoji, x - 3, y + 3);

      // 3. 右下の生産リソース小バッジ（何を生産する施設か一目で分かる）
      if (genEmoji) {
        const bx = x + half - 6;
        const by = y + half - 6;
        ctx.beginPath();
        ctx.arc(bx, by, 10, 0, Math.PI * 2);
        ctx.fillStyle = "#2C1810";
        ctx.fill();
        ctx.strokeStyle = "#FFD700";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.font = "11px serif";
        ctx.fillText(genEmoji, bx, by + 0.5);
      }

      // 4. 下部の高視認ネームプレート＋生産進捗ゲージ（「Player: 焚き火」）
      const titleText = `${ownerLabel}:${b.name}`;
      ctx.font = "bold 10px 'Segoe UI', 'Meiryo', sans-serif";
      const plateW = Math.max(66, ctx.measureText(titleText).width + 12);
      const plateH = 18;
      const px = x - plateW / 2;
      const py = y + half + 4;

      ctx.fillStyle = "rgba(28, 16, 10, 0.92)";
      ctx.beginPath();
      ctx.roundRect(px, py, plateW, plateH, 5);
      ctx.fill();
      ctx.strokeStyle = ownerColor;
      ctx.lineWidth = 1.4;
      ctx.stroke();

      if (b.interval && b.interval < 900) {
        const progress = Math.max(0, Math.min(1, 1 - b.generateTimer / b.interval));
        const barW = plateW - 8;
        const barH = 2.5;
        ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
        ctx.fillRect(px + 4, py + plateH - 4, barW, barH);
        ctx.fillStyle = "#FFD700";
        ctx.fillRect(px + 4, py + plateH - 4, barW * progress, barH);
      }

      ctx.fillStyle = "#FFFDF7";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(titleText, x, py + 7);

      // 5. 生産完了時のポップアップ
      if (b.flashTimer > 0 && b.lastGenType) {
        const pop = `+1 ${RESOURCE_EMOJI[b.lastGenType]}`;
        ctx.font = "bold 12px 'Segoe UI', sans-serif";
        const pw = ctx.measureText(pop).width + 10;
        ctx.fillStyle = "#2C1810";
        ctx.beginPath();
        ctx.roundRect(x - pw / 2, y - half - 22, pw, 18, 5);
        ctx.fill();
        ctx.strokeStyle = "#FFD700";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = "#FFD700";
        ctx.fillText(pop, x, y - half - 13);
      }
      ctx.restore();
    });

    // 建築設置ゴーストプレビュー（設置後の角丸スクエア形状がそのまま分かる）
    if (this.pendingType && previewPos) {
      const r = BUILDING_RECIPES[this.pendingType];
      const ben = BUILDING_BENEFITS[this.pendingType];
      if (r) {
        const gx = Math.round(previewPos.x);
        const gy = Math.round(previewPos.y);
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = "rgba(255, 247, 224, 0.88)";
        ctx.beginPath();
        ctx.roundRect(gx - 22, gy - 22, 44, 44, 9);
        ctx.fill();
        ctx.setLineDash([5, 3]);
        ctx.strokeStyle = "#FFD700";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = "24px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(r.emoji, gx, gy);

        const hint = `${r.name} をここに設置${ben ? ` (+${RESOURCE_EMOJI[ben.generates]})` : ""}`;
        ctx.font = "bold 10.5px 'Segoe UI', 'Meiryo', sans-serif";
        const hw = ctx.measureText(hint).width + 12;
        ctx.fillStyle = "rgba(28, 16, 10, 0.9)";
        ctx.beginPath();
        ctx.roundRect(gx - hw / 2, gy + 26, hw, 18, 5);
        ctx.fill();
        ctx.fillStyle = "#FFD700";
        ctx.fillText(hint, gx, gy + 35);
        ctx.restore();
      }
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BUILDING_RECIPES, BUILDING_BENEFITS, BuildingManager };
}
