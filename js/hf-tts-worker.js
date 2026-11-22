// ============================================================
// hf-tts-worker.js — サーバー不要で動くブラウザ内蔵 Hugging Face ニューラル日本語音声
// Model: onnx-community/Kokoro-82M-v1.0-ONNX (StyleTTS2 + ISTFTNet, 24kHz, Apache-2.0)
// Frontend: Rust WASM OpenJTalk (Naist-JDic + A2/A3 文節区切り) -> Kokoro 日本語 IPA
// 3キャラクター個別ボイス:
//   - Alice : jf_alpha    (クリアで自然な女性声・探偵)
//   - Bob   : jm_kumo     (落ち着いた深みのある男性声・詩人)
//   - Carol : jf_tebukuro (明るく元気な女性声・料理人)
// ============================================================

import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.mjs";

const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
// jsDelivr は 50MB 超の WASM を 403 で制限するため、CORS 許可済みの unpkg から Rust WASM OpenJTalk を取得
const WASM_G2P_URL = "https://unpkg.com/piper-plus@0.9.1/dist/rust-wasm/piper_plus_wasm.js";
const HF_KOKORO_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";
const KOKORO_CACHE_NAME = "bot-game-kokoro-tts-v1";
const SAMPLE_RATE = 24000;

if (ort?.env?.wasm) {
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.wasm.proxy = false;
  if (typeof self !== "undefined" && !self.crossOriginIsolated) {
    ort.env.wasm.numThreads = 1;
  }
}

// 3キャラクター全員に別々のネイティブ日本語 StyleTTS2 話者モデルを割り当て
const CHAR_VOICE_PROFILES = {
  Alice: { voice: "jf_alpha",    speed: 0.92 },
  Bob:   { voice: "jm_kumo",     speed: 0.90 },
  Carol: { voice: "jf_tebukuro", speed: 0.95 },
};

// piper_plus_wasm (Rust OpenJTalk) の PUA 契約に完全準拠した音素テーブル
const OJT_SYMBOLS = [
  "_", "^", "$", "?", "\uE016", "\uE017", "\uE018", "#", "[", "]",
  "a", "i", "u", "e", "o", "A", "I", "U", "E", "O",
  "\uE000", "\uE001", "\uE002", "\uE003", "\uE004",
  "N", "\uE019", "\uE01A", "\uE01B", "\uE01C", "\uE005",
  "k", "\uE006", "\uE007", "g", "\uE008", "\uE009",
  "t", "\uE00A", "d", "\uE00B", "p", "\uE00C", "b", "\uE00D",
  "\uE00E", "\uE00F", "s", "\uE010", "z", "\uE011",
  "f", "h", "\uE012", "v", "n", "\uE013", "m", "\uE014",
  "r", "\uE015", "w", "y", "j", "q",
];

const OJT_CONFIG_JSON = JSON.stringify({
  phoneme_type: "openjtalk",
  language_id_map: { ja: 0 },
  phoneme_id_map: Object.fromEntries(OJT_SYMBOLS.map((s, i) => [s, [i]])),
});

const PUA_NAME = {
  "\uE000": "a:", "\uE001": "i:", "\uE002": "u:", "\uE003": "e:", "\uE004": "o:",
  "\uE005": "cl", "\uE006": "ky", "\uE007": "kw", "\uE008": "gy", "\uE009": "gw",
  "\uE00A": "ty", "\uE00B": "dy", "\uE00C": "py", "\uE00D": "by",
  "\uE00E": "ch", "\uE00F": "ts", "\uE010": "sh", "\uE011": "zy",
  "\uE012": "hy", "\uE013": "ny", "\uE014": "my", "\uE015": "ry",
  "\uE016": "?!", "\uE017": "?.", "\uE018": "?~",
  "\uE019": "N_m", "\uE01A": "N_n", "\uE01B": "N_ng", "\uE01C": "N_uvular",
};

