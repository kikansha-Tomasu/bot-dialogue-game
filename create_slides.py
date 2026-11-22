"""Bot対話ゲーム 紹介スライド生成スクリプト（最新版）"""

import datetime
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches, Pt

# Color palette — bright intellectual theme
BG_DARK = RGBColor(0xF0, 0xF4, 0xFF)
BG_MID = RGBColor(0xDD, 0xE6, 0xF7)
ACCENT = RGBColor(0x1D, 0x4E, 0xD8)
ACCENT_BLUE = RGBColor(0x37, 0x30, 0xA3)
WHITE = RGBColor(0x0F, 0x17, 0x2A)
LIGHT_GRAY = RGBColor(0x47, 0x55, 0x69)
ALICE_COLOR = RGBColor(0x7C, 0x3A, 0xED)
BOB_COLOR = RGBColor(0xC2, 0x41, 0x0C)
CAROL_COLOR = RGBColor(0xBE, 0x18, 0x5D)
YELLOW = RGBColor(0x03, 0x69, 0xA1)
GREEN = RGBColor(0x06, 0x6E, 0x2A)
GOLD = RGBColor(0x92, 0x5E, 0x00)
PURE_WHITE = RGBColor(0xFF, 0xFF, 0xFF)

W = Inches(13.33)
H = Inches(7.5)

prs = Presentation()
prs.slide_width = W
prs.slide_height = H
blank_layout = prs.slide_layouts[6]


def add_bg(slide, color=BG_DARK):
    shape = slide.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape


