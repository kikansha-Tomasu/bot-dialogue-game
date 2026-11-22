// ============================================================
// hf-browser-worker.js — サーバー不要で動くブラウザ内蔵 Hugging Face AI
// Official @huggingface/transformers v3 (WebGPU / WASM) Web Worker
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
let loadingPromise = null;

async function detectWebGPU() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      return { ok: false, hasFp16: false };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, hasFp16: false };
    const hasFp16 = Boolean(adapter.features && adapter.features.has("shader-f16"));
    return { ok: true, hasFp16 };
  } catch (_) {
    return { ok: false, hasFp16: false };
  }
}

async function ensureModelLoaded() {
  if (generator) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const gpu = await detectWebGPU();
    // 460〜488MB 級の高速・安定 ONNX モデルを優先（1.2GB超によるブラウザメモリ不足を防止）
    const candidates = gpu.ok
      ? (gpu.hasFp16
          ? [
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "webgpu", dtype: "q4f16" },
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "webgpu", dtype: "q4" },
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q8" },
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
            ]
          : [
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "webgpu", dtype: "q4" },
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q8" },
              { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
            ])
      : [
          { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q8" },
          { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
        ];

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

      return await pipeline("text-generation", cfg.modelId, {
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
          if (sumTotal > 0) {
            pct = Math.round((sumLoaded / sumTotal) * 100);
          } else if (typeof info.progress === "number") {
            pct = Math.round(info.progress);
          }

          if (pct !== null) {
            const clamped = Math.max(0, Math.min(99, pct));
            const isInitializing = (sumTotal > 50_000_000 && sumLoaded >= sumTotal) || clamped >= 99;
            const stage = isInitializing
              ? "initializing"
              : sumTotal > 0
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
    };

    let lastErr = null;
    for (const cfg of candidates) {
      try {
        generator = await attemptLoad(cfg);
        loadedModelId = cfg.modelId;
        loadedDevice = cfg.device;
        self.postMessage({
          type: "ready",
          modelId: loadedModelId,
          device: loadedDevice,
        });
        return;
      } catch (err) {
        const msg = String(err?.message || err);
        console.warn(`[HF Browser Worker] ${cfg.modelId} (${cfg.device}/${cfg.dtype}) failed:`, msg);
        // シークレットウィンドウ等で CacheStorage がブロックされた場合はキャッシュOFFで1回再試行
        if (env.useBrowserCache && /cache|storage|quota|security/i.test(msg)) {
          env.useBrowserCache = false;
          try {
            generator = await attemptLoad(cfg);
            loadedModelId = cfg.modelId;
            loadedDevice = cfg.device;
            self.postMessage({
              type: "ready",
              modelId: loadedModelId,
              device: loadedDevice,
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
    loadingPromise = null;
    throw lastErr || new Error("ブラウザ内 Hugging Face モデルの読み込みに失敗しました");
  })();

  return loadingPromise;
}

function cleanJapanese(text) {
  let out = String(text || "").trim();
  const map = [
    ["发现", "発見"], ["药", "薬"], ["气", "気"], ["乐", "楽"],
    ["买", "買"], ["卖", "売"], ["钱", "銭"], ["这", "この"],
  ];
  for (const [src, dst] of map) {
    out = out.split(src).join(dst);
  }
  return out;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === "load") {
    try {
      await ensureModelLoaded();
    } catch (err) {
      self.postMessage({ type: "error", message: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === "generate") {
    const { requestId, messages, maxNewTokens = 64, temperature = 0.72 } = msg;
    try {
      if (!generator) {
        await ensureModelLoaded();
      }
      const output = await generator(messages, {
        max_new_tokens: Math.min(Math.max(32, maxNewTokens), 110),
        do_sample: true,
        temperature,
        top_p: 0.9,
        repetition_penalty: 1.15,
      });

      const gen = output?.[0]?.generated_text;
      let content = "";
      if (Array.isArray(gen)) {
        const last = gen[gen.length - 1];
        content = typeof last === "string" ? last : (last?.content || "");
      } else {
        content = String(gen || "");
      }

      self.postMessage({
        type: "result",
        requestId,
        content: cleanJapanese(content),
        modelId: loadedModelId,
        device: loadedDevice,
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