const PALATAL_U_SET = new Set([
  "s", "z", "ts", "ky", "gy", "ty", "dy", "py", "by", "ch", "sh", "zy", "j", "hy", "ny", "my", "ry",
]);

const PALATAL_I_CONS = {
  k: "kʲ", g: "ɡʲ", b: "bʲ", p: "pʲ", m: "mʲ", r: "ɾʲ", v: "vʲ", t: "tʲ", d: "dʲ", ts: "ʦʲ",
};

const VOWEL_NAMES = new Set(["a", "i", "u", "e", "o", "a:", "i:", "u:", "e:", "o:", "A", "I", "U", "E", "O"]);

let initPromise = null;
let phonemizerInstance = null;
let kokoroSession = null;
let kokoroVocab = null;
let loadedDevice = "wasm";
const voiceEmbeddings = new Map();
let synthQueue = Promise.resolve();

function reportProgress(percent, stage = "loading") {
  self.postMessage({
    type: "progress",
    model: "kokoro-82m",
    percent: Math.max(1, Math.min(99, Math.round(percent))),
    stage,
  });
}

async function detectUsableWebGPU() {
  try {
    if (typeof navigator === "undefined" || !navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    // requestAdapter() が成功しても requestDevice() で失敗する環境（ヘッドレス・旧ドライバ等）を事前除外
    const device = await adapter.requestDevice();
    if (!device) return false;
    try { device.destroy(); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}

async function fetchCachedArrayBuffer(url, onProgress = null) {
  let cache = null;
  if (typeof caches !== "undefined") {
    try {
      cache = await caches.open(KOKORO_CACHE_NAME);
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

  const resp = await fetch(url);
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
      if (now - lastEmit >= 200 || received >= contentLength) {
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
 * OpenJTalk (piper_plus_wasm) の音素列＋韻律特徴量(A2/A3)を
 * Kokoro-82M v1.0 学習時（misaki/cutlet.py）と同一の日本語 IPA＋文節スペース列へ変換する
 */
function ojtToKokoroIpa(phonemeIds, prosodyFeatures) {
  const items = [];
  for (let i = 0; i < phonemeIds.length; i++) {
    const sym = OJT_SYMBOLS[phonemeIds[i]];
    if (!sym) continue;
    const name = PUA_NAME[sym] || sym;
    // VITS 音素間パディング "_" およびアクセント記号 "^", "[", "]" を除外して前後音素を直接参照可能にする
    if (name === "_" || name === "^" || name === "[" || name === "]") continue;
    const a2 = prosodyFeatures ? prosodyFeatures[i * 3 + 1] : 0;
    const a3 = prosodyFeatures ? prosodyFeatures[i * 3 + 2] : 0;
    items.push({ name, a2, a3 });
  }

  const out = [];
  let prevA2 = 0;
  let prevA3 = 0;
  let prevName = "";

  for (let i = 0; i < items.length; i++) {
    const { name: t, a2, a3 } = items[i];
    const next = items[i + 1]?.name || "";
    const next2 = items[i + 2]?.name || "";
    const prev = items[i - 1]?.name || "";

    if (t === "$") { out.push("."); continue; }
    if (t === "?") { out.push("?"); continue; }
    if (t === "?!") { out.push("?!"); continue; }
    if (t === "?." || t === "?~") { out.push("?"); continue; }
    if (t === "#") { out.push(" "); prevA2 = 0; prevA3 = 0; prevName = t; continue; }

    // A2（文節内モーラ位置）が 1 へ戻ったら文節境界として自然なスペースを挿入
    if (
      out.length > 0 &&
      a2 === 1 &&
      (prevA2 > 1 || (prevA2 === 1 && prevA3 === 1 && VOWEL_NAMES.has(prevName)))
    ) {
      out.push(" ");
    }

    if (t === "cl" || t === "q") {
      out.push("ʔ");
    } else if (t === "N_m") {
      out.push("m");
    } else if (t === "N_ng") {
      out.push("ŋ");
    } else if (t === "N_uvular") {
      out.push("ɴ");
    } else if (t === "N_n") {
      if (next === "ny" || next === "ch" || next === "zy" || next === "j" || (next === "n" && next2.toLowerCase() === "i")) {
        out.push("ɲ");
      } else {
        out.push("n");
      }
    } else if (t === "N") {
      if (next === "m" || next === "my" || next === "p" || next === "py" || next === "b" || next === "by") out.push("m");
      else if (next === "k" || next === "ky" || next === "kw" || next === "g" || next === "gy" || next === "gw") out.push("ŋ");
      else if (next === "ny" || next === "ch" || next === "zy" || next === "j" || (next === "n" && next2.toLowerCase() === "i")) out.push("ɲ");
      else if (next === "n" || next === "t" || next === "ty" || next === "d" || next === "dy" || next === "r" || next === "ry" || next === "z") out.push("n");
      else out.push("ɴ");
    } else if (t === "a:") {
      out.push("aː");
    } else if (t === "i:") {
      out.push("iː");
    } else if (t === "e:") {
      out.push("eː");
    } else if (t === "o:") {
      out.push("oː");
    } else if (t === "u:") {
      out.push(PALATAL_U_SET.has(prev) ? "ɨː" : "ɯː");
    } else {
      const tl = t.toLowerCase();
      if (tl === "a" || tl === "i" || tl === "e" || tl === "o") {
        out.push(tl);
      } else if (tl === "u") {
        out.push(PALATAL_U_SET.has(prev) ? "ɨ" : "ɯ");
      } else {
        const nextVowel = next.toLowerCase().replace(":", "");
        if (nextVowel === "i" && PALATAL_I_CONS[t]) {
          out.push(PALATAL_I_CONS[t]);
        } else {
          switch (t) {
            case "k": out.push("k"); break;
            case "ky": out.push("kʲ"); break;
            case "kw": out.push("kᵝ"); break;
            case "g": out.push("ɡ"); break;
            case "gy": out.push("ɡʲ"); break;
            case "gw": out.push("ɡᵝ"); break;
            case "s": out.push("s"); break;
            case "sh": out.push("ɕ"); break;
            case "z":
              if (nextVowel === "i") out.push("ʥ");
              else if (nextVowel === "u") out.push("z");
              else out.push("ʣ");
              break;
            case "zy": case "j": out.push("ʥ"); break;
            case "t": out.push("t"); break;
            case "ty": out.push("tʲ"); break;
            case "ts": out.push("ʦ"); break;
            case "ch": out.push("ʨ"); break;
            case "d": out.push("d"); break;
            case "dy": out.push("dʲ"); break;
            case "n": out.push(nextVowel === "i" ? "ɲ" : "n"); break;
            case "ny": out.push("ɲ"); break;
            case "h":
              if (nextVowel === "i") out.push("ç");
              else if (nextVowel === "u") out.push("ɸ");
              else out.push("h");
              break;
            case "hy": out.push("ç"); break;
            case "f": out.push("ɸ"); break;
            case "b": out.push("b"); break;
            case "by": out.push("bʲ"); break;
            case "p": out.push("p"); break;
            case "py": out.push("pʲ"); break;
            case "m": out.push("m"); break;
            case "my": out.push("mʲ"); break;
            case "y": out.push("j"); break;
            case "r": out.push("ɾ"); break;
            case "ry": out.push("ɾʲ"); break;
            case "w": out.push("β"); break;
            case "v": out.push("v"); break;
            default: break;
          }
        }
      }
    }

    if (a2 > 0) {
      prevA2 = a2;
      prevA3 = a3;
    }
    prevName = t;
  }

  return out
    .join("")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function phonemizeJapaneseToKokoro(text) {
  const normalized = normalizeGameJapaneseTerms(text);
  if (!normalized) return [];

  // 日本語の句読点・感嘆符・疑問符を保持しながら節ごとに音素化
  const parts = normalized.match(/[^。！？!?,、]+[。！？!?,、]*/g) || [normalized];
  const clauses = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const endMatch = trimmed.match(/[。！？!?,、]+$/);
    const endRaw = endMatch ? endMatch[0] : "";
    const body = endRaw ? trimmed.slice(0, -endRaw.length).trim() : trimmed;
    if (!body) continue;

    const res = phonemizerInstance.phonemize(body, "ja");
    let ipa = "";
    try {
      ipa = ojtToKokoroIpa(res.phonemeIds, res.prosodyFeatures)
        .replace(/[.?!]+$/, "")
        .trim();
    } finally {
      res.free();
    }
    if (!ipa) continue;

    let punct = "";
    if (/[？?]/.test(endRaw) && /[！!]/.test(endRaw)) punct = "?!";
    else if (/[？?]/.test(endRaw)) punct = "?";
    else if (/[！!]/.test(endRaw)) punct = "!";
    else if (/[、,]/.test(endRaw)) punct = ",";
    else if (/[。.]/.test(endRaw)) punct = ".";

    clauses.push(ipa + punct);
  }

  // Kokoro の最大トークン長(510)を超えない安全なチャンクにまとめる（通常の1〜2文は1チャンクで自然抑揚）
  const chunks = [];
  let current = "";
  for (const clause of clauses) {
    const candidate = current ? `${current} ${clause}` : clause;
    if (current && candidate.length > 260) {
      chunks.push(current);
      current = clause;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function tokenizeKokoroIpa(ipa) {
  const ids = [0];
  for (const ch of ipa) {
    const id = kokoroVocab[ch];
    if (id !== undefined) {
      ids.push(id);
      if (ids.length >= 510) break;
    }
  }
  ids.push(0);
  return ids;
}

async function runKokoroInference(session, tokenIds, voiceData, speed) {
  const styleIndex = Math.min(Math.max(tokenIds.length - 2, 0), 509);
  const style = voiceData.slice(styleIndex * 256, (styleIndex + 1) * 256);
  const feeds = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(tokenIds, BigInt), [1, tokenIds.length]),
    style: new ort.Tensor("float32", style, [1, 256]),
    speed: new ort.Tensor("float32", new Float32Array([speed]), [1]),
  };
  const out = await session.run(feeds);
  const waveform = out.waveform || Object.values(out)[0];
  return waveform?.data ? new Float32Array(waveform.data) : new Float32Array(0);
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
  return peak > 0.005 && peak < 20.0;
}

/**
 * Float32 PCM (24kHz) をピーク正規化＆12msデクリック処理して 16-bit WAV へエンコード
 */
function encodeNormalizedWav(pcm, sampleRate = SAMPLE_RATE, targetPeak = 0.88, maxGain = 3.5) {
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

async function ensureKokoroReady() {
  if (kokoroSession && phonemizerInstance && kokoroVocab) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    reportProgress(5, "phonemizer");

    // 1. OpenJTalk Rust WASM 音素化エンジン + Tokenizer + 3キャラ分の日本語話者ベクトルを並列ロード
    const uniqueVoices = [...new Set(Object.values(CHAR_VOICE_PROFILES).map((p) => p.voice))];
    const [wasmMod, tokJson, ...voiceBufs] = await Promise.all([
      (async () => {
        const mod = await import(WASM_G2P_URL);
        if (typeof mod.default === "function") await mod.default();
        return mod;
      })(),
      fetchCachedJson(`${HF_KOKORO_BASE}/tokenizer.json`),
      ...uniqueVoices.map((vn) => fetchCachedArrayBuffer(`${HF_KOKORO_BASE}/voices/${vn}.bin`)),
    ]);

    phonemizerInstance = new wasmMod.WasmPhonemizer(OJT_CONFIG_JSON);
    kokoroVocab = tokJson?.model?.vocab || {};
    uniqueVoices.forEach((vn, idx) => {
      voiceEmbeddings.set(vn, new Float32Array(voiceBufs[idx]));
    });
    reportProgress(28, "downloading");

    // 2. WebGPU (FP32: NaN 回避かつ 0.7秒の高速生成) を優先し、非対応環境は軽量 WASM (q8f16: 82MB) へ自動切替
    const hasWebGPU = await detectUsableWebGPU();
    const candidates = hasWebGPU
      ? [
          { device: "webgpu", file: "onnx/model.onnx", eps: ["webgpu"] },
          { device: "wasm",   file: "onnx/model_q8f16.onnx", eps: ["wasm"] },
          { device: "wasm",   file: "onnx/model_quantized.onnx", eps: ["wasm"] },
        ]
      : [
          { device: "wasm",   file: "onnx/model_q8f16.onnx", eps: ["wasm"] },
          { device: "wasm",   file: "onnx/model_quantized.onnx", eps: ["wasm"] },
        ];

    const sanityIds = tokenizeKokoroIpa("koɲɲiʨiβa.");
    const sanityVoice = voiceEmbeddings.get("jf_alpha");
    let lastErr = null;

    for (const cand of candidates) {
      let sess = null;
      try {
        const modelBuf = await fetchCachedArrayBuffer(`${HF_KOKORO_BASE}/${cand.file}`, (frac) => {
          reportProgress(28 + frac * 62, "downloading");
        });
        reportProgress(92, "initializing");

        sess = await ort.InferenceSession.create(new Uint8Array(modelBuf), {
          executionProviders: cand.eps,
        });

        // WebGPU シェーダの事前ウォームアップ＆NaN/無音異常の事前検知（正常でなければ自動フォールバック）
        if (cand.device === "webgpu" && sanityVoice) {
          reportProgress(96, "warmup");
          const probe = await runKokoroInference(sess, sanityIds, sanityVoice, 0.92);
          if (!validateWaveform(probe)) {
            throw new Error("WebGPU sanity waveform check failed (NaN or silent output)");
          }
        }

        kokoroSession = sess;
        loadedDevice = cand.device;
        self.postMessage({
          type: "ready",
          model: "kokoro-82m",
          device: loadedDevice,
          label: `Kokoro-82M 24kHz · ${loadedDevice.toUpperCase()} · jf_alpha / jm_kumo / jf_tebukuro`,
        });
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[HF TTS Worker] Kokoro (${cand.device}/${cand.file}) failed:`, err?.message || err);
        if (sess) {
          try { await sess.release(); } catch (_) {}
        }
      }
    }
    throw lastErr || new Error("Kokoro-82M initialization failed");
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
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
      await ensureKokoroReady();
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
      await ensureKokoroReady();

      const { wavBuffer, durationSec, usedVoice } = await enqueue(async () => {
        const chunks = phonemizeJapaneseToKokoro(text);
        if (chunks.length === 0) {
          throw new Error("No speakable Japanese phonemes");
        }
        const voiceData = voiceEmbeddings.get(profile.voice) || voiceEmbeddings.get("jf_alpha");
        const pcms = [];
        let totalSamples = 0;
        const pauseSamples = Math.round(SAMPLE_RATE * 0.12);

        for (let ci = 0; ci < chunks.length; ci++) {
          const ids = tokenizeKokoroIpa(chunks[ci]);
          if (ids.length <= 2) continue;
          const pcm = await runKokoroInference(kokoroSession, ids, voiceData, profile.speed);
          if (!validateWaveform(pcm)) {
            throw new Error(`Invalid waveform output for ${profile.voice}`);
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
        return { wavBuffer, durationSec, usedVoice: profile.voice };
      });

      self.postMessage(
        {
          type: "audio",
          requestId,
          wavBuffer,
          durationSec,
          model: `kokoro:${usedVoice}`,
          device: loadedDevice,
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
