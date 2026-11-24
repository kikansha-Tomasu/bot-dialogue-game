import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ブラウザと同じ読み込み順でグローバルを準備
const { C } = require(path.join(rootDir, "colors.js"));
globalThis.C = C;

const { GAME_CONFIG, AI_CHARACTERS_CONFIG } = require(path.join(rootDir, "js/config.js"));
globalThis.GAME_CONFIG = GAME_CONFIG;
globalThis.AI_CHARACTERS_CONFIG = AI_CHARACTERS_CONFIG;

const {
  BASE_RESOURCE_TYPES,
  CROP_ITEM_TYPES,
  DISH_ITEM_TYPES,
  TRADABLE_ITEM_TYPES,
  ITEM_CATEGORY_DEFS,
  RESOURCE_EMOJI,
  RESOURCE_LABEL,
  RESOURCE_SHORT_LABEL,
  ITEM_CHART_COLOR,
  MAP_RESOURCE_LAYOUTS,
  WorldResource,
  ResourceManager,
} = require(path.join(rootDir, "js/resources.js"));
globalThis.BASE_RESOURCE_TYPES = BASE_RESOURCE_TYPES;
globalThis.CROP_ITEM_TYPES = CROP_ITEM_TYPES;
globalThis.DISH_ITEM_TYPES = DISH_ITEM_TYPES;
globalThis.TRADABLE_ITEM_TYPES = TRADABLE_ITEM_TYPES;
globalThis.ITEM_CATEGORY_DEFS = ITEM_CATEGORY_DEFS;
globalThis.RESOURCE_EMOJI = RESOURCE_EMOJI;
globalThis.RESOURCE_LABEL = RESOURCE_LABEL;
globalThis.RESOURCE_SHORT_LABEL = RESOURCE_SHORT_LABEL;
globalThis.ITEM_CHART_COLOR = ITEM_CHART_COLOR;

const {
  INITIAL_COINS,
  makeInventory,
  inventoryAdd,
  inventoryCanAfford,
  inventoryDeduct,
  getInventorySummary,
  computeAssetValue,
} = require(path.join(rootDir, "js/inventory.js"));
globalThis.INITIAL_COINS = INITIAL_COINS;
globalThis.makeInventory = makeInventory;
globalThis.inventoryAdd = inventoryAdd;
globalThis.inventoryCanAfford = inventoryCanAfford;
globalThis.inventoryDeduct = inventoryDeduct;
globalThis.getInventorySummary = getInventorySummary;
globalThis.computeAssetValue = computeAssetValue;

const {
  BUILDING_RECIPES,
  BUILDING_BENEFITS,
  BuildingManager,
} = require(path.join(rootDir, "js/buildings.js"));
globalThis.BUILDING_RECIPES = BUILDING_RECIPES;
globalThis.BUILDING_BENEFITS = BUILDING_BENEFITS;

const { OrderBook } = require(path.join(rootDir, "js/trade.js"));
const { NavGrid } = require(path.join(rootDir, "js/pathfinding.js"));
const {
  CROP_CATALOG,
  COOKING_RECIPES,
  MAP_FARM_PLOTS,
  MAX_PLOTS_PER_CHAR,
  FarmManager,
} = require(path.join(rootDir, "js/farming.js"));
globalThis.CROP_CATALOG = CROP_CATALOG;
globalThis.COOKING_RECIPES = COOKING_RECIPES;
globalThis.MAP_FARM_PLOTS = MAP_FARM_PLOTS;
globalThis.MAX_PLOTS_PER_CHAR = MAX_PLOTS_PER_CHAR;
const {
  TOWN_LEVELS,
  PLAYER_UPGRADES,
  AVATAR_CATALOG,
  VICTORY_TARGET_ASSETS,
  ProgressionManager,
} = require(path.join(rootDir, "js/progression.js"));
globalThis.TOWN_LEVELS = TOWN_LEVELS;
globalThis.PLAYER_UPGRADES = PLAYER_UPGRADES;
globalThis.AVATAR_CATALOG = AVATAR_CATALOG;
globalThis.VICTORY_TARGET_ASSETS = VICTORY_TARGET_ASSETS;
const { SaveManager } = require(path.join(rootDir, "js/storage.js"));
const { buildCharacters } = require(path.join(rootDir, "js/characters.js"));
const { ChatManager } = require(path.join(rootDir, "js/chat.js"));
const { HuggingFaceClient, LMStudioClient } = require(path.join(rootDir, "js/api.js"));
globalThis.HuggingFaceClient = HuggingFaceClient;
globalThis.LMStudioClient = LMStudioClient;
const { AIBrain } = require(path.join(rootDir, "js/ai-brain.js"));

function makeChar(id, name, invOverrides = {}) {
  return {
    id,
    name,
    color: "#8338EC",
    emoji: "🎩",
    isPlayer: id === "player",
    x: 100,
    y: 100,
    inventory: { ...makeInventory(), ...invOverrides },
    conversationHistory: [],
    setSpeechBubble() {},
  };
}

// ── Inventory テスト ────────────────────────────────────────
test("Inventory: deduct prevents negative values and computeAssetValue sums market value across resources, crops, and dishes", () => {
  const inv = makeInventory();
  assert.equal(inv.coin, INITIAL_COINS);
  assert.equal(inventoryAdd(inv, "wood", 3), true);
  assert.equal(inventoryAdd(inv, "wood", -2), false);
  assert.equal(inv.wood, 3);

  assert.equal(inventoryDeduct(inv, { wood: 5 }), false);
  assert.equal(inv.wood, 3); // 差し引かれていないこと

  assert.equal(inventoryDeduct(inv, { wood: 2 }), true);
  assert.equal(inv.wood, 1);

  // 作物・料理も取引履歴がある場合のみ市場価格で評価され、未約定品は0評価（固定価格なし）
  inventoryAdd(inv, "carrot", 2);
  inventoryAdd(inv, "carrot_salad", 1);
  const val = computeAssetValue(inv, {
    wood: [1.5, 2.5],
    stone: [],
    herb: [],
    fish: [],
    carrot: [4],
    carrot_salad: [],
  });
  assert.equal(val.coins, INITIAL_COINS);
  assert.equal(val.resourceValue, 2.5 + 2 * 4);
  assert.equal(val.total, INITIAL_COINS + 10.5);
});

