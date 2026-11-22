class Game {
  constructor() {
    this.canvas = document.getElementById("game-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.keysHeld = new Set();
    this.mousePos = null;
    this.lastTime = null;
    this.running = false;
    this._lastNearbyIdsKey = "";
    this._lastGatherReady = null;
    this._inventoryRefreshTimer = 0;
    this._autoSaveTimer = 0;
    this._skipUnloadSave = false;
    this._restoredSave = false;
    this._hfBannerDismissed = false;
    this._hfBannerHideTimer = null;
    this._hfBannerCompletedShown = false;

    this._resizeCanvas();

    this.navGrid = new NavGrid();
    this.saveManager = new SaveManager();
    this.mapRenderer = new MapRenderer();
    this.characters = buildCharacters(this.canvas.width, this.canvas.height);
    this.player = this.characters.find(c => c.isPlayer);
    this.aiChars = this.characters.filter(c => !c.isPlayer);

    this.resourceManager = new ResourceManager();
    this.resourceManager.init(this.canvas.width, this.canvas.height, this.mapRenderer.getCurrentMapId());
    this.buildingManager = new BuildingManager(this.player);
    this.farmManager = new FarmManager();
    this.progression = new ProgressionManager(this.player);
    this.gatherCooldown = 0;

    this.chatManager = new ChatManager();
    this.apiClient = new HuggingFaceClient();
    this.aiBrain = new AIBrain(
      this.characters, this.chatManager, this.apiClient,
      this.resourceManager
    );
    this.orderBook = new OrderBook();

    const syncLivePanels = () => {
      if (this._isInventoryOpen()) this._renderInventoryPanel();
      if (this.buildingManager.isMenuOpen) this.buildingManager.refreshPanel();
      if (this.progression.isOpen) this._renderProgressionPanel();
      this._updateTownHudBadge();
      this._updateStatusPill();
      this._scheduleSave();
    };

    this.orderBook.onChange = syncLivePanels;
    this.buildingManager.onChange = syncLivePanels;
    this.aiBrain.onStateChange = syncLivePanels;
    this.progression.onChange = syncLivePanels;
    this.farmManager.onChange = syncLivePanels;

    this.progression.onTownUpgrade = (spec) => {
      this.mapRenderer.setTownLevel(spec.level);
      this.player.setSpeechBubble(`${spec.icon} 街がLv.${spec.level}「${spec.name}」に発展！`);
      this.chatManager.addMessage({
        senderId: "system",
        senderName: "街の発展",
        senderColor: "#7A5600",
        recipientId: "all",
        recipientName: "全員",
        text: `${spec.icon} 街が Lv.${spec.level}「${spec.name}」に発展しました！（${spec.visualSummary}）`,
        isAI: false,
      });
      this.aiBrain.celebrateTownUpgrade(spec, this.player);
    };

    this.progression.onAvatarChange = (item) => {
      this.player.setSpriteFolder(item.folder);
      this.player.setSpeechBubble(`${item.icon} ${item.name}に着替えた！`);
    };

    this.progression.onDividend = (coins, spec) => {
      this.chatManager.addMessage({
        senderId: "system",
        senderName: `${spec.name} 配当`,
        senderColor: "#7A5600",
        recipientId: this.player.id,
        recipientName: this.player.name,
        text: `🏙 街の発展配当として 🪙×${coins} を受け取りました！`,
        isAI: false,
      });
    };

    this.progression.onSeasonVictory = (winner, ranked) => {
      this.chatManager.addMessage({
        senderId: "system",
        senderName: "シーズン結果",
        senderColor: "#C48A00",
        recipientId: "all",
        recipientName: "全員",
        text: `🏆 ${winner.emoji} ${winner.name} がシーズン優勝を達成！（${winner.reason} ／ 総資産 ${winner.totalAssets.toFixed(1)}🪙）`,
        isAI: false,
      });
      if (!this.progression.victoryModalDismissed) {
        this._openVictoryModal(winner, ranked);
      }
    };

    this.orderBook.onExecute = (order, executor) => {
      const msg = `@${order.posterName} ${RESOURCE_EMOJI[order.buyType]}×${order.buyAmount}と${RESOURCE_EMOJI[order.sellType]}×${order.sellAmount}を交換したよ！ありがとう！`;
      this.chatManager.addMessage({
        senderId: executor.id,
        senderName: executor.name,
        senderColor: executor.id === "player" ? C.player : executor.color,
        recipientId: order.posterId,
        recipientName: order.posterName,
        text: msg,
        isAI: executor.id !== "player",
      });
      // プレイヤーが関与した約定では商人ボーナスを付与
      if (executor.id === "player" || order.posterId === "player") {
        const bonus = this.progression.onPlayerTradeExecuted();
        if (bonus > 0) {
          this.player.setSpeechBubble(`💰 商人ボーナス +🪙${bonus}`);
        }
      }
      syncLivePanels();
    };

    this.aiBrain.orderBook = this.orderBook;
    this.aiBrain.buildingManager = this.buildingManager;
    this.aiBrain.progression = this.progression;
    this.aiBrain.farmManager = this.farmManager;
    this.aiBrain.navGrid = this.navGrid;

    this.mapRenderer.onReady = (maps, currentId) => {
      this._populateMapSelector(maps, currentId);
      this._restoreSavedSession();
      this._rebuildNavigationAndSnap();
      this._updateTownHudBadge();
    };

    this._setupInput();
    this._setupChatUI();
    this._setupTopBar();
    this._setupProgressionUI();
    this._setupResize();
    this._setupPersistenceHooks();
    this.apiClient.onBrowserProgress = (info) => {
      if (info?.ready) {
        this.aiBrain.llmAvailable = true;
      }
      this._updateStatusPill();
    };
    this._refreshHealth();
    // オフライン状態になっても自動的に Hugging Face へ再接続を試み続ける
    this._hfReconnectTimer = setInterval(() => {
      if (this.apiClient.mode === "browser-hf") {
        if (!this.apiClient._workerReady && !this.apiClient._workerLoading) {
          this.apiClient._initBrowserWorker();
          this._updateStatusPill();
        }
        if (
          typeof ttsManager !== "undefined" &&
          ttsManager &&
          !ttsManager._isLocalHost &&
          !ttsManager.browserTtsReady &&
          !ttsManager.browserTtsLoading &&
          ttsManager.browserTtsError
        ) {
          ttsManager._initBrowserTtsWorker();
        }
        return;
      }
      const ttsDown = typeof ttsManager !== "undefined" && ttsManager && ttsManager._isLocalHost && ttsManager.localAvailable !== true;
      if (!this.aiBrain.llmAvailable || ttsDown) {
        this._refreshHealth(true);
      }
    }, 12000);
  }

  _scheduleSave() {
    if (this._skipUnloadSave || !this._restoredSave) return;
    this.saveManager.scheduleSave(() => SaveManager.captureGameState(this), 400);
  }

  _restoreSavedSession() {
    const saved = this.saveManager.load();
    if (saved) {
      if (saved.mapId && saved.mapId !== this.mapRenderer.getCurrentMapId()) {
        if (this.mapRenderer.setMap(saved.mapId)) {
          const sel = document.getElementById("map-select");
          if (sel) sel.value = saved.mapId;
          this.resourceManager.init(this.canvas.width, this.canvas.height, saved.mapId);
          this.farmManager.initForMap(saved.mapId, false);
        }
      }
      SaveManager.applyGameState(this, saved);
      this.mapRenderer.setTownLevel(this.progression.townLevel);
      this.chatManager.addMessage({
        senderId: "system",
        senderName: "システム",
        senderColor: "#4A5C2E",
        recipientId: this.player.id,
        recipientName: this.player.name,
        text: `💾 前回のセーブデータを復元しました（街 Lv.${this.progression.townLevel}「${this.progression.getTownSpec().name}」）`,
        isAI: false,
      });
    }
    this._restoredSave = true;
  }

  _rebuildNavigationAndSnap() {
    const mapData = this.mapRenderer.getCurrentMapData();
    const atlasAssets = this.mapRenderer.getAtlasAssets();
    if (!mapData || !atlasAssets.length) return;

    this.navGrid.buildFromMap(mapData, atlasAssets, this.canvas.width, this.canvas.height, 2);
    this.resourceManager.snapToWalkable(this.navGrid);

    // キャラクターが障害物上に重なっている場合は最寄りの通行可能位置へ安全退避
    this.characters.forEach(c => {
      c.clearPath();
      if (this.navGrid.isPointBlocked(c.x, c.y + 10, 9)) {
        const safe = this.navGrid.findNearestWalkablePoint(c.x, c.y + 10);
        if (safe) {
          c.x = safe.x;
          c.y = Math.max(20, safe.y - 10);
        }
      }
    });
  }

  _setupPersistenceHooks() {
    window.addEventListener("beforeunload", () => {
      if (this._skipUnloadSave || !this._restoredSave) return;
      this.saveManager.saveImmediate(SaveManager.captureGameState(this));
    });
  }

  _isTypingInForm(e) {
    if (e && e.isComposing) return true;
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
  }

  _resizeCanvas() {
    const wrap = document.getElementById("canvas-wrap");
    if (wrap) {
      this.canvas.width = Math.max(320, wrap.clientWidth);
      this.canvas.height = Math.max(240, wrap.clientHeight);
    } else {
      const panel = document.getElementById("chat-panel");
      this.canvas.width = Math.max(320, window.innerWidth - (panel ? panel.offsetWidth : 360));
      this.canvas.height = Math.max(240, window.innerHeight);
    }
  }

  _setupResize() {
    window.addEventListener("resize", () => {
      const oldW = this.canvas.width;
      const oldH = this.canvas.height;
      this._resizeCanvas();
      const newW = this.canvas.width;
      const newH = this.canvas.height;
      if (oldW > 0 && oldH > 0) {
        this.characters.forEach(c => c.scalePosition(oldW, oldH, newW, newH));
        this.resourceManager.scalePositions(oldW, oldH, newW, newH);
        this.buildingManager.scalePositions(oldW, oldH, newW, newH);
        this.navGrid.rebuildForSize(newW, newH);
      }
    });
  }

  _closeAllPanels(except = null) {
    if (except !== "inventory") {
      document.getElementById("inventory-panel")?.classList.add("hidden");
    }
    if (except !== "build" && this.buildingManager.isMenuOpen) {
      this.buildingManager.closeMenu();
    }
    if (except !== "orderbook" && this.orderBook.isOpen) {
      this.orderBook.close();
    }
    if (except !== "progression" && this.progression.isOpen) {
      this._closeProgressionPanel();
    }
    if (except !== "victory") {
      document.getElementById("victory-panel")?.classList.add("hidden");
    }
  }

  _setupInput() {
    window.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        const hfOv = document.getElementById("hf-loader-overlay");
        if (hfOv && !hfOv.classList.contains("hidden")) {
          this._hfBannerDismissed = true;
          hfOv.classList.add("hidden");
        }
        if (this.buildingManager.pendingType) {
          this.buildingManager.cancelPlacement();
          this.canvas.style.cursor = "default";
          return;
        }
        this._closeAllPanels();
        return;
      }

      if (this._isTypingInForm(e)) return;

      const key = e.key.toLowerCase();
      this.keysHeld.add(key);

      if (key === "w" || key === "a" || key === "s" || key === "d" || key.startsWith("arrow")) {
        if (!this._hfBannerDismissed && this.apiClient?.mode === "browser-hf" && !this.apiClient._workerReady) {
          this._hfBannerDismissed = true;
          document.getElementById("hf-loader-overlay")?.classList.add("hidden");
        }
      }

      if (e.repeat) return;
      if (key === "i") this._toggleInventoryPanel();
      if (key === "b") this._toggleBuildPanel();
      if (key === "t") this._toggleOrderBook();
      if (key === "u") this._toggleProgressionPanel();
    });

    window.addEventListener("keyup", e => {
      this.keysHeld.delete(e.key.toLowerCase());
    });

    window.addEventListener("blur", () => this.keysHeld.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.keysHeld.clear();
    });

    document.getElementById("btn-gather")?.addEventListener("click", () => this._triggerGather(true));
    document.getElementById("btn-build")?.addEventListener("click", () => this._toggleBuildPanel());
    document.getElementById("btn-progression")?.addEventListener("click", () => this._toggleProgressionPanel());

    this.canvas.addEventListener("mousemove", e => {
      const rect = this.canvas.getBoundingClientRect();
      this.mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      this.canvas.style.cursor = this.buildingManager.pendingType ? "crosshair" : "default";
    });

    this.canvas.addEventListener("mouseleave", () => {
      this.mousePos = null;
      this.canvas.style.cursor = "default";
    });

    this.canvas.addEventListener("click", e => {
      if (!this.buildingManager.pendingType) return;
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const placedType = this.buildingManager.pendingType;
      const ok = this.buildingManager.placeAt(cx, cy);
      this.canvas.style.cursor = "default";
      if (ok && BUILDING_RECIPES[placedType]) {
        const r = BUILDING_RECIPES[placedType];
        this.player.setSpeechBubble(`${r.emoji} ${r.name}を建てた！`);
      } else {
        this.player.setSpeechBubble("資源が足りません");
      }
    });
  }

  _toggleBuildPanel() {
    if (this.buildingManager.pendingType) {
      this.buildingManager.cancelPlacement();
      this.canvas.style.cursor = "default";
      return;
    }
    const willOpen = !this.buildingManager.isMenuOpen;
    if (willOpen) this._closeAllPanels("build");
    this.buildingManager.toggleMenu();
  }

  _toggleOrderBook() {
    if (this.orderBook.isOpen) {
      this.orderBook.close();
    } else {
      this._closeAllPanels("orderbook");
      this.orderBook.open(this.player);
    }
  }

  _toggleProgressionPanel() {
    if (this.progression.isOpen) {
      this._closeProgressionPanel();
    } else {
      this._closeAllPanels("progression");
      this.progression.isOpen = true;
      this._renderProgressionPanel();
      document.getElementById("progression-panel")?.classList.remove("hidden");
    }
  }

  _closeProgressionPanel() {
    this.progression.isOpen = false;
    document.getElementById("progression-panel")?.classList.add("hidden");
  }

  _setupProgressionUI() {
    document.getElementById("progression-close")?.addEventListener("click", () => {
      this._closeProgressionPanel();
    });

    document.querySelectorAll(".prog-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        this.progression._activeTab = btn.dataset.ptab;
        document.querySelectorAll(".prog-tab-btn").forEach(b => {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-selected", String(active));
        });
        this._renderProgressionPanel();
      });
    });

    const panel = document.getElementById("progression-panel");
    panel?.addEventListener("click", e => {
      const questBtn = e.target.closest("[data-action='complete-quest']");
      if (questBtn) {
        const res = this.progression.completeActiveQuest();
        if (res.ok) {
          this._showProgressionStatus(`✅「${res.completed.title}」を納品し 🪙+${res.completed.rewardCoins} を獲得！`, true);
          this.player.setSpeechBubble(`🎯 納品完了！ +🪙${res.completed.rewardCoins}`);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
        return;
      }

      const townBtn = e.target.closest("[data-action='upgrade-town']");
      if (townBtn) {
        const res = this.progression.upgradeTown();
        if (res.ok) {
          this._showProgressionStatus(`🎉 街が Lv.${res.spec.level}「${res.spec.name}」に発展しました！`, true);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
        return;
      }

      const upgBtn = e.target.closest("[data-upgrade-id]");
      if (upgBtn) {
        const res = this.progression.buyUpgrade(upgBtn.dataset.upgradeId);
        if (res.ok) {
          this._showProgressionStatus(`⚡ ${res.upgrade.name} Lv.${res.tier.level} を習得しました！`, true);
          this.player.setSpeechBubble(`${res.upgrade.icon} ${res.upgrade.name} Lv.${res.tier.level}！`);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
        return;
      }

      const avatarBtn = e.target.closest("[data-avatar-id]");
      if (avatarBtn) {
        const res = this.progression.unlockOrEquipAvatar(avatarBtn.dataset.avatarId);
        if (res.ok) {
          const msg = res.newlyUnlocked
            ? `🐾 ${res.item.name} を解放して着替えました！`
            : `🐾 ${res.item.name} に着替えました！`;
          this._showProgressionStatus(msg, true);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
        return;
      }

      const plantBtn = e.target.closest("[data-plant-crop]");
      if (plantBtn) {
        const cropId = plantBtn.dataset.plantCrop;
        const map = this.mapRenderer.getCurrentMapData();
        const res = this.farmManager.plantCrop(
          this.player,
          cropId,
          null,
          this.progression.townLevel,
          this.canvas.width,
          this.canvas.height,
          map?.width || 12,
          map?.height || 10
        );
        if (res.ok) {
          this._showProgressionStatus(`🌱 農地に「${res.crop.emoji}${res.crop.name}」の種をまきました！（Stage 0/3 → 3で収穫）`, true);
          this.player.setSpeechBubble(`🌱 ${res.crop.emoji}${res.crop.name}を植えた！`);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
        return;
      }

      const harvestBtn = e.target.closest("[data-harvest-plot]");
      if (harvestBtn) {
        const plotId = harvestBtn.dataset.harvestPlot;
        const res = this.farmManager.harvestPlot(plotId, this.player);
        if (res.ok) {
          const bonusStr = res.bonusResource ? ` と ${RESOURCE_EMOJI[res.bonusResource]}×${res.bonusAmount}` : "";
          this._showProgressionStatus(`🌾「${res.crop.emoji}${res.crop.name}」を収穫し 🪙+${res.rewardCoins}${bonusStr} を獲得！`, true);
          this.player.setSpeechBubble(`🌾 ${res.crop.emoji}収穫！ +🪙${res.rewardCoins}`);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
        return;
      }

      const harvestAllBtn = e.target.closest("[data-action='harvest-all']");
      if (harvestAllBtn) {
        const list = this.farmManager.harvestAllRipeForChar(this.player);
        if (list.length > 0) {
          const coins = list.reduce((s, r) => s + r.rewardCoins, 0);
          this._showProgressionStatus(`🌾 ${list.length}区画を一括収穫し 🪙+${coins} を獲得しました！`, true);
          this.player.setSpeechBubble(`🌾 一括収穫！ +🪙${coins}`);
        }
        return;
      }

      const cookBtn = e.target.closest("[data-cook-recipe]");
      if (cookBtn) {
        const recipeId = cookBtn.dataset.cookRecipe;
        const res = this.farmManager.cookRecipe(this.player, recipeId);
        if (res.ok) {
          this._showProgressionStatus(`🍳「${res.recipe.emoji}${res.recipe.name}」を調理・出品し 🪙+${res.rewardCoins} を獲得！`, true);
          this.player.setSpeechBubble(`🍳 ${res.recipe.emoji}${res.recipe.name}完成！ +🪙${res.rewardCoins}`);
        } else {
          this._showProgressionStatus(`❌ ${res.reason}`, false);
        }
      }
    });

    document.getElementById("victory-close")?.addEventListener("click", () => {
      this.progression.victoryModalDismissed = true;
      document.getElementById("victory-panel")?.classList.add("hidden");
      this._scheduleSave();
    });
    document.getElementById("btn-victory-continue")?.addEventListener("click", () => {
      this.progression.victoryModalDismissed = true;
      document.getElementById("victory-panel")?.classList.add("hidden");
      this._scheduleSave();
    });
    document.getElementById("btn-victory-reset")?.addEventListener("click", () => {
      this._skipUnloadSave = true;
      this.saveManager.clear();
      window.location.reload();
    });
  }

  _openVictoryModal(winner, ranked) {
    this._closeAllPanels("victory");
    const el = document.getElementById("victory-content");
    const panel = document.getElementById("victory-panel");
    if (!el || !panel) return;

    const isPlayerWin = winner.id === this.player.id;
    const medals = ["🥇", "🥈", "🥉", "4️⃣"];
    const rows = (ranked || this._getRankedCharacters()).map(({ char, asset, buildings, farms }, i) => {
      const cooked = this.farmManager.getCookedCount(char.id);
      return `<div class="inv-char-card${char.id === winner.id ? " inv-player-card" : ""}">
        <div class="inv-card-top">
          <span class="inv-rank">${medals[i] || `${i + 1}.`}</span>
          <span class="inv-char-name" style="color:${char.color}">${char.emoji} ${char.name}</span>
          <span class="inv-building-tag">🏠${buildings} 🌾${farms} 🍳${cooked}</span>
          <span class="inv-networth">総資産 <b>${asset.total.toFixed(1)}🪙</b></span>
        </div>
      </div>`;
    }).join("");

    el.innerHTML = `
      <div class="victory-hero">
        <div class="victory-winner-name">${isPlayerWin ? "🎉 あなたの優勝！" : `😤 ライバル ${winner.name} が優勝！`}</div>
        <div class="victory-reason">${winner.emoji} ${winner.name} — ${winner.reason}</div>
      </div>
      <div>${rows}</div>
    `;
    panel.classList.remove("hidden");
  }

  _showProgressionStatus(msg, ok) {
    const el = document.getElementById("progression-status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = ok ? "var(--c-successText, #245C1A)" : "var(--c-dangerText, #B71C1C)";
    clearTimeout(this._progStatusTimer);
    this._progStatusTimer = setTimeout(() => { el.textContent = ""; }, 3500);
  }

  _renderCostChips(cost) {
    return Object.entries(cost)
      .map(([t, n]) => {
        const have = this.player.inventory[t] || 0;
        const ok = have >= n;
        return `<span class="cost-chip ${ok ? "cost-ok" : "cost-short"}">${RESOURCE_EMOJI[t]} ${have}/${n}</span>`;
      })
      .join(" ");
  }

  _renderProgressionPanel() {
    const titleEl = document.getElementById("player-title-badge");
    if (titleEl) titleEl.textContent = this.progression.getTitle();

    // 1. 常時表示の納品依頼バナー
    const questEl = document.getElementById("quest-banner");
    const q = this.progression.activeQuest;
    if (questEl && q) {
      const canComplete = inventoryCanAfford(this.player.inventory, q.cost);
      questEl.innerHTML = `
        <div class="quest-info">
          <div class="quest-title">🎯 街の依頼：${q.title} <span class="quest-count">（達成 ${this.progression.completedQuestsCount}回）</span></div>
          <div class="quest-reqs">納品: ${this._renderCostChips(q.cost)} → <span class="quest-reward">報酬 🪙+${q.rewardCoins}</span></div>
        </div>
        <button type="button" class="prog-action-btn${canComplete ? " is-ready" : ""}" data-action="complete-quest" ${canComplete ? "" : "disabled"}>納品する</button>
      `;
    }

    // 2. タブ本体
    const bodyEl = document.getElementById("progression-body");
    if (!bodyEl) return;

    const tab = this.progression._activeTab;
    if (tab === "town") {
      const cur = this.progression.getTownSpec();
      const next = this.progression.getNextTownSpec();
      const pct = Math.round((this.progression.townLevel / TOWN_LEVELS.length) * 100);

      let nextHtml = "";
      if (next) {
        const canUp = inventoryCanAfford(this.player.inventory, next.cost);
        nextHtml = `
          <div class="prog-card prog-next-card">
            <div class="prog-card-head">
              <span class="prog-card-title">${next.icon} 次段階：Lv.${next.level}「${next.name}」</span>
            </div>
            <div class="prog-desc">🗺 見た目変化：${next.visualSummary}</div>
            <div class="prog-effect">✨ 特典：${next.effectSummary}</div>
            <div class="prog-cost-row">必要コスト：${this._renderCostChips(next.cost)}</div>
            <button type="button" class="prog-primary-btn${canUp ? " is-ready" : ""}" data-action="upgrade-town" ${canUp ? "" : "disabled"}>
              ${canUp ? `✨ Lv.${next.level} へ街を発展させる！` : "コイン・資源が不足しています"}
            </button>
          </div>`;
      } else {
        nextHtml = `
          <div class="prog-card prog-complete-card">
            <div class="prog-card-title">🏆 街の発展コンプリート！</div>
            <div class="prog-desc">すべての道路が未来仕様へ進化し、中央広場に時計台が完成しました！</div>
          </div>`;
      }

      bodyEl.innerHTML = `
        <div class="prog-card prog-current-card">
          <div class="prog-card-head">
            <span class="prog-card-title">${cur.icon} 現在：Lv.${cur.level}「${cur.name}」</span>
            <span class="prog-lv-pill">Lv.${cur.level} / ${TOWN_LEVELS.length}</span>
          </div>
          <div class="prog-bar-track"><div class="prog-bar-fill" style="width:${pct}%"></div></div>
          <div class="prog-stats-row">
            <span>定期配当: <b>🪙+${cur.dividendCoins}/60秒</b></span>
            <span>採集量: <b>×${this.progression.getPlayerGatherAmount()}</b></span>
            <span>建物速度: <b>${Math.round(this.progression.getBuildingSpeedMultiplier(this.player.id) * 100)}%</b></span>
          </div>
        </div>
        ${nextHtml}
      `;
      return;
    }

    if (tab === "farming") {
      const myPlots = this.farmManager.getPlotsByOwner(this.player.id);
      const ripeCount = this.farmManager.getRipePlotsByOwner(this.player.id).length;
      const emptyCount = this.farmManager.getEmptyPlots().length;
      const townLv = this.progression.townLevel;

      const myPlotsHtml = myPlots.length > 0
        ? `<div class="farm-my-plots">` + myPlots.map(p => {
            const crop = CROP_CATALOG[p.cropId];
            const isRipe = p.stage >= 3;
            const stageNames = ["種まき (Stage 0/3)", "発芽 (Stage 1/3)", "成長中 (Stage 2/3)", "✨ 収穫可能！ (Stage 3/3)"];
            return `<div class="farm-plot-card${isRipe ? " is-ripe" : ""}">
              <img class="farm-plot-thumb" src="map-assets/assets/progression_layers/crops/${crop.id}_stage_${p.stage}.png" alt="${crop.name}">
              <div class="farm-plot-info">
                <div class="farm-plot-title">${crop.emoji} ${crop.name}</div>
                <div class="farm-plot-stage">${stageNames[p.stage]}</div>
              </div>
              <button type="button" class="prog-action-btn${isRipe ? " is-ready" : ""}" data-harvest-plot="${p.id}" ${isRipe ? "" : "disabled"}>
                ${isRipe ? "収穫" : `${Math.ceil(p.stageTimer)}秒`}
              </button>
            </div>`;
          }).join("") + `</div>`
        : `<div class="prog-desc">現在栽培中の農地はありません。下のカタログから種をまきましょう！（マップ上の自分の畑の近くで <kbd>E</kbd> キーでも収穫できます）</div>`;

      const rivalPlots = this.farmManager.plots.filter(p => p.cropId && p.ownerId !== this.player.id);
      const rivalHtml = rivalPlots.length > 0
        ? rivalPlots.map(p => {
            const c = CROP_CATALOG[p.cropId];
            return `<span class="rival-farm-chip" style="border-color:${p.ownerColor}">${p.ownerName}: ${c.emoji}${c.name} (Stage ${p.stage}/3)</span>`;
          }).join("")
        : `<span>まだライバルの畑はありません（空き農地を先に確保するチャンス！）</span>`;

      const cropsHtml = Object.values(CROP_CATALOG).map(crop => {
        const unlocked = this.farmManager.isCropUnlocked(crop.id, this.player, townLv);
        const check = this.farmManager.canPlant(this.player, crop.id, townLv);
        const bonusStr = crop.bonusResource
          ? ` + ${RESOURCE_EMOJI[crop.bonusResource]}×${crop.bonusAmount}`
          : "";
        const lockLabel = !unlocked
          ? `🔒 街Lv.${crop.minTownLevel}（または🪙${crop.unlockCoinThreshold}）で解放`
          : check.ok
            ? "🌱 種をまく"
            : myPlots.length >= MAX_PLOTS_PER_CHAR
              ? "区画上限(2/2)"
              : emptyCount === 0
                ? "空き農地なし"
                : "資源・コイン不足";

        return `<div class="crop-card${unlocked ? "" : " is-locked"}">
          <div class="crop-card-top">
            <img class="crop-thumb" src="map-assets/assets/progression_layers/crops/${crop.id}_stage_3.png" alt="${crop.name}">
            <div class="crop-title-wrap">
              <div class="crop-name">${crop.emoji} ${crop.name}</div>
              <div class="crop-time">成長: 約${crop.stageTime * 3}秒（3段階）</div>
            </div>
          </div>
          <div class="crop-reward">収穫: 🪙+${crop.rewardCoins}${bonusStr}</div>
          <div class="prog-cost-row">種代: ${this._renderCostChips(crop.cost)}</div>
          <button type="button" class="prog-action-btn${check.ok ? " is-ready" : ""}" data-plant-crop="${crop.id}" ${check.ok ? "" : "disabled"}>
            ${lockLabel}
          </button>
        </div>`;
      }).join("");

      bodyEl.innerHTML = `
        <div class="prog-card prog-current-card">
          <div class="prog-card-head">
            <span class="prog-card-title">🌾 あなたの農地（${myPlots.length}/${MAX_PLOTS_PER_CHAR}区画）</span>
            <span class="prog-lv-pill">マップ空き: ${emptyCount}区画</span>
          </div>
          ${myPlotsHtml}
          ${ripeCount > 1 ? `<button type="button" class="prog-primary-btn is-ready" data-action="harvest-all">🌾 収穫可能な ${ripeCount}区画 を一括収穫する</button>` : ""}
        </div>
        <div class="farm-rival-strip">
          <b>⚔️ ライバルの農地:</b> ${rivalHtml}
        </div>
        <div class="crop-grid">${cropsHtml}</div>
      `;
      return;
    }

    if (tab === "cooking") {
      const pantry = this.farmManager.getPantry(this.player.id);
      const pantryItems = Object.entries(pantry)
        .filter(([, cnt]) => cnt > 0)
        .map(([cid, cnt]) => `<span class="pantry-chip">${CROP_CATALOG[cid]?.emoji || "🌱"}${CROP_CATALOG[cid]?.name || cid}×${cnt}</span>`)
        .join("");

      const recipesHtml = Object.values(COOKING_RECIPES).map(r => {
        const check = this.farmManager.canCook(this.player, r.id);
        const cropChips = Object.entries(r.crops || {}).map(([cid, need]) => {
          const have = pantry[cid] || 0;
          const ok = have >= need;
          const c = CROP_CATALOG[cid];
          return `<span class="cost-chip ${ok ? "cost-ok" : "cost-short"}">${c.emoji}${c.name} ${have}/${need}</span>`;
        }).join(" ");
        const resChips = this._renderCostChips(r.resources || {});

        return `<div class="recipe-card">
          <div class="recipe-title">${r.emoji} ${r.name}</div>
          <div class="recipe-desc">${r.desc}</div>
          <div class="crop-reward">売上報酬: 🪙+${r.rewardCoins}</div>
          <div class="prog-cost-row">食材: ${cropChips} ${resChips}</div>
          <button type="button" class="prog-action-btn${check.ok ? " is-ready" : ""}" data-cook-recipe="${r.id}" ${check.ok ? "" : "disabled"}>
            ${check.ok ? `🍳 調理して出品 (+🪙${r.rewardCoins})` : "食材・資源不足"}
          </button>
        </div>`;
      }).join("");

      bodyEl.innerHTML = `
        <div class="pantry-strip">
          <b>🧺 収穫食材ストック（畑の収穫で+1個貯まります）:</b>
          ${pantryItems || `<span class="inv-char-empty">まだ収穫した作物がありません（🌾農業タブで種まき＆収穫しよう）</span>`}
        </div>
        <div class="recipe-grid">${recipesHtml}</div>
      `;
      return;
    }

    if (tab === "upgrades") {
      bodyEl.innerHTML = Object.values(PLAYER_UPGRADES).map(def => {
        const curLv = this.progression.upgrades[def.id] || 0;
        const maxLv = def.tiers.length;
        const nextTier = def.tiers[curLv];
        if (!nextTier) {
          return `<div class="prog-card prog-maxed-card">
            <div class="prog-card-head">
              <span class="prog-card-title">${def.icon} ${def.name}</span>
              <span class="prog-lv-pill is-max">MAX (Lv.${maxLv})</span>
            </div>
            <div class="prog-effect">効果適用中：${def.tiers[maxLv - 1].effect}</div>
          </div>`;
        }
        const canBuy = inventoryCanAfford(this.player.inventory, nextTier.cost);
        return `<div class="prog-card">
          <div class="prog-card-head">
            <span class="prog-card-title">${def.icon} ${def.name}</span>
            <span class="prog-lv-pill">Lv.${curLv} → Lv.${nextTier.level}</span>
          </div>
          <div class="prog-effect">効果：${nextTier.effect}</div>
          <div class="prog-cost-row">必要：${this._renderCostChips(nextTier.cost)}</div>
          <button type="button" class="prog-action-btn${canBuy ? " is-ready" : ""}" data-upgrade-id="${def.id}" ${canBuy ? "" : "disabled"}>
            ${canBuy ? `Lv.${nextTier.level} に強化する` : "不足"}
          </button>
        </div>`;
      }).join("");
      return;
    }

    // tab === "avatars"
    bodyEl.innerHTML = `<div class="avatar-grid">` + AVATAR_CATALOG.map(a => {
      const unlocked = this.progression.unlockedAvatars.includes(a.id);
      const equipped = this.progression.activeAvatar === a.id;
      const canBuy = unlocked || (this.player.inventory.coin || 0) >= a.costCoins;
      const btnLabel = equipped ? "装備中" : unlocked ? "着替える" : `🪙×${a.costCoins} で解放`;
      return `<div class="avatar-card${equipped ? " is-equipped" : ""}">
        <img class="avatar-thumb" src="${a.folder}/down_1_idle.png" alt="${a.name}">
        <div class="avatar-name">${a.icon} ${a.name}</div>
        <button type="button" class="prog-action-btn${(!equipped && canBuy) ? " is-ready" : ""}" data-avatar-id="${a.id}" ${(equipped || !canBuy) ? "disabled" : ""}>
          ${btnLabel}
        </button>
      </div>`;
    }).join("") + `</div>`;
  }

  _updateTownHudBadge() {
    const badge = document.getElementById("town-badge");
    const progBtn = document.getElementById("btn-progression");
    const spec = this.progression.getTownSpec();
    if (badge) {
      badge.textContent = `${spec.icon} 街Lv.${spec.level}`;
      badge.title = `街の発展：Lv.${spec.level}「${spec.name}」— クリックで発展＆ショップを開く (U)`;
    }
    if (progBtn) {
      const questReady = this.progression.activeQuest &&
        inventoryCanAfford(this.player.inventory, this.progression.activeQuest.cost);
      const nextTown = this.progression.getNextTownSpec();
      const townReady = nextTown && inventoryCanAfford(this.player.inventory, nextTown.cost);
      const ripeReady = this.farmManager.getRipePlotsByOwner(this.player.id).length > 0;
      progBtn.classList.toggle("has-ready-action", Boolean(questReady || townReady || ripeReady));
    }
  }

  _setupTopBar() {
    const ttsBtn = document.getElementById("btn-tts-toggle");
    const syncTtsBtn = () => {
      if (!ttsBtn || typeof ttsManager === "undefined" || !ttsManager) return;
      const on = ttsManager.enabled;
      const blocked = Boolean(on && ttsManager.autoplayBlocked);
      const isHfLocal = ttsManager.localAvailable === true;
      const isHfBrowser = !ttsManager._isLocalHost && ttsManager.browserTtsReady;
      const isHfBrowserLoading = !ttsManager._isLocalHost && ttsManager.browserTtsLoading;
      const modeLabel = isHfLocal
        ? "Hugging Face Style-Bert-VITS2 JP-Extra (あみたろ / jvnv-M1 / jvnv-F2)"
        : isHfBrowser
          ? "Hugging Face ニューラル音声 (piper-plus: つくよみちゃん / CSS10)"
          : isHfBrowserLoading
            ? `Hugging Face ニューラル音声を読込中 (${ttsManager.browserTtsProgress || 0}%)`
            : `自然日本語ブラウザ音声 (${ttsManager.activeVoiceLabel || "Web Speech API"})`;
      ttsBtn.textContent = !on
        ? "🔇 音声OFF"
        : blocked
          ? "🔇 タップで音ON"
          : (isHfLocal || isHfBrowser)
            ? "🔊 HF音声ON"
            : isHfBrowserLoading
              ? `⏳ HF音声 ${ttsManager.browserTtsProgress || 0}%`
              : "🔊 ブラウザ音声";
      ttsBtn.setAttribute("aria-pressed", String(on && !blocked));
      ttsBtn.title = !on
        ? "読み上げOFF — クリックで有効化"
        : blocked
          ? "ブラウザが自動再生を保留中 — ここまたは画面内をクリックすると音声が流れます"
          : `読み上げON（${modeLabel}）— クリックでミュート`;
      ttsBtn.classList.toggle("is-muted", !on);
      ttsBtn.classList.toggle("status-checking", blocked);

      if (blocked && !this._autoplayHintShown) {
        this._autoplayHintShown = true;
        this.chatManager?.addMessage({
          senderId: "system",
          senderName: "音声案内",
          senderColor: "#8A6218",
          recipientId: this.player?.id || "player",
          recipientName: this.player?.name || "Player",
          text: "🔇 ブラウザの自動再生制限で音声が保留中です。画面内または上部の「タップで音ON」をクリックすると再生されます。",
          isAI: false,
        });
      }
    };

    if (ttsBtn && typeof ttsManager !== "undefined" && ttsManager) {
      ttsManager.onStateChange = syncTtsBtn;
      ttsBtn.addEventListener("click", () => {
        ttsManager.unlockAudio(true);
        ttsManager.toggle();
        syncTtsBtn();
        ttsBtn.blur();
      });
      syncTtsBtn();
    }

    document.getElementById("status-pill")?.addEventListener("click", e => {
      e.currentTarget.blur();
      if (this.apiClient.mode === "browser-hf") {
        this._hfBannerDismissed = false;
        this._updateHfLoaderBanner();
      }
      this._refreshHealth();
      if (typeof ttsManager !== "undefined" && ttsManager) {
        ttsManager._checkAvailability();
      }
    });
    document.getElementById("hf-loader-close")?.addEventListener("click", e => {
      e.currentTarget.blur();
      if (typeof ttsManager !== "undefined" && ttsManager) ttsManager.unlockAudio(true);
      this._hfBannerDismissed = true;
      document.getElementById("hf-loader-overlay")?.classList.add("hidden");
    });
    document.getElementById("hf-loader-overlay")?.addEventListener("click", e => {
      if (typeof ttsManager !== "undefined" && ttsManager) ttsManager.unlockAudio(true);
      if (e.target === e.currentTarget) {
        this._hfBannerDismissed = true;
        e.currentTarget.classList.add("hidden");
      }
    });
    document.getElementById("hf-loader-retry")?.addEventListener("click", e => {
      e.currentTarget.blur();
      this._hfBannerDismissed = false;
      this.apiClient._initBrowserWorker();
      this._updateStatusPill();
    });
    document.getElementById("chat-hf-loader")?.addEventListener("click", () => {
      if (this.apiClient.mode !== "browser-hf") return;
      this._hfBannerDismissed = false;
      if (!this.apiClient._workerReady && !this.apiClient._workerLoading) {
        this.apiClient._initBrowserWorker();
      }
      this._updateStatusPill();
    });
    document.getElementById("town-badge")?.addEventListener("click", e => {
      e.currentTarget.blur();
      this._toggleProgressionPanel();
    });

    document.getElementById("btn-reset-save")?.addEventListener("click", e => {
      e.currentTarget.blur();
      if (!window.confirm("セーブデータを削除して最初から始めますか？")) return;
      this._skipUnloadSave = true;
      this.saveManager.clear();
      window.location.reload();
    });

    const mapSelect = document.getElementById("map-select");
    mapSelect?.addEventListener("change", () => {
      const nextId = mapSelect.value;
      mapSelect.blur();
      if (this.mapRenderer.setMap(nextId)) {
        this.resourceManager.init(this.canvas.width, this.canvas.height, nextId);
        this.farmManager.initForMap(nextId, true);
        this.aiChars.forEach(c => {
          c.gatherTarget = null;
          c.atGatherTarget = false;
          c.wanderTarget = null;
          c.clearPath();
        });
        this._rebuildNavigationAndSnap();
        this._scheduleSave();
      }
    });
  }

  _populateMapSelector(maps, currentId) {
    const sel = document.getElementById("map-select");
    if (!sel || !maps.length) return;
    sel.innerHTML = maps
      .map(m => `<option value="${m.id}"${m.id === currentId ? " selected" : ""}>🗺 ${m.name}</option>`)
      .join("");
  }

  async _refreshHealth(silent = false) {
    const pill = document.getElementById("status-pill");
    if (pill && !silent) {
      pill.textContent = "⏳ HF接続確認中...";
      pill.className = "hud-pill status-checking";
    }
    const data = await this.apiClient.checkHealth();
    const hfInfo = data?.hf_api || data?.lm_studio;
    this.aiBrain.llmAvailable = Boolean(hfInfo?.ok);
    if (typeof ttsManager !== "undefined" && ttsManager && data?.tts) {
      ttsManager.localAvailable = Boolean(data.tts.local_available);
      ttsManager._failCount = 0;
      if (ttsManager.onStateChange) ttsManager.onStateChange(ttsManager.enabled, ttsManager.localAvailable);
    }
    this._updateStatusPill(data);
  }

  _updateStatusPill(healthData = null) {
    const pill = document.getElementById("status-pill");
    if (!pill) return;

    if (this.apiClient.mode === "browser-hf") {
      if (this.apiClient._workerReady) {
        const modelShort = (this.apiClient._workerModel || "Qwen2.5").split("/").pop();
        const dev = (this.apiClient._workerDevice || "webgpu").toUpperCase();
        pill.textContent = "🟢 HFブラウザAI";
        pill.title = `サーバー不要モード: ブラウザ内 Hugging Face AI 稼働中 (${this.apiClient._workerModel} / ${dev})`;
        pill.dataset.model = modelShort;
        pill.className = "hud-pill status-online";
      } else if (this.apiClient._workerLoading) {
        const pct = this.apiClient._workerProgress || 0;
        const stage = this.apiClient._workerStage;
        pill.textContent = stage === "initializing"
          ? "⚙️ HF AI起動中..."
          : pct > 0
            ? `⏳ HF AI読込 ${pct}%`
            : "⏳ HF AI準備中...";
        pill.title = "ブラウザ内に Hugging Face AI モデルを読み込んでいます — クリックで進捗バナーを表示";
        pill.className = "hud-pill status-checking";
      } else {
        const err = this.apiClient._workerError ? ` (${this.apiClient._workerError})` : "";
        pill.textContent = "🟡 HF再試行中";
        pill.title = `ブラウザ内 Hugging Face AI の読み込みを再試行できます${err} — クリックで再読込`;
        pill.className = "hud-pill status-offline";
      }
      this._updateHfLoaderBanner();
      return;
    }

    this._updateHfLoaderBanner();

    const online = this.aiBrain.llmAvailable;
    const hfInfo = healthData?.hf_api || healthData?.lm_studio;
    const charSummary = this.aiChars
      .map(c => `${c.name}: ${(c.lastUsedModel || c.model || this.apiClient.model || "").split("/").pop()}`)
      .join(" / ");
    if (online) {
      const modelShort = (this.apiClient.model || "").split("/").pop();
      pill.textContent = "🟢 HF AI接続済";
      pill.title = `Hugging Face AI 接続済み（${charSummary}）— クリックで再確認`;
      if (modelShort) pill.dataset.model = modelShort;
      pill.className = "hud-pill status-online";
    } else {
      const err = hfInfo?.error ? ` (${hfInfo.error})` : "";
      pill.textContent = "🟡 HFオフライン応答";
      pill.title = `Hugging Face AI 未接続のためルールベース応答で動作中${err} — クリックで再接続確認`;
      pill.className = "hud-pill status-offline";
    }
  }

  _updateHfLoaderBanner() {
    const overlay = document.getElementById("hf-loader-overlay");
    const chatStrip = document.getElementById("chat-hf-loader");
    if (!overlay && !chatStrip) return;

    if (this.apiClient.mode !== "browser-hf") {
      overlay?.classList.add("hidden");
      chatStrip?.classList.add("hidden");
      return;
    }

    const titleEl    = document.getElementById("hf-loader-title");
    const pctEl      = document.getElementById("hf-loader-pct");
    const subEl      = document.getElementById("hf-loader-sub");
    const sizeEl     = document.getElementById("hf-loader-size");
    const trackEl    = document.getElementById("hf-progress-track");
    const fillEl     = document.getElementById("hf-progress-fill");
    const retryEl    = document.getElementById("hf-loader-retry");
    const closeBtn   = document.getElementById("hf-loader-close");
    const chatLblEl  = document.getElementById("chat-hf-label");
    const chatPctEl  = document.getElementById("chat-hf-pct");
    const chatFillEl = document.getElementById("chat-hf-fill");

    const formatMB = (bytes) => {
      if (!bytes || bytes <= 0) return "0";
      return bytes >= 1024 * 1024 * 100
        ? String(Math.round(bytes / (1024 * 1024)))
        : (bytes / (1024 * 1024)).toFixed(1);
    };

    const devTag = this.apiClient._workerDevice
      ? this.apiClient._workerDevice.toUpperCase()
      : "";

    if (this.apiClient._workerReady) {
      if (!this._hfBannerCompletedShown) {
        this._hfBannerCompletedShown = true;
        this.chatManager.addMessage({
          senderId: "system",
          senderName: "HF AI",
          senderColor: "#245C1A",
          recipientId: "all",
          recipientName: "全員",
          text: `🤗 Hugging Face AI の読み込みが完了しました！（${devTag || "Browser"}）キャラクターと自然な会話ができます`,
          isAI: false,
        });

        if (chatStrip) {
          chatStrip.className = "is-ready";
          if (chatLblEl) chatLblEl.textContent = "✅ HF AI 準備完了！";
          if (chatPctEl) chatPctEl.textContent = "100%";
          if (chatFillEl) {
            chatFillEl.classList.remove("is-indeterminate");
            chatFillEl.style.width = "100%";
          }
        }
        if (overlay && !this._hfBannerDismissed) {
          overlay.className = "is-ready";
          if (titleEl) titleEl.textContent = "✅ Hugging Face AI 準備完了！";
          if (pctEl) pctEl.textContent = "100%";
          if (subEl) subEl.textContent = "自然なAI会話が有効になりました";
          if (sizeEl) sizeEl.textContent = devTag;
          if (trackEl) trackEl.setAttribute("aria-valuenow", "100");
          if (fillEl) {
            fillEl.classList.remove("is-indeterminate");
            fillEl.style.width = "100%";
          }
          if (closeBtn) closeBtn.textContent = "▶ ゲームを始める";
          retryEl?.classList.add("hidden");
        }
        clearTimeout(this._hfBannerHideTimer);
        this._hfBannerHideTimer = setTimeout(() => {
          overlay?.classList.add("hidden");
          chatStrip?.classList.add("hidden");
        }, 1800);
      }
      return;
    }

    clearTimeout(this._hfBannerHideTimer);

    if (this.apiClient._workerLoading) {
      const pct = Math.max(0, Math.min(99, this.apiClient._workerProgress || 0));
      const stage = this.apiClient._workerStage || "connecting";
      const loaded = this.apiClient._workerLoadedBytes || 0;
      const total = this.apiClient._workerTotalBytes || 0;
      const sizeText = total > 0
        ? `${formatMB(loaded)} / ${formatMB(total)} MB${devTag ? ` · ${devTag}` : ""}`
        : devTag;

      const isInit = stage === "initializing";
      const isDl = !isInit && (stage === "downloading" || pct > 0);
      const pctText = isInit ? "99%" : isDl ? `${pct}%` : "...";

      // 1. チャット欄常設の進捗バー（中央カードを閉じた後も必ず見える）
      if (chatStrip) {
        chatStrip.className = "is-loading";
        if (chatLblEl) {
          chatLblEl.textContent = isInit
            ? "⚙️ HF AI 起動中...（あと少し）"
            : isDl
              ? `🤗 HF AI 読込中${sizeText ? ` (${sizeText})` : ""}`
              : "🤗 HF AI モデル接続中...";
        }
        if (chatPctEl) chatPctEl.textContent = pctText;
        if (chatFillEl) {
          if (isDl) {
            chatFillEl.classList.remove("is-indeterminate");
            chatFillEl.style.width = `${Math.max(2, pct)}%`;
          } else {
            chatFillEl.classList.add("is-indeterminate");
            chatFillEl.style.width = isInit ? "99%" : "";
          }
        }
      }

      // 2. 画面中央のメイン読み込みカード
      if (overlay) {
        if (this._hfBannerDismissed) {
          overlay.classList.add("hidden");
        } else {
          overlay.className = "is-loading";
          retryEl?.classList.add("hidden");
          if (closeBtn) closeBtn.textContent = "▶ 音声を有効にして遊ぶ";
          if (trackEl) trackEl.setAttribute("aria-valuenow", String(pct));
          if (titleEl) {
            titleEl.textContent = isInit
              ? "⚙️ Hugging Face AI を起動中..."
              : isDl
                ? "🤗 Hugging Face AI を読み込み中"
                : "🤗 Hugging Face AI へ接続中...";
          }
          if (pctEl) pctEl.textContent = pctText;
          if (subEl) {
            subEl.textContent = isInit
              ? "あと少しで完了します（このまま遊べます）"
              : "初回のみブラウザへ保存（次回から即起動）";
          }
          if (sizeEl) sizeEl.textContent = sizeText;
          if (fillEl) {
            if (isDl) {
              fillEl.classList.remove("is-indeterminate");
              fillEl.style.width = `${Math.max(2, pct)}%`;
            } else {
              fillEl.classList.add("is-indeterminate");
              fillEl.style.width = isInit ? "99%" : "";
            }
          }
        }
      }
      return;
    }

    // 読み込みエラー状態（チャット欄バー・中央カードの両方から再読込可能）
    if (chatStrip) {
      chatStrip.className = "is-error";
      if (chatLblEl) chatLblEl.textContent = "⚠️ HF AI 読込エラー（クリックで再読込）";
      if (chatPctEl) chatPctEl.textContent = "再試行";
      if (chatFillEl) {
        chatFillEl.classList.remove("is-indeterminate");
        chatFillEl.style.width = "100%";
      }
    }
    if (overlay) {
      if (this._hfBannerDismissed) {
        overlay.classList.add("hidden");
      } else {
        overlay.className = "is-error";
        const errDetail = (this.apiClient._workerError || "").slice(0, 90);
        if (titleEl) titleEl.textContent = "⚠️ Hugging Face AI の読み込みに失敗";
        if (pctEl) pctEl.textContent = "";
        if (subEl) {
          subEl.textContent = errDetail
            ? `原因: ${errDetail}`
            : "オフライン応答でそのまま遊べます（自動再試行中）";
        }
        if (sizeEl) sizeEl.textContent = "オフライン応答でプレイ可";
        if (closeBtn) closeBtn.textContent = "オフライン応答で遊ぶ";
        if (fillEl) {
          fillEl.classList.remove("is-indeterminate");
          fillEl.style.width = "100%";
        }
        retryEl?.classList.remove("hidden");
      }
    }
  }

  _setupChatUI() {
    const input = document.getElementById("chat-input");
    const sendBtn = document.getElementById("send-btn");
    const hintEl = document.getElementById("proximity-hint");

    document.getElementById("btn-inventory")?.addEventListener("click", () => this._toggleInventoryPanel());
    document.getElementById("btn-orderbook")?.addEventListener("click", () => this._toggleOrderBook());
    document.getElementById("inventory-close")?.addEventListener("click", () => {
      document.getElementById("inventory-panel")?.classList.add("hidden");
    });
    document.getElementById("build-close")?.addEventListener("click", () => {
      this.buildingManager.closeMenu();
    });

    sendBtn?.addEventListener("click", () => this._sendPlayerMessage());
    input?.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        this._sendPlayerMessage();
      }
    });

    hintEl?.addEventListener("click", e => {
      const chip = e.target.closest("[data-name]");
      if (!chip) return;
      const name = chip.dataset.name;
      const body = input.value.replace(/^[@＠]\w+\s*/, "");
      input.value = `@${name} ${body}`;
      input.focus();
    });
  }

  _sendPlayerMessage() {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;

    const mentionName = this.chatManager.parseMention(text);
    if (!mentionName) {
      this._flashInput("@名前 メッセージ の形式で入力（上のキャラ名をクリック可）");
      return;
    }

    const target = this.chatManager.resolveCharacter(mentionName, this.aiChars);
    if (!target) {
      this._flashInput(`@${mentionName} というキャラクターはいません`);
      return;
    }

    this.chatManager.addMessage({
      senderId: this.player.id,
      senderName: this.player.name,
      senderColor: C.player,
      recipientId: target.id,
      recipientName: target.name,
      text,
      isAI: false,
    });

    this.player.setSpeechBubble(text);
    input.value = "";

    this.aiBrain.handlePlayerMessage(text, target, this.player);
  }

  _isInventoryOpen() {
    const panel = document.getElementById("inventory-panel");
    return Boolean(panel && !panel.classList.contains("hidden"));
  }

  _toggleInventoryPanel() {
    const panel = document.getElementById("inventory-panel");
    if (!panel) return;
    if (!panel.classList.contains("hidden")) {
      panel.classList.add("hidden");
      return;
    }
    this._closeAllPanels("inventory");
    this._renderInventoryPanel();
    panel.classList.remove("hidden");
  }

  _getRankedCharacters() {
    return this.characters
      .map(char => {
        const buildings = this.buildingManager.getBuildingsByOwner(char.id).length;
        const farms = this.farmManager.getPlotsByOwner(char.id).length;
        const farmValue = this.farmManager.getFarmAssetValue(char.id);
        const asset = computeAssetValue(char.inventory, this.orderBook.priceHistory, {
          farmValue,
          buildingCount: buildings,
        });
        return { char, asset, buildings, farms };
      })
      .sort((a, b) => b.asset.total - a.asset.total);
  }

  _renderInventoryPanel() {
    const content = document.getElementById("inventory-content");
    if (!content) return;

    const ranked = this._getRankedCharacters();
    const topTotal = ranked[0]?.asset.total || 0;
    const leaderName = ranked[0]?.char.name || "Player";
    const pct = Math.min(100, Math.round((topTotal / VICTORY_TARGET_ASSETS) * 100));
    const medals = ["🥇", "🥈", "🥉", "4️⃣"];

    const winnerBanner = this.progression.seasonWinner
      ? `<div class="victory-target-banner">
          <div class="victory-target-top">
            <span>🏆 シーズン王者: ${this.progression.seasonWinner.emoji} ${this.progression.seasonWinner.name}</span>
            <span>${this.progression.seasonWinner.reason}</span>
          </div>
        </div>`
      : `<div class="victory-target-banner">
          <div class="victory-target-top">
            <span>🏆 優勝条件: 総資産 ${VICTORY_TARGET_ASSETS}🪙 または 街Lv.5 に最初到達</span>
            <span>現在トップ: ${leaderName} (${topTotal.toFixed(1)}/${VICTORY_TARGET_ASSETS}🪙)</span>
          </div>
          <div class="prog-bar-track"><div class="prog-bar-fill" style="width:${pct}%"></div></div>
        </div>`;

    content.innerHTML = winnerBanner + ranked.map(({ char, asset, buildings, farms }, idx) => {
      const items = Object.entries(char.inventory)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `<span class="inv-chip">${RESOURCE_EMOJI[k]} ${RESOURCE_LABEL[k]}×${v}</span>`)
        .join("");
      const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(char.color || "") ? char.color : "#555";
      const buildingTag = buildings > 0 ? `<span class="inv-building-tag">🏠 ${buildings}棟</span>` : "";
      const farmTag = farms > 0 ? `<span class="inv-building-tag">🌾 ${farms}区画</span>` : "";
      const hfModelShort = !char.isPlayer && (char.lastUsedModel || char.model)
        ? (char.lastUsedModel || char.model).split("/").pop()
        : "";
      const hfVoiceShort = !char.isPlayer && char.ttsConfig?.ttsModel
        ? char.ttsConfig.ttsModel
        : "";
      const hfTag = hfModelShort
        ? `<span class="inv-building-tag" title="Hugging Face LLM: ${char.lastUsedModel || char.model} / 音声: ${char.ttsConfig?.hfRepo || "litagin/style_bert_vits2_jvnv"} (${hfVoiceShort})">🤗 ${hfModelShort}${hfVoiceShort ? ` 🔊${hfVoiceShort}` : ""}</span>`
        : "";
      const gap = topTotal - asset.total;
      const gapBadge = idx === 0
        ? `<span class="inv-gap-badge is-leader">👑 トップ</span>`
        : `<span class="inv-gap-badge">1位差 -${gap.toFixed(1)}🪙</span>`;

      return `<div class="inv-char-card${char.isPlayer ? " inv-player-card" : ""}">
        <div class="inv-card-top">
          <span class="inv-rank">${medals[idx] || `${idx + 1}.`}</span>
          <span class="inv-char-name" style="color:${safeColor}">${char.emoji} ${char.name}</span>
          ${hfTag}
          ${buildingTag}
          ${farmTag}
          ${gapBadge}
          <span class="inv-networth" title="コイン＋資源評価＋建物＋農地評価">総資産 <b>${asset.total.toFixed(1)}🪙</b></span>
        </div>
        <div class="inv-card-items ${items ? "" : "inv-char-empty"}">${items || "（所持品なし）"}</div>
      </div>`;
    }).join("");
  }

  _flashInput(msg) {
    const input = document.getElementById("chat-input");
    if (!input) return;
    input.placeholder = msg;
    input.style.borderColor = "#B71C1C";
    setTimeout(() => {
      input.placeholder = "@名前 メッセージ...";
      input.style.borderColor = "";
    }, 2800);
  }

  _updatePlayerMovement(dt) {
    let vx = 0;
    let vy = 0;
    if (this.keysHeld.has("w") || this.keysHeld.has("arrowup")) vy -= 1;
    if (this.keysHeld.has("s") || this.keysHeld.has("arrowdown")) vy += 1;
    if (this.keysHeld.has("a") || this.keysHeld.has("arrowleft")) vx -= 1;
    if (this.keysHeld.has("d") || this.keysHeld.has("arrowright")) vx += 1;

    if (vx !== 0 && vy !== 0) {
      const inv = 1 / Math.sqrt(2);
      vx *= inv;
      vy *= inv;
    }

    const speed = GAME_CONFIG.playerSpeed * this.progression.getPlayerSpeedMultiplier();
    const dx = vx * speed * dt;
    const dy = vy * speed * dt;

    if (this.navGrid.isReady()) {
      const moved = this.navGrid.resolveMovement(this.player.x, this.player.y, dx, dy, 10, 20, 12);
      this.player.x = moved.x;
      this.player.y = moved.y;
    } else {
      const margin = 20;
      this.player.x = Math.max(margin, Math.min(this.canvas.width - margin, this.player.x + dx));
      this.player.y = Math.max(margin, Math.min(this.canvas.height - margin, this.player.y + dy));
    }
    this.player.updateAnimation(vx * speed, vy * speed, dt);
  }

  _updateProximityHint() {
    const hintEl = document.getElementById("proximity-hint");
    const input = document.getElementById("chat-input");
    if (!hintEl || !input) return;

    const radius = GAME_CONFIG.proximityRadius;
    const nearbySet = new Set();
    let closest = null;
    let closestDist = Infinity;

    for (const c of this.aiChars) {
      const d = Math.hypot(c.x - this.player.x, c.y - this.player.y);
      if (d < radius) {
        nearbySet.add(c.id);
        if (d < closestDist) {
          closestDist = d;
          closest = c;
        }
      }
    }

    const stateKey = [...nearbySet].sort().join(",");
    if (stateKey !== this._lastNearbyIdsKey || !hintEl.childElementCount) {
      this._lastNearbyIdsKey = stateKey;
      const chips = this.aiChars.map(c => {
        const isNear = nearbySet.has(c.id);
        const hfModel = c.lastUsedModel || c.model || GAME_CONFIG.model;
        const hfVoice = c.ttsConfig?.ttsModel || "jvnv-F1-jp";
        return `<button type="button" class="mention-chip${isNear ? " is-nearby" : ""}" data-name="${c.name}" style="--chip-color:${c.color}" title="@${c.name} へ話しかける（HF AI: ${hfModel} / 音声: ${hfVoice}）">
          ${isNear ? '<span class="near-dot" aria-hidden="true"></span>' : ""}${c.emoji} @${c.name}
        </button>`;
      }).join("");
      hintEl.innerHTML = `<span class="mention-prefix">話しかける:</span>${chips}`;
    }

    if (closest && !input.value && input !== document.activeElement) {
      input.placeholder = `@${closest.name} メッセージ...`;
    } else if (!closest && !input.value && input !== document.activeElement) {
      input.placeholder = "@名前 メッセージ...";
    }
  }

  _getEffectiveGatherRadius() {
    return GAME_CONFIG.gatherRadius + this.progression.getPlayerGatherRadiusBonus();
  }

  _updateGatherButtonState() {
    const btn = document.getElementById("btn-gather");
    if (!btn) return;
    const radius = this._getEffectiveGatherRadius();
    const nearbyNodes = this.resourceManager.getNearby(this.player.x, this.player.y, radius);
    const map = this.mapRenderer.getCurrentMapData();
    const nearbyRipePlot = this.farmManager.getNearbyRipePlot(
      this.player.x,
      this.player.y,
      radius,
      this.player.id,
      this.canvas.width,
      this.canvas.height,
      map?.width || 12,
      map?.height || 10
    );
    const canGather = nearbyNodes.length > 0 || Boolean(nearbyRipePlot);
    if (canGather !== this._lastGatherReady) {
      this._lastGatherReady = canGather;
      btn.classList.toggle("can-gather", canGather);
    }
  }

  start() {
    this.running = true;
    requestAnimationFrame(ts => this._loop(ts));
  }

  _loop(timestamp) {
    if (!this.running) return;

    if (this.lastTime === null) this.lastTime = timestamp;
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    this._update(dt);
    this._render();

    requestAnimationFrame(ts => this._loop(ts));
  }

  _update(dt) {
    if (!this.mapRenderer._ready) return;
    this._updatePlayerMovement(dt);
    this._updatePlayerGather(dt);

    const w = this.canvas.width;
    const h = this.canvas.height;
    this.aiChars.forEach(c => c.updateWander(dt, w, h, this.navGrid));
    this.characters.forEach(c => c.updateSpeechBubble(dt));

    this.resourceManager.update(dt, this.progression.getRespawnSpeedMultiplier());
    this.progression.update(dt);

    const ripeEvents = this.farmManager.update(
      dt,
      ownerId => this.progression.getFarmSpeedMultiplier(ownerId)
    );
    ripeEvents.forEach(({ plot, crop }) => {
      if (plot.ownerId === this.player.id && crop) {
        this.chatManager.addMessage({
          senderId: "system",
          senderName: "農地",
          senderColor: "#245C1A",
          recipientId: this.player.id,
          recipientName: this.player.name,
          text: `🌾 あなたの畑の「${crop.emoji}${crop.name}」が収穫可能になりました！（畑で E キーまたは街発展パネルから収穫）`,
          isAI: false,
        });
        this._updateTownHudBadge();
      }
    });

    const buildEvents = this.buildingManager.update(
      dt,
      this.characters,
      ownerId => this.progression.getBuildingSpeedMultiplier(ownerId)
    );
    buildEvents.forEach(({ building, type, recipient }) => {
      this.chatManager.addMessage({
        senderId: "system",
        senderName: building.name,
        senderColor: "#8A6218",
        recipientId: recipient.id,
        recipientName: recipient.name,
        text: `${building.emoji} ${RESOURCE_EMOJI[type]}×1 を ${recipient.name} に生産`,
        isAI: false,
      });
    });

    this.aiBrain.update(dt);
    this._updateProximityHint();
    this._updateGatherButtonState();

    // 開いているパネルの定期同期
    if (this._isInventoryOpen() || this.progression.isOpen) {
      this._inventoryRefreshTimer += dt;
      if (this._inventoryRefreshTimer >= 1.0) {
        this._inventoryRefreshTimer = 0;
        if (this._isInventoryOpen()) this._renderInventoryPanel();
        if (this.progression.isOpen && this.progression._activeTab === "farming") {
          this._renderProgressionPanel();
        }
      }
    }

    // 15秒ごとの定期オートセーブ
    this._autoSaveTimer += dt;
    if (this._autoSaveTimer >= 15.0) {
      this._autoSaveTimer = 0;
      this._scheduleSave();
    }
  }

  _updatePlayerGather(dt) {
    if (this.gatherCooldown > 0) this.gatherCooldown -= dt;
    if (!this.keysHeld.has("e") || this.gatherCooldown > 0) return;
    this._triggerGather(false);
  }

  _triggerGather(showHintIfNone = false) {
    if (this.gatherCooldown > 0) return;
    const radius = this._getEffectiveGatherRadius();
    const map = this.mapRenderer.getCurrentMapData();

    // 1. 近くに自分の収穫可能な畑があれば収穫
    const ripePlot = this.farmManager.getNearbyRipePlot(
      this.player.x,
      this.player.y,
      radius,
      this.player.id,
      this.canvas.width,
      this.canvas.height,
      map?.width || 12,
      map?.height || 10
    );
    if (ripePlot) {
      const res = this.farmManager.harvestPlot(ripePlot.id, this.player);
      if (res.ok) {
        const bonusStr = res.bonusResource ? ` +${RESOURCE_EMOJI[res.bonusResource]}${res.bonusAmount}` : "";
        this.player.setSpeechBubble(`🌾 ${res.crop.emoji}${res.crop.name}収穫！ +🪙${res.rewardCoins}${bonusStr}`);
        this.gatherCooldown = GAME_CONFIG.gatherCooldown * this.progression.getPlayerGatherCooldownMultiplier();
        this._updateTownHudBadge();
        this._scheduleSave();
        return;
      }
    }

    // 2. 近くの資源ノードから採集
    const nearby = this.resourceManager.getNearby(this.player.x, this.player.y, radius);
    if (nearby.length === 0) {
      if (showHintIfNone) {
        this.player.setSpeechBubble("近くに資源・収穫可能な畑がありません");
      }
      return;
    }
    const node = nearby[0];
    const wantAmt = this.progression.getPlayerGatherAmount();
    const got = node.gather(wantAmt);
    if (got > 0) {
      inventoryAdd(this.player.inventory, node.type, got);
      this.player.setSpeechBubble(`${RESOURCE_EMOJI[node.type]} ${RESOURCE_LABEL[node.type]} +${got}`);
      this.gatherCooldown = GAME_CONFIG.gatherCooldown * this.progression.getPlayerGatherCooldownMultiplier();
      if (this._isInventoryOpen()) this._renderInventoryPanel();
      if (this.buildingManager.isMenuOpen) this.buildingManager.refreshPanel();
      if (this.progression.isOpen) this._renderProgressionPanel();
      if (this.orderBook.isOpen) this.orderBook.refresh();
      this._updateTownHudBadge();
      this._scheduleSave();
    }
  }

  _renderLoadingScreen(ctx, w, h) {
    const cx = w / 2;
    const cy = h / 2;

    ctx.fillStyle = "#FDF8F0";
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(74, 92, 46, 0.08)";
    ctx.lineWidth = 1;
    const GRID = 48;
    for (let x = 0; x < w; x += GRID) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += GRID) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const t = performance.now() / 1000;
    const R = 28;
    const SPOKES = 8;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (let i = 0; i < SPOKES; i++) {
      const angle = (i / SPOKES) * Math.PI * 2 + t * 2.5;
      const alpha = (i + 1) / SPOKES;
      ctx.beginPath();
      ctx.arc(cx, cy - 48, R, angle, angle + (Math.PI * 2 / SPOKES) * 0.7);
      ctx.strokeStyle = `rgba(74, 92, 46, ${alpha})`;
      ctx.stroke();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 22px 'Georgia', 'Yu Mincho', serif";
    ctx.fillStyle = "#4A5C2E";
    ctx.fillText("Bot対話ゲーム", cx, cy + 4);

    ctx.font = "13px 'Segoe UI', 'Meiryo', sans-serif";
    ctx.fillStyle = "rgba(74, 92, 46, 0.85)";
    ctx.fillText("マップを読み込み中...", cx, cy + 32);

    const dotCount = Math.floor(t * 2) % 4;
    const dots = "●".repeat(dotCount) + "○".repeat(3 - dotCount);
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.fillStyle = "rgba(74, 92, 46, 0.55)";
    ctx.fillText(dots, cx, cy + 52);
  }

  _render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!this.mapRenderer._ready) {
      this._renderLoadingScreen(ctx, w, h);
      return;
    }

    const effRadius = this._getEffectiveGatherRadius();
    this.mapRenderer.draw(ctx, w, h, this.farmManager, this.player, effRadius);
    this.resourceManager.draw(ctx, this.player, effRadius);
    this.buildingManager.draw(ctx, this.mousePos);

    // Y座標順（奥→手前）で自然な重なり描画
    const sortedChars = [...this.characters].sort((a, b) => a.y - b.y);
    sortedChars.forEach(c => c.draw(ctx, w));

    const ranked = this._getRankedCharacters();
    this.progression.checkSeasonVictory(ranked);
    const myRankIdx = ranked.findIndex(r => r.char.id === this.player.id);
    const rankInfo = myRankIdx >= 0
      ? { rank: myRankIdx + 1, total: ranked[myRankIdx].asset.total }
      : null;
    drawInventoryHUD(ctx, this.player.inventory, w, this.orderBook.priceHistory, rankInfo);

    if (this.buildingManager.pendingType) {
      const r = BUILDING_RECIPES[this.buildingManager.pendingType];
      ctx.save();
      ctx.fillStyle = "rgba(20, 15, 8, 0.78)";
      ctx.fillRect(0, 0, w, 40);
      ctx.fillStyle = "#FFD700";
      ctx.font = "bold 13px 'Segoe UI', 'Meiryo', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        `${r.emoji} ${r.name} を設置 — マップをクリック  |  Esc または B で取消`,
        w / 2, 20
      );
      ctx.restore();
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const game = new Game();
  game.start();
});
