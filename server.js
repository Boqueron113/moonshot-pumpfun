// ═══════════════════════════════════════════════════════════════════════════
// MOONSHOT €20 — PumpFun bot v8 — ROTACIÓN CONTINUA
// SL -20% · TP +25% · Tiempo máximo 1h por posición
// Capital siempre en movimiento
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58    = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ─────────────────────────────────────────────────────────────────
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const MORALIS_API_KEY    = process.env.MORALIS_API_KEY;

const SOL_PER_TRADE  = 0.006;  // ~€0.53 por trade
const MAX_POSITIONS  = 15;
const RESERVE_SOL    = 0.02;
const SCAN_INTERVAL  = 45000;  // scan cada 45s

// ── ROTACIÓN CONTINUA ──────────────────────────────────────────────────────
const TP1_PERCENT    = 25;     // +25% → vende 50% (rápido)
const TP2_PERCENT    = 80;     // +80% → vende resto
const TP3_PERCENT    = 200;    // +200% → moonshot (raro pero posible)
const SL_PERCENT     = -20;    // -20% → stop loss rápido
const MAX_HOLD_MS    = 60 * 60 * 1000; // 1 hora máximo por posición
const TRAIL_ACTIVATE = 50;     // trailing desde +50%
const TRAIL_DROP     = 15;     // vende si cae 15% desde peak

// Vault
const VAULT_TP1 = 0.3;
const VAULT_TP2 = 0.5;
const VAULT_TP3 = 0.7;

// ── FILTROS ────────────────────────────────────────────────────────────────
const MIN_LIQUIDITY_USD = 3000;
const MIN_AGE_MINUTES   = 3;
const MAX_AGE_MINUTES   = 30;
const MIN_VOLUME_1H_USD = 3000;
const MAX_MCAP_LIQ_RATIO = 15;
const MIN_PRICE_CHANGE  = 2;
const MAX_PRICE_CHANGE  = 500;

// ── SETUP ──────────────────────────────────────────────────────────────────
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const wallet = WALLET_PRIVATE_KEY
  ? Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY))
  : null;

const positions  = new Map();
const seenTokens = new Set();
const history    = [];
let vaultSol     = 0;
let botPaused    = false;
let totalScans   = 0;
let totalBuys    = 0;
let totalSkips   = 0;
let totalExpired = 0;