// ── ResourceManager テスト ──────────────────────────────────
test("ResourceManager: layouts for all 4 maps, sorted getNearby, respawn, and resize scaling", () => {
  const rm = new ResourceManager();
  for (const mapId of ["central_plaza", "shopping_street", "forest_hamlet", "farm_riverside"]) {
    assert.ok(MAP_RESOURCE_LAYOUTS[mapId].length > 0);
    rm.init(800, 600, mapId);
    assert.equal(rm.nodes.length, MAP_RESOURCE_LAYOUTS[mapId].length);
  }

  rm.nodes = [
    new WorldResource("far", "wood", 150, 100, 1),
    new WorldResource("near", "stone", 110, 100, 1),
  ];
  const nearby = rm.getNearby(100, 100, 75);
  assert.equal(nearby.length, 2);
  assert.equal(nearby[0].id, "near"); // 距離昇順

  assert.equal(nearby[0].gather(1), 1);
  assert.equal(nearby[0].isEmpty, true);
  nearby[0].update(nearby[0].RESPAWN_TIME + 1);
  assert.equal(nearby[0].isEmpty, false);

  rm.scalePositions(800, 600, 1600, 1200);
  assert.equal(rm.nodes[0].x, 300);
  assert.equal(rm.nodes[0].y, 200);
});

// ── BuildingManager テスト ──────────────────────────────────
test("BuildingManager: placement deducts cost, produces for builder, scales on resize", () => {
  const player = makeChar("player", "Player", { herb: 3 });
  const bm = new BuildingManager(player);

  bm.selectRecipe("flowerBed");
  assert.equal(bm.placeAt(200, 150), true);
  assert.equal(player.inventory.herb, 1);
  assert.equal(bm.placed.length, 1);

  const events = bm.update(BUILDING_BENEFITS.flowerBed.interval + 0.1, [player]);
  assert.equal(events.length, 1);
  assert.equal(events[0].recipient.id, "player");
  assert.equal(player.inventory.herb, 2);

  bm.scalePositions(800, 600, 400, 300);
  assert.equal(bm.placed[0].x, 100);
  assert.equal(bm.placed[0].y, 75);
});

// ── OrderBook テスト ────────────────────────────────────────
test("OrderBook: rejects non-coin pairs and double-reserved coin balance", () => {
  const ob = new OrderBook();
  const alice = makeChar("alice", "Alice", { wood: 3, coin: 10 });

  // 資源同士は不可
  assert.equal(ob.postOrder(alice, "wood", 1, "stone", 1), null);
  // 小数・0は不可
  assert.equal(ob.postOrder(alice, "wood", 0, "coin", 2), null);
  assert.equal(ob.postOrder(alice, "wood", 1.5, "coin", 2), null);

  // 10コイン中 6コインを予約
  const o1 = ob.postOrder(alice, "coin", 6, "wood", 2);
  assert.ok(o1);
  assert.equal(ob.getAvailableBalance(alice, "coin"), 4);

  // 残高4コインに対して6コインの別買い注文は拒否
  assert.equal(ob.postOrder(alice, "coin", 6, "stone", 2), null);
  // 4コインなら許可
  assert.ok(ob.postOrder(alice, "coin", 4, "stone", 2));
});

test("OrderBook: auto-matching preserves limit unitPrice on partial fill and passes accurate onExecute snapshot", () => {
  const ob = new OrderBook();
  const executedEvents = [];
  ob.onExecute = (snap, executor) => executedEvents.push({ snap, executor });

  const alice = makeChar("alice", "Alice", { coin: 10, wood: 0 });
  const bob = makeChar("bob", "Bob", { coin: 10, wood: 3 });

  // Bob: wood×1 を 1コインで売り（単価 1.0）
  ob.postOrder(bob, "wood", 1, "coin", 1);
  // Alice: wood×2 を 4コインで買い（指値単価 2.0）→ 1個が1コインで約定し、残り1個は2コインのまま残るべき
  const aliceOrder = ob.postOrder(alice, "coin", 4, "wood", 2);

  assert.equal(aliceOrder._matchedCount, 1);
  assert.equal(aliceOrder._wasFullyMatched, false);
  assert.equal(alice.inventory.wood, 1);
  assert.equal(alice.inventory.coin, 9);
  assert.equal(bob.inventory.wood, 2);
  assert.equal(bob.inventory.coin, 11);

  // onExecute スナップショットが ×0 ではなく実約定数であること
  assert.equal(executedEvents.length, 1);
  assert.equal(executedEvents[0].snap.sellAmount, 1);
  assert.equal(executedEvents[0].snap.buyAmount, 1);

  // 残り注文が単価2.0（wood×1 ⇔ coin×2）を維持していること（旧バグだと coin×3 に歪んでいた）
  assert.equal(ob.orders.length, 1);
  assert.equal(ob.orders[0].buyAmount, 1);
  assert.equal(ob.orders[0].sellAmount, 2);
});

test("OrderBook: incoming seller partial fill against high bid does not cancel remaining seller order", () => {
  const ob = new OrderBook();
  const alice = makeChar("alice", "Alice", { coin: 10, wood: 0 });
  const bob = makeChar("bob", "Bob", { coin: 10, wood: 3 });

  // Alice: wood×1 を 2コインで買い（単価 2.0）
  ob.postOrder(alice, "coin", 2, "wood", 1);
  // Bob: wood×2 を 2コインで売り（単価 1.0）→ 1個が2コインで約定し、残り1個が1コインで板に残るべき
  const bobOrder = ob.postOrder(bob, "wood", 2, "coin", 2);

  assert.equal(bobOrder._wasFullyMatched, false);
  assert.equal(alice.inventory.wood, 1);
  assert.equal(alice.inventory.coin, 8);
  assert.equal(bob.inventory.wood, 2);
  assert.equal(bob.inventory.coin, 12);

  assert.equal(ob.orders.length, 1);
  assert.equal(ob.orders[0].posterId, "bob");
  assert.equal(ob.orders[0].sellAmount, 1);
  assert.equal(ob.orders[0].buyAmount, 1);
});

