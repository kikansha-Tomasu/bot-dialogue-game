// ============================================================
// hf-tts-worker.js — サーバー不要で動くブラウザ内蔵 Hugging Face ニューラル日本語音声
// piper-plus (MB-iSTFT-VITS2 + Rust WASM OpenJTalk G2P) + onnxruntime-web
// Models:
//   - ayousanz/piper-plus-tsukuyomi-chan (つくよみちゃん・自然な女性日本語音声, 37.8MB)
//   - ayousanz/piper-plus-css10-ja-6lang (CSS10・自然な男性日本語音声, 37.8MB)
// ============================================================

import { PiperPlus } from "https://cdn.jsdelivr.net/npm/piper-plus@0.9.1/+esm";
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.mjs";

const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
// jsDelivr は 50MB 超の WASM を 403 で制限するため、CORS 許可済みの unpkg から Rust WASM G2P を取得
const WASM_G2P_URL = "https://unpkg.com/piper-plus@0.9.1/dist/rust-wasm/piper_plus_wasm.js";

if (ort?.env?.wasm) {
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.wasm.proxy = false;
  if (typeof self !== "undefined" && !self.crossOriginIsolated) {
    ort.env.wasm.numThreads = 1;
  }
}

const CHAR_VOICE_PROFILES = {
  Alice: { model: "tsukuyomi", lengthScale: 0.96, noiseScale: 0.45, noiseW: 0.55 },
  Bob:   { model: "css10",     lengthScale: 1.03, noiseScale: 0.36, noiseW: 0.46 },
  Carol: { model: "tsukuyomi", lengthScale: 0.88, noiseScale: 0.54, noiseW: 0.62 },
};

let sharedWasmPromise = null;
const voiceInstances = new Map();
const voicePromises = new Map();
let synthQueue = Promise.resolve();

function getSharedWasmModule() {
  if (!sharedWasmPromise) {
    sharedWasmPromise = (async () => {
      const mod = await import(WASM_G2P_URL);
      if (typeof mod.default === "function") {
        await mod.default();
      }
      return mod;
    })().catch((err) => {
      sharedWasmPromise = null;
      throw err;
    });
  }
  return sharedWasmPromise;
}

function ensureVoiceLoaded(modelKey) {
  if (voiceInstances.has(modelKey)) {
    return Promise.resolve(voiceInstances.get(modelKey));
  }
  if (voicePromises.has(modelKey)) {
    return voicePromises.get(modelKey);
  }

  const p = (async () => {
    self.postMessage({
      type: "progress",
      model: modelKey,
      percent: 10,
      stage: "loading",
    });

    const instance = await PiperPlus.initialize({
      model: modelKey,
      ort,
      wasmLoader: () => getSharedWasmModule(),
      showModelNotice: false,
      onProgress: ({ stage, progress } = {}) => {
        const raw = typeof progress === "number" ? progress : 0;
        const pct = stage === "phonemizer"
          ? Math.round(70 + raw * 28)
          : Math.round(10 + raw * 60);
        self.postMessage({
          type: "progress",
          model: modelKey,
          percent: Math.max(5, Math.min(99, pct)),
          stage: stage || "loading",
        });
      },
    });

    voiceInstances.set(modelKey, instance);
    self.postMessage({
      type: "ready",
      model: modelKey,
      label: "HF: つくよみちゃん / CSS10 (VITS2)",
    });
    return instance;
  })().catch((err) => {
    voicePromises.delete(modelKey);
    throw err;
  });

  voicePromises.set(modelKey, p);
  return p;
}

function enqueue(fn) {
  const next = synthQueue.then(fn, fn);
  synthQueue = next.then(() => {}, () => {});
  return next;
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === "preload") {
    try {
      // まず女性モデル（つくよみちゃん: Alice & Carol）を読み込み完了させる
      await enqueue(() => ensureVoiceLoaded("tsukuyomi"));
      // 続けて男性モデル（CSS10: Bob）を裏で先読み
      enqueue(() => ensureVoiceLoaded("css10")).catch((err) => {
        console.warn("[HF TTS Worker] css10 background preload skipped:", err?.message || err);
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: String(err?.message || err),
      });
    }
    return;
  }

  if (msg.type === "synthesize") {
    const { requestId, text, characterName } = msg;
    const profile = CHAR_VOICE_PROFILES[characterName] || CHAR_VOICE_PROFILES.Alice;
    try {
      const { wavBuffer, durationSec, usedModel } = await enqueue(async () => {
        let usedModel = profile.model;
        let instance;
        try {
          instance = await ensureVoiceLoaded(profile.model);
        } catch (err) {
          if (profile.model !== "tsukuyomi") {
            console.warn(`[HF TTS Worker] ${profile.model} failed, falling back to tsukuyomi:`, err?.message || err);
            usedModel = "tsukuyomi";
            instance = await ensureVoiceLoaded("tsukuyomi");
          } else {
            throw err;
          }
        }

        const result = await instance.synthesize(String(text || ""), {
          language: "ja",
          lengthScale: profile.lengthScale,
          noiseScale: profile.noiseScale,
          noiseW: profile.noiseW,
        });
        const wavBuffer = result.toWav();
        const durationSec = typeof result.duration === "number" && isFinite(result.duration)
          ? result.duration
          : 0;
        return { wavBuffer, durationSec, usedModel };
      });

      self.postMessage(
        {
          type: "audio",
          requestId,
          wavBuffer,
          durationSec,
          model: usedModel,
        },
        [wavBuffer]
      );
    } catch (err) {
      self.postMessage({
        type: "audio",
        requestId,
        error: String(err?.message || err),
      });
    }
  }
};
