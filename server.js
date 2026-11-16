const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'trades.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ============================================================================
// 1. ESTADO DE SIMULACIÓN Y PERSISTENCIA MULTI-TEMPORALIDAD
// ============================================================================
const DEFAULT_STATE = {
  bankroll: 200.00,
  initialBankroll: 200.00,
  sharesPerTrade: 5,
  trades: [],
  lastSignals: {
    '15M': null,
    '1H': null,
    '4H': null,
    '1D': null
  }
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
        lastSignals: { ...DEFAULT_STATE.lastSignals, ...(loaded.lastSignals || {}) }
      };
    }
  } catch (err) {
    console.error('[SIM] Error leyendo trades.json, iniciando por defecto:', err.message);
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
// 2. CLIENTE HTTP HELPER PARA APIS PÚBLICAS
// ============================================================================
function fetchJson(targetUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) KalshiMultiSim/2.0',
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
// 3. DATOS DE MERCADO EN VIVO (BTC SPOT + VELAS 15M, 1H, 4H, 1D + KALSHI)
// ============================================================================
let cachedBtcSpot = 64500.00;
let cachedBtcSpotTime = 0;

async function getLiveBtcPrice() {
  if (Date.now() - cachedBtcSpotTime < 3000) {
    return cachedBtcSpot;
  }
  try {
    const data = await fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    if (data && data.data && data.data.amount) {
      cachedBtcSpot = parseFloat(data.data.amount);
      cachedBtcSpotTime = Date.now();
      return cachedBtcSpot;
    }
  } catch (err) {
    try {
      const bData = await fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
      if (bData && bData.price) {
        cachedBtcSpot = parseFloat(bData.price);
        cachedBtcSpotTime = Date.now();
        return cachedBtcSpot;
      }
    } catch (err2) {}
  }
  return cachedBtcSpot;
}

async function getBinanceKlines(interval = '15m') {
  try {
    const raw = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=35`);
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
    console.warn(`[SIM] Error obteniendo velas ${interval} de Binance:`, err.message);
  }
  return [];
}

async function getKalshiBtc15mMarkets() {
  try {
    const json = await fetchJson('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M');
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
// 4. MOTOR CUANTITATIVO: INDICADORES TÉCNICOS & DECISIÓN POR TEMPORALIDAD
// ============================================================================
function calculateRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50.0;
  let gains = 0;
  let losses = 0;

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

async function evaluateSignalForTimeframe(timeframe = '15M', customStrike = null) {
  const btcSpot = await getLiveBtcPrice();

  let binanceInterval = '15m';
  if (timeframe === '1H') binanceInterval = '1h';
  else if (timeframe === '4H') binanceInterval = '4h';
  else if (timeframe === '1D') binanceInterval = '1d';

  const klines = await getBinanceKlines(binanceInterval);
  const strike = customStrike !== null ? customStrike : btcSpot;
  const distPercent = strike ? Number(((btcSpot - strike) / strike * 100).toFixed(3)) : 0;
  const distDollars = strike ? Number((btcSpot - strike).toFixed(2)) : 0;

  let rsi = 50;
  let emaFast = btcSpot;
  let emaSlow = btcSpot;
  const fastPeriod = timeframe === '1D' ? 20 : 9;
  const slowPeriod = timeframe === '1D' ? 50 : 21;

  if (klines.length >= slowPeriod + 1) {
    const closes = klines.map(k => k.close);
    closes.push(btcSpot);
    rsi = calculateRsi(closes, 14);
    emaFast = calculateEma(closes, fastPeriod);
    emaSlow = calculateEma(closes, slowPeriod);
  }

  const isBullish = emaFast >= emaSlow;
  const trend = isBullish ? 'BULLISH (Alcista)' : 'BEARISH (Bajista)';

  let decision = 'UP';
  let confidence = 65;
  let reasons = [];

  // 1. RSI
  if (rsi < 35) {
    decision = 'UP';
    confidence += 15;
    reasons.push(`RSI ${timeframe} sobrevendido (${rsi}) con potencial rebote`);
  } else if (rsi > 65) {
    decision = 'DOWN';
    confidence += 15;
    reasons.push(`RSI ${timeframe} sobrecomprado (${rsi}) con presión bajista`);
  } else {
    reasons.push(`RSI ${timeframe} neutral (${rsi})`);
  }

  // 2. Cruce de Medias Móviles
  if (isBullish) {
    if (decision === 'UP') confidence += 10;
    reasons.push(`EMA(${fastPeriod}) > EMA(${slowPeriod}) confirmando tendencia alcista`);
  } else {
    if (decision === 'DOWN') confidence += 10;
    reasons.push(`EMA(${fastPeriod}) < EMA(${slowPeriod}) confirmando tendencia bajista`);
  }

  // 3. Distancia con respecto al Strike inicial
  if (distDollars > 10) {
    if (decision === 'UP') confidence += 8;
    reasons.push(`BTC cotiza $${distDollars > 0 ? '+' : ''}${distDollars} sobre el strike ($${strike.toLocaleString()})`);
  } else if (distDollars < -10) {
    if (decision === 'DOWN') confidence += 8;
    reasons.push(`BTC cotiza $${distDollars} por debajo del strike ($${strike.toLocaleString()})`);
  }

  // Si no hay sobrecompra/sobreventa extrema, la tendencia de medias manda
  if (rsi >= 35 && rsi <= 65) {
    decision = isBullish ? 'UP' : 'DOWN';
  }

  confidence = Math.min(94, Math.max(58, confidence));

  const signal = {
    timeframe,
    timestamp: new Date().toISOString(),
    decision, // 'UP' o 'DOWN'
    confidence,
    btcSpot,
    strike,
    distPercent,
    distDollars,
    rsi,
    emaFast,
    emaSlow,
    trend,
    reasons: reasons.join(' • ')
  };

  simState.lastSignals[timeframe] = signal;
  return signal;
}

// ============================================================================
// 5. EJECUTOR DE OPERACIONES MULTI-TEMPORALIDAD
// ============================================================================
async function executeSimulatedTrade({
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
  // Comisión oficial CFTC de Kalshi
  const feeEstimate = Number(Math.max(0.01, (0.07 * rawPrice * (1 - rawPrice) * shares)).toFixed(2));
  const totalCost = Number((rawPrice * shares).toFixed(2));
  const totalInvested = Number((totalCost + feeEstimate).toFixed(2));

  const trade = {
    id: `trade-${timeframe}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
    timeframe,
    ticker,
    title,
    openTime,
    closeTime,
    strike: Number(strike.toFixed(2)),
    btcAtEntry: signal.btcSpot,
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

  console.log(`[SIM] 🎯 [${timeframe}] Operación abierta: ${decision} en ${ticker} | Strike $${strike.toLocaleString()} | 5 acc a ${(rawPrice*100).toFixed(1)}¢ | Invertido: $${totalInvested} USD`);
  return trade;
}

// ============================================================================
// 6. GESTOR DE VENTANAS TEMPORALES (15M, 1H, 4H, 1D)
// ============================================================================
function getCycleWindow(timeframe, now = new Date()) {
  const ms = now.getTime();
  let startMs, endMs, label;

  if (timeframe === '15M') {
    const mins = now.getUTCMinutes();
    const cycleMin = Math.floor(mins / 15) * 15;
    const start = new Date(now);
    start.setUTCMinutes(cycleMin, 0, 0);
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    return {
      timeframe,
      ticker: `BTC-15M-${end.toISOString().slice(11, 16).replace(':', '')}`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }

  if (timeframe === '1H') {
    const start = new Date(now);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      timeframe,
      ticker: `BTC-1H-${end.toISOString().slice(11, 13)}00`,
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
      timeframe,
      ticker: `BTC-4H-${end.toISOString().slice(11, 13)}00`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }

  if (timeframe === '1D') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return {
      timeframe,
      ticker: `BTC-1D-${end.toISOString().slice(0, 10)}`,
      openTime: start.toISOString(),
      closeTime: end.toISOString()
    };
  }
}

// ============================================================================
// 7. BUCLE AUTÓNOMO PRINCIPAL (MULTI-TEMPORALIDAD)
// ============================================================================
let isLoopRunning = false;

async function checkSettlements() {
  const openTrades = simState.trades.filter(t => t.status === 'OPEN');
  if (openTrades.length === 0) return;

  const now = new Date();
  const btcSpot = await getLiveBtcPrice();

  for (const trade of openTrades) {
    const closeDate = new Date(trade.closeTime);
    if (now >= closeDate) {
      // 1. Si es de la serie oficial KXBTC15M, intentamos consultar Kalshi directamente
      if (trade.ticker.startsWith('KXBTC15M')) {
        const market = await getKalshiSingleMarket(trade.ticker);
        if (market && (market.result === 'yes' || market.result === 'no')) {
          finalizeTrade(trade, market.result.toLowerCase(), market.expiration_value ? parseFloat(market.expiration_value) : btcSpot);
          continue;
        }
      }

      // 2. Para temporalidades 1H, 4H, 1D (o si Kalshi tarda en publicar), liquidamos con el precio benchmark de BTC al cierre
      const finalPrice = btcSpot;
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

  console.log(`[SIM] 🏁 [${trade.timeframe}] Liquidado: ${trade.ticker} | Strike: $${trade.strike} vs Final: $${settlementPrice} | ${trade.status} (${trade.netProfit >= 0 ? '+' : ''}$${trade.netProfit} USD)`);
  saveSimulationState();
}

async function runAutonomousSimulationCycle() {
  if (isLoopRunning) return;
  isLoopRunning = true;

  try {
    // 1. Liquidar operaciones vencidas
    await checkSettlements();

    const now = new Date();
    const btcSpot = await getLiveBtcPrice();

    // 2. Procesar 15M (Serie oficial Kalshi KXBTC15M)
    const markets15m = await getKalshiBtc15mMarkets();
    const active15m = markets15m.find(m => {
      const closeDate = new Date(m.close_time);
      const openDate = new Date(m.open_time);
      return (m.status === 'active' || (now >= openDate && now < closeDate)) && (closeDate - now) > 45000;
    });

    if (active15m) {
      const existing = simState.trades.find(t => t.ticker === active15m.ticker);
      if (!existing) {
        const signal = await evaluateSignalForTimeframe('15M', active15m.floor_strike || btcSpot);
        let ask = signal.decision === 'UP'
          ? (parseFloat(active15m.yes_ask_dollars) || 0.50)
          : (parseFloat(active15m.no_ask_dollars) || 0.50);

        await executeSimulatedTrade({
          timeframe: '15M',
          ticker: active15m.ticker,
          title: 'BTC price up in next 15 mins?',
          openTime: active15m.open_time,
          closeTime: active15m.close_time,
          strike: active15m.floor_strike || btcSpot,
          signal,
          rawPrice: ask
        });
      }
    }

    // 3. Procesar temporalidades 1H, 4H, 1D
    const timeframes = ['1H', '4H', '1D'];
    for (const tf of timeframes) {
      const cycle = getCycleWindow(tf, now);
      const existing = simState.trades.find(t => t.timeframe === tf && t.ticker === cycle.ticker);

      if (!existing) {
        const timeLeftSec = (new Date(cycle.closeTime) - now) / 1000;
        // Si la ventana acaba de iniciar o le queda al menos 70% de tiempo
        const maxDurationSec = tf === '1H' ? 3600 : tf === '4H' ? 14400 : 86400;
        if (timeLeftSec > maxDurationSec * 0.15) {
          const signal = await evaluateSignalForTimeframe(tf, btcSpot);
          const price = 0.50; // Probabilidad de partida ATM al inicio de la ventana
          await executeSimulatedTrade({
            timeframe: tf,
            ticker: cycle.ticker,
            title: `BTC Up/Down en ventana de ${tf}`,
            openTime: cycle.openTime,
            closeTime: cycle.closeTime,
            strike: btcSpot,
            signal,
            rawPrice: price
          });
        }
      }
    }

  } catch (err) {
    console.error('[SIM] Error en bucle multi-temporalidad:', err.message);
  } finally {
    isLoopRunning = false;
  }
}

// Bucle continuo cada 12 segundos
setInterval(runAutonomousSimulationCycle, 12000);
setTimeout(runAutonomousSimulationCycle, 1500);

// ============================================================================
// 8. SERVIDOR HTTP & REST APIS
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

  // --- API: Estado General & Métricas por Temporalidad ---
  if (pathname === '/api/status') {
    const btcSpot = await getLiveBtcPrice();
    const now = new Date();

    const tfStats = {};
    ['15M', '1H', '4H', '1D'].forEach(tf => {
      const tfTrades = simState.trades.filter(t => (t.timeframe || '15M') === tf);
      const settled = tfTrades.filter(t => t.status !== 'OPEN');
      const won = settled.filter(t => t.status === 'WON');
      const lost = settled.filter(t => t.status === 'LOST');
      const open = tfTrades.filter(t => t.status === 'OPEN');
      const pnl = Number(settled.reduce((acc, t) => acc + t.netProfit, 0).toFixed(2));
      const winRate = settled.length > 0 ? Number(((won.length / settled.length) * 100).toFixed(1)) : 0;
      const cycle = getCycleWindow(tf, now);
      const secondsLeft = Math.max(0, Math.floor((new Date(cycle.closeTime) - now) / 1000));

      tfStats[tf] = {
        total: tfTrades.length,
        settled: settled.length,
        won: won.length,
        lost: lost.length,
        open: open.length,
        winRate,
        netPnl: pnl,
        secondsLeft,
        currentCycle: cycle.ticker,
        lastSignal: simState.lastSignals[tf]
      };
    });

    const allSettled = simState.trades.filter(t => t.status !== 'OPEN');
    const allWon = allSettled.filter(t => t.status === 'WON');
    const globalWinRate = allSettled.length > 0 ? Number(((allWon.length / allSettled.length) * 100).toFixed(1)) : 0;
    const globalNetPnl = Number((simState.bankroll - simState.initialBankroll).toFixed(2));
    const globalRoi = Number(((globalNetPnl / simState.initialBankroll) * 100).toFixed(1));

    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      success: true,
      btcSpot,
      bankroll: simState.bankroll,
      initialBankroll: simState.initialBankroll,
      globalNetPnl,
      globalRoi,
      globalWinRate,
      totalTrades: simState.trades.length,
      settledCount: allSettled.length,
      openCount: simState.trades.filter(t => t.status === 'OPEN').length,
      sharesPerTrade: simState.sharesPerTrade,
      timeframes: tfStats
    }));
  }

  // --- API: Listado de Operaciones ---
  if (pathname === '/api/trades') {
    const tfFilter = parsedUrl.query.timeframe;
    let list = simState.trades;
    if (tfFilter && tfFilter !== 'ALL') {
      list = list.filter(t => t.timeframe === tfFilter);
    }
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      success: true,
      trades: list
    }));
  }

  // --- API: Forzar Análisis y Operación Inmediata ---
  if (pathname === '/api/force-trade' && req.method === 'POST') {
    try {
      const tf = parsedUrl.query.timeframe || '15M';
      const btcSpot = await getLiveBtcPrice();
      const cycle = getCycleWindow(tf, new Date());
      const signal = await evaluateSignalForTimeframe(tf, btcSpot);
      const trade = await executeSimulatedTrade({
        timeframe: tf,
        ticker: `${cycle.ticker}-MANUAL`,
        title: `Manual BTC ${tf} Trade`,
        openTime: cycle.openTime,
        closeTime: cycle.closeTime,
        strike: btcSpot,
        signal,
        rawPrice: 0.50
      });
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: true,
        trade
      }));
    } catch (e) {
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        success: false,
        error: e.message
      }));
    }
  }

  // --- API: Reiniciar Simulación ---
  if (pathname === '/api/reset' && req.method === 'POST') {
    simState = { ...DEFAULT_STATE };
    saveSimulationState();
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      success: true,
      message: 'Simulación reiniciada a $200.00 USD'
    }));
  }

  // Servir archivos estáticos
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
  console.log(`🤖 SIMULADOR KALSHI BTC MULTI-TEMPORALIDAD ACTIVO`);
  console.log(`🌐 Panel Web interactivo: http://localhost:${PORT}`);
  console.log(`📊 Temporalidades: 15 Minutos, 1 Hora, 4 Horas y Diario`);
  console.log('================================================================');
});