test("OrderBook: market buy sweeps multiple orders and prevents negative poster inventory", () => {
  const ob = new OrderBook();
  const alice = makeChar("alice", "Alice", { wood: 1, coin: 10 });
  const bob = makeChar("bob", "Bob", { wood: 2, coin: 10 });
  const carol = makeChar("carol", "Carol", { wood: 2, coin: 10 });
  const player = makeChar("player", "Player", { wood: 0, coin: 20 });

  ob.postOrder(alice, "wood", 1, "coin", 2); // 単価 2.0
  ob.postOrder(bob, "wood", 2, "coin", 6);   // 単価 3.0
  ob.postOrder(carol, "wood", 2, "coin", 2); // 単価 1.0 だが後で在庫消費される

  // Carol が建築等で木材を使い切った場合、成行買いで在庫マイナスにせず無効注文を除去
  carol.inventory.wood = 0;

  const res = ob.executeMarketBuy(player, "wood", 2);
  assert.equal(res.ok, true);
  assert.equal(res.cost, 5); // Alice(2) + Bob(3) = 5
  assert.equal(res.fills.length, 2);
  assert.equal(player.inventory.wood, 2);
  assert.equal(player.inventory.coin, 15);
  assert.equal(alice.inventory.wood, 0);
  assert.equal(bob.inventory.wood, 1);
  assert.equal(carol.inventory.wood, 0); // マイナスになっていないこと
});

test("OrderBook: market sell sweeps multiple bids safely", () => {
  const ob = new OrderBook();
  const alice = makeChar("alice", "Alice", { coin: 5 });
  const bob = makeChar("bob", "Bob", { coin: 5 });
  const player = makeChar("player", "Player", { wood: 3, coin: 0 });

  ob.postOrder(alice, "coin", 3, "wood", 1); // 単価 3.0
  ob.postOrder(bob, "coin", 4, "wood", 2);   // 単価 2.0

  const res = ob.executeMarketSell(player, "wood", 2);
  assert.equal(res.ok, true);
  assert.equal(res.receiveAmount, 5); // Alice(3) + Bob(2)
  assert.equal(player.inventory.wood, 1);
  assert.equal(player.inventory.coin, 5);
  assert.equal(alice.inventory.coin, 2);
  assert.equal(bob.inventory.coin, 3);
});

test("OrderBook: tryAIExecute can execute both Player and other AI orders", () => {
  const ob = new OrderBook();
  const alice = makeChar("alice", "Alice", { wood: 2, coin: 10 });
  const bob = makeChar("bob", "Bob", { wood: 0, coin: 10 });

  ob.postOrder(alice, "wood", 1, "coin", 2);
  const executed = ob.tryAIExecute(bob);
  assert.ok(executed);
  assert.equal(executed.posterId, "alice");
  assert.equal(bob.inventory.wood, 1);
  assert.equal(alice.inventory.coin, 12);
});

test("OrderBook: technical indicators calculate SMA, Bollinger, and RSI edge cases", () => {
  const ob = new OrderBook();
  const flat = new Array(15).fill(2);
  assert.equal(ob._calcRSI(flat, 14), 50);

  const rising = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(ob._calcRSI(rising, 14), 100);
  const sma5 = ob._calcSMA(rising, 5);
  assert.equal(sma5[4], 3);
  const bb = ob._calcBollinger(rising, 20);
  assert.ok(bb.upper[19] > bb.middle[19] && bb.middle[19] > bb.lower[19]);
});

