import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrades, parsePriceBars, summarizeEvidence, readPoolEvidence } from './pool-evidence';
import { resetGeckoFeedsForTest } from './geckoterminal';
const token = '0x' + '1'.repeat(40), quote = '0x' + '2'.repeat(40);
const now = 1800000000000;
const tx = '0x' + 'a'.repeat(64);
const trade = (id: string, from = quote, to = token, usd: unknown = '20') => ({ id, attributes: { tx_hash: tx, block_timestamp: new Date(now - 60000).toISOString(), from_token_address: from, to_token_address: to, kind: 'sell', volume_in_usd: usd, price_to_in_usd: '2', price_from_in_usd: '3' } });
test('trade direction follows the requested token, keeps distinct swaps within one tx, deduplicates IDs', () => {
  const buy = trade('buy');
  const data = parseTrades({data:[buy,buy,trade('sell',token,quote),trade('other',quote,quote),trade('self',token,token)]},token,now)!;
  assert.deepEqual(data.map(t=>t.side),['buy','sell']);
  assert.deepEqual(data.map(t=>t.priceUsd),[2,3]);
  assert.equal(data[0]!.tx,data[1]!.tx);
});
test('unreadable values are unknown and invalid/future/old trades excluded', () => {
  const future=trade('future');future.attributes.block_timestamp=new Date(now+120000).toISOString();
  const old=trade('old');old.attributes.block_timestamp=new Date(now-90000000).toISOString();
  const data=parseTrades({data:[trade('missing',quote,token,''),future,old]},token,now)!;
  assert.equal(data.length,1);assert.equal(data[0]!.usd,null);
  assert.equal(parseTrades({},token,now),null);
});
const candleBody = (rows: unknown[]) => ({data:{attributes:{ohlcv_list:rows}},meta:{base:{address:token}}});
test('candles reject wrong identity, incomplete bars and invalid ranges; sort and dedupe',()=>{
  const end=now/1000;
  const a=[end-900,1,2,1,2],b=[end-600,2,3,2,3];
  assert.equal(parsePriceBars(candleBody([a]),quote,now),null);
  const bars=parsePriceBars(candleBody([b,a,b,[end,1,2,1,2],[end-300,3,2,1,3]]),token,now)!;
  assert.equal(bars.length,2);assert.equal(bars[0]!.time,end-900);
});
test('trades carry the sender wallet, lowercased, or null; bars carry their USD volume, or null — never 0', () => {
  const t = trade('w'); (t.attributes as Record<string, unknown>).tx_from_address = '0x' + 'AB'.repeat(20);
  const junk = trade('j'); (junk.attributes as Record<string, unknown>).tx_from_address = 'not-a-wallet';
  const [a, b] = parseTrades({ data: [t, junk] }, token, now)!;
  assert.equal(a!.wallet, '0x' + 'ab'.repeat(20));
  assert.equal(b!.wallet, null);
  const end = now / 1000;
  const bars = parsePriceBars(candleBody([[end - 900, 1, 2, 1, 2, '1500.5'], [end - 600, 2, 3, 2, 3]]), token, now)!;
  assert.deepEqual(bars.map(x => x.volume), [1500.5, null]);
});

/** A trade `ageSec` old, from `wallet`, buying (to = token) or selling, for `usd`. */
const flow = (id: string, ageSec: number, side: 'buy' | 'sell', usd: number | null, wallet: string | null) =>
  ({ id, tx, time: now / 1000 - ageSec, side, usd, priceUsd: 1, wallet });
const W = (n: number) => '0x' + n.toString(16).padStart(40, '0');

