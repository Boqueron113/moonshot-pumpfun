// ═══════════════════════════════════════════════════════════════════════════
// MOONSHOT €20 — PumpFun bot optimizado para bankroll de €20 (~0.13 SOL)
// Filtros anti-rug · Auto take-profit escalonado · Vault seguro
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const WebSocket = require('ws');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG PARA €20 ────────────────────────────────────────────────────────
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // opcional
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;   // opcional

// Capital: con €20 ~ 0.13 SOL, dejamos ~0.02 SOL (€3) de reserva para fees
const SOL_PER_TRADE   = 0.006;  // ~€0.90 por entrada
const MAX_POSITIONS   = 15;     // hasta 15 posiciones simultáneas
const RESERVE_SOL     = 0.02;   // reserva fija para gas fees
const MAX_DAILY_SPEND = 0.10;   // máximo ~€15 gastados/día

// Take profit escalonado
const TP1_PERCENT = 40;   // +40%: vende 30% (recupera capital casi entero)
const TP2_PERCENT = 120;  // +120%: vende 40% (asegura beneficio)
const TP3_PERCENT = 300;  // +300%: vende todo (moonshot completo)
const SL_PERCENT  = -35;  // -35%: stop loss

// Trailing stop (anti-dump)
const TRAIL_ACTIVATE = 80;   // activa trailing tras +80%
const TRAIL_DROP     = 25;   // vende si cae 25% desde peak

// Filtros anti-rug ESTRICTOS (críticos con €20)
const MIN_LIQUIDITY_SOL = 8;
const MAX_CREATOR_PCT   = 0.15;
const MAX_TOP10_PCT     = 0.45;
const MIN_AGE_MINUTES   = 3;
const MAX_AGE_MINUTES   = 30;
const MIN_HOLDERS       = 25;

// Auto-vault (% de cada TP que va al vault seguro)
const VAULT_TP1 = 0.5;
const VAULT_TP2 = 0.6;
const VAULT_TP3 = 0.75;

// ── SETUP SOLANA ──────────────────────────────────────────────────────────
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const wallet = WALLET_PRIVATE_KEY
  ? Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY))
  : null;

const positions = new Map();
const history = [];
let vaultSol = 0;
let dailySpent = 0;
let lastResetDay = new Date().getDate();
let botPaused = false;

// ── TELEGRAM (opcional) ───────────────────────────────────────────────────
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

// ── ANTI-RUG CHECKS ───────────────────────────────────────────────────────
function antiRugCheck(token) {
  const fails = [];
  if (!token.liquidity_sol || token.liquidity_sol < MIN_LIQUIDITY_SOL)
    fails.push(`liq<${MIN_LIQUIDITY_SOL}SOL`);
  if ((token.creator_percent || 1) > MAX_CREATOR_PCT)
    fails.push(`creator>${MAX_CREATOR_PCT*100}%`);
  if ((token.top10_percent || 1) > MAX_TOP10_PCT)
    fails.push(`top10>${MAX_TOP10_PCT*100}%`);
  const ageMin = (Date.now() - (token.created_timestamp || Date.now())) / 60000;
  if (ageMin < MIN_AGE_MINUTES) fails.push(`too-young:${ageMin.toFixed(1)}m`);
  if (ageMin > MAX_AGE_MINUTES) fails.push(`too-old:${ageMin.toFixed(1)}m`);
  if ((token.holder_count || 0) < MIN_HOLDERS) fails.push(`holders<${MIN_HOLDERS}`);
  return { ok: fails.length === 0, fails };
}

