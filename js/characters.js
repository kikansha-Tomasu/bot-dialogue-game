const SPRITE_SIZE = 48;
const CHAR_FOOT_OFFSET_Y = 10;
const CHAR_COLLISION_RADIUS = 8;

class Character {
  constructor({ id, name, color, emoji, startFx, startFy, personality, isPlayer, spriteFolder, model, ttsConfig, strategyProfile }) {
    this.id = id;
    this.name = name;
    this.color = color;
    this.emoji = emoji || "";
    this.isPlayer = isPlayer || false;
    this.personality = personality || "";
    this.model = model || null;
    this.ttsConfig = ttsConfig || null;
    this.strategyProfile = strategyProfile || null;
    this.strategy = !this.isPlayer ? {
      archetype: strategyProfile?.archetype || "balanced",
      styleLabel: strategyProfile?.styleLabel || "バランス型",
      goal: strategyProfile?.defaultGoal || "採集・農業・取引を組み合わせて総資産1位を目指す",
      focusAction: strategyProfile?.defaultFocus || "gather",
      targetItem: strategyProfile?.defaultItem || "wood",
      targetRival: "Player",
      turnCount: 0,
      revisionCount: 0,
      lastRank: 0,
      lastUpdatedAt: 0,
    } : null;

    this.startFx = startFx;
    this.startFy = startFy;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;

    this.inventory = makeInventory();
    this.conversationHistory = [];
    this.wanderTarget = null;
    this.wanderTimer = Math.random() * 5;
    this.isTalking = false;
    this.isSpeaking = false;
    this.talkingTo = null;
    this._talkingTimer = null;
    this._thinkingTimer = null;
    this._speechSeq = 0;
    this._hasPendingSpeech = false;
    this._speechQueue = [];
    this._activeTypingId = null;
    this._speakAnimTime = 0;
    this.speechBubble = null;
    this.isTyping = false;
    this.gatherTarget = null;
    this.atGatherTarget = false;
    this.chatTarget = null;
    this.atChatTarget = false;

    // A* 経路追従状態
    this._path = [];
    this._pathGoalKey = "";
    this._pathRecalcTimer = 0;
    this._stuckTimer = 0;
    this._lastCheckX = 0;
    this._lastCheckY = 0;

    this.spriteFolder = spriteFolder || null;
    this._sprites = {};
    this._facing = "down";
    this._walkPhase = 1;
    this._walkTimer = 0;
    if (this.spriteFolder && typeof Image !== "undefined") this._loadSprites();
  }

  setSpriteFolder(folder) {
    if (!folder || folder === this.spriteFolder) return;
    this.spriteFolder = folder;
    this._sprites = {};
    if (typeof Image !== "undefined") this._loadSprites();
  }

  _loadSprites() {
    const DIRS = ["up", "down", "left", "right"];
    const FRAMES = [[0, "step_left"], [1, "idle"], [2, "step_right"]];
    for (const dir of DIRS) {
      for (const [idx, action] of FRAMES) {
        const key = `${dir}_${idx}_${action}`;
        const img = new Image();
        img.src = `${this.spriteFolder}/${key}.png`;
        this._sprites[key] = img;
      }
    }
  }

  clearPath() {
    this._path = [];
    this._pathGoalKey = "";
    this._stuckTimer = 0;
    this._lastCheckX = this.x;
    this._lastCheckY = this.y;
  }

  faceToward(target) {
    if (!target) return;
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    if (Math.hypot(dx, dy) < 2) return;
    if (Math.abs(dx) >= Math.abs(dy)) {
      this._facing = dx >= 0 ? "right" : "left";
    } else {
      this._facing = dy >= 0 ? "down" : "up";
    }
  }

