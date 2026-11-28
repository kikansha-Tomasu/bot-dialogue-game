#!/usr/bin/env python3
"""
Bot対話ゲーム ローカルサーバー (自然日本語・完全無料 Hugging Face AI 版)
- ゲーム用静的ファイル配信（許可リスト方式）: http://127.0.0.1:8765/
- ローカル Hugging Face GGUF LLM (llama.cpp AVX2 高速推論):
    * Alice / Bob: mmnga/sarashina2.2-3b-instruct-v0.1-gguf (SB Intuitions 純国産日本語 3B Q4_K_M)
    * Carol      : SakanaAI/TinySwallow-1.5B-Instruct-GGUF (Sakana AI 32B蒸留日本語 1.5B Q4_K_M)
- ローカル Hugging Face Style-Bert-VITS2 自然日本語音声合成:
    * Alice: litagin/sbv2_amitaro (あみたろ・自然な会話ボイス)
    * Bob  : litagin/style_bert_vits2_jvnv (jvnv-M1-jp・落ち着いた男性ボイス)
    * Carol: ayousanz/tsukuyomi-chan-style-bert-vits2-model (つくよみちゃん・クリアな自然ボイス)

有料枠・APIクレジットを一切消費せず、ローカルCPU/GPU上で自然かつ高速に動作します。
"""

from collections import OrderedDict
import importlib.util
import io
import json
import math
import os
import re
import subprocess
import sys
import threading
import zipfile
from pathlib import Path, PurePosixPath

import requests
from flask import Flask, abort, jsonify, request, send_from_directory
from flask_cors import CORS

ROOT = Path(__file__).resolve().parent


def load_dotenv(env_path: Path, override: bool = False) -> None:
    """外部ライブラリ不要の軽量 .env ローダー（既定では既存の環境変数を優先）"""
    if not env_path.is_file():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].strip()
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if not key:
                continue
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            if override:
                os.environ[key] = val
            else:
                os.environ.setdefault(key, val)
    except OSError:
        pass


load_dotenv(ROOT / ".env")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# ── Hugging Face AI 設定（既定：有料枠不要の完全ローカル GGUF / SBV2） ──
HF_USE_CLOUD_ROUTER = os.environ.get("HF_USE_CLOUD_ROUTER", "false").strip().lower() in (
    "1", "true", "yes"
)
HF_ROUTER_BASE = os.environ.get("HF_ROUTER_BASE", "https://router.huggingface.co").rstrip("/")
HF_CHAT_URL = os.environ.get("HF_CHAT_URL", f"{HF_ROUTER_BASE}/v1/chat/completions")
HF_MODELS_URL = os.environ.get("HF_MODELS_URL", f"{HF_ROUTER_BASE}/v1/models")
HF_INFERENCE_TTS_BASE = os.environ.get(
    "HF_INFERENCE_TTS_BASE", f"{HF_ROUTER_BASE}/hf-inference/models"
).rstrip("/")

HF_GEMMA3_GGUF_REPO = os.environ.get(
    "HF_GEMMA3_GGUF_REPO", "unsloth/gemma-3-4b-it-GGUF"
)
HF_SARASHINA_GGUF_REPO = os.environ.get(
    "HF_SARASHINA_GGUF_REPO", "mmnga/sarashina2.2-3b-instruct-v0.1-gguf"
)
HF_TINYSWALLOW_GGUF_REPO = os.environ.get(
    "HF_TINYSWALLOW_GGUF_REPO", "SakanaAI/TinySwallow-1.5B-Instruct-GGUF"
)
HF_LOCAL_MODEL = os.environ.get("HF_LOCAL_MODEL", HF_GEMMA3_GGUF_REPO)
HF_TRANSFORMERS_FALLBACK_MODEL = os.environ.get(
    "HF_TRANSFORMERS_FALLBACK_MODEL", "Qwen/Qwen2.5-0.5B-Instruct"
)
HF_DEFAULT_MODEL = os.environ.get("HF_DEFAULT_MODEL", HF_GEMMA3_GGUF_REPO)
HF_TTS_API_MODEL = os.environ.get("HF_TTS_API_MODEL", "facebook/mms-tts-jpn")

# キャラクター別の自然・高性能日本語 Hugging Face モデル & 音声プロファイル
# 全キャラで Google Gemma 3 4B (unsloth/gemma-3-4b-it-GGUF Q4_K_M) をメモリ共有して省RAM・高品質化
HF_CHARACTER_PROFILES = {
    "alice": {
        "repo_id": HF_GEMMA3_GGUF_REPO,
        "profile_id": f"{HF_GEMMA3_GGUF_REPO}#alice",
        "label": "Gemma-3-4B (自然な日本語)",
        "temperature": 0.72,
        "top_p": 0.90,
        "repeat_penalty": 1.10,
        "voice": "amitaro",
        "fallback_voice": "jvnv-F1-jp",
        "voice_style": "Neutral",
        "style_weight": 1.0,
        "few_shot": [
            {"role": "user", "content": "Player「こんにちは！今日は何をしてるの？」"},
            {"role": "assistant", "content": "こんにちは！私は広場の相場を眺めながら、何か掘り出し物がないか探していたところだよ。そっちは調子どう？"},
            {"role": "user", "content": "Bob「木材が少し余ってきたよ。」"},
            {"role": "assistant", "content": "おっ、いいニュースだね！手頃な値段で取引板に出してくれたら、私がすぐ買いに行くよ。"},
        ],
    },
    "bob": {
        "repo_id": HF_GEMMA3_GGUF_REPO,
        "profile_id": f"{HF_GEMMA3_GGUF_REPO}#bob",
        "label": "Gemma-3-4B (自然な日本語)",
        "temperature": 0.78,
        "top_p": 0.92,
        "repeat_penalty": 1.12,
        "voice": "jvnv-M1-jp",
        "fallback_voice": "jvnv-M1-jp",
        "voice_style": "Neutral",
        "style_weight": 1.0,
        "few_shot": [
            {"role": "user", "content": "Player「こんにちは！今日は何をしてるの？」"},
            {"role": "assistant", "content": "静かな風を感じながら、私はこの街の移ろいを眺めていたよ。焦らず木を集めて、しっかりした建物を建てるつもりさ。"},
            {"role": "user", "content": "Alice「相場が動いてきたね！」"},
            {"role": "assistant", "content": "そうだな、賑わってきたのはいいことだ。私は慌てず、納得できる値段のときだけ動くよ。"},
        ],
    },
    "carol": {
        "repo_id": HF_GEMMA3_GGUF_REPO,
        "profile_id": f"{HF_GEMMA3_GGUF_REPO}#carol",
        "label": "Gemma-3-4B (自然な日本語)",
        "temperature": 0.75,
        "top_p": 0.90,
        "repeat_penalty": 1.10,
        "voice": "jvnv-F2-jp",
        "fallback_voice": "jvnv-F2-jp",
        "voice_style": "Neutral",
        "style_weight": 1.0,
        "few_shot": [
            {"role": "user", "content": "Player「こんにちは！今日は何をしてるの？」"},
            {"role": "assistant", "content": "こんにちは！私は畑で新鮮な野菜を育てて、とびきり美味しい料理を作ろうと思ってるところだよ！"},
            {"role": "user", "content": "Bob「いい匂いがしてきたな。」"},
            {"role": "assistant", "content": "えへへ、気づいてくれた？もうすぐ焼き上がるから、できたら取引板に並べるね！"},
        ],
    },
}

