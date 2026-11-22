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
  Bob:   { model: "css10",     lengthScale: 1.03, noiseScale: 0.36, noiseW: 0.46, fallbackLengthScale: 1.08 },
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

function ensureVoiceLoaded(modelKey, reportProgress = true) {
  if (voiceInstances.has(modelKey)) {
    return Promise.resolve(voiceInstances.get(modelKey));
  }
  if (voicePromises.has(modelKey)) {
    return voicePromises.get(modelKey);
  }

  const p = (async () => {
    if (reportProgress) {
      self.postMessage({
        type: "progress",
        model: modelKey,
        percent: 10,
        stage: "loading",
      });
    }

    const instance = await PiperPlus.initialize({
      model: modelKey,
      ort,
      wasmLoader: () => getSharedWasmModule(),
      showModelNotice: false,
      onProgress: ({ stage, progress } = {}) => {
        if (!reportProgress) return;
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

/**
 * 16-bit PCM WAV データの音量を聞き取りやすいピーク水準へ正規化する
 */
function normalizeWavBuffer(wavBuffer, targetPeak = 0.88, maxGain = 4.5) {
  if (!wavBuffer || wavBuffer.byteLength <= 44) return wavBuffer;
  const view = new DataView(wavBuffer);
  // RIFF / WAVE ヘッダ確認
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint16(20, true) !== 1) {
    return wavBuffer;
  }
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== 16) return wavBuffer;

  const sampleCount = Math.floor((wavBuffer.byteLength - 44) / 2);
  let maxAbs = 0;
  for (let i = 0; i < sampleCount; i++) {
    const a = Math.abs(view.getInt16(44 + i * 2, true));
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs < 16) return wavBuffer; // 完全無音なら触らない

  const gain = Math.min(maxGain, (targetPeak * 32767) / maxAbs);
  if (gain <= 1.08) return wavBuffer;

  for (let i = 0; i < sampleCount; i++) {
    const off = 44 + i * 2;
    const scaled = Math.round(view.getInt16(off, true) * gain);
    view.setInt16(off, Math.max(-32768, Math.min(32767, scaled)), true);
  }
  return wavBuffer;
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === "preload") {
    try {
      // まず女性モデル（つくよみちゃん: Alice & Carol）を読み込み完了させる
      await ensureVoiceLoaded("tsukuyomi", true);
      // 男性モデル（CSS10: Bob）は推論キューを塞がないようキュー外で静かに先読みする
      ensureVoiceLoaded("css10", false).catch((err) => {
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
      // tsukuyomi が未ロードなら待機（初回のみ）。css10 ダウンロード中はブロックせず tsukuyomi で即代用する。
      await ensureVoiceLoaded("tsukuyomi", true);

      const { wavBuffer, durationSec, usedModel } = await enqueue(async () => {
        let usedModel = profile.model;
        let instance = voiceInstances.get(profile.model);
        let lengthScale = profile.lengthScale;

        if (!instance) {
          usedModel = "tsukuyomi";
          instance = voiceInstances.get("tsukuyomi");
          if (profile.fallbackLengthScale) {
            lengthScale = profile.fallbackLengthScale;
          }
          // 次回以降に向けて css10 の読込も裏で継続
          if (profile.model !== "tsukuyomi") {
            ensureVoiceLoaded(profile.model, false).catch(() => {});
          }
        }

        const result = await instance.synthesize(String(text || ""), {
          language: "ja",
          lengthScale,
          noiseScale: profile.noiseScale,
          noiseW: profile.noiseW,
        });
        const wavBuffer = normalizeWavBuffer(result.toWav());
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
