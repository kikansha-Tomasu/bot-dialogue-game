# Bot対話ゲーム

AIキャラクターが2Dマップ上を自由に動き回り、プレイヤーや互いに会話するブラウザゲームです。  
資源を採集し、農地で作物を育て、料理をクラフトし、建築物を建て、キャラクター間で市場取引を行うことができます。  
**GitHub Pages 上でサーバーを立てずにそのまま動作する「サーバー不要モード」**と、**ローカルPCで高音質・高性能モデルを動かす「ローカルサーバーモード」**の両方に自動対応しています。

---

## 特徴

- **サーバー不要（GitHub Pages）でそのまま稼働**：
  - 静的サイトを開くだけで、ブラウザ内蔵の **Hugging Face Transformers.js v3（WebGPU / WASM）** が Web Worker 上で自動起動し、無料・APIトークン不要で **Hugging Face ONNX モデル**（`onnx-community/Qwen2.5-1.5B-Instruct` / `Qwen2.5-0.5B-Instruct`）を動かします（モデルはブラウザにキャッシュされます）。
  - 読み上げ音声は OS / ブラウザの自然な日本語ニューラル音声（Microsoft Nanami / Keita Natural、Google 日本語など）を自動選択し、絵文字や `Lv.3` を自然な日本語へ変換して読み上げます。
- **ローカル高音質・高性能モード（`server.py` / `起動.bat`）**：
  - `http://127.0.0.1:8765` で起動すると自動的にローカルサーバーへ接続し、**Google Gemma 3 4B Instruct**（`unsloth/gemma-3-4b-it-GGUF`, `Q4_K_M`）＋ **Style-Bert-VITS2 JP-Extra**（あみたろ / `jvnv-M1-jp` / `jvnv-F2-jp`）で自然な日本語会話と高品質な音声合成が完全無料・回数無制限で楽しめます。
- **全員が「総資産ランキング1位」を競うライバル**：
  - **🎩 Alice**（明るい探偵）・**🎭 Bob**（哲学的詩人）・**🌸 Carol**（陽気な料理人）・**Player** が、資源採集・**8種作物の農業プログレッション（Stage 0〜3）**・**6種レシピの料理クラフト**・建築・板寄せ取引市場・街発展（Lv.0〜5）を駆使してトップ（総資産 `150🪙` または 街 `Lv.5` 到達）を競います。
- **4種類のマップ**：`Central Plaza` / `Shopping Street` / `Forest Hamlet` / `Farm Riverside` を画面上部から即座に切替可能。

---

## 遊び方（2通りの起動方法）

### 方法1：サーバー不要で遊ぶ（GitHub Pages）

1. GitHub リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定すると、`.github/workflows/pages.yml` が自動で静的サイトをデプロイします。
2. 公開された GitHub Pages URL をブラウザ（Chrome / Edge 推奨・WebGPU 対応環境だと高速）で開くだけで、サーバー起動・環境構築・APIキー不要ですぐに遊べます。
   - 初回のみブラウザ内で Hugging Face AI モデルを読み込みます（画面左上に `⏳ HF AI読込 XX%` と表示され、読み込み中もそのまま遊べます）。

### 方法2：ローカルPCで Gemma 3 4B ＋ Style-Bert-VITS2 音声を使う

1. Python 3.12 と依存パッケージを準備します（`pip install -r requirements.txt`）。
2. **`起動.bat` をダブルクリック**（または `python server.py` を実行）します。
   - `.env` や `HF_TOKEN` は不要です（完全無料の公開 Hugging Face GGUF / Style-Bert-VITS2 モデルを自動ダウンロードします）。
3. ブラウザで `http://127.0.0.1:8765` が開きます。

---

## 使用している Hugging Face AI モデル