  updateAnimation(vx, vy, dt) {
    const speedMag = Math.hypot(vx, vy);
    const moving = speedMag > 4;
    if (moving) {
      const absX = Math.abs(vx);
      const absY = Math.abs(vy);
      const isCurrentlyHoriz = this._facing === "left" || this._facing === "right";
      // 斜め移動時の向きフリッカー（ブルブル現象）をヒステリシスで防止
      if (isCurrentlyHoriz) {
        if (absY > absX * 1.25) {
          this._facing = vy > 0 ? "down" : "up";
        } else if (absX > 2) {
          this._facing = vx > 0 ? "right" : "left";
        }
      } else {
        if (absX > absY * 1.25) {
          this._facing = vx > 0 ? "right" : "left";
        } else if (absY > 2) {
          this._facing = vy > 0 ? "down" : "up";
        }
      }

      this._walkTimer -= dt;
      if (this._walkTimer <= 0) {
        this._walkPhase = this._walkPhase === 0 ? 2 : 0;
        this._walkTimer = 0.2;
      }
    } else {
      this._walkPhase = 1;
      this._walkTimer = 0;
    }
  }

  initPosition(canvasW, canvasH) {
    this.x = this.startFx * canvasW;
    this.y = this.startFy * canvasH;
    this._lastCheckX = this.x;
    this._lastCheckY = this.y;
  }

  scalePosition(oldW, oldH, newW, newH) {
    if (oldW <= 0 || oldH <= 0) return;
    const sx = newW / oldW;
    const sy = newH / oldH;
    this.x *= sx;
    this.y *= sy;
    if (this.wanderTarget) {
      this.wanderTarget.x *= sx;
      this.wanderTarget.y *= sy;
    }
    this.clearPath();
  }

  _moveTowardGoal(goalX, goalY, dt, canvasW, canvasH, navGrid, dynamicGoal = false) {
    const speed = GAME_CONFIG.aiSpeed;
    const prevX = this.x;
    const prevY = this.y;
    const footX = this.x;
    const footY = this.y + CHAR_FOOT_OFFSET_Y;

    let usingWaypoint = false;
    let targetX = goalX;
    let targetY = goalY;

    if (navGrid && navGrid.isReady()) {
      const goalKey = `${Math.round(goalX / 16)},${Math.round(goalY / 16)}`;
      this._pathRecalcTimer -= dt;
      const needRecalc = this._path.length === 0 ||
        this._pathGoalKey !== goalKey ||
        (dynamicGoal && this._pathRecalcTimer <= 0);

      if (needRecalc) {
        this._path = navGrid.findPath(footX, footY, goalX, goalY);
        this._pathGoalKey = goalKey;
        this._pathRecalcTimer = 0.8;
        if (this._path && this._path.unreachable) {
          this.vx = 0;
          this.vy = 0;
          return { collided: true, stuck: true, unreachable: true };
        }
      }

      const wpReach = Math.max(14, (navGrid.cellW || 16) * 0.45);
      while (this._path.length > 0) {
        const wp = this._path[0];
        // A* ウェイポイントは足元座標基準のため足元位置で到達判定する
        if (Math.hypot(wp.x - footX, wp.y - footY) < wpReach) {
          this._path.shift();
        } else {
          break;
        }
      }

      if (this._path.length > 0) {
        targetX = this._path[0].x;
        targetY = this._path[0].y;
        usingWaypoint = true;
      }
    }

    const dx = targetX - (usingWaypoint ? footX : this.x);
    const dy = targetY - (usingWaypoint ? footY : this.y);
    const dist = Math.hypot(dx, dy);

    if (dist < 2.5) {
      this.vx = 0;
      this.vy = 0;
      return { collided: false, stuck: false };
    }

    // ステップ量を残距離 dist 以下にクランプし、目標地点を通り過ぎて往復振動（ブルブル）するのを防止
    const maxStep = Math.min(dist, speed * dt);
    const stepX = (dx / dist) * maxStep;
    const stepY = (dy / dist) * maxStep;
    let collided = false;

    if (navGrid && navGrid.isReady()) {
      const moved = navGrid.resolveMovement(
        this.x,
        this.y,
        stepX,
        stepY,
        CHAR_COLLISION_RADIUS,
        20,
        CHAR_FOOT_OFFSET_Y
      );
      this.x = moved.x;
      this.y = moved.y;
      collided = moved.collided;
    } else {
      const margin = 24;
      this.x = Math.max(margin, Math.min(canvasW - margin, this.x + stepX));
      this.y = Math.max(margin, Math.min(canvasH - margin, this.y + stepY));
    }

    // 実際の移動変位から速度を算出（壁に引っかかって動けていないのに足踏みブルブルするのを防ぐ）
    const safeDt = Math.max(dt, 0.001);
    this.vx = (this.x - prevX) / safeDt;
    this.vy = (this.y - prevY) / safeDt;

    // 全移動モード（徘徊・採集・チャット接近）共通のスタック検知
    const progress = Math.hypot(this.x - this._lastCheckX, this.y - this._lastCheckY);
    if (progress < 4) {
      this._stuckTimer += dt;
    } else {
      this._stuckTimer = 0;
      this._lastCheckX = this.x;
      this._lastCheckY = this.y;
    }

    return { collided, stuck: this._stuckTimer > 1.4 };
  }

