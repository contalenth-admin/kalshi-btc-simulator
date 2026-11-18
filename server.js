const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'trades.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const ASSETS = ['BTC', 'ETH', 'SOL'];
const TIMEFRAMES = ['15M', '1H', '4H', '1D'];

const ASSET_CONFIG = {
  BTC: {
    name: 'Bitcoin',
    coinbasePair: 'BTC-USD',
    binanceSymbol: 'BTCUSDT',
    kalshi15mSeries: 'KXBTC15M',
    color: '#f59e0b'
  },
  ETH: {
    name: 'Ethereum',
    coinbasePair: 'ETH-USD',
    binanceSymbol: 'ETHUSDT',
    kalshi15mSeries: 'KXETH15M',
    color: '#3b82f6'
  },
  SOL: {
    name: 'Solana',
    coinbasePair: 'SOL-USD',
    binanceSymbol: 'SOLUSDT',
    kalshi15mSeries: 'KXSOL15M',
    color: '#8b5cf6'
  }
};

// ============================================================================
// 1. ESTADO DE SIMULACIÓN Y PERSISTENCIA
// ============================================================================
const DEFAULT_STATE = {
  bankroll: 500.00,
  initialBankroll: 500.00,
  sharesPerTrade: 5,
  trades: [],
  lastSignals: {}
};

let simState = loadSimulationState();

function loadSimulationState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      return {
        ...DEFAULT_STATE,
        ...loaded,
        trades: (loaded.trades || []).map(t => ({
          ...t,
          asset: t.asset || 'BTC',
          timeframe: t.timeframe || '15M'
        }))
      };
    }
  } catch (err) {
    console.error('[SIM] Error leyendo trades.json:', err.message);
  }
  return { ...DEFAULT_STATE };
}

function saveSimulationState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(simState, null, 2), 'utf8');
  } catch (err) {
    console.error('[SIM] Error guardando trades.json:', err.message);
  }
}

// ============================================================================
// 2. CLIENTE HTTP HELPER
// ============================================================================
function fetchJson(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) KalshiMultiCryptoSim/3.0',
        'Accept': 'application/json',
        ...headers
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
          }
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`JSON parse error: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ============================================================================
// 3. DATOS DE MERCADO EN VIVO (BTC, ETH, SOL SPOT + VELAS)
// ============================================================================
const cachedSpots = {
  BTC: { price: 65000, time: 0 },
  ETH: { price: 1830, time: 0 },
  SOL: { price: 71.5, time: 0 }
};

async function getLiveSpot(asset = 'BTC') {
  const cache = cachedSpots[asset];
  if (cache && Date.now() - cache.time < 3000) {
    return cache.price;
  }

  const cfg = ASSET_CONFIG[asset];
  try {
    const data = await fetchJson(`https://api.coinbase.com/v2/prices/${cfg.coinbasePair}/spot`);
    if (data && data.data && data.data.amount) {
      cache.price = parseFloat(data.data.amount);
      cache.time = Date.now();
      return cache.price;
    }
  } catch (err) {
    try {
      const bData = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${cfg.binanceSymbol}`);
      if (bData && bData.price) {
        cache.price = parseFloat(bData.price);
        cache.time = Date.now();
        return cache.price;
      }
    } catch (err2) {}
  }
  return cache ? cache.price : 100;
}

async function getBinanceKlines(symbol, interval = '15m') {
  try {
    const raw = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=35`);
    if (Array.isArray(raw)) {
      return raw.map(k => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6]
      }));
    }
  } catch (err) {
    console.warn(`[SIM] Error obteniendo velas ${symbol} ${interval}:`, err.message);
  }
  return [];
}

