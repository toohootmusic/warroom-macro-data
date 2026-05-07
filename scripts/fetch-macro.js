import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUTPUT_PATH = 'data/macro-latest.json';
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const STOOQ_SYMBOLS = {
  brent:  { symbol: 'cb.f',   name: 'Brent Crude' },
  sp500:  { symbol: '^spx',   name: 'S&P 500' },
  dxy:    { symbol: 'dx.f',   name: 'DXY' },
  usdbrl: { symbol: 'usdbrl', name: 'USD/BRL' },
  ibov:   { symbol: '^bvp',   name: 'IBOV' },
};

function loadPrevious() {
  try {
    if (!existsSync(OUTPUT_PATH)) return {};
    const raw = readFileSync(OUTPUT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.data || {};
  } catch {
    return {};
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split(',');
  const values = lines[1].split(',');
  const row = {};
  headers.forEach((h, i) => row[h.trim()] = values[i]?.trim());
  return row;
}

async function fetchStooqQuote(symbol) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const row = parseCSV(text);
  if (!row || !row.Close || row.Close === 'N/D') throw new Error('No data');
  return {
    close: parseFloat(row.Close),
    timestamp: `${row.Date}T${row.Time}Z`,
  };
}

async function fetchStooqHistory(symbol) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 3) throw new Error('Not enough history');
  const prevLine = lines[lines.length - 2].split(',');
  const headers = lines[0].split(',');
  const closeIdx = headers.findIndex(h => h.trim() === 'Close');
  const prevClose = parseFloat(prevLine[closeIdx]);
  if (isNaN(prevClose)) throw new Error('Invalid previous close');
  return prevClose;
}

async function fetchOneStooq(key, prev, errors) {
  const { symbol, name } = STOOQ_SYMBOLS[key];
  const previousData = prev[key] || null;
  try {
    const [quoteResult, historyResult] = await Promise.allSettled([
      fetchStooqQuote(symbol),
      fetchStooqHistory(symbol),
    ]);
    if (quoteResult.status !== 'fulfilled') {
      throw new Error(quoteResult.reason?.message || 'quote failed');
    }
    const value = quoteResult.value.close;
    const timestamp = quoteResult.value.timestamp;
    let previous_close = null;
    let change_abs = null;
    let change_pct = null;
    if (historyResult.status === 'fulfilled') {
      previous_close = historyResult.value;
      change_abs = value - previous_close;
      change_pct = (change_abs / previous_close) * 100;
    } else if (previousData?.value) {
      previous_close = previousData.value;
      change_abs = value - previous_close;
      change_pct = (change_abs / previous_close) * 100;
    }
    return {
      symbol,
      name,
      value,
      change_pct,
      change_abs,
      previous_close,
      timestamp,
    };
  } catch (err) {
    errors.push(`${key}: ${err.message}`);
    return previousData;
  }
}

async function fetchVixTwelveData(prev, errors) {
  const previousData = prev.vix || null;
  if (!TWELVEDATA_API_KEY) {
    errors.push('vix: TWELVEDATA_API_KEY not set');
    return previousData;
  }
  try {
    const url = `https://api.twelvedata.com/quote?symbol=VIX&apikey=${TWELVEDATA_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status === 'error') throw new Error(json.message || 'twelvedata error');
    if (!json.close) throw new Error('No close value');
    const value = parseFloat(json.close);
    const previous_close = parseFloat(json.previous_close);
    const change_abs = parseFloat(json.change);
    const change_pct = parseFloat(json.percent_change);
    return {
      symbol: 'VIX',
      name: 'VIX',
      value,
      change_pct: isNaN(change_pct) ? null : change_pct,
      change_abs: isNaN(change_abs) ? null : change_abs,
      previous_close: isNaN(previous_close) ? null : previous_close,
      timestamp: json.datetime ? `${json.datetime}Z` : new Date().toISOString(),
    };
  } catch (err) {
    errors.push(`vix: ${err.message}`);
    return previousData;
  }
}

async function fetchBTC(prev, errors) {
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const value = json.bitcoin.usd;
    const change_pct = json.bitcoin.usd_24h_change;
    const change_abs = (value * change_pct) / 100;
    const previous_close = value - change_abs;
    return {
      symbol: 'BTC-USD',
      name: 'Bitcoin',
      value,
      change_pct,
      change_abs,
      previous_close,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    errors.push(`coingecko: ${err.message}`);
    return prev.btc || null;
  }
}

async function main() {
  const prev = loadPrevious();
  const errors = [];
  const stooqKeys = Object.keys(STOOQ_SYMBOLS);
  const stooqResults = await Promise.all(
    stooqKeys.map(k => fetchOneStooq(k, prev, errors))
  );
  const vixResult = await fetchVixTwelveData(prev, errors);
  const btcResult = await fetchBTC(prev, errors);
  const data = {};
  stooqKeys.forEach((k, i) => {
    if (stooqResults[i]) data[k] = stooqResults[i];
  });
  if (vixResult) data.vix = vixResult;
  if (btcResult) data.btc = btcResult;
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(next.getUTCHours() + 6);
  const output = {
    generated_at: now.toISOString(),
    next_update: next.toISOString(),
    data,
    errors,
  };
  const dir = dirname(OUTPUT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Symbols OK: ${Object.keys(data).length}`);
  console.log(`Errors: ${errors.length}`);
  if (errors.length) console.log(errors);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