// ── TELEGRAM ───────────────────────────────────────────────────────────────
async function notify(msg) {
  console.log(`[ALERT] ${msg.replace(/\*/g,'').replace(/`/g,'')}`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }
    );
  } catch (e) { /* silent */ }
}

// ── SCORE ──────────────────────────────────────────────────────────────────
function scoreToken(ageMin, liq, ratio, change5m) {
  let score = 0;
  score += Math.max(0, 100 - Math.abs(ageMin - 10) * 6) * 0.3;
  score += Math.min(100, (liq / 30000) * 100) * 0.3;
  score += Math.max(0, (MAX_MCAP_LIQ_RATIO - ratio) / MAX_MCAP_LIQ_RATIO * 100) * 0.2;
  score += Math.max(0, Math.min(100, change5m * 2)) * 0.2;
  return Math.round(score);
}

// ── FILTROS ────────────────────────────────────────────────────────────────
function filterToken(token) {
  const fails = [];
  const createdAt = token.createdAt
    ? (typeof token.createdAt === 'string' ? new Date(token.createdAt).getTime() : token.createdAt)
    : null;
  const ageMin = createdAt ? (Date.now() - createdAt) / 60000 : 999;

  if (ageMin < MIN_AGE_MINUTES)  fails.push(`joven:${ageMin.toFixed(1)}m`);
  if (ageMin > MAX_AGE_MINUTES)  fails.push(`viejo:${ageMin.toFixed(0)}m`);

  const liq   = parseFloat(token.liquidity) || parseFloat(token.liquidityUsd) || 0;
  if (liq < MIN_LIQUIDITY_USD)   fails.push(`liq:$${Math.round(liq)}`);

  const vol1h = parseFloat(token.volume1h) || parseFloat(token.volume?.h1) || 0;
  if (vol1h > 0 && vol1h < MIN_VOLUME_1H_USD) fails.push(`vol:$${Math.round(vol1h)}`);

  const mcap  = parseFloat(token.marketCap) || parseFloat(token.fullyDilutedValuation) || 0;
  const ratio = liq > 0 ? mcap / liq : 999;
  if (ratio > MAX_MCAP_LIQ_RATIO) fails.push(`ratio:${ratio.toFixed(1)}x`);

  const change5m = parseFloat(token.priceChange5m) || parseFloat(token.priceChange?.m5) || 0;
  if (change5m !== 0) {
    if (change5m < MIN_PRICE_CHANGE)  fails.push(`mom:${change5m.toFixed(1)}%`);
    if (change5m > MAX_PRICE_CHANGE)  fails.push(`tarde:${change5m.toFixed(0)}%`);
  }

  return {
    ok: fails.length === 0, fails,
    ageMin, liq, vol1h, ratio, change5m,
    score: scoreToken(ageMin, liq, ratio, change5m),
  };
}

// ── TRADE ──────────────────────────────────────────────────────────────────
async function trade(action, mint, amountSol) {
  if (!wallet) return { success: false, error: 'no wallet' };
  try {
    const res = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      {
        publicKey: wallet.publicKey.toBase58(),
        action, mint,
        denominatedInSol: 'true',
        amount: amountSol,
        slippage: 15,
        priorityFee: 0.0005,
        pool: 'pump',
      },
      { responseType: 'arraybuffer', timeout: 10000 }
    );
    const tx = VersionedTransaction.deserialize(new Uint8Array(res.data));
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx);
    return { success: true, signature: sig };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function getSolBalance() {
  if (!wallet) return 0;
  try { return (await connection.getBalance(wallet.publicKey)) / 1e9; }
  catch { return 0; }
}

// ── SCAN ───────────────────────────────────────────────────────────────────
async function scanRecentTokens() {
  if (botPaused || positions.size >= MAX_POSITIONS) return;
  if (!MORALIS_API_KEY) { console.log('[ERROR] Falta MORALIS_API_KEY'); return; }

  const balance = await getSolBalance();
  if (balance - SOL_PER_TRADE < RESERVE_SOL) {
    botPaused = true;
    await notify('⚠️ *Bot pausado* — saldo insuficiente');
    return;
  }

  totalScans++;
  console.log(`\n[SCAN #${totalScans}] ${positions.size} pos · balance:${balance.toFixed(3)} SOL · vault:${vaultSol.toFixed(3)}`);

  try {
    const { data } = await axios.get(
      'https://solana-gateway.moralis.io/token/mainnet/exchange/pumpfun/new',
      {
        params: { limit: 100 },
        headers: { 'Accept': 'application/json', 'X-API-Key': MORALIS_API_KEY },
        timeout: 10000,
      }
    );

    const tokens = data.result || data.tokens || (Array.isArray(data) ? data : []);
    console.log(`[SCAN] Moralis: ${tokens.length} tokens`);

    const candidates = [];
    for (const token of tokens) {
      const mint = token.tokenAddress || token.mint || token.address;
      if (!mint || seenTokens.has(mint)) continue;
      const check = filterToken(token);
      if (check.ok) {
        candidates.push({ token, check, mint });
      } else {
        totalSkips++;
        console.log(`[SKIP] ${String(token.symbol||'?').padEnd(12)} ${check.fails.join(' · ')}`);
      }
    }

    candidates.sort((a, b) => b.check.score - a.check.score);
    console.log(`[SCAN] ★ ${candidates.length} candidatos`);

    for (const { token, check, mint } of candidates) {
      if (positions.size >= MAX_POSITIONS) break;
      seenTokens.add(mint);
      totalBuys++;

      const sym = token.symbol || token.name || 'UNK';
      console.log(`[BUY ★${check.score}] ${sym} · ${check.ageMin.toFixed(1)}m · liq:$${Math.round(check.liq)}`);

      const result = await trade('buy', mint, SOL_PER_TRADE);
      if (result.success) {
        const priceUsd = parseFloat(token.priceUsd) || parseFloat(token.price) || 0;
        positions.set(mint, {
          mint, symbol: sym,
          entryPrice: priceUsd,
          amountSol: SOL_PER_TRADE,
          remainingSol: SOL_PER_TRADE,
          peakPrice: priceUsd,
          score: check.score,
          tp1Done: false, tp2Done: false,
          openedAt: Date.now(),
          signature: result.signature,
        });
        const expiresIn = Math.round(MAX_HOLD_MS / 60000);
        await notify(
          `🎯 *ENTRADA* \`${sym}\` ★${check.score}/100\n` +
          `💰 ${SOL_PER_TRADE} SOL · ⏱ ${check.ageMin.toFixed(1)}min\n` +
          `💧 Liq: $${Math.round(check.liq)}\n` +
          `⏳ Cierre automático en ${expiresIn}min si no hay TP/SL\n` +
          `[Solscan](https://solscan.io/tx/${result.signature})`
        );
      } else {
        console.log(`[FAIL] ${sym}: ${result.error}`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

  } catch (e) {
    if (e.response?.status === 401) { console.log('[ERROR] Moralis API Key inválida'); await notify('❌ *Error* — API Key de Moralis inválida'); }
    else if (e.response?.status === 429) { console.log('[ERROR] Límite Moralis alcanzado, esperando...'); }
    else { console.log(`[SCAN ERROR] ${e.message}`); }
  }
}

// ── MONITOR TP/SL/TIEMPO ───────────────────────────────────────────────────
async function monitorPositions() {
  if (positions.size === 0) return;

  for (const [mint, pos] of positions) {
    try {
      // ── EXPIRACIÓN POR TIEMPO (1 hora) ─────────────────────────────────
      const holdTime = Date.now() - pos.openedAt;
      if (holdTime >= MAX_HOLD_MS) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          totalExpired++;
          const heldMin = Math.round(holdTime / 60000);
          history.push({ ...pos, exitPrice: pos.entryPrice, pnl: 0, type: 'expired', time: Date.now() });
          positions.delete(mint);
          await notify(`⏰ *EXPIRADO* \`${pos.symbol}\` — ${heldMin}min · capital liberado para reinvertir`);
        }
        continue;
      }

      // ── PRECIO ─────────────────────────────────────────────────────────
      const { data } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const pair = data.pairs?.[0];
      if (!pair) continue;

      const price = parseFloat(pair.priceUsd) || pos.entryPrice;
      if (price <= 0) continue;

      const pnl   = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (price > pos.peakPrice) pos.peakPrice = price;
      const dropFromPeak = ((price - pos.peakPrice) / pos.peakPrice) * 100;
      const timeLeft     = Math.round((MAX_HOLD_MS - holdTime) / 60000);

      // TP3 MOONSHOT
      if (pnl >= TP3_PERCENT) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          const gained = pos.remainingSol * (1 + pnl / 100);
          vaultSol += gained * VAULT_TP3;
          history.push({ ...pos, exitPrice: price, pnl, type: 'moonshot', time: Date.now() });
          positions.delete(mint);
          await notify(`🚀🌙 *MOONSHOT* \`${pos.symbol}\` +${pnl.toFixed(0)}%\n💎 ${(gained * VAULT_TP3).toFixed(4)} SOL al vault`);
        }
      // TP2
      } else if (pnl >= TP2_PERCENT && !pos.tp2Done) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          const gained = pos.remainingSol * (1 + pnl / 100);
          vaultSol += gained * VAULT_TP2;
          history.push({ ...pos, exitPrice: price, pnl, type: 'tp2', time: Date.now() });
          positions.delete(mint);
          await notify(`💰 *TP2* \`${pos.symbol}\` +${pnl.toFixed(0)}% · capital libre`);
        }
      // TP1
      } else if (pnl >= TP1_PERCENT && !pos.tp1Done) {
        const r = await trade('sell', mint, pos.remainingSol * 0.5);
        if (r.success) {
          const gained = pos.remainingSol * 0.5 * (1 + pnl / 100);
          vaultSol += gained * VAULT_TP1;
          pos.tp1Done = true;
          pos.remainingSol *= 0.5;
          await notify(`💸 *TP1* \`${pos.symbol}\` +${pnl.toFixed(0)}% · mitad vendida · ${timeLeft}min restantes`);
        }
      // TRAILING
      } else if (pnl >= TRAIL_ACTIVATE && dropFromPeak <= -TRAIL_DROP) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          history.push({ ...pos, exitPrice: price, pnl, type: 'trailing', time: Date.now() });
          positions.delete(mint);
          await notify(`📉 *Trailing* \`${pos.symbol}\` +${pnl.toFixed(0)}% · capital libre`);
        }
      // STOP LOSS
      } else if (pnl <= SL_PERCENT) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          history.push({ ...pos, exitPrice: price, pnl, type: 'stop_loss', time: Date.now() });
          positions.delete(mint);
          await notify(`🛑 *SL* \`${pos.symbol}\` ${pnl.toFixed(0)}% · capital libre`);
        }
      } else {
        console.log(`[POS] ${pos.symbol.padEnd(10)} ${pnl>=0?'+':''}${pnl.toFixed(1)}% · ⏳${timeLeft}min`);
      }

    } catch (e) { /* skip */ }
  }
}

