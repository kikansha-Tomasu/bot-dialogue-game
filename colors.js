// ============================================================
// colors.js — 色の一元管理ファイル（田舎風テーマ）
// ============================================================

const PALETTE = [
  "#5A8A44", // 0  中草緑（ベース）
  "#4A7A38", // 1  濃草緑
  "#7AB85A", // 2  薄草緑
  "#B8A070", // 3  砂利道メイン
  "#7A5C38", // 4  土道エッジ（暗め）
  "#D4C4A0", // 5  土道ハイライト（明るい中央）
  "#6D4C1F", // 6  木の幹
  "#FDF8F0", // 7  温かみクリーム（パネル背景・吹き出し）
  "#2C1810", // 8  最暗茶（テキスト）
  "#4A5C2E", // 9  ダークオリーブ（ヘッダー）
  "#3D7A24", // 10 木の葉（中）
  "#8338EC", // 11 バイオレット（Alice）
  "#B84700", // 12 温かみオレンジ（Bob・WCAG AA コントラスト確保）
  "#D4187A", // 13 深マゼンタ（Carol）
  "#FFD700", // 14 ブライトゴールド（Player）
  "#F5CB00", // 15 やや暗いゴールド（UIアクセント）
  "#2D5C1A", // 16 暗森緑（葉の影・茂み）
  "#90C060", // 17 明るい葉
  "#D8C8A8", // 18 温かみタン（入力エリア）
  "#909090", // 19 石グレー
  "#6D4C3D", // 20 中茶（UI補助・コントラスト強化）
  "#B71C1C", // 21 深赤（エラー）
  "#EEE8DA", // 22 温かみベージュ
  "#F5D5A0", // 23 薄ピーチ（プレイヤーメッセージ）
  "#4CAF50", // 24 茎緑
  "#BA68C8", // 25 ラベンダー（花）
  "#F48FB1", // 26 ピンク（花）
  "#FFEB3B", // 27 ブライトイエロー（花）
  "#FFFDE7", // 28 クリーム白（花）
  "#3B7DC2", // 29 池の水色
];

// ────────────────────────────────────────────
// セマンティックカラー定義
// ────────────────────────────────────────────
const C = {
  // キャラクター（草緑背景に映える補色系）
  alice:  PALETTE[11], // #8338EC バイオレット
  bob:    PALETTE[12], // #B84700 温かみオレンジ（WCAG AA）
  carol:  PALETTE[13], // #D4187A 深マゼンタ
  player: PALETTE[14], // #FFD700 ブライトゴールド

  // マップ ─ 草地
  grassBase:  PALETTE[0],
  grassDark:  PALETTE[1],
  grassLight: PALETTE[2],

  // マップ ─ 土道
  pathMain:  PALETTE[3],
  pathEdge:  PALETTE[4],
  pathLight: PALETTE[5],

  // マップ ─ 木
  treeTrunk:       PALETTE[6],
  treeCanopyDark:  PALETTE[16],
  treeCanopy:      PALETTE[10],
  treeCanopyLight: PALETTE[17],

  // マップ ─ 茂み
  bushDark: PALETTE[16],
  bushMain: PALETTE[10],

  // マップ ─ 石・井戸
  stoneColor: PALETTE[19],
  stoneLight: PALETTE[22],

  // マップ ─ 池
  pondWater: PALETTE[29],
  pondDeep:  "#1A4E8C",

  // マップ ─ 花
  stemGreen:    PALETTE[24],
  flowerYellow: PALETTE[27],
  flowerWhite:  PALETTE[28],
  flowerPink:   PALETTE[26],
  flowerPurple: PALETTE[25],
  flowerRed:    "#FF5252",

  // チャットパネル
  panelBg:     PALETTE[7],
  headerBg:    PALETTE[9],
  headerText:  PALETTE[14],
  headerHint:  "#D7E8B5",
  scrollThumb: PALETTE[20],

  // メッセージ
  msgBorder:     PALETTE[22],
  msgHover:      "#EDE5D0",
  msgText:       PALETTE[8],
  senderArrow:   PALETTE[4],
  recipientName: PALETTE[9],
  timeText:      PALETTE[20],

  // プレイヤーメッセージ
  playerMsgBg:    PALETTE[23],
  playerMsgHover: "#F0C888",
  playerMsgText:  PALETTE[8],

  // タイピングインジケータ
  typingText: PALETTE[9],
  typingDot:  PALETTE[10],

  // 入力エリア
  inputAreaBg:  PALETTE[18],
  hintText:     PALETTE[8],
  inputBg:      PALETTE[7],
  inputBorder:  PALETTE[4],
  inputText:    PALETTE[8],
  inputFocus:   "#C48A00",
  placeholder:  PALETTE[20],
  sendBtnBg:    PALETTE[9],
  sendBtnText:  PALETTE[14],
  sendBtnHover: PALETTE[1],

  // ステータス・評価色（WCAG AA コントラスト確保）
  successText:   "#245C1A",
  dangerText:    PALETTE[21],
  goldText:      "#7A5600",
  statusOnline:  "#2E7D32",
  statusOffline: "#9A5B00",

  // エラー
  errorBg:     PALETTE[21],
  errorText:   PALETTE[7],
  errorBorder: PALETTE[14],

  // キャンバス上のキャラクター描画
  charOutline:   PALETTE[8],
  playerRing:    PALETTE[14],
  nameBadgeText: PALETTE[7],
  bubbleBg:      PALETTE[7],
  bubbleText:    PALETTE[8],
  canvasHint:    PALETTE[14],
};

// ────────────────────────────────────────────
// CSS カスタムプロパティとして `:root` に適用
// ────────────────────────────────────────────
(function applyCSSVars() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const style = document.documentElement.style;
  Object.entries(C).forEach(([key, val]) => {
    if (typeof val === "string") {
      style.setProperty(`--c-${key}`, val);
    }
  });
  PALETTE.forEach((color, i) => {
    style.setProperty(`--p-${i}`, color);
  });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { PALETTE, C };
}