  updateWander(dt, canvasW, canvasH, navGrid = null) {
    if (this.isTalking) {
      this.vx = 0;
      this.vy = 0;
      this.updateAnimation(0, 0, dt);
      if (this.talkingTo) {
        this.faceToward(this.talkingTo);
      }
      if (this.isSpeaking) {
        this._speakAnimTime += dt;
      } else {
        this._speakAnimTime = 0;
      }
      return;
    }
    this._speakAnimTime = 0;

    if (this.chatTarget) {
      const dist = Math.hypot(this.chatTarget.x - this.x, this.chatTarget.y - this.y);
      if (dist < GAME_CONFIG.proximityRadius * 0.85) {
        this.vx = 0;
        this.vy = 0;
        this.atChatTarget = true;
        this.clearPath();
      } else {
        const res = this._moveTowardGoal(this.chatTarget.x, this.chatTarget.y, dt, canvasW, canvasH, navGrid, true);
        if (res.stuck) {
          if (dist < GAME_CONFIG.proximityRadius * 1.6) {
            this.atChatTarget = true;
          } else {
            this.chatTarget = null;
          }
          this.vx = 0;
          this.vy = 0;
          this.clearPath();
        }
      }
      this.updateAnimation(this.vx, this.vy, dt);
      return;
    }

    if (this.gatherTarget) {
      if (this.gatherTarget.isEmpty) {
        this.gatherTarget = null;
        this.atGatherTarget = false;
        this.clearPath();
      } else {
        const dist = Math.hypot(this.gatherTarget.x - this.x, this.gatherTarget.y - this.y);
        if (dist < GAME_CONFIG.gatherRadius * 0.72) {
          this.vx = 0;
          this.vy = 0;
          this.atGatherTarget = true;
          this.clearPath();
        } else {
          const res = this._moveTowardGoal(this.gatherTarget.x, this.gatherTarget.y, dt, canvasW, canvasH, navGrid, false);
          if (res.stuck) {
            if (dist < GAME_CONFIG.gatherRadius * 1.25) {
              this.atGatherTarget = true;
            } else {
              this.gatherTarget = null;
            }
            this.vx = 0;
            this.vy = 0;
            this.clearPath();
          }
        }
        this.updateAnimation(this.vx, this.vy, dt);
        return;
      }
    }

    const margin = 36;
    if (!this.wanderTarget || this.wanderTimer <= 0) {
      this.wanderTimer = GAME_CONFIG.aiChatMinInterval * 0.4
        + Math.random() * GAME_CONFIG.aiChatMinInterval * 0.3;
      this.wanderTarget = navGrid && navGrid.isReady()
        ? navGrid.pickRandomWalkablePoint(margin)
        : {
            x: margin + Math.random() * Math.max(10, canvasW - margin * 2),
            y: margin + Math.random() * Math.max(10, canvasH - margin * 2),
          };
      this.clearPath();
    }

    this.wanderTimer -= dt;
    const dist = Math.hypot(this.wanderTarget.x - this.x, this.wanderTarget.y - (this.y + CHAR_FOOT_OFFSET_Y));

    if (dist < 14) {
      this.vx = 0;
      this.vy = 0;
      this.wanderTarget = null;
      this.clearPath();
    } else {
      const res = this._moveTowardGoal(this.wanderTarget.x, this.wanderTarget.y, dt, canvasW, canvasH, navGrid, false);
      if (res.stuck) {
        this.vx = 0;
        this.vy = 0;
        this.wanderTarget = null;
        this.clearPath();
      }
    }

    this.updateAnimation(this.vx, this.vy, dt);
  }

