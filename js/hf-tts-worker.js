// ============================================================
// hf-tts-worker.js — サーバー不要で動くブラウザ内蔵 感情表現対応 44.1kHz 日本語ニューラル音声
// Engine: ZEN-TTS v1.4.0 (https://zenryokukikai.com) — 無改変の公式配布物を動的ロード
//   - 44.1 kHz NSF デコーダ + 5感情スタイル連続混合 (neutral / happy / sad / angry / apologetic)
//   - WebGPU（約 200ms）優先 / CPU WASM SIMD（約 500ms）自動フォールバック
//   - Cache API 永続キャッシュ対応（2回目以降は通信不要で即起動）
// 3キャラクター個別ボイス:
//   - Alice : marine  (全力 マリン   — やわらかくクリアな女性声・探偵)
//   - Bob   : hashiro (全力 ハシロウ — 落ち着いた深みのある男性声・詩人)
//   - Carol : kikka   (全力 キッカ   — 素朴で透明感のある若い女性声・料理人)
// ============================================================

const ZEN_VERSION = "v1.4.0";
const ESM_BASE = `https://esm.sh/gh/zenryokukikai/zen-tts@${ZEN_VERSION}/src/runtime`;
const G2P_BASE = `https://cdn.jsdelivr.net/gh/zenryokukikai/zen-tts@${ZEN_VERSION}/models/g2p`;
const WASM_URL = `https://cdn.jsdelivr.net/gh/zenryokukikai/zen-tts@${ZEN_VERSION}/cpu/tts-cpu.wasm`;
const ZTM_BASE = "https://tts-models.zenryoku.work/v1.3.0";
const CACHE_NAME = "bot-game-zen-tts-v1.4.0";
const SAMPLE_RATE = 44100;

// 3キャラクターそれぞれに独立した 44.1kHz 日本語スタジオモデルと性格に合った基本感情・抑揚を割り当て
const CHAR_VOICE_PROFILES = {
  Alice: {
    voice: "marine",
    speed: 0.96,
    pitch: 0.5,
    baseEmotion: { happy: 45, neutral: 55 },
    baseStrength: 1.25,
  },
  Bob: {
    voice: "hashiro",
    speed: 0.94,
    pitch: 0,
    baseEmotion: { neutral: 72, happy: 28 },
    baseStrength: 1.18,
  },
  Carol: {
    voice: "kikka",
    speed: 0.98,
    pitch: 0.5,
    baseEmotion: { happy: 65, neutral: 35 },
    baseStrength: 1.32,
  },
};

let zenRuntime = null;
let sharedAssets = null; // { g2pJson, g2pBin, wasmBytes, gpuDevice, backend }
let baseInitPromise = null;
let gpuEpoch = 0;
const ztmBufferPromises = new Map();
const voiceEngines = new Map();
const voiceEnginePromises = new Map();
let synthQueue = Promise.resolve();

function reportProgress(percent, stage = "loading") {
  self.postMessage({
    type: "progress",
    model: "zen-tts",
    percent: Math.max(1, Math.min(99, Math.round(percent))),
    stage,
  });
}