HF_CHARACTER_MODELS = {
    k: v["profile_id"] for k, v in HF_CHARACTER_PROFILES.items()
}
HF_FALLBACK_MODELS = [
    HF_GEMMA3_GGUF_REPO,
    HF_SARASHINA_GGUF_REPO,
    HF_TINYSWALLOW_GGUF_REPO,
    "Qwen/Qwen2.5-1.5B-Instruct",
    "meta-llama/Llama-3.1-8B-Instruct",
    "google/gemma-2-9b-it",
]

# 後方互換エイリアス
LM_STUDIO_BASE = HF_ROUTER_BASE
LM_STUDIO_URL = HF_CHAT_URL
LM_STUDIO_MODELS_URL = HF_MODELS_URL
LM_STUDIO_TTS_URL = f"{HF_INFERENCE_TTS_BASE}/{HF_TTS_API_MODEL}"

_LOCAL_PROXIES = {"http": None, "https": None}


def _is_local_url(url: str) -> bool:
    return any(h in (url or "") for h in ("127.0.0.1", "localhost"))


def get_hf_token() -> str:
    """環境変数・.env・huggingface_hub キャッシュから Hugging Face トークンを取得（ローカル推論では未設定でも可）"""
    for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HF_API_KEY"):
        val = os.environ.get(key, "").strip()
        if val:
            return val
    load_dotenv(ROOT / ".env")
    for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HF_API_KEY"):
        val = os.environ.get(key, "").strip()
        if val:
            return val
    try:
        from huggingface_hub import get_token
        cached = get_token()
        if cached:
            return cached.strip()
    except Exception:
        pass
    return ""


def _build_hf_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    token = get_hf_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


# ── Hugging Face ローカル GGUF (llama.cpp) / transformers / Style-Bert-VITS2 ──
_llama_models = {}
_llama_lock = threading.Lock()

_local_llm_cache = {}
_local_llm_lock = threading.Lock()
_threads_configured = False

_sbv2_models = {}
_sbv2_model_styles = {}
_sbv2_bert_loaded = False
_sbv2_lock = threading.Lock()
_tts_audio_cache = OrderedDict()
_TTS_CACHE_MAX = 128

_JVNV_REPO = os.environ.get("HF_TTS_REPO", "litagin/style_bert_vits2_jvnv")
_BERT_REPO = os.environ.get("HF_BERT_REPO", "ku-nlp/deberta-v2-large-japanese-char-wwm")

