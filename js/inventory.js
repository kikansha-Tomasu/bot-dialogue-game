const INITIAL_COINS = 50;
const INVENTORY_RESOURCE_TYPES = typeof TRADABLE_ITEM_TYPES !== "undefined"
  ? TRADABLE_ITEM_TYPES
  : ["wood", "stone", "herb", "fish"];

function makeInventory() {
  return { wood: 0, stone: 0, herb: 0, fish: 0, coin: INITIAL_COINS };
}

function inventoryAdd(inv, type, amount) {
  const n = Number(amount);
  if (!inv || !type || !Number.isFinite(n) || n <= 0) return false;
  inv[type] = (inv[type] || 0) + n;
  return true;
}

function inventoryCanAfford(inv, cost) {
  if (!inv || !cost) return false;
  return Object.entries(cost).every(([t, n]) => (inv[t] || 0) >= n);
}

function inventoryDeduct(inv, cost) {
  if (!inventoryCanAfford(inv, cost)) return false;
  Object.entries(cost).forEach(([t, n]) => {
    inv[t] = Math.max(0, (inv[t] || 0) - n);
  });
  return true;
}

function getInventorySummary(inv, maxNonCoinItems = Infinity) {
  if (!inv) return "";
  const parts = [];
  if ((inv.coin || 0) > 0) {
    parts.push(`${RESOURCE_EMOJI.coin || "🪙"}×${inv.coin}`);
  }
  const nonCoin = Object.entries(inv)
    .filter(([k, v]) => k !== "coin" && v > 0);
  const shown = Number.isFinite(maxNonCoinItems) ? nonCoin.slice(0, maxNonCoinItems) : nonCoin;
  for (const [k, v] of shown) {
    parts.push(`${RESOURCE_EMOJI[k] || k}×${v}`);
  }
  if (nonCoin.length > shown.length) {
    parts.push(`他${nonCoin.length - shown.length}種`);
  }
  return parts.join("  ");
}

function computeAssetValue(inv, priceHistory, extras = null) {
  const coins = inv?.coin || 0;
  let resourceValue = 0;
  let pricedCount = 0;
  const breakdown = [];
  const itemTypes = typeof TRADABLE_ITEM_TYPES !== "undefined"
    ? TRADABLE_ITEM_TYPES
    : INVENTORY_RESOURCE_TYPES;

  for (const type of itemTypes) {
    const amt = inv?.[type] || 0;
    if (amt <= 0) continue;
    const hist = priceHistory?.[type];
    const price = hist && hist.length > 0 ? hist[hist.length - 1] : null;
    if (price !== null) {
      const value = amt * price;
      resourceValue += value;
      pricedCount++;
      breakdown.push({ type, amount: amt, unitPrice: price, value });
    } else {
      breakdown.push({ type, amount: amt, unitPrice: null, value: 0 });
    }
  }

  const farmValue = Number(extras?.farmValue) || 0;
  const buildingValue = (Number(extras?.buildingCount) || 0) * 4;

  return {
    coins,
    resourceValue,
    farmValue,
    buildingValue,
    total: coins + resourceValue + farmValue + buildingValue,
    pricedCount,
    breakdown,
  };
}

function drawInventoryHUD(ctx, inv, w, priceHistory = null, rankInfo = null) {
  const summary = getInventorySummary(inv, 5);
  const medals = ["🥇1位", "🥈2位", "🥉3位", "4️⃣4位"];
  const rankPrefix = rankInfo && rankInfo.rank >= 1
    ? `${medals[rankInfo.rank - 1] || `${rankInfo.rank}位`}  |  `
    : "";
  let label = rankPrefix + "🎒 " + (summary || "（空）");
  if (rankInfo && typeof rankInfo.total === "number") {
    label += `  |  総資産 ${rankInfo.total.toFixed(1)}🪙`;
  } else if (priceHistory) {
    const val = computeAssetValue(inv, priceHistory);
    if (val.resourceValue > 0) {
      label += `  |  総資産 ${val.total.toFixed(1)}🪙`;
    }
  }
  ctx.save();
  ctx.font = "bold 12.5px 'Segoe UI', 'Meiryo', sans-serif";
  const tw = ctx.measureText(label).width;
  const pad = 11;
  const bh = 30;
  const bx = Math.max(10, w - tw - pad * 2 - 10);
  // 左上HUDバー（約480px幅）と重なる画面幅では自動的に2段目へ配置
  const by = bx < 490 ? 46 : 10;

  ctx.fillStyle = "rgba(44, 24, 16, 0.78)";
  ctx.beginPath();
  ctx.roundRect(bx, by, tw + pad * 2, bh, 6);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 215, 0, 0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#FDF8F0";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, bx + pad, by + bh / 2);
  ctx.restore();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    INITIAL_COINS,
    INVENTORY_RESOURCE_TYPES,
    makeInventory,
    inventoryAdd,
    inventoryCanAfford,
    inventoryDeduct,
    getInventorySummary,
    computeAssetValue,
    drawInventoryHUD,
  };
}