test('trade windows: counts, distinct wallets, buy share and the top seller at 5, 15 and 60 minutes', () => {
  const trades = [
    flow('a', 60, 'buy', 30, W(1)), flow('b', 120, 'buy', 30, W(2)), flow('c', 200, 'sell', 20, W(3)),
    flow('d', 600, 'buy', 50, W(1)), flow('e', 700, 'sell', 80, W(4)), flow('f', 800, 'sell', 20, W(3)),
    flow('g', 2000, 'sell', 300, W(4)), flow('h', 3000, 'buy', 10, W(5)), flow('old', 4000, 'buy', 999, W(6)),
  ];
  const e = { poolId: quote, token, candles: { failed: true, failure: 'budget', data: [] }, trades: { failed: false, observedAt: now, data: trades } };
  const w = summarizeEvidence(e, now).tradeWindows!;
  assert.deepEqual(w.m5, { trades: 3, buys: 2, sells: 1, distinctBuyers: 2, distinctSellers: 1, buyUsd: 60, sellUsd: 20, buySharePct: 75, topSellerSharePctOfSellUsd: 100, sampleCoversWindow: true });
  assert.deepEqual(w.m15, { trades: 6, buys: 3, sells: 3, distinctBuyers: 2, distinctSellers: 2, buyUsd: 110, sellUsd: 120, buySharePct: 47.8, topSellerSharePctOfSellUsd: 66.7, sampleCoversWindow: true });
  assert.deepEqual(w.h1, { trades: 8, buys: 4, sells: 4, distinctBuyers: 3, distinctSellers: 2, buyUsd: 120, sellUsd: 420, buySharePct: 22.2, topSellerSharePctOfSellUsd: 90.5, sampleCoversWindow: true });
  // An unpriced trade makes that window's amounts unknown; an unattributed one, its wallet counts.
  const holes = summarizeEvidence({ ...e, trades: { ...e.trades, data: [flow('x', 30, 'buy', null, W(1)), flow('y', 400, 'sell', 5, null)] } }, now).tradeWindows!;
  assert.equal(holes.m5!.buyUsd, null);
  assert.equal(holes.m5!.buySharePct, null);
  assert.equal(holes.m5!.distinctBuyers, 1);
  assert.equal(holes.m15!.distinctSellers, null);
  assert.equal(holes.m15!.topSellerSharePctOfSellUsd, null);
  // A full sample that does not reach back across a window says so.
  const full = Array.from({ length: 300 }, (_, i) => flow(`f${i}`, 1 + i, 'buy', 1, W(i + 1)));
  const capped = summarizeEvidence({ ...e, trades: { ...e.trades, data: full } }, now).tradeWindows!;
  assert.equal(capped.m5!.sampleCoversWindow, true, "its oldest trade is inside five minutes' reach");
  assert.equal(capped.m15!.sampleCoversWindow, false);
  // A trade leg that did not land is unknown, not quiet.
  assert.equal(summarizeEvidence({ ...e, trades: { failed: true, failure: 'provider-cooldown', data: [] } }, now).tradeWindows, null);
});

test('candle volume: totals, the last quarter hour against the one before, and the last bars themselves', () => {
  const end = Math.floor(now / 1000 / 300) * 300;
  const bars = Array.from({ length: 8 }, (_, i) => ({ time: end - (8 - i) * 300, open: 1, high: 1.2, low: 0.9 + i / 100, close: 1.1, volume: 100 * (i + 1) }));
  const e = { poolId: quote, token, candles: { failed: false, observedAt: now, data: bars }, trades: { failed: true, failure: 'budget', data: [] } };
  const s = summarizeEvidence(e, now);
  assert.deepEqual(s.candleVolumeUsd, { allBars: 3600, last15m: 2100, prior15m: 1200 });
  assert.equal(s.recentBars.length, 6);
  assert.deepEqual(s.recentBars.at(-1), { end, open: 1, high: 1.2, low: 0.97, close: 1.1, volumeUsd: 800 });
  // One bar without a volume: no totals, never a sum that treats it as 0.
  const gap = summarizeEvidence({ ...e, candles: { ...e.candles, data: bars.map((b, i) => i === 3 ? { ...b, volume: null } : b) } }, now);
  assert.equal(gap.candleVolumeUsd, null);
  assert.equal(gap.recentBars[1]!.volumeUsd, null);
  // A failed candle read: no volume, no bars.
  const failed = summarizeEvidence({ ...e, candles: { failed: true, failure: 'budget', data: [] } }, now);
  assert.equal(failed.candleVolumeUsd, null);
  assert.deepEqual(failed.recentBars, []);
  assert.match(s.caveat, /Distinct wallets are transaction senders/);
  assert.doesNotMatch(JSON.stringify(summarizeEvidence({ ...e, trades: { failed: false, observedAt: now, data: [flow('a', 10, 'buy', 1, W(7))] } }, now)), new RegExp(W(7)), 'wallets are counted, never repeated');
});

