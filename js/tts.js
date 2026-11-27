const TTS_STORAGE_KEY = "botGame.ttsEnabled";

class TTSManager {
  constructor() {
    this.enabled = this._loadSavedEnabled();
    this.localAvailable = null;
    this.provider = "huggingface";
    this.repo = "litagin/sbv2_amitaro";
    this._isLocalHost = TTSManager._detectLocalHost();
    this._failCount = 0;
    this._queue = [];
    this._playing = false;
    this._activeItem = null;
    this._currentAudio = null;
    this._currentSource = null;
    this._audioCtx = null;
    this.audioUnlocked = false;
    this.autoplayBlocked = false;
    this._blockedReplay = null;
    this._unblockedAtMs = 0;
    this._activeTimers = new Set();
    this._voices = [];
    this._voicesLoaded = false;
    this._voiceWaiters = [];
    this.activeVoiceLabel = "HFニューラル音声";
    this.onStateChange = null;

    // サーバー不要（GitHub Pages 等）用のブラウザ内蔵 Hugging Face VITS2 TTS Worker
    this._ttsWorker = null;
    this.browserTtsReady = false;
    this.browserTtsLoading = false;
    this.browserTtsProgress = 0;
    this.browserTtsError = "";
    this._ttsPending = new Map();
    this._ttsReqSeq = 0;
    this._wavCache = new Map();

    if (typeof window !== "undefined") {
      this._installAudioUnlockHooks();
      this._initBrowserVoices();
      if (typeof fetch !== "undefined") {
        this._checkAvailability();
      }
      if (!this._isLocalHost) {
        this._initBrowserTtsWorker();
      }
    }
  }