// ── ChatManager & API クライアント テスト ───────────────────
test("ChatManager: parses half/full-width mentions and escapes HTML/colors", () => {
  const cm = new ChatManager();
  assert.equal(cm.parseMention("@Alice こんにちは"), "Alice");
  assert.equal(cm.parseMention("＠Bob 元気？"), "Bob");
  assert.equal(cm._escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(cm._sanitizeColor("red; background:url(x)"), "#5C4033");
  assert.equal(cm._sanitizeColor("#8338EC"), "#8338EC");
});

test("LMStudioClient: strips <think>, preserves up to 2 sentences, sanitizes placeholders", () => {
  const cleaned = LMStudioClient.cleanDialogueResponse(
    "<think>内部推論テキスト</think>\nPLAN: chat\n@Player すごい発見だよ！木材を2コインで買わない？おまけの3文目は切るよ。",
    "Player"
  );
  assert.equal(cleaned, "@Player すごい発見だよ！木材を2コインで買わない？");

  const sanitized = LMStudioClient.sanitizeAnnounceMessage("@nearest_name 木材を集めたよ！", "Bob");
  assert.equal(sanitized, "@Bob 木材を集めたよ！");
});

// ── AIBrain テスト ──────────────────────────────────────────
test("AIBrain: parses trade decisions, queues player messages, and generates offline replies", async () => {
  const alice = makeChar("alice", "Alice", { wood: 2, coin: 10 });
  const player = makeChar("player", "Player", { coin: 10 });
  const cm = new ChatManager();
  const rm = new ResourceManager();
  rm.init(800, 600);
  const api = new LMStudioClient();
  const brain = new AIBrain([alice, player], cm, api, rm);
  brain.orderBook = new OrderBook();
  brain.llmAvailable = false;

  assert.deepEqual(
    brain._parseTradeDecision("PLAN: trade\nACTION: sell\nRESOURCE: wood\nAMOUNT: 2\nCOINS: 5"),
    { action: "sell", resource: "wood", amount: 2, coins: 5 }
  );
  assert.equal(brain._parseTradeDecision("ACTION: sell\nRESOURCE: wood\nAMOUNT: 999\nCOINS: 5"), null);

  // 処理中でもプレイヤー発言を捨てずにキューへ積むこと
  brain.isProcessing["alice"] = true;
  await brain.handlePlayerMessage("@Alice 取引しよう", alice, player);
  assert.equal(brain.pendingPlayerMessages["alice"].length, 1);

  const offline = brain._generateOfflineReply(alice, "Player", "木材を買いたい");
  assert.ok(offline.startsWith("@Player "));
});

// ── NavGrid（コリジョン & A* 経路探索）テスト ─────────────────
test("NavGrid: builds collision from map/atlas, slides along walls, and finds A* path around obstacle", () => {
  const nav = new NavGrid();
  const fakeMap = {
    width: 5,
    height: 5,
    terrain: [
      "GGGGG",
      "GGWGG",
      "GGWGG",
      "GGWGG",
      "GGGGG",
    ],
    legend: { G: "grass", W: "wall" },
    objects: [],
  };
  const fakeAtlas = [
    { id: "grass", collision: { type: "none", solid: false } },
    { id: "wall",  collision: { type: "rect", solid: true, x: 0, y: 0, w: 256, h: 256 } },
  ];
  nav.buildFromMap(fakeMap, fakeAtlas, 500, 500, 2);

  // 中央の壁 (250, 250) は通行不可
  assert.equal(nav.isPointBlocked(250, 250, 5), true);
  // 左側 (50, 250) から右側 (450, 250) へ壁を迂回する A* 経路が求まること
  const path = nav.findPath(50, 250, 450, 250);
  assert.ok(path.length >= 2);
  for (const pt of path) {
    assert.equal(nav.isPointBlocked(pt.x, pt.y, 2), false);
  }

  // 壁へ斜め移動したとき X は止まりつつ Y 方向へ滑らかにスライドすること
  const moved = nav.resolveMovement(190, 240, 25, 20, 8, 10, 0);
  assert.equal(moved.x, 190);
  assert.ok(moved.y > 240);
});

// ── ProgressionManager（街発展・強化・アバター・固定報酬廃止）テスト ──
test("ProgressionManager: no fixed quests/dividends/trade-bonuses, town upgrades Lv.0->5, upgrades & avatars persist", () => {
  const player = makeChar("player", "Player", { coin: 30, wood: 5, stone: 4, herb: 6, fish: 2 });
  const pm = new ProgressionManager(player);

  // 固定報酬の納品依頼が存在しないこと
  assert.equal("activeQuest" in pm, false);
  assert.equal(typeof pm.completeActiveQuest, "undefined");

  // 街 Lv.1 アップグレード（コスト: coin 10, wood 3, stone 2）
  const tRes = pm.upgradeTown();
  assert.equal(tRes.ok, true);
  assert.equal(pm.townLevel, 1);
  assert.equal(player.inventory.coin, 20);

  // 時間経過しても自動配当コインは一切増えないこと
  const div = pm.update(180);
  assert.equal(div, 0);
  assert.equal(player.inventory.coin, 20);

  // 俊足ブーツ強化（コスト: coin 4, herb 2）→ 移動速度 1.25倍
  const uRes = pm.buyUpgrade("boots");
  assert.equal(uRes.ok, true);
  assert.equal(pm.getPlayerSpeedMultiplier(), 1.25);

  // 豊作の知恵（旧merchant）強化しても約定時固定コインボーナスは0、農地速度と収穫数のみ伸びること
  const fRes = pm.buyUpgrade("merchant");
  assert.equal(fRes.ok, true);
  assert.equal(pm.getFarmHarvestBonus("player"), 1);
  assert.equal(pm.getFarmHarvestBonus("alice"), 0);
  const coinBeforeTradeCount = player.inventory.coin;
  assert.equal(pm.onPlayerTradeExecuted(), 0);
  assert.equal(player.inventory.coin, coinBeforeTradeCount);
  assert.equal(pm.totalTradesCompleted, 1);

  // アバター解放（コイン消費して解放＆切替）
  const aRes = pm.unlockOrEquipAvatar("animal_01");
  assert.equal(aRes.ok, true);
  assert.equal(aRes.newlyUnlocked, true);
  assert.equal(pm.activeAvatar, "animal_01");

  // 全コイン消費合計が世界総コイン供給量（4人×INITIAL_COINS）内に収まりデッドロックしないこと
  const townCoinSum = TOWN_LEVELS.reduce((s, t) => s + (t.cost.coin || 0), 0);
  const upgCoinSum = Object.values(PLAYER_UPGRADES)
    .flatMap(u => u.tiers)
    .reduce((s, t) => s + (t.cost.coin || 0), 0);
  const avatarCoinSum = AVATAR_CATALOG.reduce((s, a) => s + (a.costCoins || 0), 0);
  assert.ok(townCoinSum + upgCoinSum + avatarCoinSum < INITIAL_COINS * 4);

  // シリアライズ→デシリアライズが一致すること
  const snap = pm.serialize();
  const pm2 = new ProgressionManager(makeChar("player", "Player"));
  pm2.deserialize(snap);
  assert.equal(pm2.townLevel, 1);
  assert.equal(pm2.upgrades.boots, 1);
  assert.equal(pm2.upgrades.merchant, 1);
  assert.equal(pm2.activeAvatar, "animal_01");
  assert.equal(pm2.totalTradesCompleted, 1);
});

// ── SaveManager（セッション＆取引履歴保存）テスト ───────────
test("SaveManager: saves, loads, restores full game state including crops, dishes, and market prices", () => {
  const mem = new Map();
  const fakeStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v),
    removeItem: k => mem.delete(k),
  };
  const sm = new SaveManager(fakeStorage);

  const player = makeChar("player", "Player", { coin: 25, wood: 4, carrot: 2, carrot_salad: 1 });
  const alice = makeChar("alice", "Alice", { coin: 30, stone: 3 });
  const bm = new BuildingManager(player);
  player.inventory.herb = 2;
  bm.placeAtForChar(player, "flowerBed");

  const ob = new OrderBook();
  ob.postOrder(alice, "stone", 2, "coin", 4);
  ob.executeOrder(ob.orders[0].id, player);
  ob.postOrder(player, "carrot_salad", 1, "coin", 9);
  ob.executeOrder(ob.orders[0].id, alice);
  ob.postOrder(alice, "stone", 1, "coin", 3); // オープン注文を残す

  const pm = new ProgressionManager(player);
  pm.townLevel = 2;
  pm.upgrades.boots = 1;

  const game1 = {
    canvas: { width: 800, height: 600 },
    mapRenderer: { getCurrentMapId: () => "forest_hamlet" },
    characters: [alice, player],
    player,
    buildingManager: bm,
    orderBook: ob,
    progression: pm,
  };

  assert.equal(sm.saveImmediate(SaveManager.captureGameState(game1)), true);
  const loaded = sm.load();
  assert.ok(loaded);
  assert.equal(loaded.mapId, "forest_hamlet");
  assert.equal(loaded.orderBook.tradeHistory.length, 2);

  // 新規インスタンスへ復元
  const p2 = makeChar("player", "Player");
  const a2 = makeChar("alice", "Alice");
  const game2 = {
    canvas: { width: 800, height: 600 },
    characters: [a2, p2],
    player: p2,
    buildingManager: new BuildingManager(p2),
    orderBook: new OrderBook(),
    progression: new ProgressionManager(p2),
  };
  SaveManager.applyGameState(game2, loaded);

  assert.equal(game2.progression.townLevel, 2);
  assert.equal(game2.progression.upgrades.boots, 1);
  assert.equal(game2.buildingManager.placed.length, 1);
  assert.equal(game2.orderBook.tradeHistory.length, 2);
  assert.equal(game2.orderBook.orders.length, 1);
  assert.equal(p2.inventory.coin, player.inventory.coin);
  assert.equal(p2.inventory.carrot, 2);
  assert.equal(a2.inventory.carrot_salad, 1);
  assert.deepEqual(game2.orderBook.priceHistory.carrot_salad, [9]);

  sm.clear();
  assert.equal(sm.hasSave(), false);
});

