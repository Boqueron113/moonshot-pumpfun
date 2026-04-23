// ═══════════════════════════════════════════════════════════════════════════
// MOONSHOT €20 — PumpFun bot v3
// Filtros extra: volumen creciente + bonding curve + ratio precio/liquidez
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
const SCAN_INTERVAL  = 30000;

const TP1_PERCENT    = 40;
const TP2_PERCENT    = 120;
const TP3_PERCENT    = 300;
const SL_PERCENT     = -35;
const TRAIL_ACTIVATE = 80;
const TRAIL_DROP     = 25;

// ── FILTROS ────────────────────────────────────────────────────────────────
const MIN_LIQUIDITY_SOL  = 5;
const MIN_AGE_MINUTES    = 3;
const MAX_AGE_MINUTES    = 30;

// NUEVOS filtros v3
const MIN_BONDING_CURVE  = 0.20;  // mínimo 20% de bonding curve completada
const MAX_BONDING_CURVE  = 0.70;  // máximo 70% (si ya pasó esto, llegas tarde)
const MIN_VOLUME_RATIO   = 0.15;  // volumen debe ser >15% del market cap (actividad real)
const MAX_MCAP_LIQ_RATIO = 15;   // market cap no puede ser >15x la liquidez (pump artificial)

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
let totalSkipped = 0;
let totalBought  = 0;

// ── TELEGRAM ───────────────────────────────────────────────────────────────
async function notify(msg) {
  console.log(`[ALERT] ${msg}`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }
    );
  } catch (e) { /* silent */ }
}

