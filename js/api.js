const HF_BROWSER_FEW_SHOT = {
  alice: [
    { role: "user", content: "こんにちは！調子はどう？" },
    { role: "assistant", content: "@Player こんにちは！街の広場を観察しながら、畑の作物を育てて総資産1位を狙っているところだよ！" },
  ],
  bob: [
    { role: "user", content: "こんにちは！調子はどう？" },
    { role: "assistant", content: "@Player 風が穏やかだね。静かに畑を育てながら、誰よりも豊かな資産を築くつもりさ。" },
  ],
  carol: [
    { role: "user", content: "こんにちは！調子はどう？" },
    { role: "assistant", content: "@Player こんにちは！畑で新鮮な野菜を育てて、美味しい料理を作ってランキング1位を目指すよ！" },
  ],
};

class HuggingFaceClient {
  constructor() {
    this.model = typeof GAME_CONFIG !== "undefined" ? GAME_CONFIG.model : "unsloth/gemma-3-4b-it-GGUF";
    this.endpoint = "/chat";
    this.healthEndpoint = "/health";
    this._queues = {};
    this.mode = "checking"; // "local-server" | "browser-hf" | "cloud-direct"
    this.hfAvailable = null;
    this.lmAvailable = null;
    this.loadedModels = [];

    // サーバー不要（GitHub Pages 等）用のブラウザ内蔵 Hugging Face Transformers.js Worker
    this._worker = null;
    this._workerReady = false;
    this._workerLoading = false;
    this._workerProgress = 0;
    this._workerLoadedBytes = 0;
    this._workerTotalBytes = 0;
    this._workerStage = "connecting";
    this._workerModel = "";
    this._workerDevice = "";
    this._workerError = "";
    this._workerPending = new Map();
    this._reqSeq = 0;
    this.onBrowserProgress = null;
  }

  static isLocalServerHost() {
    if (typeof window === "undefined" || !window.location) return false;
    const h = window.location.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  }

  _withQueue(modelId, fn) {
    if (!this._queues[modelId]) this._queues[modelId] = Promise.resolve();
    const next = this._queues[modelId].then(fn, fn);
    this._queues[modelId] = next.then(() => {}, () => {});
    return next;
  }