// ── FarmManager（農業プログレッション＆固定報酬ゼロ確認）テスト ──
test("FarmManager: 8 crops grow 0->3, enforce ownership & 2-plot cap, yield items with ZERO fixed coins", () => {
  const fm = new FarmManager();
  assert.equal(Object.keys(CROP_CATALOG).length, 8);
  assert.equal(fm.plots.length, 8);

  // 作物・料理カタログに固定コイン報酬(rewardCoins)が存在しないこと
  for (const crop of Object.values(CROP_CATALOG)) {
    assert.equal("rewardCoins" in crop, false, `${crop.id} に固定 rewardCoins が残っていないこと`);
  }
  for (const recipe of Object.values(COOKING_RECIPES)) {
    assert.equal("rewardCoins" in recipe, false, `${recipe.id} に固定 rewardCoins が残っていないこと`);
  }

  const player = makeChar("player", "Player", { coin: 50, wood: 3, herb: 3 });
  const alice = makeChar("alice", "Alice", { coin: 50, wood: 3, herb: 3 });

  // Player がニンジン (Stage 0, コスト wood:1) を植える
  const p1 = fm.plantCrop(player, "carrot", null, 0);
  assert.equal(p1.ok, true);
  assert.equal(player.inventory.wood, 2);
  assert.equal(player.inventory.coin, 50); // コインは消費されない
  assert.equal(p1.plot.stage, 0);

  // Player が小麦を2区画目に植える
  const p2 = fm.plantCrop(player, "wheat", null, 0);
  assert.equal(p2.ok, true);
  // 3区画目は上限(2区画)で拒否されること
  const p3 = fm.plantCrop(player, "carrot", null, 0);
  assert.equal(p3.ok, false);

  // ライバル Alice も空き区画に種をまけること
  const a1 = fm.plantCrop(alice, "carrot", null, 0);
  assert.equal(a1.ok, true);

  // 成長進行: Stage 0 -> 1 -> 2 -> 3
  const stepTime = CROP_CATALOG.carrot.stageTime + 0.1;
  fm.update(stepTime);
  assert.equal(p1.plot.stage, 1);
  fm.update(stepTime);
  assert.equal(p1.plot.stage, 2);
  // Stage 2 ではまだ収穫不可
  assert.equal(fm.harvestPlot(p1.plot.id, player).ok, false);

  // 未約定作物の農地評価は0（固定価格なし）、約定価格があれば市場価格を反映
  assert.equal(fm.getFarmAssetValue("player", { carrot: [] }), 0);
  assert.ok(fm.getFarmAssetValue("player", { carrot: [5] }) > 0);

  const ripeEvents = fm.update(stepTime);
  assert.ok(ripeEvents.length >= 1);
  assert.equal(p1.plot.stage, 3);

  // ライバル Alice は Player の畑を横取り収穫できないこと
  assert.equal(fm.harvestPlot(p1.plot.id, alice).ok, false);

  // Player が収穫するとコインは0増加、所持品に作物(🥕+1)と副産物資源(🌿+1)のみ追加されること
  const coinsBefore = player.inventory.coin;
  const herbsBefore = player.inventory.herb;
  const hRes = fm.harvestPlot(p1.plot.id, player);
  assert.equal(hRes.ok, true);
  assert.equal(player.inventory.coin, coinsBefore);
  assert.equal(player.inventory.carrot, 1);
  assert.equal(player.inventory.herb, herbsBefore + CROP_CATALOG.carrot.bonusAmount);
  assert.equal(p1.plot.cropId, null);
});

test("Rivalry: investor bonuses apply exclusively to Player and AI executes PLAN: farm", () => {
  const player = makeChar("player", "Player", { coin: 50, wood: 5, stone: 5 });
  const alice = makeChar("alice", "Alice", { coin: 50, wood: 3, herb: 3 });
  const pm = new ProgressionManager(player);
  pm.townLevel = 3;
  pm.upgrades.craftsman = 1;

  // プレイヤーの投資ボーナスはライバル Alice には適用されないこと
  assert.ok(pm.getBuildingSpeedMultiplier("player") > 1.5);
  assert.equal(pm.getBuildingSpeedMultiplier("alice"), 1.0);
  assert.ok(pm.getFarmSpeedMultiplier("player") > 1.2);
  assert.equal(pm.getFarmSpeedMultiplier("alice"), 1.0);

  // AI が PLAN: farm で自律的に農地へ種まき・収穫できること
  const cm = new ChatManager();
  const rm = new ResourceManager();
  rm.init(800, 600);
  const api = new LMStudioClient();
  const brain = new AIBrain([alice, player], cm, api, rm);
  brain.farmManager = new FarmManager();
  brain.orderBook = new OrderBook();
  brain.progression = pm;

  brain._executePlanFarm(alice, "PLAN: farm\nCROP: wheat\nMESSAGE: @Player 小麦を植えて逆転するよ！");
  const alicePlots = brain.farmManager.getPlotsByOwner("alice");
  assert.equal(alicePlots.length, 1);
  assert.equal(alicePlots[0].cropId, "wheat");

  // AI は作物・料理の trade 指示も正しくパースできること
  assert.deepEqual(
    brain._parseTradeDecision("PLAN: trade\nACTION: sell\nRESOURCE: carrot_salad\nAMOUNT: 1\nCOINS: 9"),
    { action: "sell", resource: "carrot_salad", amount: 1, coins: 9 }
  );
});

