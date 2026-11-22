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
    this._activeTimers = new Set();
    this._voices = [];
    this._voicesLoaded = false;
    this._voiceWaiters = [];
    this.activeVoiceLabel = "ブラウザAI音声";
    this.onStateChange = null;

    if (typeof window !== "undefined") {
      this._initBrowserVoices();
      if (typeof fetch !== "undefined") {
        this._checkAvailability();
      }
    }
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
    const fallback = typeof GAME_CONFIG !== "undefined" ? Boolean(GAME_CONFIG.ttsEnabled) : true;
    try {
      if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem(TTS_STORAGE_KEY);
        if (saved === "true") return true;
        if (saved === "false") return false;
      }
    } catch (_) {}
    return fallback;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(TTS_STORAGE_KEY, String(this.enabled));
      }
    } catch (_) {}
    if (!this.enabled) {
      this.stop();
    }
    if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  _finalizeItem(item, mode = "cancelled") {
    if (!item) return;
    item.cancelled = true;
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
    this._clearAllTimers();

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
   * 音声を事前に準備（合成・ロード）し、再生開始と同時に onStart、再生終了時に onEnd を発火する。
   * これによりチャット表示・吹き出し・キャラクターの動きを音声再生と完全に同期できる。
   */
  speak(text, characterName, callbacks = {}) {
    const onStart = typeof callbacks === "function" ? callbacks : callbacks?.onStart;
    const onEnd = typeof callbacks === "object" ? callbacks?.onEnd : undefined;
    const clean = TTSManager.sanitizeForSpeech(text);

    if (!this.enabled || !clean || typeof window === "undefined") {
      try { onStart?.({ durationSec: 0, mode: "muted" }); } catch (_) {}
      try { onEnd?.({ mode: "muted" }); } catch (_) {}
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
      onStart,
      onEnd,
      started: false,
      ended: false,
      cancelled: false,
      _blobUrl: null,
      preparePromise: null,
    };
    // キュー待機中でも先に音声データを合成・準備しておく（再生のテンポを上げる）
    item.preparePromise = this._prepareAudio(clean, characterName, item);

    this._queue.push(item);
    if (!this._playing) this._processNext();
  }

  static sanitizeForSpeech(text) {
    return String(text || "")
      .replace(/^[@＠]\w+\s*/, "")
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

    // GitHub Pages 等のサーバーレス環境ではブラウザ自然日本語音声を準備
    if (!this._isLocalHost) {
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

      const url = URL.createObjectURL(blob);
      item._blobUrl = url;
      const audio = new Audio(url);
      audio.preload = "auto";

      // 音声メタデータ / 再生準備完了まで待機（再生開始の瞬間にチャットを表示するため）
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

      const realDur = (isFinite(audio.duration) && audio.duration > 0.1)
        ? audio.duration
        : estDuration;
      return { kind: "audio", audio, url, durationSec: realDur };
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
      if (this._activeItem === item) {
        this._activeItem = null;
      }
      this._processNext();
    });
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

        audio.onplaying = () => fireStart("hf-audio", durationSec);
        audio.onended = () => done("hf-audio");
        audio.onerror = () => done("hf-audio-error");

        const playPromise = audio.play();
        if (playPromise && typeof playPromise.then === "function") {
          playPromise
            .then(() => fireStart("hf-audio", durationSec))
            .catch(() => {
              // ブラウザの自動再生ポリシーでブロックされた場合もチャットを表示し、読み上げ相当時間だけ待機
              const fallbackMs = Math.max(1800, Math.min(4500, Math.round(durationSec * 800)));
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
      if (!this.enabled || item.cancelled || typeof window === "undefined" || !window.speechSynthesis) {
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