  async _fetchWithTimeout(url, options = {}, timeoutMs = 45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("リクエストがタイムアウトしました");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _getSavedBrowserToken() {
    try {
      if (typeof localStorage !== "undefined") {
        return (localStorage.getItem("botGame.hfToken") || "").trim();
      }
    } catch (_) {}
    return "";
  }

  _initBrowserWorker() {
    if (this._workerReady || this._workerLoading || typeof Worker === "undefined") return;
    if (this._worker) {
      // 前回の読み込みエラーから再試行
      this._workerLoading = true;
      this._workerError = "";
      this._workerStage = "connecting";
      this._worker.postMessage({ type: "load" });
      if (this.onBrowserProgress) {
        this.onBrowserProgress({
          ready: false,
          percent: this._workerProgress,
          loadedBytes: this._workerLoadedBytes,
          totalBytes: this._workerTotalBytes,
          stage: this._workerStage,
          modelId: this._workerModel,
          device: this._workerDevice,
        });
      }
      return;
    }
    try {
      this._worker = new Worker("js/hf-browser-worker.js?v=gh6", { type: "module" });
      this._workerLoading = true;
      this._workerError = "";
      this._workerStage = "connecting";
      this._worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === "progress") {
          this._workerProgress = msg.percent || 0;
          this._workerLoadedBytes = msg.loadedBytes || 0;
          this._workerTotalBytes = msg.totalBytes || 0;
          this._workerStage = msg.stage || (this._workerProgress > 0 ? "downloading" : "connecting");
          this._workerModel = msg.modelId || this._workerModel;
          this._workerDevice = msg.device || this._workerDevice;
          if (this.onBrowserProgress) {
            this.onBrowserProgress({
              ready: false,
              percent: this._workerProgress,
              loadedBytes: this._workerLoadedBytes,
              totalBytes: this._workerTotalBytes,
              stage: this._workerStage,
              modelId: this._workerModel,
              device: this._workerDevice,
            });
          }
        } else if (msg.type === "ready") {
          this._workerReady = true;
          this._workerLoading = false;
          this._workerProgress = 100;
          this._workerStage = "ready";
          this._workerModel = msg.modelId || "onnx-community/Qwen2.5-0.5B-Instruct";
          this._workerDevice = msg.device || "wasm";
          this.hfAvailable = true;
          this.lmAvailable = true;
          this.model = this._workerModel;
          if (this.onBrowserProgress) {
            this.onBrowserProgress({
              ready: true,
              percent: 100,
              loadedBytes: this._workerTotalBytes,
              totalBytes: this._workerTotalBytes,
              stage: "ready",
              modelId: this._workerModel,
              device: this._workerDevice,
            });
          }
        } else if (msg.type === "error") {
          this._workerLoading = false;
          this._workerStage = "error";
          this._workerError = msg.message || "Worker load failed";
          if (this.onBrowserProgress) {
            this.onBrowserProgress({ ready: false, stage: "error", error: this._workerError });
          }
        } else if (msg.type === "result") {
          const resolver = this._workerPending.get(msg.requestId);
          if (resolver) {
            this._workerPending.delete(msg.requestId);
            if (msg.error) resolver.reject(new Error(msg.error));
            else resolver.resolve(msg);
          }
        }
      };
      this._worker.onerror = (err) => {
        this._workerLoading = false;
        this._workerStage = "error";
        this._workerError = err?.message || "Web Worker error";
        try { this._worker?.terminate(); } catch (_) {}
        this._worker = null;
        for (const [, r] of this._workerPending) {
          r.reject(new Error(this._workerError));
        }
        this._workerPending.clear();
        if (this.onBrowserProgress) {
          this.onBrowserProgress({ ready: false, stage: "error", error: this._workerError });
        }
      };
      this._worker.postMessage({ type: "load" });
    } catch (err) {
      this._workerLoading = false;
      this._workerStage = "error";
      this._workerError = err?.message || "Worker unavailable";
    }
  }

  _runBrowserWorker(messages, maxNewTokens = 64, temperature = 0.72) {
    return new Promise((resolve, reject) => {
      if (!this._worker) this._initBrowserWorker();
      if (!this._worker) {
        reject(new Error("ブラウザ内 Hugging Face AI Worker を起動できません"));
        return;
      }
      if (!this._workerReady) {
        reject(new Error(`ブラウザ内 Hugging Face AI を読込中です (${this._workerProgress}%)`));
        return;
      }
      const requestId = ++this._reqSeq;
      const timer = setTimeout(() => {
        this._workerPending.delete(requestId);
        reject(new Error("ブラウザ内 Hugging Face AI がタイムアウトしました"));
      }, 60000);

      this._workerPending.set(requestId, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this._worker.postMessage({
        type: "generate",
        requestId,
        messages,
        maxNewTokens,
        temperature,
      });
    });
  }

  async checkHealth() {
    // 1. localhost / 127.0.0.1 の場合はローカル Python サーバー (/health) を確認
    if (HuggingFaceClient.isLocalServerHost()) {
      try {
        const resp = await this._fetchWithTimeout(this.healthEndpoint, { method: "GET" }, 3000);
        if (resp.ok) {
          const data = await resp.json();
          const hf = data.hf_api || data.lm_studio || { ok: false, models: [] };
          this.mode = "local-server";
          this.hfAvailable = Boolean(hf.ok);
          this.lmAvailable = this.hfAvailable;
          this.loadedModels = Array.isArray(hf.models) ? hf.models : [];
          return data;
        }
      } catch (_) {
        // ローカルサーバー未起動時はサーバー不要のブラウザ内蔵 HF AI へ自動切替
      }
    }

    // 2. GitHub Pages 等の静的ホスティング（サーバー不要モード）
    this.mode = "browser-hf";
    this._initBrowserWorker();
    const ready = Boolean(this._workerReady);
    this.hfAvailable = ready;
    this.lmAvailable = ready;
    const browserStatus = {
      ok: ready,
      provider: "huggingface",
      mode: "browser-transformers-js",
      loading: this._workerLoading,
      progress: this._workerProgress,
      model: this._workerModel || "onnx-community/Qwen2.5-0.5B-Instruct",
      device: this._workerDevice || "webgpu/wasm",
      models: this._workerModel ? [this._workerModel] : [],
      error: this._workerError || undefined,
    };
    return {
      ok: true,
      hf_api: browserStatus,
      lm_studio: browserStatus,
      tts: { local_available: false, mode: "browser-neural-speech" },
    };
  }

  static stripReasoningTags(rawText) {
    let text = String(rawText ?? "");
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
    text = text.replace(/<think>[\s\S]*$/gi, "");
    return text.trim();
  }

  static truncateToSentences(text, maxSentences = 2) {
    const str = String(text ?? "").trim();
    if (!str) return "";
    const regex = /[。！？!?]+/g;
    let count = 0;
    let match;
    while ((match = regex.exec(str)) !== null) {
      count++;
      if (count >= maxSentences) {
        return str.slice(0, match.index + match[0].length).trim();
      }
    }
    return str;
  }

  static cleanDialogueResponse(rawText, targetName) {
    let text = HuggingFaceClient.stripReasoningTags(rawText);
    text = text.replace(/```[\s\S]*?```/g, "").trim();
    text = text
      .replace(/^(PLAN|RESOURCE|ACTION|AMOUNT|COINS|BUILD|CROP|TARGET|MESSAGE)\s*[:：][^\n]*/gim, "")
      .trim();
    text = text.replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ").trim();

    if (targetName) {
      const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const mentionRe = new RegExp(`[@＠]${escaped}\\s*`, "gi");
      const matches = [...text.matchAll(mentionRe)];
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        const body = text.slice(last.index + last[0].length).trim();
        text = `@${targetName} ${body}`.trim();
      } else {
        text = text.replace(/^[@＠](?:nearest_name|TARGET名|相手の名前|\w+)\s*/i, "").trim();
        text = `@${targetName} ${text}`.trim();
      }
    }

    text = HuggingFaceClient.truncateToSentences(text, 2);
    return text;
  }

  static sanitizeAnnounceMessage(rawMsg, targetName) {
    if (!rawMsg) return null;
    let msg = HuggingFaceClient.stripReasoningTags(rawMsg);
    msg = msg.replace(/^["「『]|["」』]$/g, "").trim();
    msg = msg.replace(/[@＠](?:nearest_name|TARGET名|相手の名前)\s*/gi, "").trim();
    msg = msg.replace(/^[@＠]\w+\s*/, "").trim();
    if (!msg) return null;
    msg = HuggingFaceClient.truncateToSentences(msg, 2);
    return targetName ? `@${targetName} ${msg}` : msg;
  }

  async _callDirectCloudRouter(messages, maxTokens) {
    const token = this._getSavedBrowserToken();
    if (!token) return null;
    const resp = await this._fetchWithTimeout(
      "https://router.huggingface.co/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-7B-Instruct",
          max_tokens: maxTokens,
          stream: false,
          messages,
        }),
      },
      30000
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  async callAI(character, userMessage, targetName, historyUserMessage) {
    const model = character.model || this.model;
    const queueKey = this.mode === "browser-hf" ? "browser-hf" : model;
    return this._withQueue(queueKey, async () => {
      const promptWithHint = targetName
        ? `${userMessage}\n（必ず「@${targetName} 」から始めて1〜2文の自然な日本語で返答してください）`
        : userMessage;
      const buildMessages = (history) => [
        { role: "system", content: character.personality },
        ...history,
        { role: "user", content: promptWithHint },
      ];

      let rawText = "";

      if (this.mode === "browser-hf") {
        const fewShot = HF_BROWSER_FEW_SHOT[character.id] || [];
        const browserMsgs = [
          {
            role: "system",
            content: `${character.personality}\n重要: 自分をAIと呼ばずキャラクター本人として1〜2文の自然な日本語で話してください。`,
          },
          ...fewShot,
          ...character.conversationHistory.slice(-4),
          { role: "user", content: promptWithHint },
        ];
        // ユーザーが任意でブラウザに HF_TOKEN を保存していればクラウドも優先試行
        const cloudReply = await this._callDirectCloudRouter(browserMsgs, GAME_CONFIG.maxTokens).catch(() => null);
        if (cloudReply) {
          rawText = cloudReply;
          character.lastUsedModel = "Qwen/Qwen2.5-7B-Instruct";
        } else {
          const res = await this._runBrowserWorker(browserMsgs, 56, 0.72);
          rawText = res.content;
          if (res.modelId) character.lastUsedModel = res.modelId;
        }
        this.hfAvailable = true;
        this.lmAvailable = true;
      } else {
        let response = await this._fetchWithTimeout(
          this.endpoint,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              max_tokens: GAME_CONFIG.maxTokens,
              stream: false,
              messages: buildMessages(character.conversationHistory),
            }),
          },
          90000
        );

        if (response.status === 400 && character.conversationHistory.length > 4) {
          character.conversationHistory = character.conversationHistory.slice(-4);
          response = await this._fetchWithTimeout(
            this.endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                max_tokens: GAME_CONFIG.maxTokens,
                stream: false,
                messages: buildMessages(character.conversationHistory),
              }),
            },
            90000
          );
        }

        if (!response.ok) {
          let errMsg = `HTTP ${response.status}`;
          try {
            const err = await response.json();
            errMsg = err.error?.message || errMsg;
          } catch (_) {}
          if (response.status === 502 || response.status === 503 || response.status === 401) {
            this.hfAvailable = false;
            this.lmAvailable = false;
          }
          throw new Error(errMsg);
        }

        this.hfAvailable = true;
        this.lmAvailable = true;
        const data = await response.json();
        if (data.hf_model_used) {
          character.lastUsedModel = data.hf_model_used;
        }
        rawText = data.choices?.[0]?.message?.content?.trim();
        if (!rawText) {
          rawText = data.choices?.[0]?.message?.reasoning_content?.trim() ?? "";
        }
      }

      if (!rawText) throw new Error("空のレスポンスが返されました");

      const text = HuggingFaceClient.cleanDialogueResponse(rawText, targetName);
      if (!text || (targetName && text === `@${targetName}`)) {
        throw new Error("有効な返答を生成できませんでした");
      }

      character.conversationHistory.push(
        { role: "user", content: historyUserMessage ?? userMessage },
        { role: "assistant", content: text }
      );
      if (character.conversationHistory.length > GAME_CONFIG.maxContextMessages) {
        character.conversationHistory = character.conversationHistory.slice(
          -GAME_CONFIG.maxContextMessages
        );
      }

      return text;
    });
  }

  async callAIForMasterAction(character, context, nearestName = "Player") {
    const model = character.model || this.model;
    const queueKey = this.mode === "browser-hf" ? "browser-hf" : model;
    return this._withQueue(queueKey, async () => {
      const systemPrompt = character.personality + `

あなたは今、次に何をするか決めようとしています。
**他のキャラクター（Player含む）は全員ライバルです。目標: 総資産ランキングでライバル全員を上回り1位になること。**

状況を踏まえ、以下の形式で次の行動を**1回だけ**出力してください。説明不要。

採集する場合：
PLAN: gather
RESOURCE: wood または stone または herb または fish
MESSAGE: @${nearestName} （採集後にライバルへ言う一文。キャラの個性で自然に）

農業（種まき・収穫）をする場合：
PLAN: farm
CROP: carrot または wheat または cabbage または tomato または corn または rice または pumpkin または strawberry
MESSAGE: @${nearestName} （農業・収穫についてライバルへ言う一文。キャラの個性で自然に）

取引する場合：
PLAN: trade
ACTION: sell または buy または execute または skip
RESOURCE: wood または stone または herb または fish
AMOUNT: 数量（整数）
COINS: コイン数（整数）
MESSAGE: @${nearestName} （取引を知らせる一文。キャラの個性で自然に）

建築する場合：
PLAN: build
BUILD: campfire または flowerBed または woodenFence または fishingSpot
MESSAGE: @${nearestName} （建築を知らせる一文。キャラの個性で自然に）

チャットで交渉・牽制・情報収集する場合：
PLAN: chat
TARGET: Alice または Bob または Carol または Player
MESSAGE: @相手の名前 （キャラの個性で、取引交渉・ライバルへの牽制などを1〜2文で）

出力例（農業の場合）：
PLAN: farm
CROP: carrot
MESSAGE: @${nearestName} 畑にニンジンを植えて資産を増やすよ！

PLAN:の直後は必ず gather / farm / trade / build / chat のいずれかのみ。それ以外の言葉は絶対に使わないこと。`;

      let text = "";
      if (this.mode === "browser-hf") {
        if (!this._workerReady) return null;
        try {
          const compactMsgs = [
            {
              role: "system",
              content: "次の行動を PLAN: gather / farm / trade / build / chat の形式で3行だけ出力してください。",
            },
            { role: "user", content: "状況: コイン10, 木材2\n次の行動:" },
            { role: "assistant", content: `PLAN: farm\nCROP: carrot\nMESSAGE: @${nearestName} 畑にニンジンを植えて資産を増やすよ！` },
            { role: "user", content: `${context.slice(0, 420)}\n次の行動:` },
          ];
          const res = await this._runBrowserWorker(compactMsgs, 56, 0.7);
          text = res.content;
        } catch (err) {
          console.warn(`[HuggingFace Browser] callAIForMasterAction skipped: ${err.message}`);
          return null;
        }
      } else {
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: context },
        ];
        let response;
        try {
          response = await this._fetchWithTimeout(
            this.endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model, max_tokens: 120, stream: false, messages }),
            },
            90000
          );
        } catch (err) {
          this.hfAvailable = false;
          this.lmAvailable = false;
          console.warn(`[HuggingFace] callAIForMasterAction network error: ${err.message}`);
          return null;
        }

        if (!response.ok) {
          let errMsg = `HTTP ${response.status}`;
          try { const err = await response.json(); errMsg = err.error?.message || errMsg; } catch (_) {}
          if (response.status === 502 || response.status === 503 || response.status === 401) {
            this.hfAvailable = false;
            this.lmAvailable = false;
          }
          console.warn(`[HuggingFace] callAIForMasterAction error: ${errMsg}`);
          return null;
        }

        this.hfAvailable = true;
        this.lmAvailable = true;
        const data = await response.json();
        if (data.hf_model_used) {
          character.lastUsedModel = data.hf_model_used;
        }
        text = data.choices?.[0]?.message?.content?.trim();
        if (!text) {
          text = data.choices?.[0]?.message?.reasoning_content?.trim() ?? "";
        }
      }

      if (!text) return null;
      text = HuggingFaceClient.stripReasoningTags(text);
      const planIdx = text.search(/PLAN\s*[:：]/i);
      if (planIdx > 0) text = text.slice(planIdx);
      return text;
    });
  }
}

// 後方互換エイリアス
const LMStudioClient = HuggingFaceClient;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { HuggingFaceClient, LMStudioClient };
}
