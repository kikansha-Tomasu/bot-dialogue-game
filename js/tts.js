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
    this._currentAudio = null;
    this._voices = [];
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

  _initBrowserVoices() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const refresh = () => {
      try {
        this._voices = window.speechSynthesis.getVoices() || [];
        const best = this._selectNaturalJapaneseVoice("female");
        if (best) this.activeVoiceLabel = best.name;
      } catch (_) {}
    };
    refresh();
    if (typeof window.speechSynthesis.addEventListener === "function") {
      window.speechSynthesis.addEventListener("voiceschanged", refresh);
    } else {
      window.speechSynthesis.onvoiceschanged = refresh;
    }
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

  stop() {
    this._queue = [];
    this._playing = false;
    if (this._currentAudio) {
      try {
        this._currentAudio.pause();
        this._currentAudio.src = "";
      } catch (_) {}
      this._currentAudio = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
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

  speak(text, characterName) {
    if (!this.enabled) return;
    if (this._queue.length >= 6) this._queue.shift();
    this._queue.push({ text, characterName });
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

  _processNext() {
    if (!this.enabled || this._queue.length === 0) {
      this._playing = false;
      return;
    }
    this._playing = true;
    const { text, characterName } = this._queue.shift();
    const clean = TTSManager.sanitizeForSpeech(text);
    if (!clean) {
      this._processNext();
      return;
    }
    this._speak(clean, characterName).finally(() => this._processNext());
  }

  async _speak(text, characterName) {
    const cfg = (typeof AI_CHARACTERS_CONFIG !== "undefined" ? AI_CHARACTERS_CONFIG : [])
      .find(c => c.name === characterName)?.ttsConfig || {};

    // GitHub Pages 等のサーバーレス環境ではブラウザ内蔵の自然ニューラル日本語音声を使用
    if (!this._isLocalHost) {
      await this._speakFallback(text, cfg);
      return;
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
        body: JSON.stringify({ text, voice, speed, style }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (timer) clearTimeout(timer);
      if (!resp.ok) {
        this._failCount++;
        this.localAvailable = false;
        if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
        await this._speakFallback(text, cfg);
        return;
      }
      this._failCount = 0;
      this.localAvailable = true;
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      if (!this.enabled) return;
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      this._currentAudio = audio;
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = () => { console.warn("[TTS] audio play error"); resolve(); };
        audio.play().catch(() => resolve());
      });
      this._currentAudio = null;
      URL.revokeObjectURL(url);
    } catch (err) {
      if (timer) clearTimeout(timer);
      this._failCount++;
      this.localAvailable = false;
      if (this.onStateChange) this.onStateChange(this.enabled, this.localAvailable);
      await this._speakFallback(text, cfg);
    }
  }

  _speakFallback(text, cfg = {}) {
    return new Promise((resolve) => {
      if (!this.enabled || typeof window === "undefined" || !window.speechSynthesis) {
        resolve();
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
      utt.onend = resolve;
      utt.onerror = () => resolve();
      window.speechSynthesis.speak(utt);
    });
  }
}

const ttsManager = typeof window !== "undefined" ? new TTSManager() : null;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { TTSManager };
}