test("Market-only Coins: harvest -> cook -> list on OrderBook conserves coins strictly and only pays upon execution", () => {
  const fm = new FarmManager();
  const ob = new OrderBook();
  const player = makeChar("player", "Player", { coin: 50, wood: 2, herb: 2 });
  const carol = makeChar("carol", "Carol", { coin: 50, wood: 2, herb: 2 });
  const initialTotalCoins = player.inventory.coin + carol.inventory.coin;

  // 1. ニンジン栽培＆収穫：所持品に 🥕+1、コインは一切増えない
  const planted = fm.plantCrop(player, "carrot", null, 0);
  const step = CROP_CATALOG.carrot.stageTime + 0.1;
  fm.update(step);
  fm.update(step);
  fm.update(step);
  fm.harvestPlot(planted.plot.id, player);
  assert.equal(player.inventory.carrot, 1);
  assert.equal(player.inventory.coin, 50);

  // 2. 🥗 キャロットサラダ調理：所持品に 🥗+1、コインは一切増えない
  const cookRes = fm.cookRecipe(player, "carrot_salad");
  assert.equal(cookRes.ok, true);
  assert.equal(player.inventory.carrot, 0);
  assert.equal(player.inventory.carrot_salad, 1);
  assert.equal(player.inventory.coin, 50);
  assert.equal(fm.getCookedCount("player"), 1);

  // 3. 法外な高値(50🪙)で売り注文を出しても：出品だけではコインは増えず、AIも買わない
  const highOrder = ob.postOrder(player, "carrot_salad", 1, "coin", 50);
  assert.ok(highOrder);
  assert.equal(player.inventory.coin, 50);
  assert.equal(ob.tryAIExecute(carol), null);
  assert.equal(player.inventory.coin, 50);
  assert.equal(player.inventory.coin + carol.inventory.coin, initialTotalCoins);

  // 4. 取消して妥当価格(9🪙)で再出品 → 約定するまではコイン不変、AI約定で初めて買い手→売り手へ厳密移動
  assert.equal(ob.cancelOrder(highOrder.id, "player"), true);
  const fairOrder = ob.postOrder(player, "carrot_salad", 1, "coin", 9);
  assert.ok(fairOrder);
  assert.equal(player.inventory.coin, 50); // 出品直後はまだ不変

  const exec = ob.tryAIExecute(carol);
  assert.ok(exec);
  assert.equal(player.inventory.coin, 59);
  assert.equal(carol.inventory.coin, 41);
  assert.equal(player.inventory.carrot_salad, 0);
  assert.equal(carol.inventory.carrot_salad, 1);
  assert.equal(player.inventory.coin + carol.inventory.coin, initialTotalCoins); // 総コイン厳密保存
  assert.deepEqual(ob.priceHistory.carrot_salad, [9]);

  // 5. AIライバル (Carol) も所持作物があれば自動調理でき、コインは増えない
  carol.inventory.carrot = 1;
  carol.inventory.herb = 2;
  const carolCoinBeforeCook = carol.inventory.coin;
  const aiCook = fm.tryAICook(carol, ob.priceHistory);
  assert.ok(aiCook);
  assert.equal(aiCook.recipe.id, "carrot_salad");
  assert.equal(carol.inventory.coin, carolCoinBeforeCook);
  assert.equal(carol.inventory.carrot_salad, 2);

  // 6. 建物設置時に同一座標で重ならないようオフセット配置されること
  player.inventory.herb = 10;
  const bm = new BuildingManager(player);
  bm.placeAtForChar(player, "flowerBed");
  bm.placeAtForChar(player, "flowerBed");
  const dist = Math.hypot(bm.placed[0].x - bm.placed[1].x, bm.placed[0].y - bm.placed[1].y);
  assert.ok(dist >= 40);

  // 7. シーズン優勝判定（総資産 150🪙 到達で勝者が記録されること）
  const pm = new ProgressionManager(player);
  let winnerEvent = null;
  pm.onSeasonVictory = w => { winnerEvent = w; };
  assert.equal(pm.checkSeasonVictory([{ char: carol, asset: { total: 140 } }]), null);
  const win = pm.checkSeasonVictory([{ char: carol, asset: { total: 155 } }]);
  assert.ok(win);
  assert.equal(win.id, "carol");
  assert.equal(winnerEvent.id, "carol");
});

test("HuggingFace AI: each character has a distinct Hugging Face LLM model and Style-Bert-VITS2 voice", () => {
  assert.equal(GAME_CONFIG.aiProvider, "huggingface");
  assert.equal(GAME_CONFIG.ttsProvider, "huggingface");
  assert.equal(GAME_CONFIG.ttsRepo, "litagin/sbv2_amitaro");

  const chars = buildCharacters(800, 600);
  const aiChars = chars.filter(c => !c.isPlayer);
  assert.equal(aiChars.length, 3);

  const models = new Set(aiChars.map(c => c.model));
  const voices = new Set(aiChars.map(c => c.ttsConfig?.ttsModel));
  assert.equal(models.size, 3);
  assert.equal(voices.size, 3);

  const alice = aiChars.find(c => c.id === "alice");
  const bob = aiChars.find(c => c.id === "bob");
  const carol = aiChars.find(c => c.id === "carol");

  assert.equal(alice.model, "unsloth/gemma-3-4b-it-GGUF#alice");
  assert.equal(alice.ttsConfig.ttsModel, "amitaro");
  assert.equal(alice.ttsConfig.style, "Neutral");
  assert.equal(bob.model, "unsloth/gemma-3-4b-it-GGUF#bob");
  assert.equal(bob.ttsConfig.ttsModel, "jvnv-M1-jp");
  assert.equal(bob.ttsConfig.style, "Neutral");
  assert.equal(carol.model, "unsloth/gemma-3-4b-it-GGUF#carol");
  assert.equal(carol.ttsConfig.ttsModel, "jvnv-F2-jp");
  assert.equal(carol.ttsConfig.style, "Neutral");

  const client = new HuggingFaceClient();
  assert.equal(client.model, "unsloth/gemma-3-4b-it-GGUF");
});