| 動作モード | LLM（会話・行動判断） | 音声（TTS） | サーバー / 課金 |
|---|---|---|---|
| **GitHub Pages（サーバー不要）** | `onnx-community/Qwen2.5-1.5B-Instruct`（WebGPU）<br>`onnx-community/Qwen2.5-0.5B-Instruct`（WASMフォールバック） | ブラウザ自然日本語ニューラル音声<br>（Nanami / Keita Natural 等） | **サーバー不要・無料** |
| **ローカルサーバー（`server.py`）** | `unsloth/gemma-3-4b-it-GGUF`（Google Gemma 3 4B `Q4_K_M`） | `litagin/sbv2_amitaro`（Alice）<br>`litagin/style_bert_vits2_jvnv`（Bob `M1` / Carol `F2`） | ローカル無料・API枠不要 |

---

## 操作方法

※ チャット入力欄やフォーム入力中（日本語IME変換中を含む）はゲーム操作キーが自動無効化されます。

| キー | 内容 |
|------|------|
| `WASD` / 矢印キー | プレイヤー移動（建物・森・池は壁沿いスライドで回避） |
| `E` | 近くの資源を採集／収穫可能な自分の畑を収穫（範囲内で `[E]` 表示） |
| `B` | 建築メニューを開く／閉じる（設置中は取消） |
| `U` | 街の発展・農業・料理・能力強化・アバターパネルを開く／閉じる |
| `T` | 取引板を開く／閉じる |
| `I` | インベントリ・ライバル総資産ランキングを開く／閉じる |
| `Esc` | 開いているパネルを閉じる／建築設置をキャンセル |

---

## ファイル構成

```text
Bot対話ゲーム/
├── index.html                        ← エントリーHTML（相対パスで静的配信対応）
├── colors.js                         ← カラーパレット定義
├── .nojekyll                         ← GitHub Pages 静的配信マーカー
├── .github/workflows/pages.yml       ← GitHub Pages 自動デプロイワークフロー
├── css/style.css                     ← UI・アクセシビリティ対応スタイル
├── js/
│   ├── hf-browser-worker.js          ← サーバー不要用 Hugging Face Transformers.js Web Worker
│   ├── api.js                        ← Hugging Face AI クライアント（ローカル／ブラウザ自動切替）
│   ├── tts.js                        ← 音声管理（Style-Bert-VITS2 ／ 自然日本語ブラウザ音声）
│   ├── config.js                     ← ゲーム・キャラクター設定
│   ├── resources.js                  ← 資源ノード管理＆高視認描画
│   ├── inventory.js                  ← インベントリ＆総資産評価
│   ├── buildings.js                  ← 建築物配置・資源自動生産
│   ├── trade.js                      ← 板寄せ取引所・チャート・テクニカル指標
│   ├── pathfinding.js                ← コリジョン＆8方向A*経路探索
│   ├── farming.js                    ← 8種作物農業プログレッション＆6種料理クラフト
│   ├── progression.js                ← 街発展（Lv.0〜5）・納品依頼・強化・優勝判定
│   ├── storage.js                    ← localStorage 自動セーブ＆復元
│   ├── characters.js                 ← キャラクター移動・A*追従・アニメーション
│   ├── map.js                        ← タイルマップ・街発展レイヤー・農地描画
│   ├── chat.js                       ← チャット履歴・メンション・XSS対策
│   ├── ai-brain.js                   ← AI自律行動・常時HF再接続・オフライン応答
│   └── game.js                       ← メインループ・HUD・UI制御
├── characters/                       ← キャラクター＆動物アバタースプライト
├── map-assets/                       ← タイルマップ・建物・作物・街発展アセット
├── server.py                         ← ローカル高音質サーバー（任意）
├── 起動.bat                           ← Windows ローカルサーバー起動スクリプト（任意）
└── tests/
    ├── test_server.py                ← サーバー＆セキュリティ単体テスト（unittest）
    └── game_logic.test.mjs           ← ゲームロジック＆サーバーレス動作テスト（node:test）
```

---

## テストの実行

```bash
# Python サーバー＆セキュリティテスト
python -m unittest discover -s tests -v

# Node.js ゲームロジック＆サーバーレス動作テスト（Node 20+）
node --test tests/game_logic.test.mjs
```