def add_rect(slide, x, y, w, h, color):
    shape = slide.shapes.add_shape(1, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    return shape


def add_text(
    slide, text, x, y, w, h, font_size=24, bold=False, color=WHITE,
    align=PP_ALIGN.LEFT, italic=False, wrap=True
):
    tx_box = slide.shapes.add_textbox(x, y, w, h)
    tf = tx_box.text_frame
    tf.word_wrap = wrap
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(font_size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.italic = italic
    return tx_box


def add_accent_bar(slide, y=Inches(0.12), color=ACCENT):
    add_rect(slide, 0, y, prs.slide_width, Inches(0.06), color)


# ── Slide 1: Title ──────────────────────────────────────────────────────────
s1 = prs.slides.add_slide(blank_layout)
add_bg(s1)
add_rect(s1, 0, Inches(2.8), prs.slide_width, Inches(2.3), BG_MID)
add_accent_bar(s1, Inches(2.75), ACCENT)
add_accent_bar(s1, Inches(5.05), ACCENT)

add_text(s1, "Bot 対話ゲーム", Inches(1), Inches(0.95), Inches(11.3), Inches(1.4),
         font_size=58, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
add_text(s1, "〜 AIキャラクターと共に街を育てる経済シミュレーション 〜",
         Inches(1), Inches(2.15), Inches(11.3), Inches(0.65),
         font_size=22, color=ALICE_COLOR, align=PP_ALIGN.CENTER, italic=True)
add_text(s1, "マルチエージェント対話 × 板取引市場 × 街発展プログレッション",
         Inches(0.8), Inches(3.1), Inches(11.7), Inches(0.8),
         font_size=26, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
add_text(s1, "Hugging Face AI（キャラ別LLM＋音声合成） ／ A*経路探索 ／ 4マップ切替 ／ 農業＆料理クラフト",
         Inches(0.8), Inches(3.95), Inches(11.7), Inches(0.75),
         font_size=17, color=LIGHT_GRAY, align=PP_ALIGN.CENTER)
add_text(s1, datetime.date.today().strftime("%Y年%m月%d日"),
         Inches(9.5), Inches(6.8), Inches(3.2), Inches(0.5),
         font_size=14, color=LIGHT_GRAY, align=PP_ALIGN.RIGHT)

# ── Slide 2: ゲーム概要 ──────────────────────────────────────────────────────
s2 = prs.slides.add_slide(blank_layout)
add_bg(s2)
add_accent_bar(s2)

add_text(s2, "ゲーム概要", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=36, bold=True, color=WHITE)
add_rect(s2, Inches(0.5), Inches(1.25), Inches(12.3), Inches(0.04), ACCENT)
add_text(
    s2,
    "Bot対話ゲームは、3体のAIが自律的に歩き・会話・取引する2Dブラウザゲームです。\n"
    "プレイヤーは資源を集めて市場で売買し、納品依頼や取引でコインを増やして\n"
    "街の発展（Lv.1〜5）・能力強化・限定アバター解放を目指します。",
    Inches(0.5), Inches(1.45), Inches(12.3), Inches(1.4), font_size=20, color=LIGHT_GRAY
)

concepts = [
    ("🤖", "AI自律行動", "LLMが採集・取引・建築・\n交渉を戦略判断。\n未接続時もオフライン動作"),
    ("🗺️", "4マップ & A*探索", "建物・森・池の当たり判定と\nA*経路探索で自然に歩行。\n4マップを即座に切替"),
    ("📈", "本格取引板市場", "残高予約・板寄せ成行・\n自動マッチング・テクニカル指標\nと総資産ランキング"),
    ("🏙️", "街発展 & 農業競争", "全キャラが総資産1位を競うライバル！\n8種作物の4段階農業＆街Lv.5進化\n能力強化＆動物アバター解放"),
]
for i, (emoji, title, body) in enumerate(concepts):
    x = Inches(0.4 + i * 3.15)
    add_rect(s2, x, Inches(3.05), Inches(2.95), Inches(3.85), BG_MID)
    add_rect(s2, x, Inches(3.05), Inches(2.95), Inches(0.06), ACCENT)
    add_text(s2, emoji, x, Inches(3.2), Inches(2.95), Inches(0.75), font_size=32, align=PP_ALIGN.CENTER)
    add_text(s2, title, x, Inches(4.0), Inches(2.95), Inches(0.6), font_size=18, bold=True, color=WHITE, align=PP_ALIGN.CENTER)
    add_text(s2, body, x + Inches(0.1), Inches(4.7), Inches(2.75), Inches(1.9), font_size=14, color=LIGHT_GRAY, align=PP_ALIGN.CENTER)

# ── Slide 3: お金と資源を増やすモチベーション設計（新機能）──────────────────────
s3 = prs.slides.add_slide(blank_layout)
add_bg(s3)
add_accent_bar(s3)

add_text(s3, "お金と資源を増やす好循環ループ", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=34, bold=True, color=WHITE)
add_text(s3, "「集める・稼ぐ」ほど街が美しく進化し、操作感・収益力・見た目が変わる！",
         Inches(0.5), Inches(1.1), Inches(12.2), Inches(0.55), font_size=18, bold=True, color=ACCENT)

pillars = [
    (ALICE_COLOR, "🌾 農業プログレッション & ライバル陣取り（8種作物×4段階）",
     "• 全キャラがライバル！8区画の農地を巡ってニンジン〜イチゴまで8種作物を栽培\n"
     "• 種まき(Stage 0)→発芽(1)→成長(2)→実り(3)へ畑スプライトが進化し収穫で高収益！\n"
     "• 街の納品依頼（資源→🪙コイン）と合わせて経済が大きく循環"),
    (BOB_COLOR, "🏙️ 街の発展 Lv.1 → Lv.5（マップが実進化！）",
     "• Lv.1〜5で道路が砂利→石畳→舗装→光センサー→未来道路に進化\n"
     "• 道標・花壇・ベンチ・街灯・市場屋台・噴水・ソーラー屋根・時計台が出現\n"
     "• 60秒ごとの街配当（最大+10🪙）・資源再生速度＆生産速度UP・AI祝福演出"),
    (GREEN, "⚡ プレイヤー能力強化（4種×2段階）",
     "• 👟俊足ブーツ（移動速度+50%）／ ⛏️熟練つるはし（採集量+2・範囲拡大）\n"
     "• 🏗️建築マスター（自建物生産2倍）／ 💰商人の才覚（約定毎+2🪙ボーナス）"),
    (CAROL_COLOR, "🐾 動物アバター解放＆称号",
     "• コインでワンコ・ネコ・ウサギ・ペンギン衣装を解放＆いつでも着替え\n"
     "• 街Lv.5達成で称号「🏆 街の開拓王」獲得、自動セーブで継続プレイ対応"),
]
for i, (color, title, body) in enumerate(pillars):
    y = Inches(1.75 + i * 1.35)
    add_rect(s3, Inches(0.45), y, Inches(12.4), Inches(1.22), BG_MID)
    add_rect(s3, Inches(0.45), y, Inches(0.08), Inches(1.22), color)
    add_text(s3, title, Inches(0.7), y + Inches(0.05), Inches(11.9), Inches(0.42),
             font_size=17, bold=True, color=color)
    add_text(s3, body, Inches(0.7), y + Inches(0.45), Inches(11.9), Inches(0.75),
             font_size=13.5, color=LIGHT_GRAY)

# ── Slide 4: デモのポイント（展示会向け）────────────────────────────────────────
s4 = prs.slides.add_slide(blank_layout)
add_bg(s4)
add_accent_bar(s4)

add_text(s4, "デモの見どころ", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=36, bold=True, color=WHITE)
add_text(s4, "ここを体験してください！", Inches(0.5), Inches(1.1), Inches(12), Inches(0.55),
         font_size=20, bold=True, color=ACCENT)

demo_points = [
    ("🏙️", "街レベルアップで風景が変わる瞬間",
     "Uキーで街を発展させると、マップ上の道路タイルと広場の装飾が\n"
     "リアルタイムに進化！AIキャラクターたちもお祝いコメントをくれます。"),
    ("🤖", "建物や池を避けて歩くA*自律AI",
     "18〜45秒ごとにAIが採集・取引・建築・交渉を自律判断。\n"
     "障害物を避けて目的地へ向かい、チャットで自然に掛け合います。"),
    ("📈", "板寄せ成行＆テクニカル指標つきの取引板",
     "指値・板寄せ成行・自動マッチング・MA5/MA10/BB/RSIを実装。\n"
     "チャット欄を隠さないレイアウトで交渉しながら注文できます。"),
    ("🔊", "Hugging Face 音声AI & 直感UI",
     "Hugging Face (litagin/style_bert_vits2_jvnv) によるキャラ別日本語音声合成。\n"
     "@Alice/@Bob/@Carolチップや自動セーブで誰でもすぐ遊べます。"),
]
for i, (emoji, title, body) in enumerate(demo_points):
    row, col = divmod(i, 2)
    x = Inches(0.4 + col * 6.4)
    y = Inches(1.85 + row * 2.55)
    add_rect(s4, x, y, Inches(6.1), Inches(2.25), BG_MID)
    add_rect(s4, x, y, Inches(0.07), Inches(2.25), [ALICE_COLOR, BOB_COLOR, CAROL_COLOR, YELLOW][i])
    add_text(s4, f"{emoji} {title}", Inches(0.6 + col * 6.4), y + Inches(0.12),
             Inches(5.8), Inches(0.65), font_size=18, bold=True, color=WHITE)
    add_text(s4, body, Inches(0.6 + col * 6.4), y + Inches(0.82),
             Inches(5.8), Inches(1.3), font_size=14, color=LIGHT_GRAY)

# ── Slide 5: AIキャラクター紹介 ──────────────────────────────────────────────
s5 = prs.slides.add_slide(blank_layout)
add_bg(s5)
add_accent_bar(s5)

add_text(s5, "AIキャラクター紹介", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=36, bold=True, color=WHITE)

chars = [
    (ALICE_COLOR, "🎩 Alice", "明るい探偵",
     "好奇心旺盛で謎解きが大好き。\n鋭い観察眼で相場や街の変化に\nすぐ気づく活発な探偵。\n\n🤗 LLM: Gemma-3-4B (HF GGUF)\n🔊 声: あみたろ (HF 2.5 JP-Extra)"),
    (BOB_COLOR,   "🎭 Bob",   "哲学的詩人",
     "内省的で物事の深い意味を考える。\n詩的な言葉で語り、市場や街の\n移ろいを詠む静かな詩人。\n\n🤗 LLM: Gemma-3-4B (HF GGUF)\n🔊 声: jvnv-M1-jp (HF JP-Extra)"),
    (CAROL_COLOR, "🌸 Carol", "陽気な料理人",
     "いつも笑顔で周りを元気にする。\n食べ物や料理に例えた楽しい交渉が\nトレードマークの親切な料理人。\n\n🤗 LLM: Gemma-3-4B (HF GGUF)\n🔊 声: jvnv-F2-jp (HF JP-Extra)"),
]
for i, (color, name, role, desc) in enumerate(chars):
    x = Inches(0.5 + i * 4.3)
    add_rect(s5, x, Inches(1.3), Inches(4.0), Inches(5.5), BG_MID)
    add_rect(s5, x, Inches(1.3), Inches(4.0), Inches(0.08), color)
    add_text(s5, name, x, Inches(1.5), Inches(4.0), Inches(0.85),
             font_size=28, bold=True, color=color, align=PP_ALIGN.CENTER)
    add_rect(s5, Inches(1.5 + i * 4.3), Inches(2.45), Inches(1.0), Inches(0.04), color)
    add_text(s5, role, x, Inches(2.58), Inches(4.0), Inches(0.55),
             font_size=18, color=WHITE, align=PP_ALIGN.CENTER, italic=True)
    add_text(s5, desc, Inches(0.65 + i * 4.3), Inches(3.25), Inches(3.7), Inches(3.3),
             font_size=15, color=LIGHT_GRAY)

add_text(s5, "クイックメンションチップをクリックするだけで話しかけ可能 ／ 思考中の発言もキューで確実に返答",
         Inches(0.5), Inches(6.95), Inches(12.3), Inches(0.45),
         font_size=14, color=ACCENT, align=PP_ALIGN.CENTER, italic=True)

# ── Slide 6: AI行動 & A*ナビゲーション ──────────────────────────────────────
s6 = prs.slides.add_slide(blank_layout)
add_bg(s6)
add_accent_bar(s6)

add_text(s6, "AI行動 & A*経路探索の仕組み", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=34, bold=True, color=WHITE)

add_rect(s6, Inches(0.4), Inches(1.2), Inches(5.9), Inches(2.7), BG_MID)
add_rect(s6, Inches(0.4), Inches(1.2), Inches(5.9), Inches(0.07), ALICE_COLOR)
add_text(s6, "ε-greedy 戦略判断 ＋ オフライン耐性", Inches(0.55), Inches(1.3), Inches(5.6), Inches(0.55),
         font_size=17, bold=True, color=ALICE_COLOR)
add_text(
    s6,
    "• 75%: Hugging Face LLMが在庫・相場・街Lvを分析し最適行動\n"
    "• 25%: 探索的ランダム行動（膠着防止）\n"
    "• オフライン時もルールベース応答＋相場連動売買で継続動作\n"
    "• プレイヤー発言は専用キューで取りこぼしゼロ",
    Inches(0.55), Inches(1.92), Inches(5.6), Inches(1.85), font_size=14, color=LIGHT_GRAY
)

add_rect(s6, Inches(6.6), Inches(1.2), Inches(6.3), Inches(2.7), BG_MID)
add_rect(s6, Inches(6.6), Inches(1.2), Inches(6.3), Inches(0.07), BOB_COLOR)
add_text(s6, "A*経路探索 & 地形コリジョン", Inches(6.75), Inches(1.3), Inches(6.0), Inches(0.55),
         font_size=17, bold=True, color=BOB_COLOR)
add_text(
    s6,
    "• atlas.json の建物・森・池コリジョンからグリッド構築\n"
    "• 8方向A*（角抜け防止・直線間引き）で障害物を回避\n"
    "• プレイヤー移動も軸分離スライドで壁沿いに滑らか歩行\n"
    "• ウィンドウリサイズ・マップ切替時に自動再構築",
    Inches(6.75), Inches(1.92), Inches(6.0), Inches(1.85), font_size=14, color=LIGHT_GRAY
)

add_rect(s6, Inches(0.4), Inches(4.15), Inches(12.5), Inches(2.85), BG_MID)
add_rect(s6, Inches(0.4), Inches(4.15), Inches(12.5), Inches(0.07), CAROL_COLOR)
add_text(s6, "LLMコンテキスト＆堅牢な応答整形", Inches(0.55), Inches(4.25), Inches(12.1), Inches(0.55),
         font_size=17, bold=True, color=CAROL_COLOR)
context_items = [
    "自分・他キャラのインベントリと推定総資産",
    "街の発展レベル（Lv.0〜5）と稼働中建物",
    "資源ノードの残量・距離・注文板内容",
    "テクニカル指標（MA5/MA10/BB/RSI）",
    "<think>タグ・余計なPLAN行の自動除去（2文保持）",
    "モデル自動検出（/health）＆タイムアウト制御",
]
for i, item in enumerate(context_items):
    col = i % 2
    row = i // 2
    add_text(s6, f"• {item}", Inches(0.65 + col * 6.2), Inches(4.9 + row * 0.65),
             Inches(5.9), Inches(0.55), font_size=14, color=LIGHT_GRAY)

# ── Slide 7: 経済システム & 取引板 ───────────────────────────────────────────
s7 = prs.slides.add_slide(blank_layout)
add_bg(s7)
add_accent_bar(s7)

add_text(s7, "経済システム & 取引板", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=36, bold=True, color=WHITE)

add_text(s7, "4種の資源と生産建物", Inches(0.5), Inches(1.2), Inches(5.8), Inches(0.55),
         font_size=21, bold=True, color=ACCENT)
resources = [
    ("🪵 木材", "木の柵(80s)で生産"), ("🪨 石", "焚き火(60s)で生産"),
    ("🌿 薬草", "花壇(50s)で生産"), ("🐟 魚", "釣り場(70s)で生産"),
]
for i, (res, src) in enumerate(resources):
    row, col = divmod(i, 2)
    x = Inches(0.5 + col * 3.05)
    y = Inches(1.85 + row * 0.8)
    add_rect(s7, x, y, Inches(2.9), Inches(0.65), BG_MID)
    add_text(s7, f"{res}  {src}", x + Inches(0.1), y + Inches(0.12), Inches(2.7), Inches(0.45),
             font_size=13.5, bold=True, color=WHITE)

add_text(s7, "総資産ランキング & 継続セーブ", Inches(0.5), Inches(3.65), Inches(6.0), Inches(0.55),
         font_size=20, bold=True, color=ACCENT)
add_text(
    s7,
    "• 🥇🥈🥉 全キャラの総資産（🪙＋保有資源評価額）を\n"
    "  リアルタイム順位表示（I キー）\n"
    "• 建築時はゴーストプレビュー＆生産進捗バー表示\n"
    "• 取引履歴・価格チャート・街Lv・建物を localStorage に\n"
    "  自動保存（いつでもリセット可能）",
    Inches(0.55), Inches(4.25), Inches(5.9), Inches(2.7), font_size=14.5, color=LIGHT_GRAY
)

add_rect(s7, Inches(6.7), Inches(1.2), Inches(6.2), Inches(5.8), BG_MID)
add_rect(s7, Inches(6.7), Inches(1.2), Inches(6.2), Inches(0.06), ACCENT)
add_text(s7, "取引板エンジン（T キーで開く）", Inches(6.9), Inches(1.32), Inches(5.8), Inches(0.6),
         font_size=20, bold=True, color=WHITE)
trade_info = [
    "📌 指値注文 — 残高予約で二重発注を防止、単価プレビュー付",
    "⚡ 板寄せ成行 — 複数注文を最良気配から自動で横断約定",
    "🔄 自動マッチング — 価格・時間優先、部分約定も単価維持",
    "🛡️ 在庫整合性 — 約定前検証＆履行不能注文の自動整理",
    "📊 チャート＆指標 — MA5 / MA10 / BB / RSI + 直近約定履歴",
    "💰 商人ボーナス — 能力強化で約定ごとに追加コイン獲得",
]
for i, line in enumerate(trade_info):
    add_text(s7, line, Inches(6.9), Inches(2.05 + i * 0.78), Inches(5.8), Inches(0.7),
             font_size=14.5, color=LIGHT_GRAY)

# ── Slide 8: 技術スタック & 品質・セキュリティ ─────────────────────────────────
s8 = prs.slides.add_slide(blank_layout)
add_bg(s8)
add_accent_bar(s8)

add_text(s8, "技術スタック & 品質・セキュリティ", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=34, bold=True, color=WHITE)

stacks = [
    (ALICE_COLOR, "フロントエンド", [
        "Vanilla JS（ビルド不要のモジュール設計）",
        "HTML5 Canvas（4マップ・街Lv進化・Yソート）",
        "8方向 A* 経路探索＆壁沿いスライド移動",
        "localStorage 自動セーブ＆復元",
        "WCAG AA 配慮・IME安全入力・レスポンシブ",
    ]),
    (BOB_COLOR, "バックエンド & セキュリティ", [
        "Python + Flask（許可リスト静的配信）",
        "localhost 限定 CORS & .env 環境変数対応",
        "/health 疎通・モデル自動検出エンドポイント",
        "Style-Bert-VITS2 スレッド安全ロード＆速度制限",
        "未導入時は Web Speech API へ自動フォールバック",
    ]),
    (CAROL_COLOR, "Hugging Face AI & 品質保証", [
        "キャラ別 Hugging Face LLM (Qwen/Llama/Gemma)",
        "Hugging Face 音声合成 (Style-Bert-VITS2 JVNV)",
        "モデル自動フォールバック＆オフライン応答エンジン",
        "Python unittest（サーバー・セキュリティ検証）",
        "Node.js node:test（取引・A*・農業・料理検証）",
    ]),
]
for i, (color, title, items) in enumerate(stacks):
    x = Inches(0.4 + i * 4.3)
    add_rect(s8, x, Inches(1.3), Inches(4.1), Inches(5.7), BG_MID)
    add_rect(s8, x, Inches(1.3), Inches(4.1), Inches(0.08), color)
    add_text(s8, title, x, Inches(1.42), Inches(4.1), Inches(0.7),
             font_size=20, bold=True, color=color, align=PP_ALIGN.CENTER)
    for j, item in enumerate(items):
        add_text(s8, f"• {item}", Inches(0.55 + i * 4.3), Inches(2.2 + j * 0.92),
                 Inches(3.85), Inches(0.85), font_size=14, color=LIGHT_GRAY)

# ── Slide 9: 操作方法 & まとめ ────────────────────────────────────────────────
s9 = prs.slides.add_slide(blank_layout)
add_bg(s9)
add_accent_bar(s9)

add_text(s9, "操作方法 & まとめ", Inches(0.5), Inches(0.3), Inches(12), Inches(0.8),
         font_size=36, bold=True, color=WHITE)

add_rect(s9, Inches(0.4), Inches(1.2), Inches(5.9), Inches(5.3), BG_MID)
add_text(s9, "操作キー（チャット入力中は自動抑止）", Inches(0.55), Inches(1.3), Inches(5.6), Inches(0.55),
         font_size=19, bold=True, color=ACCENT)
controls = [
    ("WASD / 矢印", "プレイヤー移動（障害物スライド）"),
    ("E",           "近くの資源を採集"),
    ("B",           "建築メニュー（プレビュー設置）"),
    ("U",           "街の発展・依頼・強化・アバター"),
    ("T",           "取引板を開く"),
    ("I",           "インベントリ・総資産ランキング"),
    ("Esc",         "開いているパネルを閉じる"),
]
for i, (key, action) in enumerate(controls):
    y = Inches(1.95 + i * 0.62)
    add_rect(s9, Inches(0.55), y, Inches(1.75), Inches(0.48), ACCENT_BLUE)
    add_text(s9, key, Inches(0.55), y + Inches(0.04), Inches(1.75), Inches(0.42),
             font_size=13, bold=True, color=PURE_WHITE, align=PP_ALIGN.CENTER)
    add_text(s9, action, Inches(2.45), y + Inches(0.04), Inches(3.75), Inches(0.44),
             font_size=14, color=LIGHT_GRAY)

add_rect(s9, Inches(6.55), Inches(1.2), Inches(6.35), Inches(5.3), BG_MID)
add_text(s9, "まとめ", Inches(6.7), Inches(1.3), Inches(6.0), Inches(0.55),
         font_size=21, bold=True, color=ACCENT)
summary_items = [
    "✅ キャラ別 Hugging Face AI (LLM) & 音声AI (Style-Bert-VITS2) 搭載",
    "✅ お金＆資源で街が Lv.1→5 へ進化・8種農業・6種料理クラフト",
    "✅ 3体のAIが A* で街を歩き、会話・採集・農業・取引を自律実行",
    "✅ 板寄せ成行・自動マッチング・テクニカル指標の本格市場",
    "✅ 自動セーブ＆4マップ切替＆音声ミュートで快適プレイ",
    "✅ 自動テスト＆セキュリティ対策を備えた堅牢な構成",
]
for i, item in enumerate(summary_items):
    add_text(s9, item, Inches(6.75), Inches(2.0 + i * 0.72), Inches(6.0), Inches(0.65),
             font_size=15, color=LIGHT_GRAY)

add_text(s9, "起動方法：起動.bat をダブルクリック（必要に応じて .env に設定を記載）",
         Inches(0.4), Inches(6.72), Inches(12.5), Inches(0.5),
         font_size=14, color=YELLOW, align=PP_ALIGN.CENTER, bold=True)

out_path = "Bot対話ゲーム_紹介スライド.pptx"
try:
    prs.save(out_path)
    print(f"Saved: {out_path}")
except PermissionError:
    print(f"Skipped saving {out_path} (file is currently open in PowerPoint)")
