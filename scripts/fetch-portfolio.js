import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const OUTPUT_PATH = 'data/portfolio-latest.json';
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

// Twelve Data — US equities & ETFs (batched in one API call)
const TD_TICKERS = [
  'USB', 'MET', 'META', 'PRU', 'BRK.B', 'BAC', 'SO', 'TTE', 'VZ',
  'O', 'CCI', 'SNDK', 'JEPI', 'TLT', 'SHY', 'IJS', 'XLK', 'IBIT',
  'VT', 'GLD', 'DIVO', 'SCHD',
];

// Stooq — Brazilian equities [stooq_symbol, normalized_key]
const STOOQ_TICKERS = [
  ['bbas3.sa',  'BBAS3'],
  ['brap4.sa',  'BRAP4'],
  ['cpfe3.sa',  'CPFE3'],
  ['jbss3.sa',  'JBSS3'],
  ['klbn3.sa',  'KLBN3'],
  ['sanb11.sa', 'SANB11'],
  ['sapr4.sa',  'SAPR4'],
];

function loadPrevious() {
  try {
    if (!existsSync(OUTPUT_PATH)) return {};
    return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')).prices || {};
  } catch { return {}; }
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const headers = lines[0].split(',').map(h => h.trim());
  const values  = lines[1].split(',').map(v => v.trim());
  const row = {};
  headers.forEach((h, i) => { row[h] = values[i]; });
  return row;
}

async function fetchStooqQuote(sym) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const row = parseCSV(await res.text());
  if (!row || !row.Close || row.Close === 'N/D') throw new Error('no data');
  return { close: parseFloat(row.Close), timestamp: `${row.Date}T${row.Time}Z` };
}

async function fetchStooqPrevClose(sym) {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).trim().split('\n');
  if (lines.length < 3) throw new Error('not enough history');
  const headers = lines[0].split(',').map(h => h.trim());
  const closeIdx = headers.findIndex(h => h === 'Close');
  const prevClose = parseFloat(lines[lines.length - 2].split(',')[closeIdx]);
  if (isNaN(prevClose)) throw new Error('invalid previous close');
  return prevClose;
}

async function fetchOneStooq(stooqSym, key, prev, errors) {
  const prevData = prev[key] || null;
  try {
    const [quoteRes, histRes] = await Promise.allSettled([
      fetchStooqQuote(stooqSym),
      fetchStooqPrevClose(stooqSym),
    ]);
    if (quoteRes.status !== 'fulfilled') throw new Error(quoteRes.reason?.message || 'quote failed');
    const value     = quoteRes.value.close;
    const timestamp = quoteRes.value.timestamp;
    let previous_close = null, change_abs = null, change_pct = null;
    if (histRes.status === 'fulfilled') {
      previous_close = histRes.value;
      change_abs = value - previous_close;
      change_pct = (change_abs / previous_close) * 100;
    } else if (prevData?.value) {
      previous_close = prevData.value;
      change_abs = value - previous_close;
      change_pct = (change_abs / previous_close) * 100;
    }
    return { symbol: key, source: 'stooq', value, change_pct, change_abs, previous_close, timestamp };
  } catch (err) {
    errors.push(`${key}: ${err.message}`);
    return prevData;
  }
}

async function fetchTwelveDataBatch(tickers, prev, errors) {
  const results = {};
  if (!TWELVEDATA_API_KEY) {
    tickers.forEach(t => errors.push(`${t}: TWELVEDATA_API_KEY not set`));
    tickers.forEach(t => { if (prev[t]) results[t] = prev[t]; });
    return results;
  }
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tickers.join(','))}&apikey=${TWELVEDATA_API_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    // Single ticker: Twelve Data returns the object directly; multi: keyed by symbol
    const raw = tickers.length === 1 ? { [tickers[0]]: json } : json;
    for (const ticker of tickers) {
      const d = raw[ticker];
      if (!d || d.status === 'error' || !d.close) {
        errors.push(`${ticker}: ${d?.message || 'no data'}`);
        if (prev[ticker]) results[ticker] = prev[ticker];
        continue;
      }
      const value          = parseFloat(d.close);
      const previous_close = parseFloat(d.previous_close);
      const change_abs     = parseFloat(d.change);
      const change_pct     = parseFloat(d.percent_change);
      results[ticker] = {
        symbol:         d.symbol || ticker,
        source:         'twelvedata',
        value,
        change_pct:     isNaN(change_pct)     ? null : change_pct,
        change_abs:     isNaN(change_abs)     ? null : change_abs,
        previous_close: isNaN(previous_close) ? null : previous_close,
        timestamp:      d.datetime ? d.datetime + 'Z' : new Date().toISOString(),
      };
    }
  } catch (err) {
    errors.push(`twelvedata-batch: ${err.message}`);
    tickers.forEach(t => { if (prev[t]) results[t] = prev[t]; });
  }
  return results;
}

async function fetchBTC(prev, errors) {
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true';
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json    = await res.json();
    const value   = json.bitcoin.usd;
    const change_pct = json.bitcoin.usd_24h_change;
    const change_abs = (value * change_pct) / 100;
    return {
      symbol:         'BTC',
      source:         'coingecko',
      value,
      change_pct,
      change_abs,
      previous_close: value - change_abs,
      timestamp:      new Date().toISOString(),
    };
  } catch (err) {
    errors.push(`BTC: ${err.message}`);
    return prev['BTC'] || null;
  }
}

async function main() {
  const prev   = loadPrevious();
  const errors = [];
  const prices = {};

  // Twelve Data batch — all US tickers in one request
  const tdResults = await fetchTwelveDataBatch(TD_TICKERS, prev, errors);
  Object.assign(prices, tdResults);

  // Stooq BR + CoinGecko BTC — in parallel
  await Promise.allSettled([
    ...STOOQ_TICKERS.map(([sym, key]) =>
      fetchOneStooq(sym, key, prev, errors).then(r => { if (r) prices[key] = r; })
    ),
    fetchBTC(prev, errors).then(r => { if (r) prices['BTC'] = r; }),
  ]);

  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(next.getUTCHours() + 6);

  const output = { generated_at: now.toISOString(), next_update: next.toISOString(), prices, errors };

  if (!existsSync('data')) mkdirSync('data', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const total = TD_TICKERS.length + STOOQ_TICKERS.length + 1;
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Tickers OK: ${Object.keys(prices).length}/${total}`);
  if (errors.length) { console.log(`Errors (${errors.length}):`); errors.forEach(e => console.log(' -', e)); }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
