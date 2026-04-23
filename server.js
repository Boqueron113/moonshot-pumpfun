// ═══════════════════════════════════════════════════════════════════════════
// MOONSHOT €20 — PumpFun bot v6
// Fix: usar endpoint token-boosts + fetchear detalles individuales con liq real
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ─────────────────────────────────────────────────────────────────
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const SOL_PER_TRADE  = 0.006;
const MAX_POSITIONS  = 15;
const RESERVE_SOL    = 0.02;
const SCAN_INTERVAL  = 60000; // 1 min

const TP1_PERCENT    = 40;
const TP2_PERCENT    = 120;
const TP3_PERCENT    = 300;
const SL_PERCENT     = -35;
const TRAIL_ACTIVATE = 80;
const TRAIL_DROP     = 25;

// Filtros
const MIN_LIQUIDITY_USD  = 3000;   // $3k mínimo
const MIN_AGE_MINUTES    = 3;
const MAX_AGE_MINUTES    = 60;     // ampliado a 1 hora
const MIN_VOLUME_1H_USD  = 3000;   // $3k volumen 1h
const MAX_MCAP_LIQ_RATIO = 15;     // más permisivo
const MIN_PRICE_CHANGE   = 2;
const MAX_PRICE_CHANGE   = 500;

const VAULT_TP1 = 0.5;
const VAULT_TP2 = 0.6;
const VAULT_TP3 = 0.75;

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