async function getKalshi15mMarkets(seriesTicker) {
  try {
    const json = await fetchJson(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}`);
    return json.markets || [];
  } catch (err) {
    return [];
  }
}

async function getKalshiSingleMarket(ticker) {
  try {
    const json = await fetchJson(`https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`);
    return json.market || null;
  } catch (err) {
    return null;
  }
}

// ============================================================================
// 4. MOTOR CUANTITATIVO (RSI, EMA, DECISIÓN)
// ============================================================================
function calculateRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50.0;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100.0;
  const rs = avgGain / avgLoss;
  return Number((100 - (100 / (1 + rs))).toFixed(1));
}

function calculateEma(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return Number(ema.toFixed(2));
}

async function evaluateSignal(asset = 'BTC', timeframe = '15M', customStrike = null) {
  const spot = await getLiveSpot(asset);
  const cfg = ASSET_CONFIG[asset];

  let binanceInterval = '15m';
  if (timeframe === '1H') binanceInterval = '1h';
  else if (timeframe === '4H') binanceInterval = '4h';
  else if (timeframe === '1D') binanceInterval = '1d';

  const klines = await getBinanceKlines(cfg.binanceSymbol, binanceInterval);
  const strike = customStrike !== null ? customStrike : spot;
  const distPercent = strike ? Number(((spot - strike) / strike * 100).toFixed(3)) : 0;
  const distDollars = strike ? Number((spot - strike).toFixed(2)) : 0;

  let rsi = 50;
  let emaFast = spot;
  let emaSlow = spot;
  const fastPeriod = timeframe === '1D' ? 20 : 9;
  const slowPeriod = timeframe === '1D' ? 50 : 21;

  if (klines.length >= slowPeriod + 1) {
    const closes = klines.map(k => k.close);
    closes.push(spot);
    rsi = calculateRsi(closes, 14);
    emaFast = calculateEma(closes, fastPeriod);
    emaSlow = calculateEma(closes, slowPeriod);
  }

  const isBullish = emaFast >= emaSlow;
  const trend = isBullish ? 'BULLISH (Alcista)' : 'BEARISH (Bajista)';

  let decision = 'UP';
  let confidence = 65;
  let reasons = [];

  if (rsi < 35) {
    decision = 'UP';
    confidence += 15;
    reasons.push(`RSI ${asset} sobrevendido (${rsi})`);
  } else if (rsi > 65) {
    decision = 'DOWN';
    confidence += 15;
    reasons.push(`RSI ${asset} sobrecomprado (${rsi})`);
  } else {
    reasons.push(`RSI ${asset} neutral (${rsi})`);
  }

  if (isBullish) {
    if (decision === 'UP') confidence += 10;
    reasons.push(`EMA(${fastPeriod}) > EMA(${slowPeriod}) alcista`);
  } else {
    if (decision === 'DOWN') confidence += 10;
    reasons.push(`EMA(${fastPeriod}) < EMA(${slowPeriod}) bajista`);
  }

  const threshold = asset === 'BTC' ? 10 : asset === 'ETH' ? 2 : 0.3;
  if (distDollars > threshold) {
    if (decision === 'UP') confidence += 8;
    reasons.push(`${asset} cotiza +$${distDollars} sobre el strike`);
  } else if (distDollars < -threshold) {
    if (decision === 'DOWN') confidence += 8;
    reasons.push(`${asset} cotiza -$${Math.abs(distDollars)} bajo el strike`);
  }

  if (rsi >= 35 && rsi <= 65) {
    decision = isBullish ? 'UP' : 'DOWN';
  }

  confidence = Math.min(94, Math.max(58, confidence));

  const sigKey = `${asset}_${timeframe}`;
  const signal = {
    asset,
    timeframe,
    timestamp: new Date().toISOString(),
    decision,
    confidence,
    spot,
    strike,
    distPercent,
    distDollars,
    rsi,
    emaFast,
    emaSlow,
    trend,
    reasons: reasons.join(' • ')
  };

  simState.lastSignals[sigKey] = signal;
  return signal;
}

// ============================================================================
// 5. EJECUTOR DE OPERACIONES
// ============================================================================
async function executeSimulatedTrade({
  asset = 'BTC',
  timeframe = '15M',
  ticker,
  title,
  openTime,
  closeTime,
  strike,
  signal,
  rawPrice = 0.50
}) {
  const shares = simState.sharesPerTrade || 5;
  const decision = signal.decision;

  rawPrice = Math.max(0.05, Math.min(0.95, rawPrice));
  const feeEstimate = Number(Math.max(0.01, (0.07 * rawPrice * (1 - rawPrice) * shares)).toFixed(2));
  const totalCost = Number((rawPrice * shares).toFixed(2));
  const totalInvested = Number((totalCost + feeEstimate).toFixed(2));

  const trade = {
    id: `trade-${asset}-${timeframe}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    asset,
    timeframe,
    ticker,
    title,
    openTime,
    closeTime,
    strike: Number(strike.toFixed(2)),
    spotAtEntry: signal.spot,
    decision,
    confidence: signal.confidence,
    indicators: {
      rsi: signal.rsi,
      trend: signal.trend,
      distDollars: signal.distDollars
    },
    reasoning: signal.reasons,
    shares,
    pricePerShare: rawPrice,
    totalCost,
    fee: feeEstimate,
    totalInvested,
    potentialPayout: Number((shares * 1.00).toFixed(2)),
    status: 'OPEN',
    settlementPrice: null,
    result: null,
    payout: 0,
    netProfit: 0,
    executedAt: new Date().toISOString()
  };

  simState.bankroll = Number((simState.bankroll - totalInvested).toFixed(2));
  simState.trades.unshift(trade);
  saveSimulationState();

  console.log(`[SIM] 🎯 [${asset} | ${timeframe}] Operación abierta: ${decision} en ${ticker} | Strike $${strike.toLocaleString()} | Invertido: $${totalInvested} USD`);
  return trade;
}