test("Anti-jitter & Always-HF-Retry: blocked AI stops vibrating/escapes stuck target and always retries Hugging Face", async () => {
  // 1. 壁に阻まれた gatherTarget でもブルブルせずスタック検知で安全に解除され、静止時はアイドル姿勢になること
  const nav = new NavGrid();
  const fakeMap = {
    width: 5,
    height: 5,
    terrain: ["GGGGG", "GWWWG", "GWGWG", "GWWWG", "GGGGG"],
    legend: { G: "grass", W: "wall" },
    objects: [],
  };
  const fakeAtlas = [
    { id: "grass", collision: { type: "none", solid: false } },
    { id: "wall",  collision: { type: "rect", solid: true, x: 0, y: 0, w: 256, h: 256 } },
  ];
  nav.buildFromMap(fakeMap, fakeAtlas, 500, 500, 2);

  const chars = buildCharacters(500, 500);
  const alice = chars.find(c => c.id === "alice");
  alice.x = 50;
  alice.y = 50;
  alice._lastCheckX = 50;
  alice._lastCheckY = 50;
  // 壁の向こう側 (250, 250) にある到達不能な採集ターゲットへ移動させる
  alice.gatherTarget = { x: 250, y: 250, isEmpty: false };
  alice.updateWander(0.1, 500, 500, nav);
  // 到達不能なターゲットは即座に解除され、壁に向かってブルブルし続けないこと
  assert.equal(alice.gatherTarget, null);
  assert.equal(alice._walkPhase, 1);

  // 目標までの距離より 1フレームの移動量 (5.5px) が大きくても通り過ぎて往復振動（ブルブル）しないこと
  alice.x = 50;
  alice.y = 50;
  alice.wanderTarget = { x: 52.8, y: 60 }; // footY = 60
  alice.wanderTimer = 10;
  alice.updateWander(0.1, 500, 500, nav);
  assert.equal(alice.wanderTarget, null);
  assert.equal(alice.vx, 0);
  assert.equal(alice._walkPhase, 1);

  // 2. llmAvailable=false でもプレイヤー発言時に常に Hugging Face (callAI) へ接続を試み、成功でオンライン復帰すること
  let callCount = 0;
  const fakeApi = {
    async callAI() {
      callCount++;
      return "@Player 復帰したよ！";
    },
  };
  const player = makeChar("player", "Player");
  const cm = new ChatManager();
  const rm = new ResourceManager();
  rm.init(500, 500);
  const brain = new AIBrain([alice, player], cm, fakeApi, rm);
  brain.llmAvailable = false;

  await brain.handlePlayerMessage("@Alice こんにちは", alice, player);
  assert.equal(callCount, 1);
  assert.equal(brain.llmAvailable, true);
});

test("Serverless GitHub Pages mode: HuggingFaceClient switches to browser-hf and TTSManager picks natural Japanese voices", async () => {
  const { TTSManager } = require(path.join(rootDir, "js/tts.js"));

  // 1. 読み上げテキストの絵文字・Lv表記の自然な日本語化
  assert.equal(
    TTSManager.sanitizeForSpeech("@Alice 🪵木材×3と🪙+10で街Lv.3になったよ！✨"),
    "木材3個と10コインで街レベル3になったよ！"
  );

  // 2. ブラウザ音声から日本語ニューラル音声（Nanami / Keita Natural）を優先選択できること
  const tts = new TTSManager();
  tts._voices = [
    { name: "Microsoft Haruka - Japanese (Japan)", lang: "ja-JP" },
    { name: "Microsoft Nanami Online (Natural) - Japanese (Japan)", lang: "ja-JP" },
    { name: "Microsoft Keita Online (Natural) - Japanese (Japan)", lang: "ja-JP" },
    { name: "Google US English", lang: "en-US" },
  ];
  assert.match(tts._selectNaturalJapaneseVoice("female").name, /Nanami.*Natural/i);
  assert.match(tts._selectNaturalJapaneseVoice("male").name, /Keita.*Natural/i);

  // 3. 非localhost（GitHub Pages 等）ではローカルサーバー無しで browser-hf モードへ自動切替すること
  const client = new HuggingFaceClient();
  assert.equal(HuggingFaceClient.isLocalServerHost(), false);
  const health = await client.checkHealth();
  assert.equal(client.mode, "browser-hf");
  assert.equal(health.ok, true);
  assert.equal(health.hf_api.mode, "browser-transformers-js");
  assert.equal(health.tts.local_available, false);

  // 4. ブラウザ内蔵 Hugging Face VITS2 TTS の WAV キャッシュが機能し上限64件を超えないこと
  const dummyWav = new ArrayBuffer(128);
  tts._cacheWav("Alice::テスト", dummyWav);
  assert.equal(tts._wavCache.has("Alice::テスト"), true);
  assert.equal(tts._wavCache.get("Alice::テスト").byteLength, 128);

  // 5. 自動再生ブロック中および解除直後(600ms以内)の toggle() で勝手に音声OFFにならず、通常時は正しく切替できること
  tts.enabled = true;
  tts.autoplayBlocked = true;
  assert.equal(tts.toggle(), true);
  tts.autoplayBlocked = false;
  tts._unblockedAtMs = Date.now();
  assert.equal(tts.toggle(), true);
  tts._unblockedAtMs = Date.now() - 1000;
  assert.equal(tts.toggle(), false);

  // 6. ブラウザ内蔵 ZEN-TTS (44.1kHz 感情対応) が3キャラ別々のモデル・動的感情制御・playbackRate=1.0・必須クレジットを維持していること
  const workerSrc = fs.readFileSync(path.join(rootDir, "js/hf-tts-worker.js"), "utf8");
  assert.match(workerSrc, /zenryokukikai\/zen-tts@/);
  assert.match(workerSrc, /tts-models\.zenryoku\.work\/v1\.3\.0/);
  assert.match(workerSrc, /function\s+inferEmotionForSentence/);
  const assignedVoices = new Set();
  for (const name of ["Alice", "Bob", "Carol"]) {
    const m = workerSrc.match(new RegExp(`${name}:\\s*\\{[\\s\\S]*?voice:\\s*"([a-z]+)"[\\s\\S]*?speed:\\s*([0-9.]+)`));
    assert.ok(m, `${name} の ZEN-TTS ボイス定義が見つかること`);
    assignedVoices.add(m[1]);
    const spd = Number(m[2]);
    assert.ok(spd >= 0.85 && spd <= 1.05, `${name} の話速(${spd})が自然な会話テンポ範囲(0.85〜1.05)であること`);
  }
  assert.equal(assignedVoices.size, 3, "Alice / Bob / Carol の3キャラが重複しない別々の音声モデルを持つこと");
  const ttsSrc = fs.readFileSync(path.join(rootDir, "js/tts.js"), "utf8");
  assert.match(ttsSrc, /const\s+playbackRate\s*=\s*1\.0\s*;/);
  const indexHtml = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
  assert.match(indexHtml, /音声合成：ZEN-TTS[\s\S]*https:\/\/zenryokukikai\.com/);
});

