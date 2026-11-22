// ============================================================
// pathfinding.js — 地形・建物コリジョン判定 & 軽量A*経路探索
// ============================================================

class NavGrid {
  constructor() {
    this.cols = 0;
    this.rows = 0;
    this.cellW = 1;
    this.cellH = 1;
    this.canvasW = 0;
    this.canvasH = 0;
    this.blocked = []; // Uint8Array (1 = 通行不可, 0 = 通行可)
    this.solidRects = []; // ピクセル座標の当たり判定矩形一覧
    this._mapData = null;
    this._atlasMap = null;
    this._subDiv = 2;
  }

  buildFromMap(mapData, atlasAssets, canvasW, canvasH, subDiv = 2) {
    if (!mapData || !canvasW || !canvasH) return;
    this._mapData = mapData;
    this._subDiv = subDiv;
    this.canvasW = canvasW;
    this.canvasH = canvasH;

    const atlasMap = new Map();
    for (const asset of atlasAssets || []) {
      atlasMap.set(asset.id, asset);
    }
    this._atlasMap = atlasMap;

    const tileW = canvasW / mapData.width;
    const tileH = canvasH / mapData.height;
    const srcSize = 256; // atlas.json の基準タイル解像度

    const rects = [];
    const addCollisionRect = (col, row, colDef, shrinkRatio = 0.08) => {
      if (!colDef || !colDef.solid || colDef.type !== "rect") return;
      const rx = col * tileW + (colDef.x / srcSize) * tileW;
      const ry = row * tileH + (colDef.y / srcSize) * tileH;
      const rw = (colDef.w / srcSize) * tileW;
      const rh = (colDef.h / srcSize) * tileH;
      // わずかに内側に縮めて狭い通路で引っかかりにくくする
      const padX = rw * shrinkRatio;
      const padY = rh * shrinkRatio;
      rects.push({
        x: rx + padX,
        y: ry + padY,
        w: Math.max(4, rw - padX * 2),
        h: Math.max(4, rh - padY * 2),
      });
    };

    // 1. 地形タイル由来のコリジョン（森・池など）
    for (let row = 0; row < (mapData.terrain || []).length; row++) {
      const rowStr = mapData.terrain[row];
      for (let col = 0; col < rowStr.length; col++) {
        const assetId = mapData.legend?.[rowStr[col]];
        const asset = atlasMap.get(assetId);
        if (asset?.collision?.solid) {
          addCollisionRect(col, row, asset.collision, 0.1);
        }
      }
    }

    // 2. マップ上の建物・障害物スプライト由来のコリジョン
    for (const obj of mapData.objects || []) {
      const asset = atlasMap.get(obj.asset);
      if (asset?.collision?.solid) {
        addCollisionRect(obj.x, obj.y, asset.collision, 0.12);
      }
    }

    this.solidRects = rects;
    this.cols = mapData.width * subDiv;
    this.rows = mapData.height * subDiv;
    this.cellW = canvasW / this.cols;
    this.cellH = canvasH / this.rows;
    this.blocked = new Uint8Array(this.cols * this.rows);

    for (let r = 0; r < this.rows; r++) {
      const cy = (r + 0.5) * this.cellH;
      for (let c = 0; c < this.cols; c++) {
        const cx = (c + 0.5) * this.cellW;
        // キャラクターの移動当たり判定半径 (8px) と一致させ、A* が通れない隙間を通らないようにする
        if (this.isPointBlocked(cx, cy, 8)) {
          this.blocked[r * this.cols + c] = 1;
        }
      }
    }
  }

  rebuildForSize(canvasW, canvasH) {
    if (!this._mapData || !this._atlasMap) return;
    this.buildFromMap(
      this._mapData,
      [...this._atlasMap.values()],
      canvasW,
      canvasH,
      this._subDiv
    );
  }

  isReady() {
    return this.cols > 0 && this.rows > 0;
  }

  // 足元座標 (x, y) が半径 radius で障害物矩形と重なるか判定
  isPointBlocked(x, y, radius = 8) {
    for (let i = 0; i < this.solidRects.length; i++) {
      const rect = this.solidRects[i];
      if (
        x + radius > rect.x &&
        x - radius < rect.x + rect.w &&
        y + radius > rect.y &&
        y - radius < rect.y + rect.h
      ) {
        return true;
      }
    }
    return false;
  }