// ── ANTI-RUG v3 ────────────────────────────────────────────────────────────
function antiRugCheck(token) {
  const fails  = [];
  const passes = [];

  // ── FILTRO 1: Edad ──────────────────────────────────────────────────────
  const ageMin = (Date.now() - token.created_timestamp) / 60000;
  if (ageMin < MIN_AGE_MINUTES) { fails.push(`too-young:${ageMin.toFixed(1)}m`); }
  else if (ageMin > MAX_AGE_MINUTES) { fails.push(`too-old:${ageMin.toFixed(1)}m`); }
  else passes.push(`age:${ageMin.toFixed(1)}m ✓`);

  // ── FILTRO 2: Liquidez ──────────────────────────────────────────────────
  const liqSol = (token.virtual_sol_reserves || 0) / 1e9;
  if (liqSol < MIN_LIQUIDITY_SOL) { fails.push(`liq:${liqSol.toFixed(1)}<${MIN_LIQUIDITY_SOL}SOL`); }
  else passes.push(`liq:${liqSol.toFixed(1)}SOL ✓`);

  // ── FILTRO 3 (NUEVO): Bonding Curve ────────────────────────────────────
  // PumpFun expone el progreso de la bonding curve
  const bondingProgress = token.bonding_curve_progress || 0; // 0 a 1
  if (bondingProgress < MIN_BONDING_CURVE) {
    fails.push(`bonding:${(bondingProgress*100).toFixed(0)}%<20%`);
  } else if (bondingProgress > MAX_BONDING_CURVE) {
    fails.push(`bonding:${(bondingProgress*100).toFixed(0)}%>70%`);
  } else {
    passes.push(`bonding:${(bondingProgress*100).toFixed(0)}% ✓`);
  }

  // ── FILTRO 4 (NUEVO): Ratio Market Cap / Liquidez ──────────────────────
  // Si el mcap es 20x la liquidez, el precio está inflado artificialmente
  const mcapUsd = token.usd_market_cap || 0;
  const liqUsd  = liqSol * (token.sol_price_usd || 150);
  const mcapLiqRatio = liqUsd > 0 ? mcapUsd / liqUsd : 999;
  if (mcapLiqRatio > MAX_MCAP_LIQ_RATIO) {
    fails.push(`mcap/liq:${mcapLiqRatio.toFixed(1)}x>15x`);
  } else {
    passes.push(`mcap/liq:${mcapLiqRatio.toFixed(1)}x ✓`);
  }

  // ── FILTRO 5 (NUEVO): Volumen relativo ─────────────────────────────────
  // Volumen 24h debe ser al menos 15% del market cap — señal de actividad real
  const volume24h    = token.volume_24h || token.volume || 0;
  const volumeRatio  = mcapUsd > 0 ? volume24h / mcapUsd : 0;
  if (volumeRatio < MIN_VOLUME_RATIO) {
    fails.push(`vol:${(volumeRatio*100).toFixed(0)}%<15%`);
  } else {
    passes.push(`vol:${(volumeRatio*100).toFixed(0)}% ✓`);
  }

  return {
    ok: fails.length === 0,
    fails,
    passes,
    ageMin,
    bondingProgress,
    mcapLiqRatio,
    volumeRatio,
    score: passes.length, // cuántos filtros pasa (máx 5)
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

// ── SCAN TOKENS RECIENTES ──────────────────────────────────────────────────
async function scanRecentTokens() {
  if (botPaused || positions.size >= MAX_POSITIONS) return;

  const balance = await getSolBalance();
  if (balance - SOL_PER_TRADE < RESERVE_SOL) {
    botPaused = true;
    await notify('⚠️ *Bot pausado* — saldo insuficiente');
    return;
  }

  totalScans++;
  console.log(`\n[SCAN #${totalScans}] Buscando tokens 3-30min... (${positions.size} pos abiertas)`);

  try {
    const { data } = await axios.get(
      'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false',
      { timeout: 8000 }
    );

    let foundThisScan = 0;

    for (const token of data) {
      if (positions.size >= MAX_POSITIONS) break;
      if (seenTokens.has(token.mint)) continue;

      const check = antiRugCheck(token);

      if (!check.ok) {
        totalSkipped++;
        console.log(`[SKIP] ${token.symbol || '?'}: ${check.fails.join(' · ')}`);
        continue;
      }

      // ✅ PASA TODOS LOS FILTROS
      seenTokens.add(token.mint);
      totalBought++;
      foundThisScan++;

      const scoreEmoji = check.score >= 5 ? '🔥' : check.score >= 4 ? '⭐' : '✅';
      console.log(`[BUY ${scoreEmoji}] ${token.symbol} · ${check.passes.join(' · ')}`);

      const result = await trade('buy', token.mint, SOL_PER_TRADE);

      if (result.success) {
        const priceUsd = (token.usd_market_cap || 0) / (token.total_supply || 1);
        positions.set(token.mint, {
          mint: token.mint,
          symbol: token.symbol || 'UNK',
          entryPrice: priceUsd,
          amountSol: SOL_PER_TRADE,
          remainingSol: SOL_PER_TRADE,
          peakPrice: priceUsd,
          tp1Done: false,
          tp2Done: false,
          bondingEntry: check.bondingProgress,
          score: check.score,
          openedAt: Date.now(),
          signature: result.signature,
        });

        await notify(
          `${scoreEmoji} *ENTRADA* \`${token.symbol}\`\n` +
          `💰 ${SOL_PER_TRADE} SOL · ${check.ageMin.toFixed(1)}min de vida\n` +
          `📊 Bonding: ${(check.bondingProgress*100).toFixed(0)}% · Vol: ${(check.volumeRatio*100).toFixed(0)}%\n` +
          `🏆 Score: ${check.score}/5 filtros\n` +
          `[Ver en Solscan](https://solscan.io/tx/${result.signature})`
        );
      } else {
        console.log(`[FAIL] ${token.symbol}: ${result.error}`);
        seenTokens.delete(token.mint); // retry next scan
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    if (foundThisScan === 0) {
      console.log(`[SCAN] Sin candidatos este scan. Total skipped: ${totalSkipped}`);
    }

  } catch (e) {
    console.log(`[SCAN ERROR] ${e.message}`);
  }
}

// ── MONITOR TP/SL ──────────────────────────────────────────────────────────
async function monitorPositions() {
  if (positions.size === 0) return;

  for (const [mint, pos] of positions) {
    try {
      const { data } = await axios.get(
        `https://frontend-api.pump.fun/coins/${mint}`,
        { timeout: 5000 }
      );
      const price        = (data.usd_market_cap || 0) / (data.total_supply || 1);
      const pnl          = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      if (price > pos.peakPrice) pos.peakPrice = price;
      const dropFromPeak = ((price - pos.peakPrice) / pos.peakPrice) * 100;

      // TP3 MOONSHOT
      if (pnl >= TP3_PERCENT) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          const gained = pos.remainingSol * (1 + pnl / 100);
          vaultSol += gained * VAULT_TP3;
          history.push({ ...pos, exitPrice: price, pnl, type: 'moonshot', time: Date.now() });
          positions.delete(mint);
          await notify(
            `🚀🌙 *MOONSHOT* \`${pos.symbol}\`\n` +
            `+${pnl.toFixed(0)}% · ${(gained * VAULT_TP3).toFixed(4)} SOL al vault 💎`
          );
        }
        continue;
      }

      // TP2
      if (pnl >= TP2_PERCENT && !pos.tp2Done) {
        const r = await trade('sell', mint, pos.remainingSol * 0.4);
        if (r.success) {
          pos.tp2Done = true;
          pos.remainingSol *= 0.6;
          await notify(`💰 *TP2* \`${pos.symbol}\` +${pnl.toFixed(0)}% · vendida 40%`);
        }
        continue;
      }

      // TP1
      if (pnl >= TP1_PERCENT && !pos.tp1Done) {
        const r = await trade('sell', mint, pos.remainingSol * 0.3);
        if (r.success) {
          pos.tp1Done = true;
          pos.remainingSol *= 0.7;
          await notify(`💸 *TP1* \`${pos.symbol}\` +${pnl.toFixed(0)}% · capital recuperado`);
        }
        continue;
      }

      // TRAILING STOP
      if (pnl >= TRAIL_ACTIVATE && dropFromPeak <= -TRAIL_DROP) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          history.push({ ...pos, exitPrice: price, pnl, type: 'trailing', time: Date.now() });
          positions.delete(mint);
          await notify(`📉 *Trailing* \`${pos.symbol}\` +${pnl.toFixed(0)}% desde entrada`);
        }
        continue;
      }

      // STOP LOSS
      if (pnl <= SL_PERCENT) {
        const r = await trade('sell', mint, pos.remainingSol);
        if (r.success) {
          history.push({ ...pos, exitPrice: price, pnl, type: 'stop_loss', time: Date.now() });
          positions.delete(mint);
          await notify(`🛑 *SL* \`${pos.symbol}\` ${pnl.toFixed(0)}%`);
        }
        continue;
      }

      console.log(`[POS] ${pos.symbol}: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% (peak: +${(((pos.peakPrice-pos.entryPrice)/pos.entryPrice)*100).toFixed(0)}%)`);

    } catch (e) { /* skip */ }
  }
}