test("Audio-synchronized chat & movement: delays chat until audio starts, holds movement/bubble during speech, resumes on end", async () => {
  const chars = buildCharacters(800, 600);
  const alice = chars.find(c => c.id === "alice");
  const player = chars.find(c => c.id === "player");
  alice.x = 200;
  alice.y = 200;
  player.x = 340;
  player.y = 200; // Alice の右側

  const cm = new ChatManager();
  const rm = new ResourceManager();
  rm.init(800, 600);
  const api = new HuggingFaceClient();
  const brain = new AIBrain(chars, cm, api, rm);

  let capturedCallbacks = null;
  brain.tts = {
    enabled: true,
    speak(text, charName, callbacks) {
      capturedCallbacks = { text, charName, callbacks };
    },
  };

  let afterFired = false;
  brain._presentResponse(alice, "@Player 音声と同期して話すよ！", player.id, player.name, () => {
    afterFired = true;
  });

  // 1. 音声準備中：チャットはまだ表示されず、キャラは停止して相手方向（右）を向く
  assert.ok(capturedCallbacks);
  assert.equal(cm.messages.length, 0);
  assert.equal(alice.isTalking, true);
  assert.equal(alice.isTyping, true);
  assert.equal(alice.isSpeaking, false);
  assert.equal(alice._facing, "right");
  assert.equal(alice.speechBubble, null);

  alice.wanderTarget = { x: 600, y: 400 };
  alice.wanderTimer = 10;
  alice.updateWander(0.2, 800, 600, null);
  assert.equal(alice.x, 200);
  assert.equal(alice.y, 200);

  // 2. 音声準備完了＆再生開始 (onStart)：チャットと吹き出しが表示され、発話モーション開始
  capturedCallbacks.callbacks.onStart({ durationSec: 3.5, mode: "hf-audio" });
  assert.equal(cm.messages.length, 1);
  assert.equal(cm.messages[0].text, "@Player 音声と同期して話すよ！");
  assert.equal(alice.isTyping, false);
  assert.equal(alice.isSpeaking, true);
  assert.ok(alice.speechBubble);

  // 音声再生中は長時間経過しても吹き出しが消えず、移動も停止したまま発話モーションが進む
  alice.updateWander(0.25, 800, 600, null);
  assert.ok(alice._speakAnimTime > 0);
  assert.equal(alice.x, 200);
  alice.updateSpeechBubble(10.0);
  assert.ok(alice.speechBubble && alice.speechBubble.ttl >= 0.9);

  // 3. 音声再生終了 (onEnd)：発話モーション終了・吹き出し残時間短縮→移動再開＆後続トリガー発火
  capturedCallbacks.callbacks.onEnd({ mode: "hf-audio" });
  assert.equal(alice.isSpeaking, false);
  assert.ok(alice.speechBubble.ttl <= 0.9);

  await new Promise(r => setTimeout(r, 420));
  assert.equal(alice.isTalking, false);
  assert.equal(alice.talkingTo, null);
  assert.equal(afterFired, true);

  // 移動再開の確認
  alice.updateWander(0.2, 800, 600, null);
  assert.ok(alice.x > 200);
});

test("LLM Output Quality & Action Speech: rejects garbled WebGPU tokens, removes q4f16, and generates gather/farm/trade speech via LLM", async () => {
  // 1. 報告された典型的な文字化け・断片トークン列を確実に拒否し、正常な日本語は通すこと
  const garbled = "eloído あ っé っ ellen 2らindedoo ど \uFFFD に せーや\uFFFD ゛ elo oo ez ǎ のア うん loquentの そら 2 ア \u0365";
  assert.equal(HuggingFaceClient.isCorruptedText(garbled), true);
  assert.equal(HuggingFaceClient.cleanDialogueResponse(garbled, "Player"), "");
  assert.equal(HuggingFaceClient.sanitizeAnnounceMessage(garbled, "Player"), null);

  assert.equal(HuggingFaceClient.isCorruptedText("@Player 🪵木材を採集したよ！次は取引板に出してみようかな。"), false);
  assert.equal(
    HuggingFaceClient.cleanDialogueResponse("@Player 木材を採集したよ！いい天気だね。", "Player"),
    "@Player 木材を採集したよ！いい天気だね。"
  );

  // 2. hf-browser-worker.js に不安定な q4f16 が残っておらず、起動時セルフテストと自動WASM退避があること
  const browserWorkerSrc = fs.readFileSync(path.join(rootDir, "js/hf-browser-worker.js"), "utf8");
  assert.equal(browserWorkerSrc.includes('dtype: "q4f16"'), false, "不安定な WebGPU q4f16 が除去されていること");
  assert.match(browserWorkerSrc, /function\s+verifyGeneratorHealth/);
  assert.match(browserWorkerSrc, /function\s+isCorruptedJapanese/);
  assert.match(browserWorkerSrc, /device:\s*"webgpu",\s*dtype:\s*"q4"/);
  assert.match(browserWorkerSrc, /device:\s*"wasm",\s*dtype:\s*"q8"/);

  // 3. 資源採集・取引反応などの行動アナウンスが定型文ではなく LLM (callAI) で生成されること
  const chars = buildCharacters(800, 600);
  const alice = chars.find(c => c.id === "alice");
  const player = chars.find(c => c.id === "player");
  const cm = new ChatManager();
  const rm = new ResourceManager();
  rm.init(800, 600);

  const promptsSent = [];
  const fakeApi = {
    mode: "browser-hf",
    _workerReady: true,
    async callAI(char, prompt, targetName) {
      promptsSent.push({ charId: char.id, prompt, targetName });
      return `@${targetName} いい木材が見つかったよ！あとで取引板で勝負しようね。`;
    },
  };
  const brain = new AIBrain(chars, cm, fakeApi, rm);
  brain.orderBook = new OrderBook();
  brain.farmManager = new FarmManager();
  brain.tts = { enabled: false };

  let presented = null;
  brain._presentResponse = (char, response, recipientId, recipientName) => {
    presented = { charId: char.id, response, recipientId, recipientName };
  };

  // _pendingAnnounceMessage が空でも定型文を使わず LLM へ問い合わせること
  alice._pendingAnnounceMessage = null;
  brain._announceGather(alice, "wood", 1);
  await new Promise(r => setTimeout(r, 30));

  assert.equal(promptsSent.length, 1);
  assert.match(promptsSent[0].prompt, /木材を1個採集した/);
  assert.equal(presented.response, `@${presented.recipientName} いい木材が見つかったよ！あとで取引板で勝負しようね。`);

  // プレイヤーの取引約定に対するAIリアクションもLLM生成になること
  brain.reactToTradeExecuted(alice, player, {
    sellType: "wood",
    sellAmount: 1,
    buyType: "coin",
    buyAmount: 3,
    resourceType: "wood",
    resourceQty: 1,
    coinQty: 3,
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(promptsSent.length, 2);
  assert.match(promptsSent[1].prompt, /売却できた/);
});