# キャラクター別の自然日本語 Hugging Face Style-Bert-VITS2 音声モデル定義 (全キャラ JP-Extra 対応)
_VOICE_REPOS = {
    "amitaro": {
        "repo": "litagin/sbv2_amitaro",
        "fallback": "jvnv-F1-jp",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
    "koharune": {
        "repo": "litagin/sbv2_koharune_ami",
        "fallback": "jvnv-F2-jp",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
    "tsukuyomi": {
        "repo": "ayousanz/tsukuyomi-chan-style-bert-vits2-model",
        "fallback": "jvnv-F2-jp",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
    "jvnv-F1-jp": {
        "repo": _JVNV_REPO,
        "subdir": "jvnv-F1-jp",
        "model_file": "jvnv-F1-jp/jvnv-F1-jp_e160_s14000.safetensors",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
    "jvnv-F2-jp": {
        "repo": _JVNV_REPO,
        "subdir": "jvnv-F2-jp",
        "model_file": "jvnv-F2-jp/jvnv-F2_e166_s20000.safetensors",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
    "jvnv-M1-jp": {
        "repo": _JVNV_REPO,
        "subdir": "jvnv-M1-jp",
        "model_file": "jvnv-M1-jp/jvnv-M1-jp_e158_s14000.safetensors",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
    "jvnv-M2-jp": {
        "repo": _JVNV_REPO,
        "subdir": "jvnv-M2-jp",
        "model_file": "jvnv-M2-jp/jvnv-M2-jp_e159_s17000.safetensors",
        "default_style": "Neutral",
        "style_weight": 1.0,
    },
}
_VALID_VOICES = set(_VOICE_REPOS.keys())
_VALID_STYLES = {"Neutral", "Angry", "Disgust", "Fear", "Happy", "Sad", "Surprise"}

_ALLOWED_ROOT_FILES = {"index.html", "colors.js"}
_ALLOWED_DIRS = {"css", "js", "characters", "map-assets"}
_ALLOWED_EXTENSIONS = {
    ".html", ".css", ".js", ".json",
    ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff2",
}


def is_allowed_static_path(filename: str) -> bool:
    """公開を許可するゲームアセットのみ True を返す"""
    if not filename or "\x00" in filename or "\\" in filename:
        return False
    if filename.startswith("/"):
        return False

    rel = PurePosixPath(filename)
    parts = rel.parts
    if not parts:
        return False
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return False

    if len(parts) == 1:
        if parts[0] not in _ALLOWED_ROOT_FILES:
            return False
    else:
        if parts[0] not in _ALLOWED_DIRS:
            return False
        if rel.suffix.lower() not in _ALLOWED_EXTENSIONS:
            return False

    try:
        resolved = (ROOT / Path(*parts)).resolve()
        resolved.relative_to(ROOT)
    except (ValueError, OSError):
        return False

    return True


def parse_tts_speed(raw_speed, default: float = 1.0) -> float:
    """TTS速度を安全な範囲 [0.5, 2.0] に正規化"""
    try:
        val = float(raw_speed)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(val) or val <= 0:
        return default
    return max(0.5, min(2.0, val))


def sanitize_tts_text(raw_text: str) -> str:
    """
    ゲーム内の絵文字・記号・単位表記を、Style-Bert-VITS2 が自然に読み上げられる
    純粋な日本語話し言葉へ変換する。
    """
    text = str(raw_text or "").strip()[:500]
    # Python の \w は日本語も一致するため ASCII 名＋明示的日本語別名のみ除去（助詞直結「@Bobの〜」を壊さない）
    text = re.sub(
        r"^[@＠](?:[A-Za-z0-9_]+|全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)"
        r"(?:(?:さん|くん|君|ちゃん|様)[\s、,:：!！]{0,20}|[\s、,:：!！]{1,20})",
        "",
        text,
    )

    # 資源・コイン・レベル表記を自然な日本語読みに変換（ReDoS回避のため空白量を制限）
    text = re.sub(r"🪵\s{0,10}(?:木材)?\s{0,10}[×x]?\s{0,10}(\d{1,6})", r"木材\1個", text)
    text = re.sub(r"🪨\s{0,10}(?:石)?\s{0,10}[×x]?\s{0,10}(\d{1,6})", r"石\1個", text)
    text = re.sub(r"🌿\s{0,10}(?:薬草)?\s{0,10}[×x]?\s{0,10}(\d{1,6})", r"薬草\1個", text)
    text = re.sub(r"🐟\s{0,10}(?:魚)?\s{0,10}[×x]?\s{0,10}(\d{1,6})", r"魚\1匹", text)
    text = re.sub(r"🪙\s{0,10}[×x+＋]?\s{0,10}(\d{1,6}(?:\.\d{1,3})?)", r"\1コイン", text)
    text = re.sub(r"(\d{1,6}(?:\.\d{1,3})?)\s{0,10}🪙", r"\1コイン", text)
    text = re.sub(r"(?<![A-Za-z])Lv\.?\s{0,5}(\d{1,4})", r"レベル\1", text, flags=re.IGNORECASE)
    text = text.replace("🪵", "木材").replace("🪨", "石").replace("🌿", "薬草").replace("🐟", "魚").replace("🪙", "コイン")

    # 絵文字・装飾記号・発音しにくい記号を除去し、三点リーダーを自然な間（読点）へ変換
    text = re.sub(r"[…\.]{2,}", "、", text)
    text = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F♪♡♥★☆✨※]", "", text)
    text = text.replace("×", "、").replace("⇔", "と").replace("→", "、")
    text = re.sub(r"（\s*）|\(\s*\)", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:220]


def infer_tts_style(
    text: str, voice: str = "amitaro", requested_style: str = "", available_styles: set | None = None
) -> tuple[str, float]:
    """
    自然な会話イントネーションを最優先に Style-Bert-VITS2 スタイルを選択する。
    JP-Extra モデルでは style_weight=1.0 の Neutral 基調が最も歪みが少なく、
    日本語 BERT による自然なアクセント・抑揚が活きる。
    """
    spec = _VOICE_REPOS.get(voice, {})
    default_style = spec.get("default_style", "Neutral")
    default_weight = float(spec.get("style_weight", 1.0))

    styles = available_styles or _VALID_STYLES
    chosen = requested_style if requested_style in styles else default_style
    weight = default_weight

    t = str(text or "")
    if "Surprise" in styles and any(w in t for w in ("えっ！？", "まさか！", "びっくりした")):
        chosen, weight = "Surprise", 0.6
    elif "Happy" in styles and voice not in ("jvnv-M1-jp", "amitaro") and any(w in t for w in ("やった！", "最高！", "嬉しい！")):
        chosen, weight = "Happy", 0.5

    if chosen not in styles:
        chosen = "Neutral" if "Neutral" in styles else next(iter(styles), "Neutral")
    return chosen, weight


def normalize_hf_messages(raw_messages: list, fold_system: bool = False) -> list:
    """
    Hugging Face Chat Completions 向けにメッセージ配列を正規化する:
    1. 末尾の assistant プレフィルを除去（直前の user にメンション指示を補足）
    2. 連続する同一 role メッセージを結合して user/assistant 交互構造を保証
    3. fold_system=True の場合は system ロールを先頭 user メッセージへ統合
    """
    cleaned = []
    for m in raw_messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role", "user")).strip().lower()
        content = str(m.get("content", "")).strip()
        if not content or role not in ("system", "user", "assistant"):
            continue
        cleaned.append({"role": role, "content": content})

    while cleaned and cleaned[-1]["role"] == "assistant":
        prefill = cleaned.pop()["content"]
        if prefill.startswith("@") and cleaned and cleaned[-1]["role"] == "user":
            if prefill not in cleaned[-1]["content"]:
                cleaned[-1]["content"] += f"\n（必ず先頭を「{prefill} 」で始めて返答してください）"

    if fold_system:
        sys_texts = [m["content"] for m in cleaned if m["role"] == "system"]
        non_sys = [m for m in cleaned if m["role"] != "system"]
        if sys_texts:
            prefix = "\n\n".join(sys_texts)
            if non_sys and non_sys[0]["role"] == "user":
                non_sys[0] = {
                    "role": "user",
                    "content": f"{prefix}\n\n{non_sys[0]['content']}",
                }
            else:
                non_sys.insert(0, {"role": "user", "content": prefix})
        cleaned = non_sys

    merged = []
    for m in cleaned:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] = f"{merged[-1]['content']}\n{m['content']}"
        else:
            merged.append(dict(m))

    if not merged:
        merged = [{"role": "user", "content": "こんにちは"}]
    return merged


def _detect_character_profile(requested_model: str, messages: list) -> dict:
    """リクエストされたモデル名または system プロンプトからキャラクター別プロファイルを特定"""
    req_lower = (requested_model or "").lower()
    for char_id, prof in HF_CHARACTER_PROFILES.items():
        if f"#{char_id}" in req_lower or req_lower == char_id:
            return prof
    if "tinyswallow" in req_lower:
        return HF_CHARACTER_PROFILES["carol"]

    sys_text = " ".join(m.get("content", "") for m in messages if m.get("role") == "system")
    if re.search(r"(?:人間の(?:男性、?)?|あなたは)Bobです", sys_text):
        return HF_CHARACTER_PROFILES["bob"]
    if re.search(r"(?:人間の(?:女性、?)?|あなたは)Carolです", sys_text):
        return HF_CHARACTER_PROFILES["carol"]
    return HF_CHARACTER_PROFILES["alice"]


def _extract_target_mention(messages: list) -> str:
    """user メッセージの相手指定（@Player / Playerへのセリフ 等）を抽出。全員向け・推敲パスなら空文字を返す。"""
    for m in reversed(messages):
        if m.get("role") == "user":
            text = m.get("content", "")
            if (
                "特定の相手への@メンションは不要" in text
                or "周囲のみんなに聞こえるように" in text
                or "そばにいるみんなに聞こえるように" in text
                or "元のセリフ：" in text
            ):
                return ""
            hit = re.search(
                r"(?:[@＠](Player|Alice|Bob|Carol)(?![A-Za-z0-9_])"
                r"|(Player|Alice|Bob|Carol)(?:へのセリフ|へ直接|に向かって|があなた))",
                text,
                re.IGNORECASE,
            )
            if hit:
                name = hit.group(1) or hit.group(2)
                return name[0].upper() + name[1:].lower()
            break
    return ""


def _cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _configure_torch_threads() -> None:
    global _threads_configured
    if _threads_configured:
        return
    try:
        import torch
        cores = os.cpu_count() or 8
        torch.set_num_threads(max(4, min(8, cores)))
        _threads_configured = True
    except Exception:
        pass


def _check_llama_cpp_available() -> bool:
    return importlib.util.find_spec("llama_cpp") is not None


def _check_transformers_available() -> bool:
    return (
        importlib.util.find_spec("transformers") is not None
        and importlib.util.find_spec("torch") is not None
    )


def _check_local_llm_available() -> bool:
    return _check_llama_cpp_available() or _check_transformers_available()


# ── Hugging Face GGUF (llama.cpp) 高速・自然日本語推論エンジン ─────
def _resolve_hf_gguf_path(repo_id: str, prefer_quant: str = "q4_k_m") -> str:
    """
    Hugging Face リポジトリから最適な Q4_K_M GGUF ファイルをローカル解決・ダウンロードする。
    キャッシュ済みならネットワーク問い合わせをスキップして即座にパスを返す。
    """
    cache_repo_dir = (
        Path.home() / ".cache" / "huggingface" / "hub"
        / f"models--{repo_id.replace('/', '--')}" / "snapshots"
    )
    if cache_repo_dir.is_dir():
        cached_ggufs = [
            p for p in cache_repo_dir.rglob("*.gguf")
            if p.is_file() and "mmproj" not in p.name.lower()
        ]
        if cached_ggufs:
            preferred = [p for p in cached_ggufs if prefer_quant in p.name.lower()]
            return str(preferred[0] if preferred else cached_ggufs[0])

    from huggingface_hub import hf_hub_download, list_repo_files

    token = get_hf_token() or None
    files = [
        f for f in list_repo_files(repo_id, token=token)
        if f.lower().endswith(".gguf") and "mmproj" not in f.lower()
    ]
    if not files:
        raise FileNotFoundError(f"{repo_id} に GGUF ファイルが見つかりません")

    chosen = next((f for f in files if prefer_quant in f.lower()), None)
    if not chosen:
        chosen = next((f for f in files if "q4_0" in f.lower() or "q5_k" in f.lower()), files[0])
    return hf_hub_download(repo_id, chosen, token=token)


def _get_llama_cpp_model(repo_id: str):
    from llama_cpp import Llama

    with _llama_lock:
        if repo_id not in _llama_models:
            actual_repo = repo_id
            try:
                gguf_path = _resolve_hf_gguf_path(repo_id)
            except Exception as e:
                if repo_id != HF_SARASHINA_GGUF_REPO:
                    print(f"[LLM] {repo_id} 取得失敗 ({e}) → {HF_SARASHINA_GGUF_REPO} へフォールバック")
                    actual_repo = HF_SARASHINA_GGUF_REPO
                    gguf_path = _resolve_hf_gguf_path(HF_SARASHINA_GGUF_REPO)
                else:
                    raise
            n_threads = max(4, min(8, os.cpu_count() or 8))
            model = Llama(
                model_path=gguf_path,
                n_ctx=2048,
                n_threads=n_threads,
                n_batch=256,
                verbose=False,
            )
            _llama_models[repo_id] = (model, actual_repo)
            if actual_repo != repo_id:
                _llama_models[actual_repo] = (model, actual_repo)
        return _llama_models[repo_id]


def _clean_dialogue_output(raw_text: str, target_name: str) -> str:
    text = str(raw_text or "").strip()
    # 先頭の重複改行・引用符・不要なロールラベルを除去
    text = re.sub(r"^(?:Assistant|Alice|Bob|Carol)\s*[:：]\s*", "", text, flags=re.IGNORECASE).strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    # 推敲パス等で「元のセリフ：...\n言い直したセリフ：...」と2行出力された場合は言い直し行を採用
    rewrite_line = next((ln for ln in lines if re.match(r"^(?:言い直したセリフ|自然なセリフ|推敲後|修正後)\s*[:：]", ln)), None)
    first = rewrite_line if rewrite_line is not None else (lines[0] if lines else "")
    first = re.sub(r"^(?:言い直したセリフ|自然なセリフ|推敲後|修正後|返答|返信|セリフ|発言)\s*[:：]\s*", "", first).strip()
    for src, dst in (("发现", "発見"), ("药", "薬"), ("气", "気"), ("乐", "楽"), ("买", "買"), ("卖", "売"), ("钱", "銭")):
        first = first.replace(src, dst)
    # メンション重複を整理（Python \w は日本語にも一致するため ASCII 名＋別名＋区切りのみ安全に除去）
    first = re.sub(
        r"^[@＠](?:[A-Za-z0-9_]+|全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)"
        r"(?:(?:さん|くん|君|ちゃん|様)[\s、,:：!！]*|[\s、,:：!！]+)",
        "",
        first,
    ).strip()
    first = re.sub(
        r"[@＠](全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー|[A-Za-z0-9_]+)",
        r"\1",
        first,
    ).strip()
    if not first:
        return ""
    # 2文まで自然に保持（1文完結＋2文目が途中切れなら1文目で綺麗に切る。1文目自体が途中切れなら「。」を勝手に足さず空で返す）
    natural_end_re = re.compile(
        r"(?:です|ます|ました|でした|ません|たい|ない|ろう|よう|しょう|[おこそとのほもよろごぞどぼぽ]う|"
        r"くれ|ちょうだい|ありがとう|よろしく|ごめん|おはよう|こんにちは|こんばんは|なの|んだ|んです|んだよ|んだね|"
        r"だよ|だね|だな|かな|かも|[だたるいうくすつぬぶむぐ][よねなさわぞぜか]|(?:っ|し|い|ん)た|(?:[ぁ-ん]|[\u4E00-\u9FFF])(?:る|い)|だ)$"
    )
    cutoff_end_re = re.compile(
        r"(?:[、,・：:;「『（(\[【]|を|が|に|は|へ|で|と|も|から|まで|より|けど|けれど|ので|のに|って|"
        r"ながら|たり|つつ|て|んで|っ|し|新鮮な|静かな|お得な|育てていな|売らな|見てみよ|集めよ)$"
    )
    matches = list(re.finditer(r"[。！？!?♪♡]+[」』\"”'）)]*", first))
    if len(matches) >= 2:
        first = first[:matches[1].end()].strip()
    elif len(matches) == 1 and matches[0].end() < len(first):
        tail = first[matches[0].end():].strip()
        if len(first) > 55 or (tail and (cutoff_end_re.search(tail) or not natural_end_re.search(tail))):
            first = first[:matches[0].end()].strip()
    elif not matches:
        trimmed = first.rstrip("、, ")
        if len(trimmed) <= 4 or cutoff_end_re.search(trimmed) or not natural_end_re.search(trimmed):
            return ""
        first = trimmed + "。"
    return f"@{target_name} {first}".strip() if target_name else first


def _generate_with_llama_cpp(
    messages: list, max_new_tokens: int = 120, requested_model: str = "", temperature: float | None = None
) -> dict:
    """
    Hugging Face の自然・高性能日本語 GGUF モデル (Gemma-3-4B / Sarashina2.2-3B) を
    llama.cpp (AVX2 SIMD) で高速・高品質にローカル推論する。
    """
    profile = _detect_character_profile(requested_model, messages)
    repo_id = profile["repo_id"]
    llm, active_repo = _get_llama_cpp_model(repo_id)
    is_gemma = "gemma" in active_repo.lower()

    sys_text = "\n".join(m["content"] for m in messages if m["role"] == "system")
    last_user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    is_structured_plan = (
        ("PLAN:" in sys_text and "RESOURCE:" in sys_text)
        or ("FOCUS:" in sys_text and "GOAL:" in sys_text)
    )
    is_polish_pass = "元のセリフ：" in last_user or "言い直したセリフ" in sys_text
    target_name = "" if (is_structured_plan or is_polish_pass) else _extract_target_mention(messages)

    if is_structured_plan:
        chat_msgs = normalize_hf_messages(messages, fold_system=is_gemma)
        gen_tokens = min(max(80, int(max_new_tokens or 140)), 180)
        stop_seqs = ["\n\n\n", "</s>", "<|im_end|>", "<end_of_turn>", "<eos>"]
    elif is_polish_pass:
        # 推敲パスでは通常会話 few_shot を混ぜず、リライト指示をそのまま渡す
        chat_msgs = normalize_hf_messages(messages, fold_system=is_gemma)
        gen_tokens = min(max(64, int(max_new_tokens or 104)), 140)
        stop_seqs = ["\n\n", "</s>", "<|im_end|>", "<end_of_turn>", "<eos>"]
    else:
        non_sys = [m for m in messages if m["role"] != "system"]
        enhanced_sys = (
            f"{sys_text}\n"
            "重要: あなたはこの街に暮らす生身の人間です。相手も同じ街に暮らす人間として、自然な話し言葉の日本語1〜2文で返答してください。"
            "英単語や中国語、硬い書き言葉は避け、普段の会話のように自然に話してください。"
        ).strip()
        chat_msgs = (
            [{"role": "system", "content": enhanced_sys}]
            + profile["few_shot"]
            + non_sys[-8:]
        )
        chat_msgs = normalize_hf_messages(chat_msgs, fold_system=is_gemma)
        gen_tokens = min(max(80, int(max_new_tokens or 120)), 160)
        stop_seqs = ["\n", "</s>", "<|im_end|>", "<end_of_turn>", "<eos>"]

    eff_temp = profile["temperature"]
    if temperature is not None:
        try:
            eff_temp = max(0.0, min(1.0, float(temperature)))
        except (TypeError, ValueError):
            pass

    with _llama_lock:
        result = llm.create_chat_completion(
            messages=chat_msgs,
            max_tokens=gen_tokens,
            temperature=eff_temp,
            top_p=profile["top_p"],
            repeat_penalty=profile["repeat_penalty"],
            stop=stop_seqs,
        )

    raw_reply = (
        result.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
        .strip()
    )

    if is_structured_plan:
        reply = raw_reply
    else:
        # 整形失敗時は「こんにちは！」で誤魔化さず空文字を返し、クライアント側の推敲・再試行に委ねる
        reply = _clean_dialogue_output(raw_reply, target_name)

    return {
        "id": "hf-local-llama-cpp",
        "object": "chat.completion",
        "model": active_repo,
        "hf_model_used": profile["profile_id"],
        "hf_engine": f"llama.cpp-gguf ({active_repo})",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }
        ],
    }


# ── フォールバック用ローカル transformers エンジン ───────────────────
def _get_local_transformers_llm(base_model_id: str = ""):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    _configure_torch_threads()
    target_id = base_model_id or HF_TRANSFORMERS_FALLBACK_MODEL
    with _local_llm_lock:
        if target_id not in _local_llm_cache:
            token = get_hf_token() or None
            device = "cuda" if _cuda_available() else "cpu"
            dtype = torch.float16 if device == "cuda" else torch.float32
            tokenizer = AutoTokenizer.from_pretrained(target_id, token=token)
            model = AutoModelForCausalLM.from_pretrained(
                target_id,
                token=token,
                dtype=dtype,
                low_cpu_mem_usage=True,
            )
            model.to(device)
            model.eval()
            _local_llm_cache[target_id] = (tokenizer, model, device, target_id)
        return _local_llm_cache[target_id]


def _generate_with_local_transformers(
    messages: list, max_new_tokens: int = 44, requested_model: str = ""
) -> dict:
    import torch

    profile = _detect_character_profile(requested_model, messages)
    tokenizer, model, device, loaded_id = _get_local_transformers_llm(HF_TRANSFORMERS_FALLBACK_MODEL)
    target_name = _extract_target_mention(messages)

    chat_msgs = normalize_hf_messages(messages, fold_system=False)
    prompt_text = tokenizer.apply_chat_template(
        chat_msgs, tokenize=False, add_generation_prompt=True
    )
    with _local_llm_lock:
        inputs = tokenizer([prompt_text], return_tensors="pt").to(device)
        with torch.inference_mode():
            generated_ids = model.generate(
                **inputs,
                max_new_tokens=min(max(80, int(max_new_tokens or 120)), 160),
                do_sample=True,
                temperature=profile["temperature"],
                top_p=profile["top_p"],
                pad_token_id=tokenizer.eos_token_id,
            )
        out_ids = generated_ids[0][inputs.input_ids.shape[1]:]
        decoded = tokenizer.decode(out_ids, skip_special_tokens=True).strip()

    reply = _clean_dialogue_output(decoded, target_name) or decoded
    return {
        "id": "hf-local-transformers",
        "object": "chat.completion",
        "model": loaded_id,
        "hf_model_used": profile["profile_id"],
        "hf_engine": f"transformers ({loaded_id})",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }
        ],
    }