  updateSpeechBubble(dt) {
    if (this.speechBubble) {
      if (this.isSpeaking) {
        // 音声再生中は吹き出しが途中で消えないように維持する
        this.speechBubble.ttl = Math.max(this.speechBubble.ttl - dt, 0.9);
      } else {
        this.speechBubble.ttl -= dt;
        if (this.speechBubble.ttl <= 0) {
          this.speechBubble = null;
        }
      }
    }
  }

  setSpeechBubble(text, durationSec = GAME_CONFIG.speechBubbleDuration) {
    const clean = String(text || "")
      .replace(/^[@＠](?:[A-Za-z0-9_]+|全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)(?:(?:さん|くん|君|ちゃん|様)[\s、,:：!！]*|[\s、,:：!！]+)/, "")
      .trim();
    const chars = [...clean];
    const shortened = chars.length > 74 ? chars.slice(0, 72).join("") + "…" : clean;
    const dur = Math.max(1.5, Number(durationSec) || GAME_CONFIG.speechBubbleDuration);
    this.speechBubble = {
      text: shortened,
      ttl: dur,
      maxTtl: dur,
    };
  }

  draw(ctx, canvasW = 1000) {
    const x = Math.round(this.x);
    const y = Math.round(this.y);

    const spriteKey = this._walkPhase === 1
      ? `${this._facing}_1_idle`
      : this._walkPhase === 0
        ? `${this._facing}_0_step_left`
        : `${this._facing}_2_step_right`;
    const spriteImg = this._sprites[spriteKey];
    const spriteReady = spriteImg && spriteImg.complete && spriteImg.naturalWidth > 0;

    const scale = SPRITE_SIZE / (spriteReady ? spriteImg.naturalHeight : SPRITE_SIZE);
    const drawW = spriteReady ? Math.round(spriteImg.naturalWidth * scale) : SPRITE_SIZE;
    const drawH = SPRITE_SIZE;
    const halfW = drawW / 2;
    const halfH = drawH / 2;

    ctx.save();

    // 足元の影
    ctx.beginPath();
    ctx.ellipse(x, y + halfH - 2, halfW * 0.65, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(30, 18, 8, 0.28)";
    ctx.fill();

    // Player ring
    if (this.isPlayer) {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(halfW, 18) + 4, 0, Math.PI * 2);
      ctx.strokeStyle = C.playerRing;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Typing / Preparing pulse ring
    if (this.isTyping) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(halfW, 18) + 6 + pulse * 5, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${this._hexToRgb(this.color)},${0.3 + pulse * 0.45})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Active speaking ring + gentle audio-synced bobbing motion
    let speakBobY = 0;
    if (this.isSpeaking) {
      const wave = Math.abs(Math.sin(this._speakAnimTime * 9.5));
      speakBobY = -Math.round(wave * 3.5);
      ctx.beginPath();
      ctx.ellipse(x, y + halfH - 2, halfW * (0.85 + wave * 0.25), 8 + wave * 2, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${this._hexToRgb(this.color)},${0.55 + wave * 0.35})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Sprite or fallback avatar
    if (spriteReady) {
      ctx.drawImage(spriteImg, x - halfW, y - halfH + speakBobY, drawW, drawH);
    } else {
      ctx.beginPath();
      ctx.arc(x, y + speakBobY, 18, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.strokeStyle = C.charOutline;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = "16px serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.emoji || this.name[0], x, y + speakBobY);
    }

    // AI の移動目的ミニアイコン
    if (!this.isPlayer && !this.speechBubble && !this.isTyping) {
      const intentIcon = this.gatherTarget ? "⛏" : this.chatTarget ? "💬" : null;
      if (intentIcon) {
        ctx.font = "12px serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(intentIcon, x + halfW + 4, y - halfH + 6);
      }
    }

    // Name badge below sprite
    ctx.font = "bold 11px 'Segoe UI', sans-serif";
    const nameW = ctx.measureText(this.name).width + 12;
    const badgeY = y + halfH + 4;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.roundRect(x - nameW / 2, badgeY, nameW, 16, 4);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.isPlayer ? "#2C1810" : C.nameBadgeText;
    ctx.fillText(this.name, x, badgeY + 8.5);

    ctx.restore();

    // Speech bubble or thinking cloud above sprite
    if (this.speechBubble) {
      this._drawSpeechBubble(ctx, x, y, halfH, canvasW);
    } else if (this.isTyping) {
      this._drawThinkingBubble(ctx, x, y, halfH, canvasW);
    }
  }

  _drawThinkingBubble(ctx, cx, cy, r, canvasW) {
    const step = Math.floor(Date.now() / 420) % 3;
    const dots = "・".repeat(step + 1);
    const label = `💭 ${dots}`;

    ctx.save();
    ctx.font = "12px 'Segoe UI', 'Meiryo', sans-serif";
    const textW = ctx.measureText("💭 ・・・").width;
    const bw = textW + 18;
    const bh = 24;
    const margin = 8;
    const bx = Math.max(margin, Math.min(canvasW - bw - margin, cx - bw / 2));
    const by = Math.max(margin, cy - r - 12 - bh - 6);

    ctx.fillStyle = "rgba(255, 250, 238, 0.94)";
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 11);
    ctx.fill();
    ctx.stroke();

    // 思考クラウドの小さな丸（2粒・左右端でも吹き出し内に収まるようクランプ）
    const tailX = Math.max(bx + 10, Math.min(bx + bw - 10, cx));
    ctx.beginPath();
    ctx.arc(tailX, by + bh + 4, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tailX, by + bh + 10, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#5C4033";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, bx + 9, by + bh / 2 + 0.5);
    ctx.restore();
  }

  _hexToRgb(hex) {
    if (!hex || !hex.startsWith("#") || hex.length < 7) return "120,120,120";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r},${g},${b}`;
  }

  _drawSpeechBubble(ctx, cx, cy, r, canvasW) {
    const text = this.speechBubble.text;
    const alpha = Math.min(1, this.speechBubble.ttl / 0.5);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "12px 'Segoe UI', 'Meiryo', sans-serif";

    const maxLineW = Math.min(260, Math.max(150, canvasW - 40));
    const lines = [];
    let current = "";
    for (const ch of text) {
      const test = current + ch;
      if (ctx.measureText(test).width > maxLineW && current.length > 0) {
        lines.push(current);
        current = ch;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    const maxLines = 3;
    const finalLines = lines.slice(0, maxLines);
    if (lines.length > maxLines) {
      const lastIdx = maxLines - 1;
      const lineChars = [...finalLines[lastIdx]];
      finalLines[lastIdx] = lineChars.slice(0, Math.max(1, lineChars.length - 1)).join("") + "…";
    }

    const lineH = 16;
    const padX = 10;
    const padY = 6;
    const textW = Math.max(...finalLines.map(l => ctx.measureText(l).width));
    const bw = textW + padX * 2;
    const bh = finalLines.length * lineH + padY * 2;

    const margin = 8;
    const bx = Math.max(margin, Math.min(canvasW - bw - margin, cx - bw / 2));
    const by = Math.max(margin, cy - r - 12 - bh - 6);
    const tailX = Math.max(bx + 10, Math.min(bx + bw - 10, cx));

    ctx.fillStyle = C.bubbleBg;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 6);
    ctx.fill();

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tailX - 5, by + bh - 1);
    ctx.lineTo(tailX, by + bh + 6);
    ctx.lineTo(tailX + 5, by + bh - 1);
    ctx.fillStyle = C.bubbleBg;
    ctx.fill();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = C.bubbleText;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    finalLines.forEach((line, i) => {
      ctx.fillText(line, bx + padX, by + padY + lineH * i + lineH / 2);
    });

    ctx.restore();
  }
}

function buildCharacters(canvasW, canvasH) {
  const chars = AI_CHARACTERS_CONFIG.map(cfg => new Character(cfg));

  const player = new Character({
    id: "player",
    name: "Player",
    color: C.player,
    emoji: "⭐",
    startFx: 0.5,
    startFy: 0.5,
    isPlayer: true,
    personality: "",
    spriteFolder: "characters/base_04",
  });

  const all = [...chars, player];
  all.forEach(c => c.initPosition(canvasW, canvasH));
  return all;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SPRITE_SIZE, Character, buildCharacters };
}