// ── TIMERS ─────────────────────────────────────────────────────────────────
setInterval(scanRecentTokens, SCAN_INTERVAL);
setInterval(monitorPositions, 15000);

// ── STATUS ─────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const balance = await getSolBalance();
  res.json({
    version: 'v3 — filtros avanzados',
    status: botPaused ? '⏸ PAUSADO' : '✅ CAZANDO',
    wallet: wallet?.publicKey.toBase58() || 'sin-wallet',
    balance_sol: balance.toFixed(4),
    vault_sol: vaultSol.toFixed(4),
    stats: { scans: totalScans, skipped: totalSkipped, bought: totalBought },
    filtros: {
      edad: `${MIN_AGE_MINUTES}-${MAX_AGE_MINUTES} min`,
      liquidez: `>${MIN_LIQUIDITY_SOL} SOL`,
      bonding_curve: `${MIN_BONDING_CURVE*100}%-${MAX_BONDING_CURVE*100}%`,
      mcap_liq_ratio: `<${MAX_MCAP_LIQ_RATIO}x`,
      volumen_relativo: `>${MIN_VOLUME_RATIO*100}%`,
    },
    positions_open: positions.size,
    positions: Array.from(positions.values()).map(p => ({
      symbol: p.symbol,
      age_min: Math.floor((Date.now() - p.openedAt) / 60000),
      score: `${p.score}/5`,
      bonding_entry: `${(p.bondingEntry*100).toFixed(0)}%`,
      tp1: p.tp1Done, tp2: p.tp2Done,
    })),
    history_last_5: history.slice(-5).map(h => ({
      symbol: h.symbol, type: h.type,
      pnl: `${h.pnl >= 0 ? '+' : ''}${h.pnl.toFixed(1)}%`,
    })),
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
  console.log(`🚀 MoonShot €20 Bot v3 — puerto ${PORT}`);
  console.log(`📊 Filtros: edad ${MIN_AGE_MINUTES}-${MAX_AGE_MINUTES}m · liq>${MIN_LIQUIDITY_SOL}SOL · bonding ${MIN_BONDING_CURVE*100}-${MAX_BONDING_CURVE*100}% · vol>${MIN_VOLUME_RATIO*100}%`);
  if (wallet) console.log(`👛 Wallet: ${wallet.publicKey.toBase58()}`);
  else console.log('⚠️  Sin WALLET_PRIVATE_KEY');

  await notify(
    '🚀 *Bot MoonShot v3 activado*\n' +
    '📊 Filtros nuevos:\n' +
    '• Bonding curve 20%-70%\n' +
    '• Market cap/liquidez <15x\n' +
    '• Volumen relativo >15%\n' +
    '• Edad 3-30 min · Liq >5 SOL'
  );
  scanRecentTokens();
});