def _generate_local_hf_chat(
    messages: list, max_new_tokens: int = 100, requested_model: str = "", temperature: float | None = None
) -> dict:
    """llama.cpp (Sarashina2.2-3B / TinySwallow-1.5B GGUF) を最優先し、未導入時のみ transformers を使用"""
    if _check_llama_cpp_available():
        try:
            return _generate_with_llama_cpp(
                messages,
                max_new_tokens=max_new_tokens,
                requested_model=requested_model,
                temperature=temperature,
            )
        except Exception as e:
            if not _check_transformers_available():
                raise
            print(f"[LLM] llama.cpp fallback to transformers: {e}")
    return _generate_with_local_transformers(
        messages, max_new_tokens=max_new_tokens, requested_model=requested_model
    )


# ── Hugging Face Style-Bert-VITS2 自然日本語音声エンジン ──────────
def _ensure_compatible_pyopenjtalk() -> None:
    """
    NumPy 2.x 環境で pyopenjtalk-dict (NumPy 1.x ビルド) が ValueError を出す場合、
    ローカル pip キャッシュにある NumPy 2.x 対応 pyopenjtalk-0.4.1 wheel を
    純粋な ASCII パス (~/.cache/pyopenjtalk_041) に展開して優先ロードする。
    """
    try:
        import pyopenjtalk  # noqa: F401
        return
    except ValueError as e:
        if "numpy.dtype size changed" not in str(e):
            raise

    for mod_name in [k for k in sys.modules if k == "pyopenjtalk" or k.startswith("pyopenjtalk.")]:
        sys.modules.pop(mod_name, None)

    shim_dir = Path.home() / ".cache" / "pyopenjtalk_041"
    init_file = shim_dir / "pyopenjtalk" / "__init__.py"
    if not init_file.is_file():
        local_app = os.environ.get("LOCALAPPDATA", "")
        if local_app:
            pip_cache = Path(local_app) / "pip" / "Cache"
            wheels = list(pip_cache.rglob("pyopenjtalk-0.4.1-*win_amd64.whl")) if pip_cache.exists() else []
            if wheels:
                shim_dir.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(wheels[0]) as zf:
                    zf.extractall(shim_dir)

    if init_file.is_file():
        shim_str = str(shim_dir)
        if shim_str not in sys.path:
            sys.path.insert(0, shim_str)