  _getAudioContext() {
    if (this._audioCtx) return this._audioCtx;
    if (typeof window === "undefined") return null;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      this._audioCtx = new AudioCtx();
      return this._audioCtx;
    } catch (_) {
      return null;
    }
  }

  unlockAudio(replayIfBlocked = true) {
    if (typeof window === "undefined") return false;
    const ctx = this._getAudioContext();
    if (!ctx) return false;

    const onUnlocked = () => {
      this.audioUnlocked = true;
      const wasBlocked = this.autoplayBlocked;
      this.autoplayBlocked = false;
      if (wasBlocked) {
        this._unblockedAtMs = Date.now();
      }
      try {
        // iOS / Safari / Chrome 向けに無音1サンプルを流して出力パイプを開く
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      } catch (_) {}
      if (wasBlocked && this.onStateChange) {
        this.onStateChange(this.enabled, this.localAvailable);
      }
      if (replayIfBlocked && wasBlocked && this._blockedReplay && this.enabled && !this._playing && this._queue.length === 0) {
        const replay = this._blockedReplay;
        this._blockedReplay = null;
        this.speak(replay.text, replay.characterName);
      }
    };

    try {
      if (ctx.state === "running") {
        onUnlocked();
        return true;
      }
      const p = ctx.resume();
      if (p && typeof p.then === "function") {
        p.then(() => {
          if (ctx.state === "running") onUnlocked();
        }).catch(() => {});
      }
    } catch (_) {}
    return ctx.state === "running";
  }

  _installAudioUnlockHooks() {
    if (typeof window === "undefined") return;
    const handleGesture = () => {
      const unlocked = this.unlockAudio(true);
      if (unlocked && !this.autoplayBlocked) {
        window.removeEventListener("pointerdown", handleGesture, true);
        window.removeEventListener("touchstart", handleGesture, true);
        window.removeEventListener("click", handleGesture, true);
        window.removeEventListener("keydown", handleGesture, true);
      }
    };
    window.addEventListener("pointerdown", handleGesture, { capture: true, passive: true });
    window.addEventListener("touchstart", handleGesture, { capture: true, passive: true });
    window.addEventListener("click", handleGesture, { capture: true, passive: true });
    window.addEventListener("keydown", handleGesture, { capture: true, passive: true });
  }

  _initBrowserTtsWorker() {
    if (this.browserTtsReady || this.browserTtsLoading || typeof Worker === "undefined") return;
    if (this._ttsWorker) {
      this.browserTtsLoading = true;
      this.browserTtsError = "";
      this._ttsWorker.postMessage({ type: "preload" });
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      return;
    }
    try {
      this._ttsWorker = new Worker("js/hf-tts-worker.js?v=gh18", { type: "module" });
      this.browserTtsLoading = true;
      this.browserTtsError = "";
      this._ttsWorker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === "progress") {
          if (!this.browserTtsReady) {
            this.browserTtsProgress = msg.percent || this.browserTtsProgress;
            if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
          }
        } else if (msg.type === "ready") {
          this.browserTtsReady = true;
          this.browserTtsLoading = false;
          this.browserTtsProgress = 100;
          this.browserTtsError = "";
          if (msg.label) this.activeVoiceLabel = msg.label;
          if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
        } else if (msg.type === "error") {
          this.browserTtsLoading = false;
          this.browserTtsError = msg.message || "Browser TTS load failed";
          console.warn("[TTS] Browser Hugging Face VITS2 load failed:", this.browserTtsError);
          if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
        } else if (msg.type === "audio") {
          const resolver = this._ttsPending.get(msg.requestId);
          if (resolver) {
            this._ttsPending.delete(msg.requestId);
            if (msg.error) resolver.reject(new Error(msg.error));
            else resolver.resolve(msg);
          }
        }
      };
      this._ttsWorker.onerror = (err) => {
        this.browserTtsLoading = false;
        this.browserTtsError = err?.message || "TTS Worker error";
        try { this._ttsWorker?.terminate(); } catch (_) {}
        this._ttsWorker = null;
        for (const [, r] of this._ttsPending) {
          r.reject(new Error(this.browserTtsError));
        }
        this._ttsPending.clear();
        if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      };
      this._ttsWorker.postMessage({ type: "preload" });
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
    } catch (err) {
      this.browserTtsLoading = false;
      this.browserTtsError = err?.message || "TTS Worker unavailable";
    }
  }

  _synthesizeInBrowserWorker(cleanText, characterName, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      if (!this._ttsWorker) this._initBrowserTtsWorker();
      if (!this._ttsWorker) {
        reject(new Error("Browser TTS Worker unavailable"));
        return;
      }
      const requestId = ++this._ttsReqSeq;
      const timer = setTimeout(() => {
        this._ttsPending.delete(requestId);
        reject(new Error("Browser TTS synthesis timeout"));
      }, timeoutMs);
      this._ttsPending.set(requestId, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this._ttsWorker.postMessage({
        type: "synthesize",
        requestId,
        text: cleanText,
        characterName,
      });
    });
  }

  _cacheWav(key, wavBuffer) {
    if (!wavBuffer || wavBuffer.byteLength === 0) return;
    if (this._wavCache.size >= 64) {
      const oldestKey = this._wavCache.keys().next().value;
      this._wavCache.delete(oldestKey);
    }
    this._wavCache.set(key, wavBuffer.slice(0));
  }

  async _createAudioFromWavBuffer(wavBuffer, item, estDuration, playbackRate = 1.0) {
    const ctx = this._getAudioContext();
    if (ctx && wavBuffer && wavBuffer.byteLength > 44 && typeof ctx.decodeAudioData === "function") {
      try {
        const audioBuffer = await ctx.decodeAudioData(wavBuffer.slice(0));
        const rawDur = (audioBuffer && isFinite(audioBuffer.duration) && audioBuffer.duration > 0.05)
          ? audioBuffer.duration
          : estDuration;
        const realDur = playbackRate > 0 ? rawDur / playbackRate : rawDur;
        return {
          kind: "webaudio",
          audioBuffer,
          wavBuffer,
          playbackRate,
          durationSec: realDur,
        };
      } catch (_) {
        // decodeAudioData 失敗時は HTMLAudioElement へフォールバック
      }
    }
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    return await this._createAudioFromBlob(blob, item, estDuration, playbackRate);
  }

  async _createAudioFromBlob(blob, item, estDuration, playbackRate = 1.0) {
    const url = URL.createObjectURL(blob);
    item._blobUrl = url;
    const audio = new Audio(url);
    audio.preload = "auto";
    if (playbackRate && playbackRate !== 1.0) {
      audio.playbackRate = playbackRate;
    }

    await new Promise((resolve) => {
      if (audio.readyState >= 2) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(metaTimer);
        resolve();
      };
      const metaTimer = setTimeout(finish, 1500);
      audio.addEventListener("canplay", finish, { once: true });
      audio.addEventListener("loadedmetadata", finish, { once: true });
      audio.addEventListener("error", finish, { once: true });
      try { audio.load(); } catch (_) { finish(); }
    });

    const rawDur = (isFinite(audio.duration) && audio.duration > 0.1)
      ? audio.duration
      : estDuration;
    const realDur = playbackRate > 0 ? rawDur / playbackRate : rawDur;
    return { kind: "audio", audio, url, durationSec: realDur };
  }

  static _detectLocalHost() {
    if (typeof window === "undefined" || !window.location) return false;
    const h = window.location.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  }

  static estimateDurationSec(text) {
    const clean = TTSManager.sanitizeForSpeech(text);
    // 日本語おおよそ 5.5 文字/秒 + 息継ぎ余裕
    return Math.max(1.8, Math.min(12.0, clean.length / 5.5 + 0.6));
  }

  _setTimer(fn, ms) {
    const id = setTimeout(() => {
      this._activeTimers.delete(id);
      fn();
    }, ms);
    this._activeTimers.add(id);
    return id;
  }

  _clearTimer(id) {
    if (id == null) return;
    clearTimeout(id);
    this._activeTimers.delete(id);
  }

  _clearAllTimers() {
    for (const id of this._activeTimers) {
      clearTimeout(id);
    }
    this._activeTimers.clear();
  }

  _initBrowserVoices() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const refresh = () => {
      try {
        const list = window.speechSynthesis.getVoices() || [];
        this._voices = list;
        if (list.length > 0) {
          this._voicesLoaded = true;
          const best = this._selectNaturalJapaneseVoice("female");
          if (best) this.activeVoiceLabel = best.name;
          while (this._voiceWaiters.length > 0) {
            const resolve = this._voiceWaiters.shift();
            resolve();
          }
        }
      } catch (_) {}
    };
    refresh();
    if (typeof window.speechSynthesis.addEventListener === "function") {
      window.speechSynthesis.addEventListener("voiceschanged", refresh);
    } else {
      window.speechSynthesis.onvoiceschanged = refresh;
    }
  }

  _waitForVoicesReady(timeoutMs = 700) {
    if (this._voicesLoaded || typeof window === "undefined" || !window.speechSynthesis) {
      return Promise.resolve();
    }
    try {
      const list = window.speechSynthesis.getVoices() || [];
      if (list.length > 0) {
        this._voices = list;
        this._voicesLoaded = true;
        return Promise.resolve();
      }
    } catch (_) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._clearTimer(timer);
        resolve();
      };
      const timer = this._setTimer(finish, timeoutMs);
      this._voiceWaiters.push(finish);
    });
  }

  _selectNaturalJapaneseVoice(gender = "female") {
    const jpVoices = (this._voices || []).filter(v => /ja|jpn/i.test(v.lang || ""));
    if (!jpVoices.length) return null;

    const femalePrefs = [
      /nanami.*natural/i,
      /nanami/i,
      /google\s*日本語/i,
      /kyoko/i,
      /sayaka/i,
      /ayumi/i,
      /haruka/i,
    ];
    const malePrefs = [
      /keita.*natural/i,
      /keita/i,
      /otoya/i,
      /ichiro/i,
      /google\s*日本語/i,
      /nanami/i,
    ];
    const prefs = gender === "male" ? malePrefs : femalePrefs;
    for (const re of prefs) {
      const hit = jpVoices.find(v => re.test(v.name || ""));
      if (hit) return hit;
    }
    return jpVoices[0];
  }

  _loadSavedEnabled() {
    // 過去の誤クリック等で localStorage に残った "false" で毎回ミュート起動しないよう、
    // 起動時のデフォルトは常に音声ON（GAME_CONFIG.ttsEnabled）とし、古い保存値を除去する
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(TTS_STORAGE_KEY);
      }
    } catch (_) {}
    return typeof GAME_CONFIG !== "undefined" ? Boolean(GAME_CONFIG.ttsEnabled) : true;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled) {
      this.unlockAudio(false);
    }
    if (!this.enabled) {
      this.stop();
    }
    if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
  }

  toggle() {
    // 自動再生がブロックされている状態（および直前600ms以内のポインター解放直後）のクリックはミュートせずONを維持
    if (this.enabled && (this.autoplayBlocked || (Date.now() - this._unblockedAtMs) < 600)) {
      this.unlockAudio(true);
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      return this.enabled;
    }
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  _finalizeItem(item, mode = "cancelled") {
    if (!item) return;
    item.cancelled = true;
    if (item._thinkTimer) {
      this._clearTimer(item._thinkTimer);
      item._thinkTimer = null;
    }
    if (item._thinkResolve) {
      const resolveThink = item._thinkResolve;
      item._thinkResolve = null;
      try { resolveThink(); } catch (_) {}
    }
    if (!item.started) {
      item.started = true;
      try { item.onStart?.({ durationSec: 0, mode }); } catch (_) {}
    }
    if (!item.ended) {
      item.ended = true;
      try { item.onEnd?.({ mode }); } catch (_) {}
    }
    if (item._blobUrl) {
      try { URL.revokeObjectURL(item._blobUrl); } catch (_) {}
      item._blobUrl = null;
    }
  }

  stop() {
    const pending = [...this._queue];
    this._queue = [];
    const active = this._activeItem;
    this._activeItem = null;
    this._playing = false;
    this._blockedReplay = null;
    this._clearAllTimers();

    if (this._currentSource) {
      try {
        this._currentSource.onended = null;
        this._currentSource.stop();
        this._currentSource.disconnect();
      } catch (_) {}
      this._currentSource = null;
    }
    if (this._currentAudio) {
      try {
        this._currentAudio.onended = null;
        this._currentAudio.onerror = null;
        this._currentAudio.onplaying = null;
        this._currentAudio.pause();
        this._currentAudio.src = "";
      } catch (_) {}
      this._currentAudio = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }

    if (active) this._finalizeItem(active, "cancelled");
    for (const item of pending) {
      this._finalizeItem(item, "cancelled");
    }
  }

  async _checkAvailability() {
    // GitHub Pages 等の静的ホスティングでは /tts-check へ無駄な 404 リクエストを出さない
    if (!this._isLocalHost) {
      this.localAvailable = false;
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      return;
    }

    try {
      const resp = await fetch("/tts-check");
      const data = await resp.json();
      this.localAvailable = Boolean(data.ok);
      if (data.repo) this.repo = data.repo;
      this._failCount = 0;
      if (this.localAvailable) {
        console.log(`[TTS] Hugging Face Style-Bert-VITS2 (${this.repo}): 利用可能`);
      } else {
        console.info("[TTS] ローカル Style-Bert-VITS2 未起動のため自然ブラウザ音声を使用します");
      }
    } catch (err) {
      this.localAvailable = false;
      console.info("[TTS] /tts-check 確認不可（自然ブラウザ音声を使用）:", err.message);
    }
    if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
  }

  /**
   * 音声を事前に準備（合成・ロード）し、準備完了時に onReady（＋任意の思考待機 thinkDelayMs）、
   * 再生開始と同時に onStart、再生終了時に onEnd を発火する。
   * これにより「準備中は動き続け、文章・音声ができたら3秒考えてから話す」動きを音声再生と完全に同期できる。
   */
  speak(text, characterName, callbacks = {}) {
    const onReady = typeof callbacks === "object" ? callbacks?.onReady : undefined;
    const onStart = typeof callbacks === "function" ? callbacks : callbacks?.onStart;
    const onEnd = typeof callbacks === "object" ? callbacks?.onEnd : undefined;
    const thinkDelayMs = typeof callbacks === "object" && typeof callbacks?.thinkDelayMs === "number"
      ? Math.max(0, callbacks.thinkDelayMs)
      : 0;
    const clean = TTSManager.sanitizeForSpeech(text);

    if (!this.enabled || !clean || typeof window === "undefined") {
      const mode = !clean ? "empty" : "muted";
      try { onStart?.({ durationSec: 0, mode }); } catch (_) {}
      try { onEnd?.({ mode }); } catch (_) {}
      return;
    }

    if (this._queue.length >= 6) {
      const dropped = this._queue.shift();
      this._finalizeItem(dropped, "dropped");
    }

    const item = {
      text,
      clean,
      characterName,
      onReady,
      onStart,
      onEnd,
      thinkDelayMs,
      readyFired: false,
      started: false,
      ended: false,
      cancelled: false,
      _blobUrl: null,
      _thinkTimer: null,
      _thinkResolve: null,
      preparePromise: null,
    };
    // キュー待機中でも先に音声データを合成・準備しておく（再生のテンポを上げる）
    item.preparePromise = this._prepareAudio(clean, characterName, item);

    this._queue.push(item);
    if (!this._playing) this._processNext();
  }

  static sanitizeForSpeech(text) {
    return String(text || "")
      .replace(/^[@＠](?:[A-Za-z0-9_]+|全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)(?:(?:さん|くん|君|ちゃん|様)[\s、,:：!！]*|[\s、,:：!！]+)/, "")
      .replace(/🪵\s*(?:木材)?\s*[×x]?\s*(\d+)/g, "木材$1個")
      .replace(/🪨\s*(?:石)?\s*[×x]?\s*(\d+)/g, "石$1個")
      .replace(/🌿\s*(?:薬草)?\s*[×x]?\s*(\d+)/g, "薬草$1個")
      .replace(/🐟\s*(?:魚)?\s*[×x]?\s*(\d+)/g, "魚$1匹")
      .replace(/🪙\s*[×x+＋]?\s*(\d+(?:\.\d+)?)/g, "$1コイン")
      .replace(/(\d+(?:\.\d+)?)\s*🪙/g, "$1コイン")
      .replace(/(?<![A-Za-z])Lv\.?\s*(\d+)/gi, "レベル$1")
      .replace(/[…\.]{2,}/g, "、")
      .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F♪♡♥★☆✨※]/gu, "")
      .replace(/[×⇔→]/g, "、")
      .replace(/\s+/g, " ")
      .trim();
  }

  _getCharConfig(characterName) {
    return (typeof AI_CHARACTERS_CONFIG !== "undefined" ? AI_CHARACTERS_CONFIG : [])
      .find(c => c.name === characterName)?.ttsConfig || {};
  }

  async _prepareAudio(cleanText, characterName, item) {
    const cfg = this._getCharConfig(characterName);
    const estDuration = TTSManager.estimateDurationSec(cleanText);

    // GitHub Pages 等のサーバーレス環境ではブラウザ内蔵 ZEN-TTS (44.1kHz 感情表現対応日本語ニューラル音声) を使用
    if (!this._isLocalHost) {
      // 再生速度(playbackRate)による早送り・音程変化は使わず、ZEN-TTS 推論側の speed / emotion のみで自然な話速・抑揚を制御
      const playbackRate = 1.0;
      const cacheKey = `${characterName}::${cleanText}`;
      const cached = this._wavCache.get(cacheKey);
      if (cached) {
        return await this._createAudioFromWavBuffer(cached, item, estDuration, playbackRate);
      }

      if (this.browserTtsReady || (this.browserTtsLoading && !this.browserTtsError)) {
        try {
          const timeoutMs = this.browserTtsReady ? 25000 : 60000;
          const res = await this._synthesizeInBrowserWorker(cleanText, characterName, timeoutMs);
          if (item.cancelled || !this.enabled) {
            return { kind: "cancelled", durationSec: 0 };
          }
          if (res?.wavBuffer && res.wavBuffer.byteLength > 44) {
            this._cacheWav(cacheKey, res.wavBuffer);
            const dur = res.durationSec > 0.1 ? res.durationSec : estDuration;
            return await this._createAudioFromWavBuffer(res.wavBuffer, item, dur, playbackRate);
          }
        } catch (err) {
          console.warn("[TTS] Browser neural TTS fallback to Web Speech:", err?.message || err);
        }
      }

      await this._waitForVoicesReady(700);
      return { kind: "speech", clean: cleanText, cfg, durationSec: estDuration };
    }

    const voice = cfg.ttsModel ?? "amitaro";
    const speed = cfg.rate     ?? 1.0;
    const style = cfg.style    ?? "Neutral";

    // localhost 環境では常に Hugging Face Style-Bert-VITS2 (/tts-local) への接続を試みる
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
    try {
      const resp = await fetch("/tts-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanText, voice, speed, style }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (timer) clearTimeout(timer);
      if (!resp.ok) {
        this._failCount++;
        this.localAvailable = false;
        if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
        await this._waitForVoicesReady(500);
        return { kind: "speech", clean: cleanText, cfg, durationSec: estDuration };
      }

      this._failCount = 0;
      this.localAvailable = true;
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);

      const blob = await resp.blob();
      if (item.cancelled || !this.enabled) {
        return { kind: "cancelled", durationSec: 0 };
      }

      const wavBuf = await blob.arrayBuffer();
      return await this._createAudioFromWavBuffer(wavBuf, item, estDuration, 1.0);
    } catch (_) {
      if (timer) clearTimeout(timer);
      this._failCount++;
      this.localAvailable = false;
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      await this._waitForVoicesReady(500);
      return { kind: "speech", clean: cleanText, cfg, durationSec: estDuration };
    }
  }

  _processNext() {
    if (!this.enabled || this._queue.length === 0) {
      this._playing = false;
      this._activeItem = null;
      return;
    }
    this._playing = true;
    const item = this._queue.shift();
    this._activeItem = item;
    this._playItem(item).finally(() => {
      // stop() 後に新しい item が再生開始されていた場合は _processNext() を二重起動しない
      if (this._activeItem === item) {
        this._activeItem = null;
        this._processNext();
      }
    });
  }

  _markAutoplayBlocked(item) {
    this.autoplayBlocked = true;
    this._blockedReplay = { text: item.text, characterName: item.characterName };
    if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
  }

  async _playItem(item) {
    let prepared;
    try {
      prepared = await item.preparePromise;
    } catch (_) {
      prepared = {
        kind: "speech",
        clean: item.clean,
        cfg: this._getCharConfig(item.characterName),
        durationSec: TTSManager.estimateDurationSec(item.clean),
      };
    }

    if (item.cancelled || !this.enabled || prepared?.kind === "cancelled") {
      this._finalizeItem(item, "cancelled");
      return;
    }

    // 文章・音声の準備が完了したタイミングで onReady を通知し、指定時間（3秒）だけ「考え中」ポーズを取る
    if (!item.readyFired) {
      item.readyFired = true;
      try {
        item.onReady?.({
          durationSec: prepared.durationSec || 0,
          thinkDelayMs: item.thinkDelayMs || 0,
        });
      } catch (_) {}
    }
    if (item.thinkDelayMs > 0) {
      await new Promise((resolve) => {
        item._thinkResolve = resolve;
        item._thinkTimer = this._setTimer(() => {
          item._thinkTimer = null;
          item._thinkResolve = null;
          resolve();
        }, item.thinkDelayMs);
      });
      if (item.cancelled || !this.enabled) {
        this._finalizeItem(item, "cancelled");
        return;
      }
    }

    const fireStart = (mode, durationSec) => {
      if (item.started || item.cancelled) return;
      item.started = true;
      try { item.onStart?.({ durationSec, mode }); } catch (_) {}
    };
    const fireEnd = (mode) => {
      if (item.ended) return;
      if (!item.started) fireStart(mode, 0);
      item.ended = true;
      try { item.onEnd?.({ mode }); } catch (_) {}
    };

    if (prepared.kind === "webaudio") {
      const ctx = this._getAudioContext();
      if (ctx && ctx.state === "running") {
        const { audioBuffer, playbackRate = 1.0, durationSec } = prepared;
        await new Promise((resolve) => {
          let finished = false;
          const src = ctx.createBufferSource();
          src.buffer = audioBuffer;
          if (playbackRate && playbackRate !== 1.0) {
            src.playbackRate.value = playbackRate;
          }
          const gainNode = typeof ctx.createGain === "function" ? ctx.createGain() : null;
          if (gainNode) {
            gainNode.gain.value = 1.0;
            src.connect(gainNode);
            gainNode.connect(ctx.destination);
          } else {
            src.connect(ctx.destination);
          }
          this._currentSource = src;

          const done = (mode = "hf-audio") => {
            if (finished) return;
            finished = true;
            this._clearTimer(safetyTimer);
            if (this._currentSource === src) this._currentSource = null;
            try { src.onended = null; src.disconnect(); } catch (_) {}
            try { gainNode?.disconnect(); } catch (_) {}
            fireEnd(mode);
            resolve();
          };

          const safetyTimer = this._setTimer(
            () => done("hf-audio-timeout"),
            Math.max(4000, Math.round((durationSec + 3) * 1000))
          );

          src.onended = () => done("hf-audio");
          try {
            src.start(0);
            this.autoplayBlocked = false;
            fireStart("hf-audio", durationSec);
          } catch (_) {
            done("hf-audio-error");
          }
        });
        return;
      }

      // AudioContext が未アンロックの場合は HTMLAudioElement でも再生を試行（成功なら鳴る、失敗ならUIでクリック促す）
      if (prepared.wavBuffer) {
        const blob = new Blob([prepared.wavBuffer], { type: "audio/wav" });
        prepared = await this._createAudioFromBlob(blob, item, prepared.durationSec, prepared.playbackRate);
        if (item.cancelled || !this.enabled || prepared?.kind === "cancelled") {
          this._finalizeItem(item, "cancelled");
          return;
        }
      }
    }

    if (prepared.kind === "audio") {
      const { audio, url, durationSec } = prepared;
      this._currentAudio = audio;
      await new Promise((resolve) => {
        let finished = false;
        const done = (mode = "hf-audio") => {
          if (finished) return;
          finished = true;
          this._clearTimer(safetyTimer);
          if (this._currentAudio === audio) this._currentAudio = null;
          if (item._blobUrl === url) {
            try { URL.revokeObjectURL(url); } catch (_) {}
            item._blobUrl = null;
          }
          fireEnd(mode);
          resolve();
        };

        const safetyTimer = this._setTimer(
          () => done("hf-audio-timeout"),
          Math.max(5000, Math.round((durationSec + 4) * 1000))
        );

        audio.onplaying = () => {
          if (this.autoplayBlocked) {
            this.autoplayBlocked = false;
            if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
          }
          fireStart("hf-audio", durationSec);
        };
        audio.onended = () => done("hf-audio");
        audio.onerror = () => done("hf-audio-error");

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise
            .then(() => fireStart("hf-audio", durationSec))
            .catch(() => {
              // 自動再生ブロックをUIに明確に通知し、画面クリック即再生に備える
              this._markAutoplayBlocked(item);
              const fallbackMs = Math.max(1800, Math.min(4000, Math.round(durationSec * 800)));
              fireStart("autoplay-blocked", fallbackMs / 1000);
              this._clearTimer(safetyTimer);
              this._setTimer(() => done("autoplay-blocked"), fallbackMs);
            });
        } else {
          fireStart("hf-audio", durationSec);
        }
      });
      return;
    }

    // ブラウザ内蔵の自然日本語音声（Web Speech API）
    await this._playSpeechFallback(item, prepared.clean, prepared.cfg, prepared.durationSec, fireStart, fireEnd);
  }

  _playSpeechFallback(item, text, cfg, durationSec, fireStart, fireEnd) {
    return new Promise((resolve) => {
      if (!this.enabled || item.cancelled) {
        this._finalizeItem(item, "cancelled");
        resolve();
        return;
      }
      if (typeof window === "undefined" || !window.speechSynthesis) {
        const waitMs = Math.max(1600, Math.min(4000, Math.round(durationSec * 800)));
        fireStart("no-speech", waitMs / 1000);
        this._setTimer(() => {
          fireEnd("no-speech");
          resolve();
        }, waitMs);
        return;
      }

      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = "ja-JP";
      const naturalVoice = this._selectNaturalJapaneseVoice(cfg.gender || "female");
      if (naturalVoice) {
        utt.voice = naturalVoice;
        this.activeVoiceLabel = naturalVoice.name;
      }
      utt.pitch = Math.max(0.85, Math.min(1.25, cfg.pitch ?? 1.0));
      utt.rate  = Math.max(0.90, Math.min(1.15, cfg.rate  ?? 1.0));

      let finished = false;
      const done = (mode = "browser-speech") => {
        if (finished) return;
        finished = true;
        this._clearTimer(startGuard);
        this._clearTimer(endGuard);
        fireEnd(mode);
        resolve();
      };

      // 一部ブラウザで onstart が発火しない場合でもチャットが止まらないよう保護
      const startGuard = this._setTimer(
        () => fireStart("browser-speech", durationSec),
        350
      );
      // Chromium の SpeechSynthesis 無応答バグ防止用タイムアウト
      const endGuard = this._setTimer(
        () => done("browser-speech-timeout"),
        Math.max(4500, Math.round(text.length * 260 + 2500))
      );

      utt.onstart = () => {
        this._clearTimer(startGuard);
        fireStart("browser-speech", durationSec);
      };
      utt.onend = () => done("browser-speech");
      utt.onerror = () => done("browser-speech-error");

      try {
        window.speechSynthesis.speak(utt);
      } catch (_) {
        done("browser-speech-error");
      }
    });
  }
}

const ttsManager = typeof window !== "undefined" ? new TTSManager() : null;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { TTSManager };
}