  // X/Y 軸独立で壁沿いスライド移動を解決（足元オフセット footOffsetY を考慮）
  resolveMovement(x, y, dx, dy, radius = 9, margin = 20, footOffsetY = 12) {
    const maxX = Math.max(margin, this.canvasW - margin);
    const maxY = Math.max(margin, this.canvasH - margin);
    const clampX = v => Math.max(margin, Math.min(maxX, v));
    const clampY = v => Math.max(margin, Math.min(maxY, v));

    if (!this.isReady()) {
      return { x: clampX(x + dx), y: clampY(y + dy), collided: false };
    }

    let nx = x;
    let ny = y;
    let collided = false;

    const tryX = clampX(nx + dx);
    if (!this.isPointBlocked(tryX, ny + footOffsetY, radius)) {
      nx = tryX;
    } else if (dx !== 0) {
      collided = true;
    }

    const tryY = clampY(ny + dy);
    if (!this.isPointBlocked(nx, tryY + footOffsetY, radius)) {
      ny = tryY;
    } else if (dy !== 0) {
      collided = true;
    }

    // すでに障害物内へめり込んでしまった場合の救出（元の位置が詰まっているときは移動を許容）
    if (collided && this.isPointBlocked(x, y + footOffsetY, radius)) {
      const safe = this.findNearestWalkablePoint(x, y + footOffsetY);
      if (safe) {
        const sdx = safe.x - x;
        const sdy = safe.y - (y + footOffsetY);
        const sdist = Math.hypot(sdx, sdy) || 1;
        const step = Math.min(sdist, Math.max(Math.hypot(dx, dy), 2));
        return {
          x: clampX(x + (sdx / sdist) * step),
          y: clampY(y + (sdy / sdist) * step),
          collided: false,
        };
      }
    }

    return { x: nx, y: ny, collided };
  }