def _resolve_sbv2_files(voice: str) -> tuple[str, str, str]:
    """Hugging Face Hub（またはローカルキャッシュ）から Style-Bert-VITS2 の 3 ファイルを取得"""
    from huggingface_hub import hf_hub_download, list_repo_files

    spec = _VOICE_REPOS.get(voice) or _VOICE_REPOS["jvnv-F1-jp"]
    repo = spec["repo"]
    token = get_hf_token() or None

    # 既知パス（jvnv系）は list_repo_files のネットワーク往復を省いて即解決
    if "model_file" in spec and "subdir" in spec:
        sub = spec["subdir"]
        return (
            hf_hub_download(repo, spec["model_file"], token=token),
            hf_hub_download(repo, f"{sub}/config.json", token=token),
            hf_hub_download(repo, f"{sub}/style_vectors.npy", token=token),
        )

    # キャッシュ済みスナップショットがあればローカルから即解決
    cache_dir = (
        Path.home() / ".cache" / "huggingface" / "hub"
        / f"models--{repo.replace('/', '--')}" / "snapshots"
    )
    if cache_dir.is_dir():
        safes = [p for p in cache_dir.rglob("*.safetensors") if p.is_file()]
        confs = [p for p in cache_dir.rglob("config.json") if p.is_file()]
        vecs = [p for p in cache_dir.rglob("style_vectors.npy") if p.is_file()]
        if safes and confs and vecs:
            return str(safes[0]), str(confs[0]), str(vecs[0])

    # 初回は Hugging Face Hub から自動探索してダウンロード
    all_files = list(list_repo_files(repo, token=token))
    model_path = next((f for f in all_files if f.endswith(".safetensors")), None)
    config_path = next((f for f in all_files if f.endswith("config.json")), None)
    style_path = next((f for f in all_files if f.endswith("style_vectors.npy")), None)
    if not (model_path and config_path and style_path):
        raise FileNotFoundError(f"{repo} に必要な Style-Bert-VITS2 ファイルが見つかりません")

    return (
        hf_hub_download(repo, model_path, token=token),
        hf_hub_download(repo, config_path, token=token),
        hf_hub_download(repo, style_path, token=token),
    )


