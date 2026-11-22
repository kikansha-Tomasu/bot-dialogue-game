// ============================================================
// hf-browser-worker.js — サーバー不要で動くブラウザ内蔵 Hugging Face AI
// Official @huggingface/transformers v3 (WebGPU / WASM) Web Worker
// ============================================================

import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

env.allowLocalModels = false;
env.useBrowserCache = true;
if (typeof self !== "undefined" && !self.crossOriginIsolated && env?.backends?.onnx?.wasm) {
  // GitHub Pages 等（COOP/COEP ヘッダー無し環境）で SharedArrayBuffer エラーを防止
  env.backends.onnx.wasm.numThreads = 1;
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
    const candidates = gpu.ok
      ? [
          {
            modelId: "onnx-community/Qwen2.5-1.5B-Instruct",
            device: "webgpu",
            dtype: gpu.hasFp16 ? "q4f16" : "q4",
          },
          {
            modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
            device: "webgpu",
            dtype: gpu.hasFp16 ? "q4f16" : "q4",
          },
          { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
        ]
      : [
          { modelId: "onnx-community/Qwen2.5-0.5B-Instruct", device: "wasm", dtype: "q4" },
        ];

    let lastErr = null;
    for (const cfg of candidates) {
      try {
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

        generator = await pipeline("text-generation", cfg.modelId, {
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
              // 主要な ONNX モデルファイルがダウンロード完了し、WebGPU/WASM 初期化へ入った段階を明示
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

        loadedModelId = cfg.modelId;
        loadedDevice = cfg.device;
        self.postMessage({
          type: "ready",
          modelId: loadedModelId,
          device: loadedDevice,
        });
        return;
      } catch (err) {
        lastErr = err;
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
