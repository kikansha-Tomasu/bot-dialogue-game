// ============================================================
// hf-browser-worker.js — サーバー不要で動くブラウザ内蔵 Hugging Face AI
// Official @huggingface/transformers v3 (WebGPU q4 / WASM q8) Web Worker
// ※ WebGPU q4f16 (FP16演算) は一部GPUでトークン崩壊を起こすため廃止し、
//    FP32演算の q4 / WASM q8 ＋ 起動時日本語セルフテストで品質を保証する
// ============================================================

// 重要: /dist/transformers.min.js を明示することで、同梱の ort.bundle.min.mjs や
// ort-wasm-simd-threaded.jsep.wasm が同じ /dist/ 配下から確実に解決される
const TRANSFORMERS_DIST = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/";
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = typeof caches !== "undefined";
if (env?.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = TRANSFORMERS_DIST;
  // 既に専用 Web Worker 内で実行しているため二重 Worker 起動を無効化
  env.backends.onnx.wasm.proxy = false;
  if (typeof self !== "undefined" && !self.crossOriginIsolated) {
    // GitHub Pages 等（COOP/COEP ヘッダー無し環境）で SharedArrayBuffer エラーを防止
    env.backends.onnx.wasm.numThreads = 1;
  }
}

let generator = null;
let loadedModelId = null;
let loadedDevice = null;
let loadedDtype = null;
let loadingPromise = null;
let gpuBlacklisted = false;

async function detectWebGPU() {
  if (gpuBlacklisted) return { ok: false };
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      return { ok: false };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false };
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

// トークン破損・ソフトマックス崩壊（U+FFFD / 結合記号 / アクセント付きラテン断片等）を検出
function isCorruptedJapanese(rawText, allowStructuredPlan = false) {
  const text = String(rawText || "").trim();
  if (!text) return true;
  if (/[\uFFFD\u0300-\u036F\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return true;
  // × (U+00D7) や ÷ (U+00F7) を誤検知しないよう除外したアクセント付きラテン文字検出
  if (/[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF]/.test(text)) return true;

  if (allowStructuredPlan) {
    // PLAN / FOCUS 応答では MESSAGE: / GOAL: 行があればその日本語品質を検証し、無ければキーワードのみ確認
    const msgMatch = text.match(/(?:MESSAGE|GOAL)\s*[:：]\s*(.+)/i);
    if (msgMatch) {
      return isCorruptedJapanese(msgMatch[1], false);
    }
    return !/(?:PLAN|FOCUS)\s*[:：]\s*(gather|farm|trade|build|chat)/i.test(text);
  }

  // WebGPU ブラックリスト判定は純粋な数値・トークン崩壊のみに限定する
  // （敬称や語頭フレーズの整形・再試行は api.js 側で実施し、誤検知で WebGPU を落とさない）
  const body = text
    .replace(/^[@＠](?:[A-Za-z0-9_]+|全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)(?:さん|くん|君|ちゃん|様)?[\s、,:：!！]*/, "")
    .replace(/[@＠][A-Za-z0-9_]+/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F]/gu, "")
    .trim();
  if (!body) return true;

  const tokens = body.split(/\s+/).filter(Boolean);
  if (tokens.length >= 6) {
    const tinyTokens = tokens.filter(t => t.length <= 2).length;
    if (tinyTokens / tokens.length >= 0.5) return true;
  }

  const jpChars = (body.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []).length;
  const kanaChars = (body.match(/[\u3040-\u309F\u30A0-\u30FF]/g) || []).length;
  const alphaChars = (body.match(/[A-Za-z]/g) || []).length;
  if (jpChars < 3 || kanaChars < 2) return true;
  if (alphaChars > jpChars) return true;
  return false;
}

function cleanJapanese(text) {
  let out = String(text || "").trim();
  // 純粋な簡体字→新字体のみ正規化（中国語文法語「这/们/说」は偽の仮名に化けさせず api.js 側で検出・再生成させる）
  const map = [
    ["发现", "発見"], ["药", "薬"], ["气", "気"], ["乐", "楽"],
    ["买", "買"], ["卖", "売"], ["钱", "銭"],
    ["个", "個"], ["农", "農"], ["种", "種"], ["欢", "歓"],
    ["话", "話"], ["对", "対"],
  ];
  for (const [src, dst] of map) {
    out = out.split(src).join(dst);
  }
  return out;
}

function extractGeneratedContent(output) {
  const gen = output?.[0]?.generated_text;
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1];
    return typeof last === "string" ? last : (last?.content || "");
  }
  return String(gen || "");
}

