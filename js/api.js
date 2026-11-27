const HF_BROWSER_FEW_SHOT = {
  alice: [
    { role: "user", content: "Playerがあなたに「こんにちは！今日は何してるの？」と話しかけました。" },
    { role: "assistant", content: "こんにちは！私は広場の取引板を眺めながら、いい掘り出し物がないか探していたところだよ。" },
    { role: "user", content: "Bobがあなたに「木材が少しずつ貯まってきたよ。」と話しかけました。" },
    { role: "assistant", content: "へえ、順調そうだね！もし余ったら、手頃な値段で取引板に出してくれたら私が買うよ。" },
    { role: "user", content: "たった今、あなたは木材を1個採集しました。そばにいるみんなに感想を言ってください。" },
    { role: "assistant", content: "きれいな木材が取れたよ！あとで相場を見ながら売り時を考えようかな。" },
  ],
  bob: [
    { role: "user", content: "Playerがあなたに「こんにちは！今日は何してるの？」と話しかけました。" },
    { role: "assistant", content: "穏やかな風だな。私は少しずつ木や石を集めて、しっかりした建物を建てる準備をしているところさ。" },
    { role: "user", content: "Aliceがあなたに「相場が動きそうだよ！」と話しかけました。" },
    { role: "assistant", content: "そうだな、街が賑わうのはいいことだ。私は慌てず、納得できる値段のときだけ動くつもりだよ。" },
    { role: "user", content: "たった今、あなたは石を1個採集しました。そばにいるみんなに感想を言ってください。" },
    { role: "assistant", content: "いい石が見つかったよ。これでまた一つ、建物の土台に近づいたな。" },
  ],
  carol: [
    { role: "user", content: "Playerがあなたに「こんにちは！今日は何してるの？」と話しかけました。" },
    { role: "assistant", content: "こんにちは！私は畑で新鮮な野菜を育てて、とびきり美味しい料理を作ろうと思ってるところだよ！" },
    { role: "user", content: "Bobがあなたに「いい匂いがしてきたな。」と話しかけました。" },
    { role: "assistant", content: "えへへ、気づいてくれた？もうすぐ出来上がるから、取引板に並べたらぜひ見てみてね！" },
    { role: "user", content: "たった今、あなたは薬草を1個採集しました。そばにいるみんなに感想を言ってください。" },
    { role: "assistant", content: "香りばっちりの薬草が取れたよ！これで美味しい料理を仕込もうっと！" },
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
      this._worker = new Worker("js/hf-browser-worker.js?v=gh18", { type: "module" });
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

  _runBrowserWorker(messages, maxNewTokens = 112, temperature = 0.55, options = {}) {
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

  // 文末が途中で途切れている（トークン上限切れ・括弧未閉じ・助詞や連用形終わり・不自然な句点止め等）を検出
  static endsWithCutoff(rawBody) {
    const s = String(rawBody ?? "").trim();
    if (!s) return true;
    // 括弧の開きっぱなし（途中切れの典型的サイン）
    const openPairs = [["「", "」"], ["『", "』"], ["（", "）"], ["(", ")"]];
    for (const [op, cl] of openPairs) {
      const nOpen = s.split(op).length - 1;
      const nClose = s.split(cl).length - 1;
      if (nOpen > nClose) return true;
    }
    // 読点・コロン・開き括弧・スラッシュ等の途中記号で終わっている
    if (/[、,・：:;「『（(\[【\/\\]$/.test(s)) return true;

    // 末尾の装飾絵文字・閉じ括弧を除いた本体で判定（「採集したよ✨」等を誤検知しない）
    const noEmoji = s.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F♪♡♥★☆✨]+$/gu, "").trim();
    const punctMatch = noEmoji.match(/^([\s\S]*?)([。！？!?〜…]+)[」』"”'）)]*$/);
    if (punctMatch) {
      const core = punctMatch[1].trim();
      const punct = punctMatch[2];
      // サーバー補完やモデル誤出力で途中切れに「。」が付いたケースを検出（例: 売ろうと思っ。/ ニンジンを。/ 集めて。）
      // （「こんにちは！」「こんばんは！」「負けないんだから！」等の自然な感嘆・挨拶は誤検知しない）
      if (!core) return true;
      if (/(?:っ|を|新鮮な|静かな|お得な|育てていな|売らな|見てみよ|集めよ)$/.test(core)) {
        return true;
      }
      if (punct === "。" && /(?:て|んで|けど|けれど|ので|のに|ながら|たり|つつ|が|に|へ|で|まで|より|(?<!こんにち|こんばん)は)$/.test(core)) {
        return true;
      }
      return false;
    }

    const core = noEmoji.replace(/[」』"”'）)]+$/, "").trim();
    if (!core) return true;
    // 途中切れの典型パターン（助詞・促音・連用形・形容動詞連体形・未然形「〜な」・未完「〜みよ/〜めよ」・抽象名詞止め）
    if (/(?:を|が|に|(?<!こんにち|こんばん)は|へ|で|と|も|から|まで|より|けど|けれど|ので|のに|って|ながら|たり|つつ|て|んで|っ|し|集め|育て|進め|考え|見つけ|始め|続け|話し|食べ|飲め|売れ|買え|建て|植え)$/.test(core)) {
      return true;
    }
    if (/(?:[\u4E00-\u9FFF\u30A0-\u30FF0-9]の|ための|ことの|ものの)$/.test(core)) return true;
    if (/(?:ていな|でいな|[あらわがざばま]な|[\u4E00-\u9FFF]な|(?:静か|穏やか|にぎやか|華やか|爽やか|鮮やか|細やか|軽やか|緩やか|柔らか|滑らか|豊か|明らか|確か|僅か|わずか|はるか|密か|ひそか)な|みよ|めよ|べよ|けよ|せよ|ねよ|れよ|げよ|ぜよ|高さ|おいしさ|美味しさ|良さ|強さ|安さ|まか|何か)$/.test(core)) {
      return true;
    }

    // 文末記号が無い場合、日本語の自然な終止表現（丁寧体・常体・終助詞・勧誘・挨拶）で終わっているか確認
    const naturalEndingRe = /(?:です|ます|ました|でした|ません|たい|ない|ろう|よう|しょう|[おこそとのほもよろごぞどぼぽ]う|くれ|ちょうだい|ありがとう|よろしく|ごめん|おはよう|こんにちは|こんばんは|おつかれ|なの|んだ|んです|んだよ|んだね|おっけー|OK|つもりだ|感じだ|最高だ|元気だ|好きだ|だよ|だね|だな|かな|かも|つもりさ|ものさ|わけさ|はずさ|のさ|[だたるいうくすつぬぶむぐ][よねなさわぞぜか]|(?:っ|し|い|ん)た|(?:[ぁ-ん]|[\u4E00-\u9FFF])(?:る|い)|だ)$/;
    return !naturalEndingRe.test(core);
  }

  static truncateToSentences(text, maxSentences = 2) {
    const str = String(text ?? "").trim();
    if (!str) return "";
    const regex = /[。！？!?]+[」』"”'）)]*/g;
    const matches = [];
    let match;
    while ((match = regex.exec(str)) !== null) {
      matches.push(match);
      if (matches.length >= maxSentences) {
        return str.slice(0, match.index + match[0].length).trim();
      }
    }
    // 1文完結＋2文目が途中で途切れている場合は、完結している最後の文で綺麗に区切る
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      const endPos = last.index + last[0].length;
      const tail = str.slice(endPos).trim();
      if (tail && HuggingFaceClient.endsWithCutoff(tail)) {
        return str.slice(0, endPos).trim();
      }
    }
    return str;
  }

  // 自分のことを「彼」「彼女」や自分の名前で三人称呼びしてしまう小型モデル特有の不具合を検出
  static hasSelfThirdPerson(rawBody, speakerName = null, targetName = null) {
    const s = String(rawBody ?? "").trim();
    if (!s) return false;

    const CHAR_ALIASES = {
      alice: ["Alice", "アリス"],
      bob: ["Bob", "ボブ"],
      carol: ["Carol", "キャロル"],
      player: ["Player", "プレイヤー"],
    };

    const speakerKey = speakerName ? String(speakerName).toLowerCase() : "";
    const targetKey = targetName ? String(targetName).toLowerCase() : "";

    // 1) 文頭・節頭で話者自身の名前を主語にして三人称語りしている（「こんにちは！Aliceは〜」「アリスは〜」等）
    if (speakerKey && CHAR_ALIASES[speakerKey]) {
      const selfPattern = CHAR_ALIASES[speakerKey].join("|");
      if (new RegExp(`(?:^|[、。！？!?\\s「『（(])(?:${selfPattern})(?:は|が|も|の|って)`).test(s)) {
        return true;
      }
    }

    // 2) 単数の「彼」「彼女」（文中含む・複合語「彼ら/彼方/彼岸」除外）：
    //    その出現位置より「前」に話者でも相手でもない第三者名が明示されていなければ誤用と判定
    const pronounRe = /(?<![元今前])(?:彼|彼女)(?![ら方岸])(?:は|が|も|の|を|に|と|へ|から|より|まで|って|だ|じゃ|自身|なら|こそ|だって|だけ|みたい)/g;
    let hit;
    while ((hit = pronounRe.exec(s)) !== null) {
      const before = s.slice(0, hit.index);
      const hasPriorThirdParty = Object.entries(CHAR_ALIASES).some(([key, aliases]) => {
        if (key === speakerKey || key === targetKey) return false;
        return aliases.some(alias => new RegExp(alias, "i").test(before));
      });
      if (!hasPriorThirdParty) {
        return true;
      }
    }

    return false;
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
    // アクセント付きラテン文字（× U+00D7 / ÷ U+00F7 を除外しつつ é, í, ǎ, ó 等の多言語崩壊トークンを検出）
    if (/[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF]/.test(text)) return true;

    // プロンプト見出し・推敲ラベル漏れ・非人間/ゲームメタ表現・簡体字中国語文法漏れを拒否
    if (/(?:【(?:相手の直前の発言|あなたの状況|自分の状況|返答のルール|いま起きた出来事|現在の状況|あなたの戦法|直近の会話|ライバル総資産ランキング|あなたの資産状況|農業の状況|他のライバルの所持品|現在の注文板|直近の取引価格)】|役職[:：]|元のセリフ[:：]|言い直したセリフ[:：]|相手の発言[:：]|直す点[:：]|自然な話し言葉|AIアシスタント|人工知能|言語モデル|プロンプト|仮想世界|ゲームの中|2Dの世界|(?<![ァ-ヶー])ボット|NPC|キャラクターとして|プログラム|(?<![A-Za-z])(?:AI|Bot)(?![A-Za-z]))/i.test(text)) {
      return true;
    }
    // 日本の常用漢字（把・没）は除外し、純粋な中国語文法語・簡体字のみを検出
    if (/[这吗呢吧很给让说们为从该]/.test(text)) {
      return true;
    }

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
    // 話者ラベルや前置き・推敲ラベル（Alice: / 返答： / 言い直したセリフ： / MESSAGE: 等）を除去
    s = s.replace(/^(?:(?:Alice|Bob|Carol|Player|Assistant|MESSAGE|返答|返信|セリフ|発言|言い直したセリフ|自然なセリフ|推敲後|修正後)\s*[:：]\s*)+/i, "").trim();
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

  static cleanDialogueResponse(rawText, targetName, speakerName = null) {
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
    if (HuggingFaceClient.endsWithCutoff(text)) return "";
    if (HuggingFaceClient.hasSelfThirdPerson(text, speakerName, targetName)) return "";

    return targetName ? `@${targetName} ${text}`.trim() : text;
  }

  static sanitizeAnnounceMessage(rawMsg, targetName, speakerName = null) {
    if (!rawMsg) return null;
    const cleaned = HuggingFaceClient.cleanDialogueResponse(rawMsg, targetName || null, speakerName);
    return cleaned || null;
  }

  // 日本語の自然さを採点（0〜100）し、推敲（Polish）すべき具体的な不自然ポイントを返す
  static scoreNaturalness(rawText, speakerName = null, targetName = null, options = {}) {
    const cleaned = HuggingFaceClient.cleanDialogueResponse(rawText, targetName || null, speakerName);
    if (!cleaned) {
      return { score: 0, issues: ["有効な日本語の話し言葉に直す"] };
    }
    const body = HuggingFaceClient.stripLeadingMention(cleaned, targetName);
    let score = 90;
    const issues = [];

    // 1. 翻訳調・硬い書き言葉・事務的な表現
    if (/(?:を行い|を行う|を行った|を実施|を獲得|が可能|について述べ|非常に|大変良|目指しており|を目指してい|である[。！]?$|なのだよ|でございます|させていただ|いたします|おります|申し上げ|について考えて|と存じます|と思われます|することができます|することが重要|確認いたしました|理解しました|承知しました)/.test(body)) {
      score -= 28;
      issues.push("硬い書き言葉や翻訳調をやめて普段の自然な話し言葉にする");
    }

    // 2. 敬語（です/ます）とタメ口の不自然な混在、および親しみやすい住人なのに堅すぎる敬語
    const hasPolite = /(?:です|ます|ました|でした|ません|でしょうか)(?:[よねか！!？?。]|$)/.test(body);
    const hasCasual = /(?:だよ|だね|だな|だぞ|だぜ|かな|なの|しよう|[うくすつぬぶむるぐ][よねさ]|た[よねさ]|い[よねさ]|んだ|っと)(?:[。！？!?]|$)/.test(body);
    if (hasPolite && hasCasual) {
      score -= 22;
      issues.push("敬語とタメ口が混ざらないよう口調を統一する");
    } else if (hasPolite && String(options.speechTone || "").startsWith("casual_")) {
      score -= 14;
      issues.push("よそよそしい敬語をやめて仲間と話す親しみやすいタメ口にする");
    }

    // 3. 一人称・二人称の不自然な連発（「私は〜、私は〜」「あなた〜、あなた〜」）
    const watashiCount = (body.match(/私/g) || []).length;
    const anataCount = (body.match(/あなた/g) || []).length;
    if (watashiCount >= 2 || anataCount >= 2) {
      score -= 18;
      issues.push("「私」「あなた」を繰り返さず自然な省略を使う");
    }

    // 4. 同じフレーズ・単語の不自然な反復（吃り・ループ）※全一致を検査し、自然な擬態語・副詞は許容
    const allowedRedup = /^(?:ふわふわ|フワフワ|わくわく|ワクワク|ドキドキ|どきどき|コツコツ|こつこつ|いろいろ|色々|ときどき|時々|みんな|どんどん|ドンドン|ますます|にこにこ|ニコニコ|ふむふむ|そろそろ|なかなか|たまたま|たびたび|ほくほく|ホクホク|もちもち|モチモチ|さくさく|サクサク|ほかほか|ホカホカ|あつあつ|アツアツ|ぴかぴか|ピカピカ|きらきら|キラキラ|つやつや|ツヤツヤ|しゃきしゃき|シャキシャキ|ぽかぽか|ポカポカ|すくすく|じわじわ|まだまだ|いよいよ|だんだん|そうそう|ただただ|ばたばた|バタバタ|ぎりぎり|ギリギリ|おいおい|ほらほら|えへへ|あはは|うふふ)$/;
    const dupLong = /([ぁ-んァ-ヶ一-龥]{4,})[\s、。！？!?]{0,6}\1/.test(body) && !/なるほどなるほど/.test(body);
    let hasBadShortDup = false;
    for (const m of body.matchAll(/([ぁ-んァ-ヶ一-龥]{2,3})\1/g)) {
      if (!allowedRedup.test(m[0])) {
        hasBadShortDup = true;
        break;
      }
    }
    if (dupLong || hasBadShortDup) {
      score -= 30;
      issues.push("同じ言葉やフレーズの重複をなくす");
    }

    // 5. 不自然な句読点・日本語途中の空白
    if (/(?:、、|。。|[！!]{3,}|[？?]{3,}|[\u3040-\u30FF\u4E00-\u9FFF]\s+[\u3040-\u30FF\u4E00-\u9FFF])/.test(body)) {
      score -= 18;
      issues.push("不自然な空白や句読点の重なりを整える");
    }

    // 6. 相手の直前発言のオウム返し（行動メモ "(木材を1個採集した)" 等は除外）
    const rawIncoming = String(options.incomingText || "").trim();
    const isActionMemo = rawIncoming.startsWith("(") && rawIncoming.endsWith(")");
    const incoming = isActionMemo
      ? ""
      : rawIncoming
          .replace(/^[@＠]\w+[\s、,:：]*/, "")
          .replace(/[\s。！？!?、,「」『』]/g, "");
    const cleanBody = body.replace(/[\s。！？!?、,「」『』]/g, "");
    if (incoming.length >= 8 && cleanBody.length >= 6) {
      const inBigrams = new Set();
      for (let i = 0; i < incoming.length - 1; i++) inBigrams.add(incoming.slice(i, i + 2));
      let overlap = 0;
      const total = Math.max(1, cleanBody.length - 1);
      for (let i = 0; i < cleanBody.length - 1; i++) {
        if (inBigrams.has(cleanBody.slice(i, i + 2))) overlap++;
      }
      if (overlap / total >= 0.7) {
        score -= 35;
        issues.push("相手の発言をそのまま繰り返さず自分の言葉で返事をする");
      }
    }

    // 7. 短すぎ・長すぎのバランス（「ありがとう！」「わかったよ！」等の自然な短返答は許容）
    if ((incoming.length >= 8 && cleanBody.length < 5) || cleanBody.length > 95) {
      score -= 14;
      issues.push("短すぎず長すぎない自然な1〜2文の会話にする");
    }

    // 8. 話者の口調らしさボーナス（末尾絵文字や全角・半角句読点を含めて自然に判定）
    const tone = options.speechTone || "";
    const voiceCore = body
      .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F♪♡♥★☆✨]+$/gu, "")
      .replace(/[」』"”'）)]+$/, "")
      .trim();
    const voiceMatched = tone === "casual_calm_male"
      ? /(?:だな|たな|さ|だね|だよ|かな|よう|ろう|な|ね|よ|[？?])[。！？!?〜…]*$/.test(voiceCore)
      : /(?:だよ|だね|かな|な|よ|ね|しよう|みるよ|てるよ|るね|っと|[？?！!])[。！？!?〜…]*$/.test(voiceCore);
    if (voiceMatched && issues.length === 0) {
      score += 5;
    }

    return { score: Math.max(0, Math.min(100, score)), issues };
  }

  async _callDirectCloudRouter(messages, maxTokens, temperature = 0.55) {
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
          temperature,
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

  async callAI(character, userMessage, targetName, historyUserMessage, options = {}) {
    const model = character.model || this.model;
    const queueKey = this.mode === "browser-hf" ? "browser-hf" : model;
    return this._withQueue(queueKey, async () => {
      const incomingText = options.incomingText
        || String(historyUserMessage || "").replace(/^[A-Za-z0-9_]+\s*[:：]\s*/, "").trim();
      const speechTone = character.speechTone
        || (character.id === "bob" ? "casual_calm_male" : character.id === "carol" ? "casual_cheerful" : "casual_bright");
      const promptWithHint = targetName
        ? `${userMessage}\n（街に暮らす生身の人間として、一人称「私」で${targetName}へ直接話す自然な日本語1〜2文だけを最後まで言い切ってください。かぎ括弧や@メンションは不要）`
        : `${userMessage}\n（街に暮らす生身の人間として、一人称「私」で自然な日本語の話し言葉1〜2文だけを最後まで言い切ってください。かぎ括弧や@メンションは不要）`;

      const browserSystem =
        `${character.compactPersonality || character.personality}\n` +
        `街に暮らす一人の人間として、自然な日本語の話し言葉1〜2文だけを最後まで言い切ってください。`;

      const buildDraftMessages = (history, extraHint = "") => {
        const content = extraHint ? `${promptWithHint}\n${extraHint}` : promptWithHint;
        if (this.mode === "browser-hf") {
          const fewShot = HF_BROWSER_FEW_SHOT[character.id] || [];
          return [
            { role: "system", content: browserSystem },
            ...fewShot,
            ...history.slice(-2),
            { role: "user", content },
          ];
        }
        return [
          { role: "system", content: character.personality },
          ...history,
          { role: "user", content },
        ];
      };

      const buildPolishMessages = (draftBody, issues = []) => {
        const toneNote = speechTone === "casual_calm_male"
          ? "落ち着いた優しい男性口調（「〜だな」「〜さ」「〜だね」）"
          : speechTone === "casual_cheerful"
            ? "明るく弾む親しみやすいタメ口（「〜だよ！」「〜ね！」）"
            : "明るく親しみやすいタメ口（「〜だよ！」「〜だね」「〜かな？」）";
        const exampleRewrite = speechTone === "casual_calm_male"
          ? "いい木材が採れたよ。あとで取引板に出してみようかな。"
          : speechTone === "casual_cheerful"
            ? "いい木材が取れたよ！あとで取引板に出してみるね！"
            : "いい木材が取れたよ！あとで取引板に出してみようかな。";
        const issueGuide = issues.length > 0
          ? `直す点：${issues.slice(0, 2).join("／")}\n`
          : "直す点：もっと人間味のある自然な話し言葉に整える\n";
        const toLine = targetName ? `話す相手：${targetName}\n` : "";
        const contextLine = incomingText && !(incomingText.startsWith("(") && incomingText.endsWith(")"))
          ? `相手の発言：「${incomingText}」\n`
          : "";
        return [
          {
            role: "system",
            content:
              `あなたはこの街に暮らす人間の${character.name}です。${toneNote}、一人称「私」で話します。` +
              `下書きのセリフを、より自然で人間らしい日本語の話し言葉1〜2文に言い直し、言い直したセリフだけを出力してください。`,
          },
          {
            role: "user",
            content: "元のセリフ：私は木材の獲得を行いました。非常に良いと思います。\n直す点：硬い書き言葉や翻訳調をやめて普段の自然な話し言葉にする\n言い直したセリフ：",
          },
          {
            role: "assistant",
            content: exampleRewrite,
          },
          {
            role: "user",
            content:
              `${toLine}${contextLine}` +
              `元のセリフ：${draftBody}\n` +
              `${issueGuide}` +
              `言い直したセリフ：`,
          },
        ];
      };

      let hadSuccessPass = false;
      const generatePass = async (msgs, maxTokens, temperature, doSample, isDraftPass = false) => {
        if (this.mode === "browser-hf") {
          const cloudReply = await this._callDirectCloudRouter(msgs, maxTokens || GAME_CONFIG.maxTokens, temperature).catch(() => null);
          if (cloudReply) {
            character.lastUsedModel = "Qwen/Qwen2.5-7B-Instruct";
            this.hfAvailable = true;
            this.lmAvailable = true;
            hadSuccessPass = true;
            return cloudReply;
          }
          const res = await this._runBrowserWorker(msgs, maxTokens, temperature, { doSample });
          if (res.modelId) character.lastUsedModel = res.modelId;
          this.hfAvailable = true;
          this.lmAvailable = true;
          hadSuccessPass = true;
          return res.content || "";
        }

        const sendLocal = (payloadMsgs) => this._fetchWithTimeout(
          this.endpoint,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens || GAME_CONFIG.maxTokens,
              temperature,
              stream: false,
              messages: payloadMsgs,
            }),
          },
          90000
        );

        let response = await sendLocal(msgs);
        // 履歴超過の400リトライは下書きパス時のみ実施（推敲パスのメッセージを下書きで上書きしない）
        if (isDraftPass && response.status === 400 && character.conversationHistory.length > 4) {
          character.conversationHistory = character.conversationHistory.slice(-4);
          response = await sendLocal(buildDraftMessages(character.conversationHistory));
        }
        if (!response.ok) {
          let errMsg = `HTTP ${response.status}`;
          try {
            const err = await response.json();
            errMsg = err.error?.message || errMsg;
          } catch (_) {}
          if (!hadSuccessPass && (response.status === 502 || response.status === 503 || response.status === 401)) {
            this.hfAvailable = false;
            this.lmAvailable = false;
          }
          throw new Error(errMsg);
        }
        this.hfAvailable = true;
        this.lmAvailable = true;
        hadSuccessPass = true;
        const data = await response.json();
        if (data.hf_model_used) {
          character.lastUsedModel = data.hf_model_used;
        }
        return data.choices?.[0]?.message?.content?.trim()
          || data.choices?.[0]?.message?.reasoning_content?.trim()
          || "";
      };

      const candidates = [];
      const evaluateAndAdd = (raw, stage) => {
        if (!raw) return null;
        const cleaned = HuggingFaceClient.cleanDialogueResponse(raw, targetName, character.name);
        if (!cleaned || (targetName && cleaned === `@${targetName}`)) return null;
        const evalRes = HuggingFaceClient.scoreNaturalness(cleaned, character.name, targetName, {
          incomingText,
          speechTone,
        });
        const entry = {
          text: cleaned,
          body: HuggingFaceClient.stripLeadingMention(cleaned, targetName),
          score: evalRes.score,
          issues: evalRes.issues,
          stage,
        };
        candidates.push(entry);
        return entry;
      };

      // Pass 1: 下書き生成（Draft）
      const draftRaw = await generatePass(
        buildDraftMessages(character.conversationHistory),
        112,
        0.52,
        true,
        true
      );
      const draftEntry = evaluateAndAdd(draftRaw, "draft");

      // Pass 2: 推敲（Polish）または厳格再生成
      if (draftEntry && draftEntry.score < 95) {
        try {
          const polishRaw = await generatePass(
            buildPolishMessages(draftEntry.body, draftEntry.issues),
            104,
            0.38,
            true,
            false
          );
          evaluateAndAdd(polishRaw, "polish");
        } catch (err) {
          console.warn(`[Dialogue Polish] ${character.name} polish pass skipped:`, err?.message || err);
        }
      } else if (!draftEntry) {
        try {
          const retryRaw = await generatePass(
            buildDraftMessages(
              character.conversationHistory,
              "※必ず一人称「私」で、街に暮らす人間らしい自然な話し言葉1文を句点（。または！）まで言い切ってください。"
            ),
            96,
            0,
            false,
            true
          );
          evaluateAndAdd(retryRaw, "retry");
        } catch (err) {
          console.warn(`[Dialogue Retry] ${character.name} retry pass failed:`, err?.message || err);
        }
      }

      // Pass 3: まだ有効案が無い、または最高スコアが低い（< 72）場合のみ決定論的リトライ／再推敲
      const pickBest = () => {
        if (!candidates.length) return null;
        return candidates.reduce((best, cur) => {
          if (!best) return cur;
          if (cur.score > best.score) return cur;
          // 同点かつ元の下書きに課題があった場合は、十分な長さがある推敲版を優先
          if (cur.score === best.score && cur.stage === "polish" && best.issues.length > 0 && cur.body.length >= 10) {
            return cur;
          }
          return best;
        }, null);
      };

      let best = pickBest();
      if (!best) {
        try {
          const rescueRaw = await generatePass(
            buildDraftMessages(
              [],
              "※一人称「私」で、短く自然な1文だけを句点（。または！）で終えて出力してください。"
            ),
            88,
            0,
            false,
            false
          );
          evaluateAndAdd(rescueRaw, "rescue");
          best = pickBest();
        } catch (_) {}
      } else if (best.score < 72 && candidates.length < 3) {
        try {
          const repolishRaw = await generatePass(
            buildPolishMessages(best.body, best.issues),
            96,
            0,
            false,
            false
          );
          evaluateAndAdd(repolishRaw, "polish");
          best = pickBest();
        } catch (_) {}
      }

      if (!best) {
        throw new Error("有効な返答を生成できませんでした");
      }

      const text = best.text;
      // 履歴には @メンション無しの自然な本文を保存し、小型モデルの不要な @出力癖を防ぐ
      const historyBody = best.body;
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
        `街のみんなを上回り一番の資産家になるため、今の街と商売の状況（順位・手持ち・建物・畑・取引板・相場）を踏まえて、これからの作戦を次の3行だけで出力してください。説明不要。\n` +
        `FOCUS: gather / farm / trade / build のいずれか1つ\n` +
        `TARGET_ITEM: 狙う品目（wood/stone/herb/fish/carrot/wheat/cabbage/tomato/corn/rice/pumpkin/strawberry/carrot_salad/herb_bread/tomato_soup/onigiri_bento/pumpkin_pie/strawberry_tart）\n` +
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
**他の仲間たち（Player含む）は全員、同じ街で暮らす生身のライバルです。目標: 総資産ランキングでみんなを上回り1位になること。**
**あなたの得意戦法: ${styleLabel} ／ 現在の長期作戦: ${currentGoal}**
**重要ルール: コインは取引板での売買成立によってのみ増えます。作物や料理も収穫・調理しただけではコインにならないため、売りたい場合は取引板に注文を出して売ってください。**

状況と自分の長期作戦を踏まえ、以下の形式で次の行動を**1回だけ**出力してください。説明不要。

採集する場合：
PLAN: gather
RESOURCE: wood または stone または herb または fish
MESSAGE: （採集後の一言。自分らしい自然な話し言葉で、かぎ括弧や@メンション不要）

農業（種まき・収穫・料理）をする場合：
PLAN: farm
CROP: carrot または wheat または cabbage または tomato または corn または rice または pumpkin または strawberry
MESSAGE: （農業・収穫についての一言。自分らしい自然な話し言葉で、かぎ括弧や@メンション不要）

取引する場合：
PLAN: trade
ACTION: sell または buy または execute または skip
RESOURCE: 資源(wood/stone/herb/fish)・作物(carrot/wheat/cabbage/tomato/corn/rice/pumpkin/strawberry)・料理(carrot_salad/herb_bread/tomato_soup/onigiri_bento/pumpkin_pie/strawberry_tart)のいずれか
AMOUNT: 数量（整数）
COINS: コイン数（整数）
MESSAGE: （取引をみんなに知らせる一言。自分らしい自然な話し言葉で、かぎ括弧や@メンション不要）

建築する場合：
PLAN: build
BUILD: campfire または flowerBed または woodenFence または fishingSpot
MESSAGE: （建築を知らせる一言。自分らしい自然な話し言葉で、かぎ括弧や@メンション不要）

チャットで交渉・牽制・情報収集する場合：
PLAN: chat
TARGET: Alice または Bob または Carol または Player
MESSAGE: （相手へ語りかける1〜2文の自然な話し言葉。かぎ括弧や@メンション不要）

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
