(function () {
  const MAPS_JSON_URL  = "map-assets/assets/maps/town_maps.json";
  const ATLAS_JSON_URL = "map-assets/assets/town_blocks/atlas.json";
  const ATLAS_BASE     = "map-assets/assets/town_blocks/";
  const PROG_JSON_URL  = "map-assets/assets/progression_layers/progression_layers.json";
  const PROG_BASE      = "map-assets/assets/progression_layers/";
  const DEFAULT_MAP_ID = "central_plaza";

  const UPGRADEABLE_ROADS = new Set([
    "road_straight", "road_corner", "road_t", "road_cross", "dirt_path",
  ]);
  const SOLAR_BUILDINGS = new Set([
    "town_hall", "bank", "house_red", "house_blue", "agent_hut",
  ]);

  class MapRenderer {
    constructor() {
      this._ready          = false;
      this._maps           = [];
      this._atlasAssets    = [];
      this._mapData        = null;
      this._townLevel      = 0;
      this._tileImages     = new Map();
      this._spriteImages   = new Map();
      this._progImages     = new Map();
      this._overlayPlan    = null;
      this._sortedObjects  = [];
      this._terrainCacheCanvas = null;
      this._terrainCacheKey = "";
      this.onReady         = null;
      this.onMapChange     = null;
      this._load();
    }

    _buildFallbackMap() {
      const width = 12;
      const height = 10;
      return {
        id: DEFAULT_MAP_ID,
        name: "Central Plaza (Offline)",
        description: "フォールバック草地マップ",
        width,
        height,
        legend: { G: "grass" },
        terrain: Array.from({ length: height }, () => "G".repeat(width)),
        objects: [],
      };
    }

    _cacheSortedObjects(mapData) {
      this._sortedObjects = [...(mapData?.objects || [])].sort((a, b) => a.y - b.y || a.x - b.x);
    }

    async _load() {
      try {
        const [mapsDoc, atlasDoc, progDoc] = await Promise.all([
          fetch(MAPS_JSON_URL).then(r => { if (!r.ok) throw new Error(r.url); return r.json(); }),
          fetch(ATLAS_JSON_URL).then(r => { if (!r.ok) throw new Error(r.url); return r.json(); }),
          fetch(PROG_JSON_URL).then(r => (r.ok ? r.json() : null)).catch(() => null),
        ]);

        this._maps = Array.isArray(mapsDoc.maps) ? mapsDoc.maps : [];
        this._atlasAssets = Array.isArray(atlasDoc.assets) ? atlasDoc.assets : [];
        this._mapData = this._maps.find(m => m.id === DEFAULT_MAP_ID) || this._maps[0] || this._buildFallbackMap();
        this._overlayPlan = this._computeOverlayPlan(this._mapData);
        this._cacheSortedObjects(this._mapData);

        await Promise.all([
          this._preloadAtlasImages(this._atlasAssets),
          this._preloadProgressionImages(progDoc),
        ]);
        this._ready = true;
        if (this.onReady) this.onReady(this.getMaps(), this.getCurrentMapId());
      } catch (err) {
        console.warn("[MapRenderer] Failed to load tile assets; using fallback map:", err);
        const fallback = this._buildFallbackMap();
        this._maps = [fallback];
        this._atlasAssets = [];
        this._mapData = fallback;
        this._overlayPlan = null;
        this._sortedObjects = [];
        this._ready = true;
        if (this.onReady) this.onReady(this.getMaps(), this.getCurrentMapId());
      }
    }

    getMaps() {
      return this._maps.map(m => ({ id: m.id, name: m.name, description: m.description || "" }));
    }

    getCurrentMapId() {
      return this._mapData?.id || DEFAULT_MAP_ID;
    }

    getCurrentMapData() {
      return this._mapData;
    }

    getAtlasAssets() {
      return this._atlasAssets;
    }

    setTownLevel(level) {
      const lv = Math.max(0, Math.min(5, Math.floor(Number(level) || 0)));
      this._townLevel = lv;
    }

    setMap(mapId) {
      const next = this._maps.find(m => m.id === mapId);
      if (!next) return false;
      this._mapData = next;
      this._overlayPlan = this._computeOverlayPlan(next);
      this._cacheSortedObjects(next);
      if (this.onMapChange) this.onMapChange(next.id, next);
      return true;
    }

    _preloadAtlasImages(assets) {
      const jobs = [];
      for (const asset of assets) {
        jobs.push(new Promise(resolve => {
          const img = new Image();
          img.onload  = () => { this._tileImages.set(asset.id, img);  resolve(); };
          img.onerror = () => { this._tileImages.set(asset.id, null); resolve(); };
          img.src = ATLAS_BASE + asset.seamlessTileFile;
        }));
        jobs.push(new Promise(resolve => {
          const img = new Image();
          img.onload  = () => { this._spriteImages.set(asset.id, img);  resolve(); };
          img.onerror = () => { this._spriteImages.set(asset.id, null); resolve(); };
          img.src = ATLAS_BASE + asset.file;
        }));
      }
      return Promise.all(jobs);
    }

    _preloadProgressionImages(progDoc) {
      if (!progDoc) return Promise.resolve();
      const entries = [
        ...(progDoc.baseTiles || []),
        ...(progDoc.assets || progDoc.overlays || []),
      ];
      const jobs = entries.map(item => new Promise(resolve => {
        const img = new Image();
        img.onload  = () => { this._progImages.set(item.id, img);  resolve(); };
        img.onerror = () => { this._progImages.set(item.id, null); resolve(); };
        img.src = PROG_BASE + item.file;
      }));
      return Promise.all(jobs);
    }

    // マップごとの街発展装飾スロットを決定論的に算出（既存オブジェクトと重複しない配置）
    _computeOverlayPlan(map) {
      if (!map) return { ground: [], roofs: [] };
      const occupied = new Set((map.objects || []).map(o => `${o.x},${o.y}`));
      const tilesByType = {
        plaza_stone: [],
        grass_field: [],
        wild_meadow: [],
        farm_plot: [],
      };
      const cx = map.width / 2;
      const cy = map.height / 2;

      for (let row = 0; row < (map.terrain || []).length; row++) {
        const rowStr = map.terrain[row];
        for (let col = 0; col < rowStr.length; col++) {
          if (occupied.has(`${col},${row}`)) continue;
          const assetId = map.legend?.[rowStr[col]];
          if (tilesByType[assetId]) {
            tilesByType[assetId].push({
              x: col,
              y: row,
              distCenter: Math.hypot(col + 0.5 - cx, row + 0.5 - cy),
            });
          }
        }
      }

      const used = new Set();
      const pick = (candidates, count, sortFn = null) => {
        const pool = candidates.filter(t => !used.has(`${t.x},${t.y}`));
        if (sortFn) pool.sort(sortFn);
        const chosen = [];
        const step = pool.length > count ? Math.max(1, Math.floor(pool.length / count)) : 1;
        for (let i = 0; i < pool.length && chosen.length < count; i += step) {
          const t = pool[i];
          used.add(`${t.x},${t.y}`);
          chosen.push(t);
        }
        return chosen;
      };

      const plaza = tilesByType.plaza_stone;
      const grass = [...tilesByType.grass_field, ...tilesByType.wild_meadow];
      const farms = tilesByType.farm_plot;
      const ground = [];

      // Lv.1: 道標
      pick(grass, 2, (a, b) => a.distCenter - b.distCenter)
        .forEach(t => ground.push({ minLevel: 1, asset: "signposts", x: t.x, y: t.y }));

      // Lv.2: 花壇プランター・ベンチ・水路
      pick(plaza.length ? plaza : grass, 3)
        .forEach(t => ground.push({ minLevel: 2, asset: "flower_planters", x: t.x, y: t.y }));
      pick(grass, 2, (a, b) => a.distCenter - b.distCenter)
        .forEach(t => ground.push({ minLevel: 2, asset: "benches", x: t.x, y: t.y }));
      pick(farms, 4)
        .forEach(t => ground.push({ minLevel: 2, asset: "irrigation_channels", x: t.x, y: t.y }));

      // Lv.3: 街灯・市場屋台
      pick(plaza.length ? plaza : grass, 4)
        .forEach(t => ground.push({ minLevel: 3, asset: "street_lamps", x: t.x, y: t.y }));
      pick(plaza.length ? plaza : grass, 2, (a, b) => a.distCenter - b.distCenter)
        .forEach(t => ground.push({ minLevel: 3, asset: "market_stalls", x: t.x, y: t.y }));

      // Lv.4: 中央噴水・祭提灯
      pick(plaza.length ? plaza : grass, 1, (a, b) => a.distCenter - b.distCenter)
        .forEach(t => ground.push({ minLevel: 4, asset: "plaza_fountain", x: t.x, y: t.y }));
      pick(plaza.length ? plaza : grass, 3)
        .forEach(t => ground.push({ minLevel: 4, asset: "festival_lanterns", x: t.x, y: t.y }));

      // 屋根上装飾（Lv.4 ソーラーパネル / Lv.5 時計台）
      const roofs = [];
      const buildingObjs = (map.objects || []).filter(o => SOLAR_BUILDINGS.has(o.asset));
      buildingObjs.slice(0, 3).forEach(o => {
        roofs.push({ minLevel: 4, asset: "solar_panels", x: o.x, y: o.y });
      });

      const landmark = (map.objects || []).find(o => o.asset === "town_hall")
        || buildingObjs[0];
      if (landmark) {
        roofs.push({ minLevel: 5, asset: "clock_tower_upgrade", x: landmark.x, y: landmark.y });
      } else {
        pick(plaza.length ? plaza : grass, 1, (a, b) => a.distCenter - b.distCenter)
          .forEach(t => ground.push({ minLevel: 5, asset: "clock_tower_upgrade", x: t.x, y: t.y }));
      }

      return { ground, roofs };
    }

    _drawFarmPlots(ctx, tileW, tileH, farmManager, playerPos, gatherRadius) {
      if (!farmManager || !Array.isArray(farmManager.plots)) return;
      const soilImg = this._progImages.get("farm_soil");

      for (const plot of farmManager.plots) {
        const px = plot.col * tileW;
        const py = plot.row * tileH;

        ctx.save();
        if (!plot.cropId) {
          // 空き農地：はっきり見える耕作土タイル＋金茶の点線枠＋「空き農地」ラベル
          if (soilImg) {
            ctx.globalAlpha = 0.72;
            ctx.drawImage(soilImg, px + 2, py + 2, tileW - 4, tileH - 4);
            ctx.globalAlpha = 1;
          } else {
            ctx.fillStyle = "rgba(109, 76, 31, 0.55)";
            ctx.fillRect(px + 2, py + 2, tileW - 4, tileH - 4);
          }
          ctx.strokeStyle = "rgba(255, 224, 130, 0.85)";
          ctx.lineWidth = 1.8;
          ctx.setLineDash([5, 4]);
          ctx.strokeRect(px + 3, py + 3, tileW - 6, tileH - 6);
          ctx.setLineDash([]);

          const emptyLabel = "🌾 空き農地";
          ctx.font = "bold 9.5px 'Segoe UI', 'Meiryo', sans-serif";
          const ew = ctx.measureText(emptyLabel).width + 8;
          const cx = px + tileW / 2;
          const cy = py + tileH / 2;
          ctx.fillStyle = "rgba(28, 16, 10, 0.78)";
          ctx.beginPath();
          ctx.roundRect(cx - ew / 2, cy - 7, ew, 14, 4);
          ctx.fill();
          ctx.fillStyle = "#FFE57F";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(emptyLabel, cx, cy);
          ctx.restore();
          continue;
        }

        // 稼働中農地：farm_soil ベース + 作物ステージオーバーレイ (stage_0〜3)
        if (soilImg) {
          ctx.drawImage(soilImg, px, py, tileW + 0.5, tileH + 0.5);
        }
        const cropImg = this._progImages.get(`${plot.cropId}_stage_${plot.stage}`);
        if (cropImg) {
          ctx.drawImage(cropImg, px, py, tileW, tileH);
        }

        const isRipe = plot.stage >= 3;
        const isPlayerPlot = plot.ownerId === "player";
        const cx = px + tileW / 2;
        const cy = py + tileH / 2;
        const inHarvestRange = isRipe && isPlayerPlot && playerPos && gatherRadius > 0 &&
          Math.hypot(cx - playerPos.x, cy - playerPos.y) <= gatherRadius;

        // 所有者カラー枠（ライバル識別）
        ctx.strokeStyle = isRipe && isPlayerPlot ? "#FFD700" : (plot.ownerColor || "#FFD700");
        ctx.lineWidth = isRipe ? 2.5 : 1.8;
        ctx.strokeRect(px + 2, py + 2, tileW - 4, tileH - 4);

        // 成長ゲージまたは収穫可能ハイライト
        const cropDef = typeof CROP_CATALOG !== "undefined" ? CROP_CATALOG[plot.cropId] : null;
        const emoji = cropDef?.emoji || "🌱";

        if (isRipe) {
          const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
          ctx.fillStyle = `rgba(255, 215, 0, ${0.15 + pulse * 0.15})`;
          ctx.fillRect(px + 2, py + 2, tileW - 4, tileH - 4);

          const label = inHarvestRange ? `${emoji} 収穫 [E]` : `${emoji} ${plot.ownerName}`;
          ctx.font = "bold 10px 'Segoe UI', 'Meiryo', sans-serif";
          const lw = ctx.measureText(label).width + 10;
          ctx.fillStyle = "rgba(44, 24, 16, 0.88)";
          ctx.beginPath();
          ctx.roundRect(cx - lw / 2, py + 3, lw, 15, 4);
          ctx.fill();
          ctx.strokeStyle = plot.ownerColor || "#FFD700";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = isPlayerPlot ? "#FFD700" : "#FDF8F0";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, cx, py + 10.5);
        } else {
          // Stage 0〜2 の進捗バー + 所有者タグ
          const stageFrac = plot.stageDuration > 0
            ? Math.max(0, Math.min(1, 1 - plot.stageTimer / plot.stageDuration))
            : 0;
          const totalProgress = (plot.stage + stageFrac) / 3;
          const bw = Math.max(24, tileW - 14);
          const bh = 4;
          const bx = cx - bw / 2;
          const by = py + tileH - 8;
          ctx.fillStyle = "rgba(44, 24, 16, 0.82)";
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = plot.ownerColor || "#7AB85A";
          ctx.fillRect(bx, by, bw * totalProgress, bh);

          const tag = `${emoji}${plot.ownerName}`;
          ctx.font = "bold 9.5px 'Segoe UI', 'Meiryo', sans-serif";
          const tw = ctx.measureText(tag).width + 8;
          ctx.fillStyle = "rgba(44, 24, 16, 0.75)";
          ctx.beginPath();
          ctx.roundRect(cx - tw / 2, py + 3, tw, 13, 3);
          ctx.fill();
          ctx.fillStyle = "#FDF8F0";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(tag, cx, py + 9.5);
        }

        ctx.restore();
      }
    }

    draw(ctx, w, h, farmManager = null, playerPos = null, gatherRadius = 0) {
      if (!this._ready || !this._mapData) return;

      const map   = this._mapData;
      const tileW = w / map.width;
      const tileH = h / map.height;

      // 1. ベース地形タイル（オフスクリーンキャッシュで毎フレーム120枚の drawImage を削減）
      const cacheKey = `${map.id}:${this._townLevel}:${Math.round(w)}x${Math.round(h)}`;
      if (typeof document !== "undefined" && w > 0 && h > 0) {
        if (!this._terrainCacheCanvas || this._terrainCacheKey !== cacheKey) {
          const off = this._terrainCacheCanvas || document.createElement("canvas");
          off.width = Math.max(1, Math.round(w));
          off.height = Math.max(1, Math.round(h));
          const octx = off.getContext("2d");
          let drewAnyTile = false;
          for (let row = 0; row < map.terrain.length; row++) {
            const rowStr = map.terrain[row];
            for (let col = 0; col < rowStr.length; col++) {
              const assetId = map.legend[rowStr[col]];
              let img = null;
              if (this._townLevel >= 1 && UPGRADEABLE_ROADS.has(assetId)) {
                img = this._progImages.get(`${assetId}_level_${this._townLevel}`) || null;
              }
              if (!img) img = this._tileImages.get(assetId);
              if (!img) continue;
              octx.drawImage(img, col * tileW, row * tileH, tileW + 0.5, tileH + 0.5);
              drewAnyTile = true;
            }
          }
          if (!drewAnyTile) {
            octx.fillStyle = typeof C !== "undefined" ? C.grassBase : "#5A8A44";
            octx.fillRect(0, 0, off.width, off.height);
          }
          this._terrainCacheCanvas = off;
          this._terrainCacheKey = cacheKey;
        }
        ctx.drawImage(this._terrainCacheCanvas, 0, 0, w, h);
      } else {
        let drewAnyTile = false;
        for (let row = 0; row < map.terrain.length; row++) {
          const rowStr = map.terrain[row];
          for (let col = 0; col < rowStr.length; col++) {
            const assetId = map.legend[rowStr[col]];
            let img = null;
            if (this._townLevel >= 1 && UPGRADEABLE_ROADS.has(assetId)) {
              img = this._progImages.get(`${assetId}_level_${this._townLevel}`) || null;
            }
            if (!img) img = this._tileImages.get(assetId);
            if (!img) continue;
            ctx.drawImage(img, col * tileW, row * tileH, tileW + 0.5, tileH + 0.5);
            drewAnyTile = true;
          }
        }
        if (!drewAnyTile) {
          ctx.fillStyle = typeof C !== "undefined" ? C.grassBase : "#5A8A44";
          ctx.fillRect(0, 0, w, h);
        }
      }

      // 2. 農業プログレッション区画（farm_soil + 8種作物の成長ステージ 0〜3）
      this._drawFarmPlots(ctx, tileW, tileH, farmManager, playerPos, gatherRadius);

      // 3. 街発展の地上オーバーレイ（道標・花壇・ベンチ・街灯・市場屋台・噴水・提灯）
      if (this._townLevel >= 1 && this._overlayPlan) {
        for (const ov of this._overlayPlan.ground) {
          if (this._townLevel < ov.minLevel) continue;
          const img = this._progImages.get(ov.asset);
          if (!img) continue;
          ctx.drawImage(img, ov.x * tileW, ov.y * tileH, tileW, tileH);
        }
      }

      // 3. マップ上の建物・自然オブジェクト（事前ソート済みキャッシュを使用）
      for (const obj of this._sortedObjects) {
        const img = this._spriteImages.get(obj.asset);
        if (!img) continue;
        ctx.drawImage(img, obj.x * tileW, obj.y * tileH, tileW, tileH);
      }

      // 4. 街発展の建物アップグレード装飾（ソーラーパネル・時計台）
      if (this._townLevel >= 4 && this._overlayPlan) {
        for (const roof of this._overlayPlan.roofs) {
          if (this._townLevel < roof.minLevel) continue;
          const img = this._progImages.get(roof.asset);
          if (!img) continue;
          ctx.drawImage(img, roof.x * tileW, roof.y * tileH, tileW, tileH);
        }
      }
    }
  }

  window.MapRenderer = MapRenderer;
})();