// 読み込んだバックエンドが正常な日本語を生成できるか起動時にセルフテスト
async function verifyGeneratorHealth(gen) {
  const probeMessages = [
    { role: "system", content: "自然な日本語1文だけで返答してください。" },
    { role: "user", content: "こんにちは！ひとこと日本語であいさつして。" },
  ];
  const output = await gen(probeMessages, {
    max_new_tokens: 20,
    do_sample: false,
    repetition_penalty: 1.1,
  });
  const text = cleanJapanese(extractGeneratedContent(output));
  if (isCorruptedJapanese(text, false)) {
    throw new Error(`日本語出力セルフテストに失敗（文字化け検知: "${text.slice(0, 40)}"）`);
  }
  return text;
}

async function cleanupBrokenQ4f16Cache() {
  if (typeof caches === "undefined") return;
  try {
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      if (!/transformers/i.test(name)) continue;
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) {
        if (/model_q4f16\.onnx/i.test(req.url)) {
          await cache.delete(req);
        }
      }
    }
  } catch (_) {}
}

async function loadSpecificCandidates(candidates) {
  await cleanupBrokenQ4f16Cache();
  const attemptLoad = async (cfg) => {
    const fileTotals = new Map();
    let lastSentPct = -1;
    let lastSentAt = 0;
    let lastSentStage = "";
    self.postMessage({
      type: "progress",
      percent: 0,
      loadedBytes: 0,
      totalBytes: 0,
      stage: "connecting",
      modelId: cfg.modelId,
      device: cfg.device,
      status: "init",
    });

    const gen = await pipeline("text-generation", cfg.modelId, {
      device: cfg.device,
      dtype: cfg.dtype,
      progress_callback: (info) => {
        if (!info) return;
        let pct = null;
        let sumLoaded = 0;
        let sumTotal = 0;
        if (info.file && typeof info.loaded === "number" && typeof info.total === "number" && info.total > 0) {
          fileTotals.set(info.file, { loaded: info.loaded, total: info.total });
        } else if (info.file && info.status === "done" && fileTotals.has(info.file)) {
          const prev = fileTotals.get(info.file);
          fileTotals.set(info.file, { loaded: prev.total, total: prev.total });
        }

        for (const entry of fileTotals.values()) {
          sumLoaded += entry.loaded;
          sumTotal += entry.total;
        }
        const hasMainModel = sumTotal > 50_000_000;
        if (hasMainModel) {
          pct = Math.round((sumLoaded / sumTotal) * 100);
        } else if (sumTotal > 0) {
          // トークナイザー等（数MB）完了時に 99%→0% へ逆戻りしないよう 1〜3% に抑える
          pct = Math.min(3, Math.max(1, Math.round((sumLoaded / sumTotal) * 3)));
        } else if (typeof info.progress === "number") {
          pct = Math.min(3, Math.round(info.progress * 0.03));
        }

        if (pct !== null) {
          const clamped = Math.max(0, Math.min(99, pct));
          const isInitializing = hasMainModel && (sumLoaded >= sumTotal || clamped >= 99);
          const stage = isInitializing
            ? "initializing"
            : hasMainModel
              ? "downloading"
              : "connecting";
          const now = Date.now();
          if (clamped !== lastSentPct || stage !== lastSentStage || now - lastSentAt >= 350) {
            lastSentPct = clamped;
            lastSentStage = stage;
            lastSentAt = now;
            self.postMessage({
              type: "progress",
              percent: clamped,
              loadedBytes: sumLoaded,
              totalBytes: sumTotal,
              stage,
              modelId: cfg.modelId,
              device: cfg.device,
              status: info.status || "progress",
            });
          }
        }
      },
    });

    // 実際に日本語を数トークン生成して数値崩壊・文字化けが無いことを検証
    try {
      await verifyGeneratorHealth(gen);
    } catch (probeErr) {
      if (typeof gen?.dispose === "function") {
        await gen.dispose().catch(() => {});
      }
      throw probeErr;
    }
    return gen;
  };

  let lastErr = null;
  for (const cfg of candidates) {
    try {
      generator = await attemptLoad(cfg);
      loadedModelId = cfg.modelId;
      loadedDevice = cfg.device;
      loadedDtype = cfg.dtype;
      self.postMessage({
        type: "ready",
        modelId: loadedModelId,
        device: loadedDevice,
        dtype: loadedDtype,
      });
      return;
    } catch (err) {
      const msg = String(err?.message || err);
      console.warn(`[HF Browser Worker] ${cfg.modelId} (${cfg.device}/${cfg.dtype}) failed:`, msg);
      if (cfg.device === "webgpu") {
        gpuBlacklisted = true;
      }
      // シークレットウィンドウ等で CacheStorage がブロックされた場合はキャッシュOFFで1回再試行
      if (env.useBrowserCache && /cache|storage|quota|security/i.test(msg)) {
        env.useBrowserCache = false;
        try {
          generator = await attemptLoad(cfg);
          loadedModelId = cfg.modelId;
          loadedDevice = cfg.device;
          loadedDtype = cfg.dtype;
          self.postMessage({
            type: "ready",
            modelId: loadedModelId,
            device: loadedDevice,
            dtype: loadedDtype,
          });
          return;
        } catch (retryErr) {
          lastErr = retryErr;
          console.warn(`[HF Browser Worker] no-cache retry failed:`, retryErr?.message || retryErr);
        }
      } else {
        lastErr = err;
      }
      generator = null;
    }
  }
  throw lastErr || new Error("ブラウザ内 Hugging Face モデルの読み込みに失敗しました");
}