def _get_sbv2_model(voice: str = "amitaro"):
    global _sbv2_bert_loaded
    _configure_torch_threads()
    if voice not in _VOICE_REPOS:
        voice = "jvnv-F1-jp"

    with _sbv2_lock:
        if voice not in _sbv2_models:
            _ensure_compatible_pyopenjtalk()
            from style_bert_vits2.constants import Languages
            from style_bert_vits2.nlp import bert_models
            from style_bert_vits2.tts_model import TTSModel

            if not _sbv2_bert_loaded:
                bert_model = bert_models.load_model(Languages.JP, _BERT_REPO)
                bert_models.load_tokenizer(Languages.JP, _BERT_REPO)
                try:
                    bert_model.eval()
                except Exception:
                    pass
                _sbv2_bert_loaded = True

            actual_voice = voice
            try:
                model_file, config_file, style_file = _resolve_sbv2_files(voice)
            except Exception as e:
                fallback = _VOICE_REPOS.get(voice, {}).get("fallback")
                if not fallback or fallback == voice:
                    raise
                print(f"[TTS] {voice} ロード失敗 ({e}) → {fallback} へフォールバック")
                actual_voice = fallback
                model_file, config_file, style_file = _resolve_sbv2_files(fallback)

            # config.json からモデル固有の利用可能スタイル一覧を取得
            styles = set(_VALID_STYLES)
            try:
                cfg_data = json.loads(Path(config_file).read_text(encoding="utf-8"))
                s2i = cfg_data.get("data", {}).get("style2id", {})
                if isinstance(s2i, dict) and s2i:
                    styles = set(s2i.keys())
            except Exception:
                pass

            tts_model = TTSModel(
                model_path=model_file,
                config_path=config_file,
                style_vec_path=style_file,
                device="cuda" if _cuda_available() else "cpu",
            )
            _sbv2_models[voice] = tts_model
            _sbv2_model_styles[voice] = styles
            if actual_voice != voice:
                _sbv2_models[actual_voice] = tts_model
                _sbv2_model_styles[actual_voice] = styles

        return _sbv2_models[voice], _sbv2_model_styles.get(voice, _VALID_STYLES)