async function fetchCachedArrayBuffer(url, onProgress = null) {
  let cache = null;
  if (typeof caches !== "undefined") {
    try {
      cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached && cached.ok) {
        const buf = await cached.arrayBuffer();
        if (onProgress) onProgress(1);
        return buf;
      }
    } catch (_) {
      cache = null;
    }
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const fetchTimer = controller ? setTimeout(() => controller.abort(), 30000) : null;
  let resp;
  try {
    resp = await fetch(url, controller ? { signal: controller.signal } : undefined);
  } finally {
    if (fetchTimer) clearTimeout(fetchTimer);
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} while fetching ${url}`);
  }

  const contentLength = Number(resp.headers.get("content-length") || 0);
  let arrayBuffer;

  if (resp.body && typeof resp.body.getReader === "function" && contentLength > 0 && onProgress) {
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    let lastEmit = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const now = Date.now();
      if (now - lastEmit >= 180 || received >= contentLength) {
        lastEmit = now;
        onProgress(Math.min(1, received / contentLength));
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    arrayBuffer = merged.buffer;
  } else {
    arrayBuffer = await resp.arrayBuffer();
    if (onProgress) onProgress(1);
  }

  if (cache && arrayBuffer.byteLength > 0) {
    try {
      await cache.put(
        url,
        new Response(arrayBuffer.slice(0), {
          headers: { "Content-Type": resp.headers.get("Content-Type") || "application/octet-stream" },
        })
      );
    } catch (_) {
      // 容量制限やシークレットモード時はキャッシュ保存のみスキップ
    }
  }
  return arrayBuffer;
}

async function fetchCachedJson(url) {
  const buf = await fetchCachedArrayBuffer(url);
  return JSON.parse(new TextDecoder("utf-8").decode(buf));
}

async function acquireWebGPUDevice() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    if (!device) return null;
    if (device.lost && typeof device.lost.then === "function") {
      device.lost.then(() => {
        gpuEpoch++;
        if (sharedAssets && sharedAssets.gpuDevice === device) {
          sharedAssets.gpuDevice = null;
          sharedAssets.backend = "cpu";
          voiceEngines.clear();
          voiceEnginePromises.clear();
        }
      }).catch(() => {});
    }
    return device;
  } catch (_) {
    return null;
  }
}

async function loadZenRuntime() {
  if (zenRuntime) return zenRuntime;
  const [
    { WgslOwnTts },
    { CpuOwnTts },
    { parseZtm, ownFromZtm, vocoderFromZtm },
    { nsfExportToWeights, nsfF0Norm, nsfOutputGain },
    { engineOptionsOf, splitSentences },
    { withBuiltinDict },
  ] = await Promise.all([
    import(`${ESM_BASE}/tts-own-device.ts`),
    import(`${ESM_BASE}/cpu-tts.ts`),
    import(`${ESM_BASE}/ztm.ts`),
    import(`${ESM_BASE}/nsf-weights.ts`),
    import(`${ESM_BASE}/speak-options.ts`),
    import(`${ESM_BASE}/builtin-dict.ts`),
  ]);
  zenRuntime = {
    WgslOwnTts,
    CpuOwnTts,
    parseZtm,
    ownFromZtm,
    vocoderFromZtm,
    nsfExportToWeights,
    nsfF0Norm,
    nsfOutputGain,
    engineOptionsOf,
    splitSentences,
    withBuiltinDict,
  };
  return zenRuntime;
}

function fetchVoiceZtm(voiceId, onProgress = null) {
  if (ztmBufferPromises.has(voiceId)) {
    return ztmBufferPromises.get(voiceId);
  }
  const p = fetchCachedArrayBuffer(`${ZTM_BASE}/${voiceId}.ztm`, onProgress).catch((err) => {
    ztmBufferPromises.delete(voiceId);
    throw err;
  });
  ztmBufferPromises.set(voiceId, p);
  return p;
}

async function ensureBaseReady() {
  if (sharedAssets && zenRuntime) return sharedAssets;
  if (baseInitPromise) return baseInitPromise;

  baseInitPromise = (async () => {
    reportProgress(5, "loading");
    const [rt, gpuDevice, g2pJson, g2pBin, wasmBytes] = await Promise.all([
      loadZenRuntime(),
      acquireWebGPUDevice(),
      fetchCachedJson(`${G2P_BASE}/g2p.json`),
      fetchCachedArrayBuffer(`${G2P_BASE}/g2p.bin`, (frac) => {
        reportProgress(5 + frac * 30, "downloading");
      }),
      fetchCachedArrayBuffer(WASM_URL),
    ]);
    zenRuntime = rt;
    sharedAssets = {
      g2pJson,
      g2pBin,
      wasmBytes,
      gpuDevice,
      backend: gpuDevice ? "webgpu" : "cpu",
    };
    reportProgress(38, "downloading");
    return sharedAssets;
  })().catch((err) => {
    baseInitPromise = null;
    throw err;
  });

  return baseInitPromise;
}

function validateWaveform(pcm) {
  if (!pcm || pcm.length < 256) return false;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    if (!Number.isFinite(v)) return false;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return peak > 0.004 && peak < 20.0;
}

async function ensureVoiceEngine(voiceId, reportPrimaryProgress = false) {
  if (voiceEngines.has(voiceId)) {
    return voiceEngines.get(voiceId);
  }
  if (voiceEnginePromises.has(voiceId)) {
    return voiceEnginePromises.get(voiceId);
  }

  const p = (async () => {
    const assets = await ensureBaseReady();
    const rt = zenRuntime;
    const ztmBuf = await fetchVoiceZtm(
      voiceId,
      reportPrimaryProgress
        ? (frac) => reportProgress(38 + frac * 44, "downloading")
        : null
    );
    if (reportPrimaryProgress) reportProgress(85, "initializing");

    const z = rt.parseZtm(ztmBuf);
    const own = rt.ownFromZtm(z, assets.g2pJson, assets.g2pBin);
    const voc = rt.vocoderFromZtm(z);
    const weights = rt.nsfExportToWeights(voc.meta, voc.bin);

    let engine = null;
    let usedBackend = "cpu";
    const startEpoch = gpuEpoch;

    if (assets.gpuDevice) {
      try {
        engine = await rt.WgslOwnTts.fromData(assets.gpuDevice, own.meta, own.bin, {
          weights,
          meta: voc.meta,
        });
        if (gpuEpoch !== startEpoch || !assets.gpuDevice) {
          // 初期化中に WebGPU デバイスが失効した場合は破棄して CPU へ切替
          engine = null;
        } else {
          usedBackend = "webgpu";
        }
      } catch (err) {
        console.warn(`[ZEN-TTS Worker] WebGPU init failed for ${voiceId}, falling back to CPU WASM:`, err?.message || err);
        engine = null;
      }
    }

    if (!engine) {
      engine = await rt.CpuOwnTts.create(
        assets.wasmBytes,
        own.meta,
        own.bin,
        weights,
        rt.nsfF0Norm(voc.meta),
        rt.nsfOutputGain(voc.meta)
      );
      usedBackend = "cpu";
    }

    // エンジン構築完了後は数十MBの生 .ztm バッファ参照を解放（再取得時は Cache API から高速読込）
    ztmBufferPromises.delete(voiceId);

    const entry = { engine, backend: usedBackend, voiceId };
    voiceEngines.set(voiceId, entry);
    return entry;
  })().catch((err) => {
    voiceEnginePromises.delete(voiceId);
    throw err;
  });

  voiceEnginePromises.set(voiceId, p);
  return p;
}

function normalizeGameJapaneseTerms(text) {
  return String(text || "")
    .replace(/\bAlice\b/gi, "アリス")
    .replace(/\bBob\b/gi, "ボブ")
    .replace(/\bCarol\b/gi, "キャロル")
    .replace(/\bPlayer\b/gi, "プレイヤー")
    .replace(/\bAI\b/g, "エーアイ")
    .replace(/\bOK\b/gi, "オーケー")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * セリフの内容・句読点・キャラクター個性に応じて ZEN-TTS の 5 感情ブレンドと抑揚強度を動的決定する
 * （棒読みを防ぎ、自然な感情表現・語尾の上がり下がりを引き出す）
 */
function inferEmotionForSentence(sentence, characterName, profile) {
  const s = String(sentence || "");
  let emotion = { ...profile.baseEmotion };
  let strength = profile.baseStrength;
  let speed = profile.speed;
  const pitch = profile.pitch;

  const isQuestion = /[？?]$|(?:かな|だろう|どう思う|教えて|なぜ|どうして)[。！？!?]*$/.test(s);
  const isExclaim = /[！!]$/.test(s);

  if (/(ごめん|すみません|すまない|申し訳|失礼)/.test(s)) {
    emotion = { apologetic: 72, sad: 13, neutral: 15 };
    strength = Math.max(strength, 1.25);
  } else if (/(負けない|くやし|悔し|勝負|絶対|許さ|ダメ|だめ|やめて)/.test(s)) {
    if (characterName === "Carol") {
      emotion = { angry: 48, happy: 32, neutral: 20 };
      strength = 1.38;
    } else if (characterName === "Alice") {
      emotion = { angry: 38, happy: 27, neutral: 35 };
      strength = 1.32;
    } else {
      emotion = { angry: 36, neutral: 64 };
      strength = 1.22;
    }
  } else if (/(残念|悲し|つらい|困っ|足りな|厳しい|ピンチ|大変|負けちゃ)/.test(s)) {
    emotion = characterName === "Bob"
      ? { sad: 54, neutral: 46 }
      : { sad: 58, apologetic: 22, neutral: 20 };
    strength = Math.max(strength, 1.25);
    speed = Math.max(0.88, speed - 0.04);
  } else if (/(やった|嬉し|うれし|最高|すごい|ありがと|おいし|美味し|楽し|ワクワク|優勝|完成|いいね|ナイス|ラッキー|収穫|成立|発展|成功|こんにちは|おはよう|ようこそ)/.test(s) || isExclaim) {
    if (characterName === "Carol") {
      emotion = { happy: 88, neutral: 12 };
      strength = 1.38;
    } else if (characterName === "Alice") {
      emotion = { happy: 78, neutral: 22 };
      strength = 1.34;
    } else {
      emotion = { happy: 52, neutral: 48 };
      strength = 1.24;
    }
  }

  if (isQuestion) {
    strength = Math.min(1.45, strength + 0.08);
    if (!emotion.sad && !emotion.apologetic && !emotion.angry) {
      emotion = {
        ...emotion,
        happy: Math.min(85, (emotion.happy || 25) + 12),
        neutral: Math.max(15, (emotion.neutral || 50) - 12),
      };
    }
  }

  return { emotion, strength, speed, pitch };
}

/**
 * Float32 PCM (44.1kHz) をピーク正規化＆12ms デクリック処理して 16-bit WAV へエンコード
 */
function encodeNormalizedWav(pcm, sampleRate = SAMPLE_RATE, targetPeak = 0.88, maxGain = 2.8) {
  const len = pcm.length;
  let maxAbs = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(pcm[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const gain = maxAbs > 1e-4 ? Math.min(maxGain, targetPeak / maxAbs) : 1.0;
  const fadeLen = Math.min(Math.round(sampleRate * 0.012), Math.floor(len / 8));

  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, len * 2, true);

  for (let i = 0; i < len; i++) {
    let s = pcm[i] * gain;
    if (fadeLen > 1) {
      if (i < fadeLen) s *= i / fadeLen;
      else if (i >= len - fadeLen) s *= (len - 1 - i) / fadeLen;
    }
    const clamped = Math.max(-1, Math.min(1, s));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return buf;
}

function enqueue(fn) {
  const next = synthQueue.then(fn, fn);
  synthQueue = next.then(() => {}, () => {});
  return next;
}

async function preloadAllVoices() {
  // 1. G2P + WASM と同時に 3 キャラ分の .ztm ダウンロードを開始（並列取得で約 8 秒）
  const baseP = ensureBaseReady();
  const ztmMarineP = fetchVoiceZtm("marine", (frac) => reportProgress(38 + frac * 44, "downloading"));
  const ztmHashiroP = fetchVoiceZtm("hashiro").catch(() => {});
  const ztmKikkaP = fetchVoiceZtm("kikka").catch(() => {});

  await Promise.all([baseP, ztmMarineP]);
  const primary = await ensureVoiceEngine("marine", true);

  // Alice（マリン）準備完了時点で即座に利用可能通知を出し、残り2話者は裏でシームレス初期化
  self.postMessage({
    type: "ready",
    model: "zen-tts",
    device: primary.backend,
    label: `ZEN-TTS 44.1kHz · ${primary.backend.toUpperCase()} · マリン / ハシロウ / キッカ`,
  });

  // 残り2話者（Bob: ハシロウ / Carol: キッカ）の初期化を synthQueue を塞がず裏で完了させる
  Promise.all([ztmHashiroP, ztmKikkaP])
    .then(async () => {
      await ensureVoiceEngine("hashiro", false).catch(() => {});
      await ensureVoiceEngine("kikka", false).catch(() => {});
    })
    .catch(() => {});
}

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === "preload") {
    try {
      await preloadAllVoices();
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
      const { wavBuffer, durationSec, usedVoice, usedBackend } = await enqueue(async () => {
        const entry = await ensureVoiceEngine(profile.voice, false);
        const rt = zenRuntime;
        const normalized = normalizeGameJapaneseTerms(text);
        if (!normalized) {
          throw new Error("Empty Japanese text for synthesis");
        }

        const sentences = rt.splitSentences(normalized);
        const validSentences = sentences.length > 0 ? sentences : [normalized];
        const dict = rt.withBuiltinDict();
        const pauseSamples = Math.round(SAMPLE_RATE * 0.14);
        const pcms = [];
        let totalSamples = 0;

        for (const sent of validSentences) {
          const trimmed = String(sent || "").trim();
          if (!trimmed) continue;
          const expr = inferEmotionForSentence(trimmed, characterName, profile);
          const opts = rt.engineOptionsOf({
            numbers: "rule",
            emotion: expr.emotion,
            strength: expr.strength,
            speed: expr.speed,
            pitch: expr.pitch,
          });
          let res;
          try {
            res = await entry.engine.speak(trimmed, { ...opts, dict });
          } catch (speakErr) {
            if (entry.backend === "webgpu") {
              console.warn(`[ZEN-TTS Worker] WebGPU speak failed for ${profile.voice}; falling back to CPU:`, speakErr?.message || speakErr);
              gpuEpoch++;
              if (sharedAssets) {
                sharedAssets.gpuDevice = null;
                sharedAssets.backend = "cpu";
              }
              voiceEngines.delete(profile.voice);
              voiceEnginePromises.delete(profile.voice);
              const cpuEntry = await ensureVoiceEngine(profile.voice, false);
              entry.engine = cpuEntry.engine;
              entry.backend = cpuEntry.backend;
              res = await cpuEntry.engine.speak(trimmed, { ...opts, dict });
            } else {
              throw speakErr;
            }
          }
          const pcm = res?.audio;
          if (!validateWaveform(pcm)) {
            throw new Error(`Invalid ZEN-TTS waveform for ${profile.voice}`);
          }
          if (pcms.length > 0) {
            pcms.push(new Float32Array(pauseSamples));
            totalSamples += pauseSamples;
          }
          pcms.push(pcm);
          totalSamples += pcm.length;
        }

        if (totalSamples === 0) {
          throw new Error("Empty synthesized waveform");
        }

        let merged;
        if (pcms.length === 1) {
          merged = pcms[0];
        } else {
          merged = new Float32Array(totalSamples);
          let off = 0;
          for (const seg of pcms) {
            merged.set(seg, off);
            off += seg.length;
          }
        }

        const wavBuffer = encodeNormalizedWav(merged, SAMPLE_RATE);
        const durationSec = merged.length / SAMPLE_RATE;
        return {
          wavBuffer,
          durationSec,
          usedVoice: profile.voice,
          usedBackend: entry.backend,
        };
      });

      self.postMessage(
        {
          type: "audio",
          requestId,
          wavBuffer,
          durationSec,
          model: `zen-tts:${usedVoice}`,
          device: usedBackend,
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