function getCycleWindow(asset, timeframe, now = new Date()) {
  if (timeframe === '15M') {
    const mins = now.getUTCMinutes();
    const cycleMin = Math.floor(mins / 15) * 15;
    const start = new Date(now);
    start.setUTCMinutes(cycleMin, 0, 0);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    return {
      asset,
      timeframe,
      ticker: `${asset}-15M-${end.toISOString().slice(11, 16).replace(':', '')}`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }

  if (timeframe === '1H') {
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      asset,
      timeframe,
      ticker: `${asset}-1H-${end.toISOString().slice(11, 13)}00`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }

  if (timeframe === '4H') {
    const hours = now.getUTCHours();
    const cycleHour = Math.floor(hours / 4) * 4;
    const start = new Date(now);
    start.setUTCHours(cycleHour, 0, 0, 0);
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    return {
      asset,
      timeframe,
      ticker: `${asset}-4H-${end.toISOString().slice(11, 13)}00`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }

  if (timeframe === '1D') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return {
      asset,
      timeframe,
      ticker: `${asset}-1D-${end.toISOString().slice(0, 10)}`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }
}

// ============================================================================
// 6. LIQUIDADOR Y BUCLE AUTÓNOMO
// ============================================================================
let isLoopRunning = false;

async function checkSettlements() {
  const openTrades = simState.trades.filter(t => t.status === 'OPEN');
  if (openTrades.length === 0) return;

  const now = new Date();

  for (const trade of openTrades) {
    const closeDate = new Date(trade.closeTime);
    if (now >= closeDate) {
      const spot = await getLiveSpot(trade.asset || 'BTC');

      // Si es un ticker nativo de Kalshi (KXBTC15M, KXETH15M, KXSOL15M)
      if (trade.ticker.startsWith('KX')) {
        const market = await getKalshiSingleMarket(trade.ticker);
        if (market && (market.result === 'yes' || market.result === 'no')) {
          finalizeTrade(trade, market.result.toLowerCase(), market.expiration_value ? parseFloat(market.expiration_value) : spot);
          continue;
        }
      }

      // Benchmark settlement para 1H, 4H, 1D
      const finalPrice = spot;
      const result = finalPrice >= trade.strike ? 'yes' : 'no';
      finalizeTrade(trade, result, finalPrice);
    }
  }
}

function finalizeTrade(trade, result, settlementPrice) {
  trade.settlementPrice = settlementPrice;
  trade.result = result;
  trade.settledAt = new Date().toISOString();

  const won = (trade.decision === 'UP' && result === 'yes') ||
              (trade.decision === 'DOWN' && result === 'no');

  if (won) {
    trade.status = 'WON';
    trade.payout = trade.potentialPayout;
    trade.netProfit = Number((trade.payout - trade.totalInvested).toFixed(2));
    simState.bankroll = Number((simState.bankroll + trade.payout).toFixed(2));
  } else {
    trade.status = 'LOST';
    trade.payout = 0;
    trade.netProfit = Number((-trade.totalInvested).toFixed(2));
  }

  console.log(`[SIM] 🏁 [${trade.asset} | ${trade.timeframe}] Liquidado: ${trade.ticker} | Strike $${trade.strike} vs $${settlementPrice} | ${trade.status} (${trade.netProfit >= 0 ? '+' : ''}$${trade.netProfit} USD)`);
  saveSimulationState();
}

async function runAutonomousSimulationCycle() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  try {
    await checkSettlements();

    const now = new Date();

    for (const asset of ASSETS) {
      const cfg = ASSET_CONFIG[asset];
      const spot = await getLiveSpot(asset);

      // 1. Serie Oficial Kalshi 15M (KXBTC15M, KXETH15M, KXSOL15M)
      const markets15m = await getKalshi15mMarkets(cfg.kalshi15mSeries);
      const active15m = markets15m.find(m => {
        const closeDate = new Date(m.close_time);
        const openDate = new Date(m.open_time);
        return (m.status === 'active' || (now >= openDate && now < closeDate)) && (closeDate - now) > 45000;
      });

      if (active15m) {
        const existing = simState.trades.find(t => t.ticker === active15m.ticker);
        if (!existing) {
          const strikeVal = active15m.floor_strike || spot;
          const signal = await evaluateSignal(asset, '15M', strikeVal);
          let ask = signal.decision === 'UP'
            ? (parseFloat(active15m.yes_ask_dollars) || 0.50)
            : (parseFloat(active15m.no_ask_dollars) || 0.50);

          await executeSimulatedTrade({
            asset,
            timeframe: '15M',
            ticker: active15m.ticker,
            title: `${asset} price up in next 15 mins?`,
            openTime: active15m.open_time,
            closeTime: active15m.close_time,
            strike: strikeVal,
            signal,
            rawPrice: ask
          });
        }
      }

      // 2. Temporalidades 1H, 4H, 1D
      for (const tf of ['1H', '4H', '1D']) {
        const cycle = getCycleWindow(asset, tf, now);
        const existing = simState.trades.find(t => t.asset === asset && t.timeframe === tf && t.ticker === cycle.ticker);

        if (!existing) {
          const timeLeftSec = (new Date(cycle.closeTime) - now) / 1000;
          const maxDurationSec = tf === '1H' ? 3600 : tf === '4H' ? 14400 : 86400;
          if (timeLeftSec > maxDurationSec * 0.15) {
            const signal = await evaluateSignal(asset, tf, spot);
            await executeSimulatedTrade({
              asset,
              timeframe: tf,
              ticker: cycle.ticker,
              title: `${asset} Up/Down en ventana de ${tf}`,
              openTime: cycle.openTime,
              closeTime: cycle.closeTime,
              strike: spot,
              signal,
              rawPrice: 0.50
            });
          }
        }
      }
    }

  } catch (err) {
    console.error('[SIM] Error en bucle multi-cripto:', err.message);
  } finally {
    isLoopRunning = false;
  }
}

setInterval(runAutonomousSimulationCycle, 12000);
setTimeout(runAutonomousSimulationCycle, 1500);

// ============================================================================
// 7. SERVIDOR HTTP & REST APIS
// ============================================================================
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // --- API: Estado General ---
  if (pathname === '/api/status') {
    const btcSpot = await getLiveSpot('BTC');
    const ethSpot = await getLiveSpot('ETH');
    const solSpot = await getLiveSpot('SOL');
    const now = new Date();

    // Desglose por Activo
    const byAsset = {};
    ASSETS.forEach(a => {
      const aTrades = simState.trades.filter(t => (t.asset || 'BTC') === a);
      const settled = aTrades.filter(t => t.status !== 'OPEN');
      const won = settled.filter(t => t.status === 'WON');
      const lost = settled.filter(t => t.status === 'LOST');
      const open = aTrades.filter(t => t.status === 'OPEN');
      const pnl = Number(settled.reduce((acc, t) => acc + t.netProfit, 0).toFixed(2));
      const winRate = settled.length > 0 ? Number(((won.length / settled.length) * 100).toFixed(1)) : 0;

      byAsset[a] = {
        name: ASSET_CONFIG[a].name,
        color: ASSET_CONFIG[a].color,
        spot: a === 'BTC' ? btcSpot : a === 'ETH' ? ethSpot : solSpot,
        total: aTrades.length,
        settled: settled.length,
        won: won.length,
        lost: lost.length,
        open: open.length,
        winRate,
        netPnl: pnl
      };
    });

    // Desglose por Temporalidad
    const byTimeframe = {};
    TIMEFRAMES.forEach(tf => {
      const tfTrades = simState.trades.filter(t => (t.timeframe || '15M') === tf);
      const settled = tfTrades.filter(t => t.status !== 'OPEN');
      const won = settled.filter(t => t.status === 'WON');
      const lost = settled.filter(t => t.status === 'LOST');
      const open = tfTrades.filter(t => t.status === 'OPEN');
      const pnl = Number(settled.reduce((acc, t) => acc + t.netProfit, 0).toFixed(2));
      const winRate = settled.length > 0 ? Number(((won.length / settled.length) * 100).toFixed(1)) : 0;
      const cycle = getCycleWindow('BTC', tf, now);
      const secondsLeft = Math.max(0, Math.floor((new Date(cycle.closeTime) - now) / 1000));

      byTimeframe[tf] = {
        total: tfTrades.length,
        settled: settled.length,
        won: won.length,
        lost: lost.length,
        open: open.length,
        winRate,
        netPnl: pnl,
        secondsLeft
      };
    });

    const allSettled = simState.trades.filter(t => t.status !== 'OPEN');
    const allWon = allSettled.filter(t => t.status === 'WON');
    const globalWinRate = allSettled.length > 0 ? Number(((allWon.length / allSettled.length) * 100).toFixed(1)) : 0;
    const globalNetPnl = Number((simState.bankroll - simState.initialBankroll).toFixed(2));
    const globalRoi = Number(((globalNetPnl / simState.initialBankroll) * 100).toFixed(1));

    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      success: true,
      spots: { BTC: btcSpot, ETH: ethSpot, SOL: solSpot },
      bankroll: simState.bankroll,
      initialBankroll: simState.initialBankroll,
      globalNetPnl,
      globalRoi,
      globalWinRate,
      totalTrades: simState.trades.length,
      settledCount: allSettled.length,
      openCount: simState.trades.filter(t => t.status === 'OPEN').length,
      sharesPerTrade: simState.sharesPerTrade,
      byAsset,
      byTimeframe,
      lastSignals: simState.lastSignals
    }));
  }

  // --- API: Listado de Operaciones ---
  if (pathname === '/api/trades') {
    const assetFilter = parsedUrl.query.asset;
    const tfFilter = parsedUrl.query.timeframe;

    let list = simState.trades;
    if (assetFilter && assetFilter !== 'ALL') {
      list = list.filter(t => (t.asset || 'BTC') === assetFilter);
    }
    if (tfFilter && tfFilter !== 'ALL') {
      list = list.filter(t => (t.timeframe || '15M') === tfFilter);
    }
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      success: true,
      trades: list
    }));
  }

  // --- API: Reiniciar Simulación ---
  if (pathname === '/api/reset' && req.method === 'POST') {
    simState = { ...DEFAULT_STATE };
    saveSimulationState();
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      success: true,
      message: 'Simulación reiniciada a $500.00 USD'
    }));
  }

  // Archivos estáticos
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log('================================================================');
  console.log(`🤖 SIMULADOR MULTI-CRIPTO (BTC • ETH • SOL) ACTIVO`);
  console.log(`🌐 Panel Web interactivo: http://localhost:${PORT}`);
  console.log(`📊 Activos: BTC, ETH, SOL | Temporalidades: 15M, 1H, 4H, 1D`);
  console.log('================================================================');

  // ============================================================================
  // KEEP-ALIVE PINGER (Evita que Render entre en modo reposo cada 15 min)
  // ============================================================================
  const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://kalshi-btc-simulator.onrender.com';
  setInterval(() => {
    try {
      const pingUrl = `${RENDER_EXTERNAL_URL}/api/status`;
      https.get(pingUrl, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          console.log(`[Keep-Alive] 💓 Ping a ${pingUrl} (HTTP ${res.statusCode}) - ${new Date().toLocaleTimeString('es-ES')}`);
        });
      }).on('error', (err) => {
        console.warn(`[Keep-Alive] Error en ping: ${err.message}`);
      });
    } catch (e) {
      console.warn(`[Keep-Alive] Excepción: ${e.message}`);
    }
  }, 4 * 60 * 1000); // Cada 4 minutos
});