// ── TELEGRAM ───────────────────────────────────────────────────────────────
async function notify(msg) {
  console.log(`[ALERT] ${msg.replace(/\*/g, '').replace(/`/g, '')}`);
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
  score += Math.max(0, 100 - Math.abs(ageMin - 15) * 4) * 0.3;
  score += Math.min(100, (liq / 30000) * 100) * 0.3;
  score += Math.max(0, (MAX_MCAP_LIQ_RATIO - ratio) / MAX_MCAP_LIQ_RATIO * 100) * 0.2;
  score += Math.max(0, Math.min(100, change5m * 2)) * 0.2;
  return Math.round(score);
}

// ── FILTROS ────────────────────────────────────────────────────────────────
function filterPair(pair) {
  const fails = [];

  if (pair.chainId !== 'solana') fails.push('no-solana');

  const ageMin = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60000
    : 999;
  if (ageMin < MIN_AGE_MINUTES) fails.push(`joven:${ageMin.toFixed(1)}m`);
  if (ageMin > MAX_AGE_MINUTES) fails.push(`viejo:${ageMin.toFixed(0)}m`);

  const liq = pair.liquidity?.usd || 0;
  if (liq < MIN_LIQUIDITY_USD) fails.push(`liq:$${Math.round(liq)}`);

  const vol1h = pair.volume?.h1 || 0;
  if (vol1h < MIN_VOLUME_1H_USD) fails.push(`vol:$${Math.round(vol1h)}`);

  const mcap = pair.fdv || pair.marketCap || 0;
  const ratio = liq > 0 ? mcap / liq : 999;
  if (ratio > MAX_MCAP_LIQ_RATIO) fails.push(`ratio:${ratio.toFixed(1)}x`);

  const change5m = pair.priceChange?.m5 || 0;
  if (change5m < MIN_PRICE_CHANGE) fails.push(`mom:${change5m.toFixed(1)}%`);
  if (change5m > MAX_PRICE_CHANGE) fails.push(`tarde:${change5m.toFixed(0)}%`);

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

// ── SCAN v6 ────────────────────────────────────────────────────────────────
// Estrategia: 
// 1. Pedir token-boosts (top 30 trending en Solana)
// 2. Para cada uno, fetchear datos completos con /latest/dex/tokens/{mint}
// 3. Filtrar y comprar los mejores
async function scanRecentTokens() {
  if (botPaused || positions.size >= MAX_POSITIONS) return;

  const balance = await getSolBalance();
  if (balance - SOL_PER_TRADE < RESERVE_SOL) {
    botPaused = true;
    await notify('⚠️ *Bot pausado* — saldo insuficiente');
    return;
  }

  totalScans++;
  console.log(`\n[SCAN #${totalScans}] DexScreener boosted tokens · ${positions.size} posiciones`);

  try {
    // Paso 1: obtener tokens boosted (trending)
    const boostedRes = await axios.get(
      'https://api.dexscreener.com/token-boosts/latest/v1',
      { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    
    const boostedArr = Array.isArray(boostedRes.data) ? boostedRes.data : [];
    const solanaTokens = boostedArr
      .filter(t => t.chainId === 'solana' && t.tokenAddress)
      .slice(0, 30);

    console.log(`[SCAN] ${solanaTokens.length} tokens Solana trending`);

    if (solanaTokens.length === 0) {
      console.log('[SCAN] Sin tokens trending, probando endpoint alternativo...');
      // Fallback: búsqueda general
      const fallback = await axios.get(
        'https://api.dexscreener.com/latest/dex/search?q=SOL',
        { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const pairs = (fallback.data.pairs || [])
        .filter(p => p.chainId === 'solana')
        .slice(0, 30);
      
      await processPairs(pairs);
      return;
    }

    // Paso 2: fetchear datos completos de cada token trending
    const pairs = [];
    for (const t of solanaTokens) {
      if (seenTokens.has(t.tokenAddress)) continue;
      try {
        const { data } = await axios.get(
          `https://api.dexscreener.com/latest/dex/tokens/${t.tokenAddress}`,
          { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (data.pairs?.[0]) pairs.push(data.pairs[0]);
      } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 200)); // rate limit
    }

    await processPairs(pairs);

  } catch (e) {
    console.log(`[SCAN ERROR] ${e.message}`);
  }
}

async function processPairs(pairs) {
  console.log(`[SCAN] Procesando ${pairs.length} pares con datos completos`);
  
  const candidates = [];
  for (const pair of pairs) {
    const mint = pair.baseToken?.address;
    if (!mint || seenTokens.has(mint)) continue;

    const check = filterPair(pair);
    if (check.ok) {
      candidates.push({ pair, check, mint });
    } else {
      totalSkips++;
      const sym = pair.baseToken?.symbol || '?';
      console.log(`[SKIP] ${sym.padEnd(10)} ${check.fails.join(' · ')}`);
    }
  }

  candidates.sort((a, b) => b.check.score - a.check.score);
  console.log(`[SCAN] ★ ${candidates.length} candidatos válidos ★`);

  for (const { pair, check, mint } of candidates) {
    if (positions.size >= MAX_POSITIONS) break;
    seenTokens.add(mint);
    totalBuys++;

    const sym = pair.baseToken?.symbol || 'UNK';
    console.log(`[BUY ★${check.score}] ${sym} · ${check.ageMin.toFixed(1)}m · liq:$${Math.round(check.liq)} · +${check.change5m.toFixed(1)}%`);

    const result = await trade('buy', mint, SOL_PER_TRADE);
    if (result.success) {
      const priceUsd = parseFloat(pair.priceUsd) || 0;
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
      await notify(
        `🎯 *ENTRADA* \`${sym}\` ★${check.score}/100\n` +
        `💰 ${SOL_PER_TRADE} SOL · ⏱ ${check.ageMin.toFixed(1)}min\n` +
        `💧 Liq: $${Math.round(check.liq)} · 📊 Vol1h: $${Math.round(check.vol1h)}\n` +
        `📈 +${check.change5m.toFixed(1)}% (5m)\n` +
        `[Solscan](https://solscan.io/tx/${result.signature}) · [Dex](https://dexscreener.com/solana/${mint})`
      );
    } else {
      console.log(`[FAIL] ${sym}: ${result.error}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── MONITOR POSICIONES ─────────────────────────────────────────────────────
async function monitorPositions() {
  if (positions.size === 0) return;

  for (const [mint, pos] of positions) {
    try {
      const { data } = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const pair = data.pairs?.[0];
      if (!pair) continue;

      const price = parseFloat(pair.priceUsd) || pos.entryPrice;
      if (price <= 0) continue;

      const pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (price > pos.peakPrice) pos.peakPrice = price;
      const dropFromPeak = ((price - pos.peakPrice) / pos.peakPrice) * 100;

      if (pnl >= TP3_PERCENT) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          const gained = pos.remainingSol * (1 + pnl / 100);
          vaultSol += gained * VAULT_TP3;
          history.push({ ...pos, exitPrice: price, pnl, type: 'moonshot', time: Date.now() });
          positions.delete(mint);
          await notify(`🚀🌙 *MOONSHOT* \`${pos.symbol}\` +${pnl.toFixed(0)}%\n💎 ${(gained * VAULT_TP3).toFixed(4)} SOL al vault`);
        }
      } else if (pnl >= TP2_PERCENT && !pos.tp2Done) {
        const r = await trade('sell', mint, pos.remainingSol * 0.4);
        if (r.success) {
          pos.tp2Done = true;
          pos.remainingSol *= 0.6;
          await notify(`💰 *TP2* \`${pos.symbol}\` +${pnl.toFixed(0)}%`);
        }
      } else if (pnl >= TP1_PERCENT && !pos.tp1Done) {
        const r = await trade('sell', mint, pos.remainingSol * 0.3);
        if (r.success) {
          pos.tp1Done = true;
          pos.remainingSol *= 0.7;
          await notify(`💸 *TP1* \`${pos.symbol}\` +${pnl.toFixed(0)}%`);
        }
      } else if (pnl >= TRAIL_ACTIVATE && dropFromPeak <= -TRAIL_DROP) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          history.push({ ...pos, exitPrice: price, pnl, type: 'trailing', time: Date.now() });
          positions.delete(mint);
          await notify(`📉 *Trailing* \`${pos.symbol}\` +${pnl.toFixed(0)}%`);
        }
      } else if (pnl <= SL_PERCENT) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          history.push({ ...pos, exitPrice: price, pnl, type: 'stop_loss', time: Date.now() });
          positions.delete(mint);
          await notify(`🛑 *SL* \`${pos.symbol}\` ${pnl.toFixed(0)}%`);
        }
      } else {
        console.log(`[POS] ${pos.symbol.padEnd(10)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% · peak:+${(((pos.peakPrice-pos.entryPrice)/pos.entryPrice)*100).toFixed(0)}%`);
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
    status: botPaused ? '⏸ PAUSADO' : '✅ CAZANDO',
    version: 'v6 — trending + detalles',
    wallet: wallet?.publicKey.toBase58() || 'sin-wallet',
    balance_sol: balance.toFixed(4),
    vault_sol: vaultSol.toFixed(4),
    stats: { scans: totalScans, buys: totalBuys, skips: totalSkips },
    positions_open: positions.size,
    positions: Array.from(positions.values()).map(p => ({
      symbol: p.symbol, score: p.score,
      age_min: Math.floor((Date.now() - p.openedAt) / 60000),
      tp1: p.tp1Done, tp2: p.tp2Done,
    })),
    history_last_5: history.slice(-5),
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
  console.log(`🚀 MoonShot €20 Bot v6 — puerto ${PORT}`);
  if (wallet) console.log(`👛 Wallet: ${wallet.publicKey.toBase58()}`);
  else console.log('⚠️  Sin WALLET_PRIVATE_KEY');
  await notify(
    '🚀 *Bot v6 activado*\n' +
    '✅ Fix: obtiene liquidez real\n' +
    '✅ Usa trending tokens Solana\n' +
    `📊 ${MIN_AGE_MINUTES}-${MAX_AGE_MINUTES}min · liq>$${MIN_LIQUIDITY_USD} · vol>$${MIN_VOLUME_1H_USD}`
  );
  scanRecentTokens();
});