// ── PUMPPORTAL TRADING ────────────────────────────────────────────────────
async function trade(action, mint, amountSol) {
  if (!wallet) return { success: false, error: 'no wallet' };
  try {
    const res = await axios.post(
      'https://pumpportal.fun/api/trade-local',
      {
        publicKey: wallet.publicKey.toBase58(),
        action,
        mint,
        denominatedInSol: 'true',
        amount: amountSol,
        slippage: 15,
        priorityFee: 0.0005,
        pool: 'pump',
      },
      { responseType: 'arraybuffer' }
    );
    const tx = VersionedTransaction.deserialize(new Uint8Array(res.data));
    tx.sign([wallet]);
    const signature = await connection.sendTransaction(tx);
    return { success: true, signature };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── GET SOL BALANCE ───────────────────────────────────────────────────────
async function getSolBalance() {
  if (!wallet) return 0;
  try {
    const lamports = await connection.getBalance(wallet.publicKey);
    return lamports / 1e9;
  } catch { return 0; }
}

// ── RESET DAILY SPEND ─────────────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().getDate();
  if (today !== lastResetDay) {
    dailySpent = 0;
    lastResetDay = today;
    notify('🔄 *Reset diario* — límite de gasto reiniciado');
  }
}

// ── WEBSOCKET: NUEVOS TOKENS ──────────────────────────────────────────────
let ws;
function connectWS() {
  ws = new WebSocket('wss://pumpportal.fun/api/data');

  ws.on('open', () => {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    console.log('[WS] 👂 Escuchando nuevos tokens PumpFun...');
    notify('🚀 *Bot MoonShot €20 activado* — escuchando PumpFun');
  });

  ws.on('message', async (data) => {
    if (botPaused) return;
    checkDailyReset();

    let token;
    try { token = JSON.parse(data); } catch { return; }
    if (!token.mint) return;

    // Límite diario
    if (dailySpent >= MAX_DAILY_SPEND) return;

    // Posiciones máximas
    if (positions.size >= MAX_POSITIONS) return;

    // Reserva de SOL
    const balance = await getSolBalance();
    if (balance - SOL_PER_TRADE < RESERVE_SOL) {
      if (!botPaused) {
        botPaused = true;
        notify('⚠️ *Bot pausado* — saldo insuficiente. Revisa el vault.');
      }
      return;
    }

    // Anti-rug
    const check = antiRugCheck(token);
    if (!check.ok) {
      console.log(`[SKIP] ${token.symbol}: ${check.fails.join(',')}`);
      return;
    }

    // COMPRAR
    console.log(`[BUY] ${token.symbol} · ${SOL_PER_TRADE} SOL`);
    const result = await trade('buy', token.mint, SOL_PER_TRADE);

    if (result.success) {
      positions.set(token.mint, {
        mint: token.mint,
        symbol: token.symbol || 'UNK',
        name: token.name || '',
        entryPrice: token.price_usd || 0,
        amountSol: SOL_PER_TRADE,
        remainingSol: SOL_PER_TRADE,
        tokensHeld: (SOL_PER_TRADE / (token.price_sol || 1)),
        peakPrice: token.price_usd || 0,
        tp1Done: false,
        tp2Done: false,
        openedAt: Date.now(),
        signature: result.signature,
      });
      dailySpent += SOL_PER_TRADE;
      notify(`🎯 *ENTRADA* \`${token.symbol}\`\n${SOL_PER_TRADE} SOL · [tx](https://solscan.io/tx/${result.signature})`);
    } else {
      console.log(`[FAIL BUY] ${token.symbol}: ${result.error}`);
    }
  });

  ws.on('close', () => {
    console.log('[WS] 🔌 Desconectado, reintentando en 5s...');
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (e) => console.log(`[WS ERROR] ${e.message}`));
}

// ── MONITOR: TP/SL/TRAILING ───────────────────────────────────────────────
setInterval(async () => {
  for (const [mint, pos] of positions) {
    try {
      const { data } = await axios.get(`https://frontend-api.pump.fun/coins/${mint}`, { timeout: 5000 });
      const price = data.usd_market_cap / (data.total_supply || 1);
      const pnl = ((price - pos.entryPrice) / pos.entryPrice) * 100;

      // Update peak
      if (price > pos.peakPrice) pos.peakPrice = price;
      const dropFromPeak = ((price - pos.peakPrice) / pos.peakPrice) * 100;

      // ─── TP3 (MOONSHOT) ───
      if (pnl >= TP3_PERCENT && pos.remainingSol > 0) {
        const result = await trade('sell', mint, pos.remainingSol);
        if (result.success) {
          const received = pos.remainingSol * (1 + pnl/100);
          vaultSol += received * VAULT_TP3;
          positions.delete(mint);
          history.push({ ...pos, exitPrice: price, pnl, type: 'moonshot', time: Date.now() });
          notify(`🚀🌙 *MOONSHOT* \`${pos.symbol}\`\n+${pnl.toFixed(0)}% · ${(received * VAULT_TP3).toFixed(4)} SOL al vault`);
        }
        continue;
      }

      // ─── TP2 ───
      if (pnl >= TP2_PERCENT && !pos.tp2Done) {
        const sellAmount = pos.remainingSol * 0.4 / (1 + pnl/100) * (1 + pnl/100);
        const result = await trade('sell', mint, pos.remainingSol * 0.4);
        if (result.success) {
          pos.tp2Done = true;
          pos.remainingSol *= 0.6;
          vaultSol += sellAmount * VAULT_TP2;
          notify(`💰 *TP2* \`${pos.symbol}\` +${pnl.toFixed(0)}%`);
        }
        continue;
      }

      // ─── TP1 ───
      if (pnl >= TP1_PERCENT && !pos.tp1Done) {
        const result = await trade('sell', mint, pos.remainingSol * 0.3);
        if (result.success) {
          pos.tp1Done = true;
          pos.remainingSol *= 0.7;
          vaultSol += pos.amountSol * 0.3 * VAULT_TP1;
          notify(`💸 *TP1* \`${pos.symbol}\` +${pnl.toFixed(0)}% · capital recuperado`);
        }
        continue;
      }

      // ─── TRAILING STOP ───
      if (pnl >= TRAIL_ACTIVATE && dropFromPeak <= -TRAIL_DROP) {
        const result = await trade('sell', mint, pos.remainingSol);
        if (result.success) {
          positions.delete(mint);
          history.push({ ...pos, exitPrice: price, pnl, type: 'trailing', time: Date.now() });
          notify(`📉 *Trailing* \`${pos.symbol}\` +${pnl.toFixed(0)}% (peak ${((pos.peakPrice-pos.entryPrice)/pos.entryPrice*100).toFixed(0)}%)`);
        }
        continue;
      }

      // ─── STOP LOSS ───
      if (pnl <= SL_PERCENT) {
        const result = await trade('sell', mint, pos.remainingSol);
        if (result.success) {
          positions.delete(mint);
          history.push({ ...pos, exitPrice: price, pnl, type: 'stop_loss', time: Date.now() });
          console.log(`[🛑 SL] ${pos.symbol}: ${pnl.toFixed(0)}%`);
        }
        continue;
      }

    } catch (e) { /* skip errors */ }
  }
}, 12000);

// ── STATUS ENDPOINT ───────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const balance = await getSolBalance();
  res.json({
    status: botPaused ? '⏸ PAUSADO' : '✅ CAZANDO',
    wallet: wallet ? wallet.publicKey.toBase58() : 'sin-wallet',
    balance_sol: balance.toFixed(4),
    vault_sol: vaultSol.toFixed(4),
    daily_spent: dailySpent.toFixed(4),
    daily_limit: MAX_DAILY_SPEND,
    positions_open: positions.size,
    positions: Array.from(positions.values()).map(p => ({
      symbol: p.symbol,
      pnl: 'ver en logs',
      age_min: Math.floor((Date.now() - p.openedAt) / 60000),
    })),
    history_last_10: history.slice(-10),
    config: {
      sol_per_trade: SOL_PER_TRADE,
      max_positions: MAX_POSITIONS,
      tp_levels: [TP1_PERCENT, TP2_PERCENT, TP3_PERCENT],
      stop_loss: SL_PERCENT,
    }
  });
});

// ── RESUME BOT (si pausó) ─────────────────────────────────────────────────
app.post('/resume', (req, res) => {
  botPaused = false;
  notify('▶️ *Bot reactivado*');
  res.json({ status: 'resumed' });
});

// ── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MoonShot €20 Bot en puerto ${PORT}`);
  if (wallet) console.log(`👛 Wallet: ${wallet.publicKey.toBase58()}`);
  else console.log('⚠️ Sin WALLET_PRIVATE_KEY configurada');
  connectWS();
});