test('summary measures contiguous returns and sampled flow, never uses missing amounts as zero',()=>{
  const bars=parsePriceBars(candleBody([[now/1000-900,1,2,1,2],[now/1000-600,2,3,2,3],[now/1000-300,3,4,3,4]]),token,now)!;
  const e={poolId:quote,token,candles:{failed:false,observedAt:now,data:bars},trades:{failed:false,observedAt:now,data:parseTrades({data:[trade('a'),trade('b',token,quote,'10')]},token,now)!}};
  const s=summarizeEvidence(e,now);assert.equal(s.measuredReturnPct,300);assert.ok(Math.abs(s.sampledBuySharePct5m! - 200/3) < 1e-10);assert.ok(s.fiveMinuteLogReturnStdDevPct!>0);
  e.trades.data[0]!.usd=null;assert.equal(summarizeEvidence(e,now).sampledBuySharePct5m,null);
  e.candles.data.splice(1,1);assert.equal(summarizeEvidence(e,now).measuredReturnPct,null);
  assert.equal(summarizeEvidence(e,now+121000).sampledTrades5m,null);
  assert.equal(summarizeEvidence(e,now+121000).latestFiveMinuteReturnPct,null);
});
test('detail reads authenticate only to fixed origin, coalesce callers and preserve partial failure',async()=>{
  const old=globalThis.fetch,key=process.env.MERRYMEN_COINGECKO_PRO_API_KEY,home=process.env.MERRYMEN_FLEET_HOME;
  process.env.MERRYMEN_COINGECKO_PRO_API_KEY='test-key';delete process.env.MERRYMEN_FLEET_HOME;
  let clock = Date.now();
  resetGeckoFeedsForTest({ now: () => clock, sleep: async ms => { clock += ms; await Promise.resolve(); } });
  const urls:string[]=[];
  globalThis.fetch=async(input,init)=>{const url=String(input);urls.push(url);assert.ok(url.startsWith('https://pro-api.coingecko.com/api/v3/onchain/'));assert.equal(init?.redirect,'error');assert.equal((init?.headers as Record<string,string>)['x-cg-pro-api-key'],'test-key');assert.ok(!url.includes('test-key'));return url.includes('/trades')?Response.json({data:[]}):new Response('',{status:401});};
  try{const [a,b]=await Promise.all([readPoolEvidence(quote,token),readPoolEvidence(quote,token)]);assert.equal(urls.length,2);assert.equal(a.candles.failure,'http-401');assert.equal(a.trades.failed,false);assert.deepEqual(a,b);await assert.rejects(readPoolEvidence('../evil',token));}
  finally{resetGeckoFeedsForTest();globalThis.fetch=old;if(key===undefined)delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY;else process.env.MERRYMEN_COINGECKO_PRO_API_KEY=key;if(home!==undefined)process.env.MERRYMEN_FLEET_HOME=home;}
});

test('public fallback keeps exact-token evidence and never receives Pro credentials', async () => {
  const oldFetch = globalThis.fetch, key = process.env.MERRYMEN_COINGECKO_PRO_API_KEY, home = process.env.MERRYMEN_FLEET_HOME;
  process.env.MERRYMEN_COINGECKO_PRO_API_KEY = 'private-evidence-key';
  delete process.env.MERRYMEN_FLEET_HOME;
  let clock = Date.now();
  resetGeckoFeedsForTest({ now: () => clock, sleep: async ms => { clock += ms; await Promise.resolve(); } });
  const target = '0x' + '3'.repeat(40), pool = '0x' + '4'.repeat(40);
  const end = Math.floor(Date.now() / 300_000) * 300;
  const origins: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); origins.push(url.origin);
    const pro = url.hostname === 'pro-api.coingecko.com';
    assert.equal(new Headers(init?.headers).get('x-cg-pro-api-key'), pro ? 'private-evidence-key' : null);
    assert.ok(url.searchParams.get('token') === target);
    if (pro) return new Response('exhausted', { status: 429 });
    return Response.json(url.pathname.endsWith('/trades') ? { data: [] } : { data: { attributes: { ohlcv_list: [[end - 600, 1, 2, 1, 2], [end - 300, 2, 3, 2, 3]] } }, meta: { base: { address: target } } });
  };
  try {
    const evidence = await readPoolEvidence(pool, target);
    assert.equal(evidence.candles.failed, false);
    assert.equal(evidence.trades.failed, false);
    assert.equal(evidence.candles.provider, 'geckoterminal-public');
    assert.ok(evidence.candles.primaryFailure);
    assert.equal(evidence.candles.data.length, 2);
    assert.equal(evidence.trades.provider, 'geckoterminal-public');
    assert.ok(origins.length <= 4);
    assert.doesNotMatch(JSON.stringify(evidence), /private-evidence-key|exhausted/);
  } finally {
    globalThis.fetch = oldFetch; resetGeckoFeedsForTest();
    if (key === undefined) delete process.env.MERRYMEN_COINGECKO_PRO_API_KEY; else process.env.MERRYMEN_COINGECKO_PRO_API_KEY = key;
    if (home === undefined) delete process.env.MERRYMEN_FLEET_HOME; else process.env.MERRYMEN_FLEET_HOME = home;
  }
});
