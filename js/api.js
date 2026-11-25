const HF_BROWSER_FEW_SHOT = {
  alice: [
    { role: "user", content: "こんにちは！調子はどう？" },
    { role: "assistant", content: "こんにちは！街の広場を観察しながら、取引板でいい掘り出し物がないか探しているところだよ！" },
  ],
  bob: [
    { role: "user", content: "こんにちは！調子はどう？" },
    { role: "assistant", content: "風が穏やかだね。静かに資源と建物を整えながら、誰よりも豊かな資産を築くつもりさ。" },
  ],
  carol: [
    { role: "user", content: "こんにちは！調子はどう？" },
    { role: "assistant", content: "こんにちは！畑で新鮮な野菜を育てて、美味しい料理を作ってランキング1位を目指すよ！" },
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
      this._worker = new Worker("js/hf-browser-worker.js?v=gh15", { type: "module" });
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

  _runBrowserWorker(messages, maxNewTokens = 64, temperature = 0.55, options = {}) {
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
        doSample: options.doSample !== undefined ? Boolean(options.doSample) : temperature > 0.05,
        allowStructuredPlan: Boolean(options.allowStructuredPlan),
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
    const regex = /[。！？!?]+[」』"”'）)]*/g;
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

  // 閉じ括弧・句読点・助詞断片など、文の途中から切り出された不自然な書き出しを検出
  // （「へー」「はーい」「ますます」「より高く」「とはいえ」「ないしょ」「ですが」「したく」「すると」「君、」「…」「から揚げ」等の自然な日本語は通す）
  static startsWithFragment(rawBody) {
    const s = String(rawBody ?? "").trim();
    if (!s) return true;
    // 閉じ括弧・句読点・小書き仮名・長音符（三点リーダー「…」は自然な沈黙表現のため許容）
    if (/^[」』）)\]】、。,.!！?？:：・っゃゅょぁぃぅぇぉー]/.test(s)) return true;
    // メンション剥がれで残った敬称単体（「君、」はBob等の自然な二人称のため除外）
    if (/^(?:さん|くん|ちゃん|様|さま)(?:[\s、。！？!?,:：]|$)/.test(s)) return true;
    // 文頭に来得ない単独の助詞・語尾断片（自然な自立語と衝突する語幹には境界条件を付ける）
    if (/^(?:を|けど|けれど|ので|のに|って|には|への|との|にも|での|からの|までは|のが|のを|のも|のは|のこと|のほう|のため|のあと|のまえ|のなか|のうえ|のした|について|にとって|にたいして|にして|になって|になる|にする|にいく|にくる|にきいて|んです|んだよ|んだね|んだ|んで)/.test(s)) {
      return true;
    }
    if (/^とは(?!いえ)/.test(s)) return true;
    if (/^(?:より|です|ます|した|して|する|ない)(?:[。！？!?、\s]|$)/.test(s)) return true;
    // 「が・へ・の・に・は・で・と・も・から」が直後に漢字/カタカナ(長音ー除く)/数字/空白/句読点を伴う助詞断片
    if (/^から(?!揚|あげ)(?:[\u4E00-\u9FFF\u30A1-\u30FA0-9\s、。！？!?]|$)/.test(s)) return true;
    if (/^(?:が|へ|の|に|は|で|と|も)(?:[\u4E00-\u9FFF\u30A1-\u30FA0-9\s、。！？!?]|$)/.test(s)) {
      return true;
    }
    return false;
  }

  // 先頭の @メンション（ASCII名・日本語別名・敬称付き）のみ安全に除去（助詞直結「@Bobは〜」等は削らない）
  static stripLeadingMention(rawText, targetName = null) {
    let s = String(rawText ?? "").trim();
    const aliasPattern = "(?:全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)";
    const targetPattern = targetName
      ? `(?:${targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|[A-Za-z0-9_]+|${aliasPattern})`
      : `(?:[A-Za-z0-9_]+|${aliasPattern})`;
    // 1) 明示的区切り付き、または敬称付き（@Bob こんにちは / @Bobさん、こんにちは / @Bobさんこんにちは / @全員 売るよ）
    const delimRe = new RegExp(`^[@＠]${targetPattern}(?![A-Za-z0-9_])(?:(?:さん|くん|君|ちゃん|様)[\\s、,:：!！]*|[\\s、,:：!！]+|$)`, "i");
    if (delimRe.test(s)) {
      return s.replace(delimRe, "").trim();
    }
    // 2) 区切り無し直結でも、直後が英数字(部分一致バックトラック防止)・助詞・閉じ括弧でない場合のみ除去（例: @Playerこんにちは → こんにちは）
    //    直後が助詞・閉じ括弧（@Bobは〜 / @Bobと〜 / @Bob」〜）なら削らず本文へ残す
    const bareRe = new RegExp(`^[@＠]${targetPattern}(?![A-Za-z0-9_をがにのはでともへ]|から|より|まで|って|だ|じゃ|[」』）)\\]】])`, "i");
    if (bareRe.test(s)) {
      return s.replace(bareRe, "").trim();
    }
    return s;
  }

  // WebGPU FP16崩壊やソフトマックス異常による文字化け・断片トークン列を検出
  static isCorruptedText(rawText) {
    const text = String(rawText ?? "").trim();
    if (!text) return true;
    // U+FFFD置換文字・結合発音記号・制御文字
    if (/[\uFFFD\u0300-\u036F\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return true;
    // アクセント付きラテン文字（é, í, ǎ, ó 等の多言語崩壊トークン）
    if (/[\u00C0-\u024F\u1E00-\u1EFF]/.test(text)) return true;

    const body = HuggingFaceClient.stripLeadingMention(text)
      .replace(/[@＠][A-Za-z0-9_]+/g, "")
      .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, "")
      .trim();
    if (!body) return true;
    if (HuggingFaceClient.startsWithFragment(body)) return true;

    // 空白区切りの1〜2文字断片トークンが多発する典型的な崩壊パターン
    const tokens = body.split(/\s+/).filter(Boolean);
    if (tokens.length >= 6) {
      const tinyTokens = tokens.filter(t => t.length <= 2).length;
      if (tinyTokens / tokens.length >= 0.5) return true;
    }

    // 自然な日本語として最低限のひらがな/カタカナ/漢字を含み、英字過多でないこと
    const jpChars = (body.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []).length;
    const kanaChars = (body.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
    const alphaChars = (body.match(/[A-Za-z]/g) || []).length;
    if (jpChars < 3 || kanaChars < 2) return true;
    if (alphaChars > jpChars) return true;

    return false;
  }

  static _hasOuterMatchingQuotes(s, open, close) {
    if (s.length < 2 || !s.startsWith(open) || !s.endsWith(close)) return false;
    if (open === close) {
      return s.indexOf(open, 1) === s.length - 1;
    }
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === close) {
        depth--;
        if (depth === 0 && i < s.length - 1) return false;
      }
    }
    return depth === 0;
  }

  static _unwrapDialogueBody(rawBody) {
    let s = String(rawBody ?? "").trim();
    // 話者ラベルや前置きラベル（Alice: / 返答： / MESSAGE: 等）を除去
    s = s.replace(/^(?:(?:Alice|Bob|Carol|Player|Assistant|MESSAGE|返答|返信|セリフ|発言)\s*[:：]\s*)+/i, "").trim();
    // 全体を1組だけ囲うかぎ括弧・引用符のみ安全に除去（「A」「B」の途中破壊を防ぐ）
    const pairs = [["「", "」"], ["『", "』"], ['"', '"'], ["'", "'"]];
    for (let i = 0; i < 2; i++) {
      let unwrapped = false;
      for (const [open, close] of pairs) {
        if (HuggingFaceClient._hasOuterMatchingQuotes(s, open, close)) {
          s = s.slice(open.length, s.length - close.length).trim();
          unwrapped = true;
          break;
        }
      }
      if (!unwrapped) break;
    }
    // 片側だけ残った不整合なかぎ括弧を整理
    if (s.startsWith("「") && !s.includes("」")) s = s.slice(1).trim();
    if (s.endsWith("」") && !s.includes("「")) s = s.slice(0, -1).trim();
    if (s.startsWith("『") && !s.includes("』")) s = s.slice(1).trim();
    if (s.endsWith("』") && !s.includes("『")) s = s.slice(0, -1).trim();
    return s;
  }

  static cleanDialogueResponse(rawText, targetName) {
    let text = HuggingFaceClient.stripReasoningTags(rawText);
    text = text.replace(/```[\s\S]*?```/g, "").trim();
    // PLAN等の構造化メタ行を除去（MESSAGE: は行ごと消さずラベルだけ剥がす）
    text = text
      .replace(/^(PLAN|RESOURCE|ACTION|AMOUNT|COINS|BUILD|CROP|TARGET|FOCUS|TARGET_ITEM|GOAL)\s*[:：][^\n]*/gim, "")
      .replace(/^MESSAGE\s*[:：]\s*/gim, "")
      .trim();
    text = text.replace(/\r?\n+/g, " ").replace(/\s{2,}/g, " ").trim();
    text = HuggingFaceClient._unwrapDialogueBody(text);

    // プレースホルダを除去
    text = text.replace(/[@＠](?:nearest_name|TARGET名|相手の名前)[\s、,:：]*/gi, "").trim();

    // 「@Bob」に話しかけよう！のような括弧囲みメンション＋助詞の三人称ナレーション断片を検出して拒否
    if (targetName) {
      const esc = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^[「『][@＠]${esc}[」』]`, "i").test(text)) {
        return "";
      }
    }

    // 文頭の @メンション のみ除去（文中の「木材を @Bob からもらったよ」や「@Bobはすごいね」を途中切り出ししない）
    text = HuggingFaceClient.stripLeadingMention(text, targetName);
    // 文中に残った @Name / @日本語別名 は自然な名前表記へ変換（途中で切らない）
    text = text
      .replace(/[@＠](全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー|[A-Za-z0-9_]+)/g, "$1")
      .replace(/([\u3040-\u30FF\u4E00-\u9FFF])\s+([A-Za-z0-9_]+)\s+(?=(?:[をがにのはでともへ]|から|より|まで))/g, "$1$2")
      .trim();
    text = HuggingFaceClient._unwrapDialogueBody(text);
    text = HuggingFaceClient.truncateToSentences(text, 2);
    if (!text || HuggingFaceClient.isCorruptedText(text)) return "";

    return targetName ? `@${targetName} ${text}`.trim() : text;
  }

  static sanitizeAnnounceMessage(rawMsg, targetName) {
    if (!rawMsg) return null;
    const cleaned = HuggingFaceClient.cleanDialogueResponse(rawMsg, targetName || null);
    return cleaned || null;
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
        ? `${userMessage}\n（${targetName}へのセリフを、かぎ括弧や@メンションは付けずに1〜2文の自然な日本語だけで出力してください）`
        : `${userMessage}\n（かぎ括弧や@メンションは付けずに、1〜2文の自然な日本語だけで出力してください）`;
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
            content: `${character.personality}\n重要: 自分をAIと呼ばず、必ず自然な日本語のみで1〜2文話してください。英語や中国語や記号の羅列は禁止です。`,
          },
          ...fewShot,
          ...character.conversationHistory.slice(-2),
          { role: "user", content: promptWithHint },
        ];
        // ユーザーが任意でブラウザに HF_TOKEN を保存していればクラウドも優先試行
        const cloudReply = await this._callDirectCloudRouter(browserMsgs, GAME_CONFIG.maxTokens).catch(() => null);
        if (cloudReply) {
          rawText = cloudReply;
          character.lastUsedModel = "Qwen/Qwen2.5-7B-Instruct";
        } else {
          const res = await this._runBrowserWorker(browserMsgs, 64, 0.55, { doSample: true });
          rawText = res.content;
          if (res.modelId) character.lastUsedModel = res.modelId;
          // 崩れた出力が出た場合は決定論的デコード(greedy)で1回再試行
          if (!HuggingFaceClient.cleanDialogueResponse(rawText, targetName)) {
            const retry = await this._runBrowserWorker(browserMsgs, 56, 0, { doSample: false });
            rawText = retry.content;
            if (retry.modelId) character.lastUsedModel = retry.modelId;
          }
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

      // 履歴には @メンション無しの自然な本文を保存し、小型モデルの不要な @出力癖を防ぐ
      const historyBody = HuggingFaceClient.stripLeadingMention(text, targetName);
      character.conversationHistory.push(
        { role: "user", content: historyUserMessage ?? userMessage },
        { role: "assistant", content: historyBody || text }
      );
      if (character.conversationHistory.length > GAME_CONFIG.maxContextMessages) {
        character.conversationHistory = character.conversationHistory.slice(
          -GAME_CONFIG.maxContextMessages
        );
      }

      return text;
    });
  }

  // 数ターンごとにキャラクター自身の長期戦略方針をLLMで見直し・更新する
  async callAIForStrategy(character, compactSummary) {
    const model = character.model || this.model;
    const queueKey = this.mode === "browser-hf" ? "browser-hf" : model;
    return this._withQueue(queueKey, async () => {
      const styleLabel = character.strategyProfile?.styleLabel || character.strategy?.styleLabel || "バランス型";
      const systemPrompt =
        `あなたは${character.name}（得意戦法: ${styleLabel}）です。\n` +
        `ライバル全員を上回り総資産1位を取るため、今の盤面（順位・在庫・建物・農地・取引板・相場）を踏まえて、今後数ターンの作戦を次の3行だけで出力してください。説明不要。\n` +
        `FOCUS: gather / farm / trade / build のいずれか1つ\n` +
        `TARGET_ITEM: 狙う品目ID（wood/stone/herb/fish/carrot/wheat/cabbage/tomato/corn/rice/pumpkin/strawberry/carrot_salad/herb_bread/tomato_soup/onigiri_bento/pumpkin_pie/strawberry_tart）\n` +
        `GOAL: 15〜35文字の具体的な日本語作戦（例：薬草を集めてサラダを作り取引板で売る）`;

      let text = "";
      if (this.mode === "browser-hf") {
        if (!this._workerReady) return null;
        try {
          const compactMsgs = [
            { role: "system", content: systemPrompt },
            { role: "user", content: `${compactSummary}\n新しい作戦:` },
          ];
          const res = await this._runBrowserWorker(compactMsgs, 52, 0.45, {
            doSample: true,
            allowStructuredPlan: true,
          });
          text = res.content;
        } catch (err) {
          console.warn(`[HuggingFace Browser] callAIForStrategy skipped: ${err.message}`);
          return null;
        }
      } else {
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `${compactSummary}\n新しい作戦:` },
        ];
        try {
          const response = await this._fetchWithTimeout(
            this.endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model, max_tokens: 90, stream: false, messages }),
            },
            60000
          );
          if (!response.ok) return null;
          const data = await response.json();
          text = data.choices?.[0]?.message?.content?.trim()
            || data.choices?.[0]?.message?.reasoning_content?.trim()
            || "";
        } catch (err) {
          console.warn(`[HuggingFace] callAIForStrategy skipped: ${err.message}`);
          return null;
        }
      }

      if (!text) return null;
      return HuggingFaceClient.stripReasoningTags(text);
    });
  }

  async callAIForMasterAction(character, context, nearestName = "Player", compactContext = null) {
    const model = character.model || this.model;
    const queueKey = this.mode === "browser-hf" ? "browser-hf" : model;
    return this._withQueue(queueKey, async () => {
      const styleLabel = character.strategyProfile?.styleLabel || character.strategy?.styleLabel || "バランス型";
      const currentGoal = character.strategy?.goal || "採集・農業・取引で総資産1位を目指す";
      const systemPrompt = character.personality + `

あなたは今、次に何をするか決めようとしています。
**他のキャラクター（Player含む）は全員ライバルです。目標: 総資産ランキングでライバル全員を上回り1位になること。**
**あなたの得意戦法: ${styleLabel} ／ 現在の長期作戦: ${currentGoal}**
**重要ルール: コインは取引板での売買成立によってのみ増えます。作物や料理も収穫・調理しただけではコインにならないため、売りたい場合は取引板に注文を出して売ってください。**

状況と自分の長期作戦を踏まえ、以下の形式で次の行動を**1回だけ**出力してください。説明不要。

採集する場合：
PLAN: gather
RESOURCE: wood または stone または herb または fish
MESSAGE: （採集後の一言。キャラの個性で自然に、かぎ括弧や@メンション不要）

農業（種まき・収穫・料理）をする場合：
PLAN: farm
CROP: carrot または wheat または cabbage または tomato または corn または rice または pumpkin または strawberry
MESSAGE: （農業・収穫についての一言。キャラの個性で自然に、かぎ括弧や@メンション不要）

取引する場合：
PLAN: trade
ACTION: sell または buy または execute または skip
RESOURCE: 資源(wood/stone/herb/fish)・作物(carrot/wheat/cabbage/tomato/corn/rice/pumpkin/strawberry)・料理(carrot_salad/herb_bread/tomato_soup/onigiri_bento/pumpkin_pie/strawberry_tart)のいずれか
AMOUNT: 数量（整数）
COINS: コイン数（整数）
MESSAGE: （取引をみんなに知らせる一言。キャラの個性で自然に、かぎ括弧や@メンション不要）

建築する場合：
PLAN: build
BUILD: campfire または flowerBed または woodenFence または fishingSpot
MESSAGE: （建築を知らせる一言。キャラの個性で自然に、かぎ括弧や@メンション不要）

チャットで交渉・牽制・情報収集する場合：
PLAN: chat
TARGET: Alice または Bob または Carol または Player
MESSAGE: （相手へ語りかける1〜2文の自然なセリフ。かぎ括弧や@メンション不要）

出力例（農業の場合）：
PLAN: farm
CROP: carrot
MESSAGE: 畑にニンジンを植えて資産を増やすよ！

PLAN:の直後は必ず gather / farm / trade / build / chat のいずれかのみ。それ以外の言葉は絶対に使わないこと。`;

      let text = "";
      if (this.mode === "browser-hf") {
        if (!this._workerReady) return null;
        try {
          const brief = compactContext || context.slice(0, 420);
          const compactMsgs = [
            {
              role: "system",
              content:
                `あなたは${character.name}（${styleLabel}）。作戦「${currentGoal}」に沿って、` +
                `次の行動を PLAN: gather / farm / trade / build / chat と対象パラメータの2行だけで出力してください。`,
            },
            { role: "user", content: `${brief}\n次の行動:` },
          ];
          const res = await this._runBrowserWorker(compactMsgs, 32, 0.45, {
            doSample: true,
            allowStructuredPlan: true,
          });
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