  _worldToCell(x, y) {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor(x / this.cellW)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor(y / this.cellH)));
    return { col, row };
  }

  _cellToWorld(col, row) {
    return {
      x: (col + 0.5) * this.cellW,
      y: (row + 0.5) * this.cellH,
    };
  }

  _isCellBlocked(col, row) {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return true;
    return this.blocked[row * this.cols + col] === 1;
  }

  // 最寄りの通行可能セルを BFS で検索
  findNearestWalkableCell(startCol, startRow) {
    if (!this.isReady()) return { col: startCol, row: startRow };
    if (!this._isCellBlocked(startCol, startRow)) {
      return { col: startCol, row: startRow };
    }
    const visited = new Uint8Array(this.cols * this.rows);
    const queue = [{ col: startCol, row: startRow }];
    visited[startRow * this.cols + startCol] = 1;
    const dirs = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const [dc, dr] of dirs) {
        const nc = cur.col + dc;
        const nr = cur.row + dr;
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
        const idx = nr * this.cols + nc;
        if (visited[idx]) continue;
        visited[idx] = 1;
        if (!this.blocked[idx]) return { col: nc, row: nr };
        queue.push({ col: nc, row: nr });
      }
    }
    return null;
  }

  findNearestWalkablePoint(x, y) {
    if (!this.isReady()) return { x, y };
    if (!this.isPointBlocked(x, y, 8)) return { x, y };
    const { col, row } = this._worldToCell(x, y);
    const cell = this.findNearestWalkableCell(col, row);
    return cell ? this._cellToWorld(cell.col, cell.row) : { x, y };
  }

  pickRandomWalkablePoint(margin = 36) {
    if (!this.isReady()) {
      return {
        x: margin + Math.random() * Math.max(10, this.canvasW - margin * 2),
        y: margin + Math.random() * Math.max(10, this.canvasH - margin * 2),
      };
    }
    for (let i = 0; i < 30; i++) {
      const col = Math.floor(Math.random() * this.cols);
      const row = Math.floor(Math.random() * this.rows);
      if (this._isCellBlocked(col, row)) continue;
      const pt = this._cellToWorld(col, row);
      if (pt.x >= margin && pt.x <= this.canvasW - margin && pt.y >= margin && pt.y <= this.canvasH - margin) {
        return pt;
      }
    }
    return this.findNearestWalkablePoint(this.canvasW / 2, this.canvasH / 2);
  }

  // 8方向 A* 経路探索（角抜け防止つき・軽量実装）
  findPath(startX, startY, goalX, goalY, maxIter = 1200) {
    if (!this.isReady()) return [{ x: goalX, y: goalY }];

    const rawStart = this._worldToCell(startX, startY);
    const rawGoal = this._worldToCell(goalX, goalY);
    const start = this.findNearestWalkableCell(rawStart.col, rawStart.row);
    const goal = this.findNearestWalkableCell(rawGoal.col, rawGoal.row);
    if (!start || !goal) return [{ x: goalX, y: goalY }];

    if (start.col === goal.col && start.row === goal.row) {
      return [this._cellToWorld(goal.col, goal.row)];
    }

    const total = this.cols * this.rows;
    const startIdx = start.row * this.cols + start.col;
    const goalIdx = goal.row * this.cols + goal.col;

    const gScore = new Float32Array(total).fill(Infinity);
    const fScore = new Float32Array(total).fill(Infinity);
    const cameFrom = new Int32Array(total).fill(-1);
    const closed = new Uint8Array(total);
    const inOpen = new Uint8Array(total);

    const heuristic = (c, r) => {
      const dx = Math.abs(c - goal.col);
      const dy = Math.abs(r - goal.row);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };

    gScore[startIdx] = 0;
    fScore[startIdx] = heuristic(start.col, start.row);
    const open = [startIdx];
    inOpen[startIdx] = 1;

    const neighbors = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];

    let iter = 0;
    let found = false;
    let bestClosestIdx = startIdx;
    let bestClosestH = fScore[startIdx];

    while (open.length > 0 && iter++ < maxIter) {
      // 最小 fScore のノードを選択（グリッド最大 ~600 セルのため線形探索で十分高速）
      let bestPos = 0;
      let bestF = fScore[open[0]];
      for (let i = 1; i < open.length; i++) {
        const f = fScore[open[i]];
        if (f < bestF) {
          bestF = f;
          bestPos = i;
        }
      }

      const curIdx = open[bestPos];
      open[bestPos] = open[open.length - 1];
      open.pop();
      inOpen[curIdx] = 0;

      if (curIdx === goalIdx) {
        found = true;
        break;
      }

      closed[curIdx] = 1;
      const curCol = curIdx % this.cols;
      const curRow = (curIdx - curCol) / this.cols;
      const curH = heuristic(curCol, curRow);
      if (curH < bestClosestH) {
        bestClosestH = curH;
        bestClosestIdx = curIdx;
      }

      for (const [dc, dr, stepCost] of neighbors) {
        const nc = curCol + dc;
        const nr = curRow + dr;
        if (this._isCellBlocked(nc, nr)) continue;

        // 斜め移動時の角抜けを防止
        if (dc !== 0 && dr !== 0) {
          if (this._isCellBlocked(curCol + dc, curRow) || this._isCellBlocked(curCol, curRow + dr)) {
            continue;
          }
        }

        const nIdx = nr * this.cols + nc;
        if (closed[nIdx]) continue;

        const tentativeG = gScore[curIdx] + stepCost;
        if (tentativeG < gScore[nIdx]) {
          cameFrom[nIdx] = curIdx;
          gScore[nIdx] = tentativeG;
          fScore[nIdx] = tentativeG + heuristic(nc, nr);
          if (!inOpen[nIdx]) {
            open.push(nIdx);
            inOpen[nIdx] = 1;
          }
        }
      }
    }

    if (!found) {
      // 壁に囲まれる等で到達不可の場合は空配列に unreachable フラグを立てて返し、壁への無意味な突進・ブルブルを防ぐ
      const unreachable = [];
      unreachable.unreachable = true;
      return unreachable;
    }

    // 経路復元＋一直線の不要中間点を間引き
    const rawCells = [];
    let trace = goalIdx;
    while (trace !== -1 && trace !== startIdx) {
      const col = trace % this.cols;
      const row = (trace - col) / this.cols;
      rawCells.push({ col, row });
      trace = cameFrom[trace];
    }
    rawCells.reverse();

    const simplified = [];
    for (let i = 0; i < rawCells.length; i++) {
      if (i === 0 || i === rawCells.length - 1) {
        simplified.push(this._cellToWorld(rawCells[i].col, rawCells[i].row));
        continue;
      }
      const prev = rawCells[i - 1];
      const curr = rawCells[i];
      const next = rawCells[i + 1];
      const dx1 = curr.col - prev.col;
      const dy1 = curr.row - prev.row;
      const dx2 = next.col - curr.col;
      const dy2 = next.row - curr.row;
      if (dx1 !== dx2 || dy1 !== dy2) {
        simplified.push(this._cellToWorld(curr.col, curr.row));
      }
    }

    return simplified;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NavGrid };
}