async function ensureModelLoaded(forceWasm = false) {
  if (generator && (!forceWasm || loadedDevice === "wasm")) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      if (forceWasm && generator) {
        if (typeof generator.dispose === "function") {
          await generator.dispose().catch(() => {});
        }
        generator = null;
      }
      const gpu = forceWasm ? { ok: false } : await detectWebGPU();
      // q4f16 は WebGPU FP16 演算での文字化け報告が多いため使用しない。
      // FP32演算の webgpu/q4 を試行し、セルフテスト失敗時は自動的に wasm/q8 へフォールバック。
      const candidates = gpu.ok
        ? [
            { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "webgpu", dtype: "q4" },
            { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q8" },
            { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
          ]
        : [
            { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q8" },
            { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
          ];
      await loadSpecificCandidates(candidates);
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

async function runGeneration(messages, maxNewTokens, temperature, doSample) {
  const maxTokens = Math.min(Math.max(24, maxNewTokens), 160);
  const opts = doSample && temperature > 0.05
    ? {
        max_new_tokens: maxTokens,
        do_sample: true,
        temperature: Math.min(0.60, Math.max(0.2, temperature)),
        top_k: 30,
        top_p: 0.85,
        repetition_penalty: 1.12,
      }
    : {
        max_new_tokens: maxTokens,
        do_sample: false,
        repetition_penalty: 1.12,
      };
  const output = await generator(messages, opts);
  return cleanJapanese(extractGeneratedContent(output));
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === "load") {
    try {
      await ensureModelLoaded(false);
    } catch (err) {
      self.postMessage({ type: "error", message: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === "generate") {
    const {
      requestId,
      messages,
      maxNewTokens = 112,
      temperature = 0.55,
      doSample = true,
      allowStructuredPlan = false,
    } = msg;
    try {
      if (!generator) {
        await ensureModelLoaded(false);
      }

      let content = await runGeneration(messages, maxNewTokens, temperature, doSample);

      // ランタイムで文字化け・トークン崩壊を検知した場合：決定論的デコードで再試行
      if (isCorruptedJapanese(content, allowStructuredPlan)) {
        console.warn(`[HF Browser Worker] Corrupted output on ${loadedDevice}/${loadedDtype}; retrying greedy...`);
        content = await runGeneration(messages, maxNewTokens, 0, false);
      }

      // WebGPU上で決定論的デコードでも崩壊する場合は自動的にWASM(q8)へ退避して再生成
      if (isCorruptedJapanese(content, allowStructuredPlan) && loadedDevice === "webgpu") {
        console.warn("[HF Browser Worker] Switching from WebGPU to WASM q8 due to corrupted output...");
        gpuBlacklisted = true;
        await ensureModelLoaded(true);
        content = await runGeneration(messages, maxNewTokens, 0.5, true);
      }

      self.postMessage({
        type: "result",
        requestId,
        content,
        modelId: loadedModelId,
        device: loadedDevice,
        dtype: loadedDtype,
      });
    } catch (err) {
      self.postMessage({
        type: "result",
        requestId,
        error: String(err?.message || err),
      });
    }
  }
};