// ── TIMERS ─────────────────────────────────────────────────────────────────
setInterval(scanRecentTokens, SCAN_INTERVAL);
setInterval(monitorPositions, 20000);

// ── STATUS ─────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const balance = await getSolBalance();
  res.json({
    status:   botPaused ? '⏸ PAUSADO' : '✅ CAZANDO',
    version:  'v8 — rotación continua',
    wallet:   wallet?.publicKey.toBase58() || 'sin-wallet',
    balance_sol:   balance.toFixed(4),
    vault_sol:     vaultSol.toFixed(4),
    stats: {
      scans: totalScans, buys: totalBuys,
      skips: totalSkips, expired: totalExpired,
      open: positions.size,
    },
    config: {
      sl:       `${SL_PERCENT}%`,
      tp1:      `+${TP1_PERCENT}%`,
      tp2:      `+${TP2_PERCENT}%`,
      tp3:      `+${TP3_PERCENT}%`,
      max_hold: `${MAX_HOLD_MS/60000}min`,
    },
    positions: Array.from(positions.values()).map(p => ({
      symbol:   p.symbol,
      score:    p.score,
      age_min:  Math.floor((Date.now() - p.openedAt) / 60000),
      time_left_min: Math.round((MAX_HOLD_MS - (Date.now() - p.openedAt)) / 60000),
      tp1: p.tp1Done,
    })),
    history_last_10: history.slice(-10),
  });
});

app.post('/resume', (req, res) => {
  botPaused = false;
  notify('▶️ *Bot reactivado*');
  res.json({ status: 'resumed' });
});

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 MoonShot €20 Bot v8 — ROTACIÓN CONTINUA — puerto ${PORT}`);
  console.log(`⚙️  SL:${SL_PERCENT}% · TP1:+${TP1_PERCENT}% · TP2:+${TP2_PERCENT}% · MAX:${MAX_HOLD_MS/60000}min`);
  if (wallet) console.log(`👛 Wallet: ${wallet.publicKey.toBase58()}`);
  else console.log('⚠️  Sin WALLET_PRIVATE_KEY');
  await notify(
    '🚀 *Bot v8 — Rotación Continua*\n' +
    `🔄 Máx por posición: ${MAX_HOLD_MS/60000}min\n` +
    `🛑 Stop loss: ${SL_PERCENT}%\n` +
    `💸 TP1: +${TP1_PERCENT}% · TP2: +${TP2_PERCENT}% · TP3: +${TP3_PERCENT}%\n` +
    '📡 Moralis API · DexScreener monitor'
  );
  scanRecentTokens();
});