def _synthesize_sbv2_wav(
    text: str, voice: str = "amitaro", speed: float = 1.0, requested_style: str = ""
) -> bytes:
    """
    Hugging Face Style-Bert-VITS2 (JP-Extra) で自然な日本語音声を合成し WAV バイト列を返す。
    - 絵文字・記号を自然な日本語読みへ前処理 (sanitize_tts_text)
    - 公式推奨の自然抑揚パラメータ (sdp_ratio=0.2, noise=0.6, noise_w=0.8, style_weight=1.0)
    - 音量ピーク正規化 (-1.5dBFS) ＋ 15ms デクリック・フェード処理
    - 128件のメモリ内 LRU キャッシュで同一セリフは <1ms で即再生
    """
    import numpy as np
    import soundfile as sf
    import torch

    if voice not in _VALID_VOICES:
        voice = "amitaro"
    speed = parse_tts_speed(speed)
    clean_text = sanitize_tts_text(text)
    if not clean_text:
        clean_text = "こんにちは。"

    model, available_styles = _get_sbv2_model(voice)
    style, style_weight = infer_tts_style(clean_text, voice, requested_style, available_styles)

    cache_key = (voice, style, round(speed, 2), clean_text)
    if cache_key in _tts_audio_cache:
        _tts_audio_cache.move_to_end(cache_key)
        return _tts_audio_cache[cache_key]

    with torch.inference_mode():
        sr, audio = model.infer(
            clean_text,
            style=style,
            style_weight=style_weight,
            sdp_ratio=0.2,
            noise=0.6,
            noise_w=0.8,
            length=1.0 / speed,
            line_split=False,
        )

    # 音量正規化＆クリックノイズ防止の極短フェード処理（クリアな聴感に仕上げる）
    wav = np.asarray(audio, dtype=np.float32)
    if wav.size > 0:
        peak = float(np.max(np.abs(wav)))
        if peak > 1e-6:
            wav = wav * (0.84 / peak)
        fade_len = min(int(sr * 0.015), wav.size // 4)
        if fade_len > 1:
            ramp = np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
            wav[:fade_len] *= ramp
            wav[-fade_len:] *= ramp[::-1]

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
    audio_bytes = buf.getvalue()

    _tts_audio_cache[cache_key] = audio_bytes
    if len(_tts_audio_cache) > _TTS_CACHE_MAX:
        _tts_audio_cache.popitem(last=False)
    return audio_bytes


def _check_sbv2_available():
    try:
        _ensure_compatible_pyopenjtalk()
        from style_bert_vits2.tts_model import TTSModel  # noqa: F401
        return True, "Hugging Face Style-Bert-VITS2 JP-Extra (amitaro / jvnv-M1-jp / jvnv-F2-jp): OK"
    except Exception as e:
        app.logger.warning("SBV2 availability check failed: %s", e)
        return False, "Style-Bert-VITS2 が利用できません。"


app = Flask(__name__)
CORS(
    app,
    origins=[re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")],
)


@app.after_request
def _disable_static_code_cache(resp):
    """ブラウザの古い JS/HTML キャッシュによる音声・AI設定の反映漏れを防ぐ"""
    ct = resp.headers.get("Content-Type", "")
    if any(t in ct for t in ("text/html", "javascript", "text/css")):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return resp


# ── ゲームファイル配信（許可リスト制御） ──────────────────────────
@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/<path:filename>", methods=["GET"])
def static_files(filename):
    if not is_allowed_static_path(filename):
        abort(404)
    return send_from_directory(ROOT, filename)


# ── ヘルスチェック（Hugging Face AI・TTS接続状態） ─────────────────
@app.route("/health", methods=["GET"])
def health():
    token = get_hf_token()
    local_llama = _check_llama_cpp_available()
    local_tf = _check_transformers_available()
    local_ok = local_llama or local_tf
    is_testing = bool(app.config.get("TESTING"))

    mode_name = (
        "cloud-router"
        if (HF_USE_CLOUD_ROUTER or is_testing)
        else ("local-llama-cpp" if local_llama else "local-transformers")
    )

    hf_status = {
        "ok": False,
        "provider": "huggingface",
        "mode": mode_name,
        "url": HF_CHAT_URL if (HF_USE_CLOUD_ROUTER or is_testing) else f"local://{HF_LOCAL_MODEL}",
        "token_configured": bool(token),
        "local_llama_cpp_available": local_llama,
        "local_transformers_available": local_tf,
        "local_model": HF_LOCAL_MODEL,
        "default_model": HF_DEFAULT_MODEL,
        "character_models": HF_CHARACTER_MODELS,
        "models": [],
    }

    if not is_testing and not HF_USE_CLOUD_ROUTER and local_ok:
        hf_status["ok"] = True
        hf_status["models"] = [
            HF_SARASHINA_GGUF_REPO,
            HF_TINYSWALLOW_GGUF_REPO,
            *HF_CHARACTER_MODELS.values(),
        ]
    else:
        try:
            kwargs = {
                "headers": _build_hf_headers(),
                "timeout": 2.5,
            }
            if _is_local_url(HF_MODELS_URL):
                kwargs["proxies"] = _LOCAL_PROXIES
            resp = requests.get(HF_MODELS_URL, **kwargs)
            if resp.ok:
                payload = resp.json()
                models = [
                    m.get("id")
                    for m in payload.get("data", [])
                    if isinstance(m, dict) and m.get("id")
                ]
                if not models:
                    models = list(HF_FALLBACK_MODELS)
                hf_status["ok"] = True
                hf_status["models"] = models[:25]
            else:
                hf_status["error"] = f"HTTP {resp.status_code}"
        except requests.exceptions.RequestException as e:
            app.logger.warning("HF models check failed: %s", e)
            hf_status["error"] = "Hugging Face API に接続できませんでした。"
        except ValueError as e:
            app.logger.warning("HF models JSON parse failed: %s", e)
            hf_status["error"] = "Hugging Face API の応答を解析できませんでした。"

    tts_ok, tts_msg = _check_sbv2_available()
    tts_status = {
        "provider": "huggingface",
        "mode": "local-style-bert-vits2",
        "repo": _JVNV_REPO,
        "voice_repos": {k: v["repo"] for k, v in _VOICE_REPOS.items()},
        "bert_repo": _BERT_REPO,
        "local_available": tts_ok,
        "api_available": bool(token),
        "message": tts_msg,
        "voices": sorted(_VALID_VOICES),
        "styles": sorted(_VALID_STYLES),
    }

    return jsonify({
        "ok": True,
        "hf_api": hf_status,
        "lm_studio": hf_status,  # 後方互換フィールド
        "tts": tts_status,
    })


# ── Hugging Face Chat エンドポイント（ローカル GGUF 優先） ──────────
@app.route("/chat", methods=["POST"])
def chat():
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        return jsonify({"error": {"message": "リクエストボディの形式が不正です（messages が必要です）"}}), 400

    requested_model = str(body.get("model") or HF_DEFAULT_MODEL).strip()
    is_testing = bool(app.config.get("TESTING"))

    # 1. 既定モード: 有料枠を使わずローカルの自然日本語 Hugging Face モデル (Sarashina2.2-3B / TinySwallow-1.5B) で推論
    if not is_testing and not HF_USE_CLOUD_ROUTER and _check_local_llm_available():
        try:
            normalized_msgs = normalize_hf_messages(body["messages"], fold_system=False)
            local_data = _generate_local_hf_chat(
                normalized_msgs,
                max_new_tokens=int(body.get("max_tokens") or 100),
                requested_model=requested_model,
                temperature=body.get("temperature"),
            )
            return jsonify(local_data), 200
        except Exception as e:
            app.logger.exception("Local HF chat inference failed")
            return jsonify({"error": {"message": "Hugging Face ローカル推論エラーが発生しました。"}}), 500

    # 2. Cloud Router モード（または単体テストのモック検証時）
    candidate_models = [requested_model] + [
        m for m in HF_FALLBACK_MODELS if m != requested_model
    ]
    headers = _build_hf_headers()
    last_resp = None

    for idx, model_id in enumerate(candidate_models):
        normalized_msgs = normalize_hf_messages(body["messages"], fold_system=(idx > 0))
        payload = {
            **body,
            "model": model_id,
            "messages": normalized_msgs,
            "stream": False,
        }

        try:
            kwargs = {
                "headers": headers,
                "json": payload,
                "timeout": 60,
            }
            if _is_local_url(HF_CHAT_URL):
                kwargs["proxies"] = _LOCAL_PROXIES
            hf_resp = requests.post(HF_CHAT_URL, **kwargs)
        except requests.exceptions.RequestException as e:
            app.logger.warning("HF chat request failed for model=%s: %s", model_id, e)
            if not is_testing and _check_local_llm_available():
                break
            return jsonify({"error": {"message": "Hugging Face API に接続できませんでした。"}}), 502

        last_resp = hf_resp
        if hf_resp.status_code == 200:
            try:
                data = hf_resp.json()
                if isinstance(data, dict):
                    data.setdefault("hf_model_used", model_id)
            except ValueError:
                app.logger.warning("HF chat response JSON parse failed for model=%s", model_id)
                data = {"error": {"message": "Hugging Face API の応答を解析できませんでした。"}}
            return jsonify(data), 200

        if hf_resp.status_code in (401, 402, 403):
            break

    if not is_testing and _check_local_llm_available():
        try:
            normalized_msgs = normalize_hf_messages(body["messages"], fold_system=False)
            local_data = _generate_local_hf_chat(
                normalized_msgs,
                max_new_tokens=int(body.get("max_tokens") or 100),
                requested_model=requested_model,
                temperature=body.get("temperature"),
            )
            return jsonify(local_data), 200
        except Exception as e:
            app.logger.exception("Local HF chat inference failed")
            return jsonify({"error": {"message": "Hugging Face ローカル推論エラーが発生しました。"}}), 500

    if last_resp is None:
        return jsonify({"error": {"message": "Hugging Face API 呼び出しに失敗しました"}}), 502

    try:
        err_data = last_resp.json()
    except ValueError:
        err_data = None

    safe_message = "Hugging Face API からエラー応答が返されました。"
    if isinstance(err_data, dict):
        err_obj = err_data.get("error")
        if isinstance(err_obj, dict):
            raw_msg = err_obj.get("message")
        elif isinstance(err_obj, str):
            raw_msg = err_obj
        else:
            raw_msg = err_data.get("message")
        if isinstance(raw_msg, str) and raw_msg.strip():
            cleaned = re.sub(r"\s+", " ", raw_msg).strip()
            if len(cleaned) <= 200 and "Traceback" not in cleaned and " at " not in cleaned:
                safe_message = cleaned

    app.logger.warning("HF chat upstream error status=%s", last_resp.status_code)
    return jsonify({"error": {"message": safe_message}}), last_resp.status_code


# ── Hugging Face TTS エンドポイント (/tts, /tts-local) ────────────
@app.route("/tts", methods=["POST"])
def tts():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": {"message": "リクエストボディの形式が不正です"}}), 400

    raw_text = body.get("text") or body.get("input") or ""
    text = raw_text.strip() if isinstance(raw_text, str) else ""
    if not text:
        return jsonify({"error": {"message": "text は必須です"}}), 400
    text = text[:500]

    voice = body.get("voice", "amitaro")
    speed = parse_tts_speed(body.get("speed", 1.0))
    style = str(body.get("style") or "")

    sbv2_ok, _ = _check_sbv2_available()
    if sbv2_ok:
        try:
            audio_bytes = _synthesize_sbv2_wav(text, voice=voice, speed=speed, requested_style=style)
            return audio_bytes, 200, {
                "Content-Type": "audio/wav",
                "Content-Length": str(len(audio_bytes)),
            }
        except Exception as e:
            app.logger.exception("TTS synthesis failed (/tts)")
            return jsonify({"error": {"message": "音声合成に失敗しました。"}}), 500

    return jsonify({"error": {"message": "Style-Bert-VITS2 が利用できません"}}), 503


@app.route("/tts-local", methods=["POST"])
def tts_local():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": {"message": "リクエストボディの形式が不正です"}}), 400

    raw_text = body.get("text", "")
    text = raw_text.strip() if isinstance(raw_text, str) else ""
    if not text:
        return jsonify({"error": {"message": "text は必須です"}}), 400
    text = text[:500]

    voice = body.get("voice", "amitaro")
    if voice not in _VALID_VOICES:
        voice = "amitaro"
    speed = parse_tts_speed(body.get("speed", 1.0))
    style = str(body.get("style") or "")
    if style and style not in _VALID_STYLES:
        style = ""

    try:
        audio_bytes = _synthesize_sbv2_wav(text, voice=voice, speed=speed, requested_style=style)
    except Exception as e:
        app.logger.exception("TTS synthesis failed (/tts-local)")
        return jsonify({"error": {"message": "音声合成に失敗しました。"}}), 500

    return audio_bytes, 200, {
        "Content-Type": "audio/wav",
        "Content-Length": str(len(audio_bytes)),
    }


@app.route("/tts-check", methods=["GET"])
def tts_check():
    ok, msg = _check_sbv2_available()
    return jsonify({
        "ok": ok,
        "provider": "huggingface",
        "mode": "local-style-bert-vits2",
        "repo": _JVNV_REPO,
        "voice_repos": {k: v["repo"] for k, v in _VOICE_REPOS.items()},
        "bert_repo": _BERT_REPO,
        "voices": sorted(_VALID_VOICES),
        "styles": sorted(_VALID_STYLES),
        "message": msg,
    }), (200 if ok else 500)


def _find_python312_with_sbv2() -> str:
    """現在の Python に style_bert_vits2 が無い場合、導入済みの Python 3.12 を探す"""
    if importlib.util.find_spec("style_bert_vits2") is not None:
        return ""
    local_app = os.environ.get("LOCALAPPDATA", "")
    if not local_app:
        return ""
    candidate = Path(local_app) / "Programs" / "Python" / "Python312" / "python.exe"
    if candidate.is_file() and candidate.resolve() != Path(sys.executable).resolve():
        return str(candidate)
    return ""


if __name__ == "__main__":
    if os.environ.get("BOT_GAME_NO_REEXEC") != "1":
        py312 = _find_python312_with_sbv2()
        if py312:
            env = dict(os.environ, BOT_GAME_NO_REEXEC="1")
            raise SystemExit(
                subprocess.call([py312, str(Path(__file__).resolve()), *sys.argv[1:]], env=env)
            )

    host = os.environ.get("GAME_HOST", "127.0.0.1")
    port = int(os.environ.get("GAME_PORT", "8765"))
    sbv2_ok, sbv2_msg = _check_sbv2_available()
    print("=" * 68)
    print(f"Bot対話ゲーム サーバー起動: http://{host}:{port}")
    print(f"Hugging Face 自然高性能LLM : {HF_GEMMA3_GGUF_REPO} (Gemma 3 4B Q4_K_M)")
    print(f"                           : フォールバック={HF_SARASHINA_GGUF_REPO} (3B)")
    print(f"Hugging Face 自然日本語音声: {sbv2_msg}")
    print("停止するには Ctrl+C を押してください")
    print("=" * 68)
    app.run(host=host, port=port, debug=False)
