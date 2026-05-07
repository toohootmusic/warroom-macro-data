#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = `${__dirname}/../data/macro-latest.json`;

const STOOQ_ASSETS = {
  brent:  { symbol: 'cb.f',   name: 'Brent Crude Oil' },
  sp500:  { symbol: '^spx',   name: 'S&P 500' },
  vix:    { symbol: '^vix',   name: 'CBOE Volatility Index' },
  dxy:    { symbol: '^dxy',   name: 'US Dollar Index' },
  usdbrl: { symbol: 'usdbrl', name: 'USD/BRL' },
  ibov:   { symbol: '^bvsp',  name: 'Ibovespa' },
};

const STOOQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; macro-bot/1.0)',
  'Accept': 'text/csv,*/*',
};

function loadPrevious() {
  try {
    const raw = readFileSync(OUTPUT_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.data || {};
  } catch {
    return {};
  }
}

function parseCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
  });
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: STOOQ_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchStooqAsset(key, prev, errors) {
  const { symbol, name } = STOOQ_ASSETS[key];
  const quoteUrl   = `https://stooq.com/q/l/?s=${symbol}&f=sd2t2ohlcv&h&e=csv`;
  const historyUrl = `https://stooq.com/q/d/l/?s=${symbol}&i=d`;

  // fetch current quote and history in parallel
  const [quoteResult, histResult] = await Promise.allSettled([
    fetchText(quoteUrl),
    fetchText(historyUrl),
  ]);

  if (quoteResult.status === 'rejected') {
    errors.push(`stooq[${symbol}] quote: ${quoteResult.reason.message}`);
    return prev[key] ?? null;
  }

  const quoteRows = parseCSV(quoteResult.value);
  if (!quoteRows.length) {
    errors.push(`stooq[${symbol}]: empty quote response`);
    return prev[key] ?? null;
  }

  const row = quoteRows[0];
  const value = row.Close !== undefined ? parseFloat(row.Close) : null;
  if (value === null || isNaN(value)) {
    errors.push(`stooq[${symbol}]: invalid Close value`);
    return prev[key] ?? null;
  }

  // build timestamp from Date + Time columns
  let timestamp = null;
  if (row.Date) {
    const iso = row.Time ? `${row.Date}T${row.Time}Z` : `${row.Date}T00:00:00Z`;
    timestamp = new Date(iso).toISOString();
  }

  // derive previous_close from penultimate history row
  let previousClose = null;
  if (histResult.status === 'fulfilled') {
    const histRows = parseCSV(histResult.value);
    // rows are ascending by date; penultimate = second-to-last
    if (histRows.length >= 2) {
      const pen = parseFloat(histRows[histRows.length - 2].Close);
      if (!isNaN(pen)) previousClose = pen;
    }
  } else {
    errors.push(`stooq[${symbol}] history: ${histResult.reason.message}`);
    // fall back to stored previous_close if available
    previousClose = prev[key]?.previous_close ?? null;
  }

  const changeAbs = previousClose !== null ? value - previousClose : null;
  const changePct = previousClose !== null && previousClose !== 0
    ? (changeAbs / previousClose) * 100
    : null;

  return { symbol, name, value, change_pct: changePct, change_abs: changeAbs, previous_close: previousClose, timestamp };
}

async function fetchBitcoin(prev, errors) {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true';
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const btc = json?.bitcoin;
    if (!btc) throw new Error('unexpected response shape');

    const price = btc.usd ?? null;
    const changePct = btc.usd_24h_change ?? null;
    const prevClose = changePct !== null && price !== null
      ? price / (1 + changePct / 100)
      : (prev.btc?.previous_close ?? null);

    return {
      symbol:         'BTC-USD',
      name:           'Bitcoin',
      value:          price,
      change_pct:     changePct,
      change_abs:     changePct !== null && price !== null ? price - prevClose : null,
      previous_close: prevClose,
      timestamp:      btc.last_updated_at ? new Date(btc.last_updated_at * 1000).toISOString() : null,
    };
  } catch (err) {
    errors.push(`coingecko: ${err.message}`);
    return prev.btc ?? null;
  }
}

function nextUpdate(now) {
  const slots = [1, 13, 19];
  const todayMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  for (const slot of slots) {
    if (slot * 60 > todayMinutes) {
      const next = new Date(now);
      next.setUTCHours(slot, 0, 0, 0);
      return next.toISOString();
    }
  }
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(slots[0], 0, 0, 0);
  return next.toISOString();
}

async function main() {
  const prev = loadPrevious();
  const errors = [];
  const now = new Date();

  const stooqKeys = Object.keys(STOOQ_ASSETS);

  // fetch all Stooq assets + BTC concurrently
  const [btcResult, ...stooqResults] = await Promise.allSettled([
    fetchBitcoin(prev, errors),
    ...stooqKeys.map(key => fetchStooqAsset(key, prev, errors)),
  ]);

  const data = {};

  stooqKeys.forEach((key, i) => {
    const result = stooqResults[i];
    if (result.status === 'fulfilled' && result.value) {
      data[key] = result.value;
    } else {
      if (result.status === 'rejected') errors.push(`stooq[${key}] unhandled: ${result.reason.message}`);
      if (prev[key]) data[key] = prev[key];
    }
  });

  if (btcResult.status === 'fulfilled' && btcResult.value) {
    data.btc = btcResult.value;
  } else {
    if (btcResult.status === 'rejected') errors.push(`btc unhandled: ${btcResult.reason.message}`);
    if (prev.btc) data.btc = prev.btc;
  }

  const output = { generated_at: now.toISOString(), next_update: nextUpdate(now), data, errors };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Written ${OUTPUT_PATH} at ${now.toISOString()}`);
  if (errors.length) console.warn('Errors:', errors);
}

main().catch(err => { console.error(err); process.exit(1); });
