// 首页推荐队列 + 轮次安排 + @ 间隔：不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-feed-'));
process.env.BILI_DIGEST_HOME = HOME;

const { readFeedQueue, feedStale, refreshFeed, takeFromFeed, roundKind, ROUND_PLAN } = await import('../lib/core/feed.js');
const { pushGate, recordPush, minutesSinceLastPush, PUSH_TRACKS } = await import('../lib/core/write.js');
const { suggestKeywords, coldState } = await import('../lib/core/weights.js');

const fakeVideos = (n, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ bvid: `BV1${String(start + i).padStart(9, '0')}`, title: `v${start + i}`, duration: 120 + i, source: 'feed' }));

test('轮次安排：每 5 轮里 3 轮首页，不会连着三轮首页', () => {
  assert.deepEqual(ROUND_PLAN, ['feed', 'feed', 'hot', 'feed', 'new']);
  const kinds = Array.from({ length: 10 }, (_, i) => roundKind(i));
  assert.equal(kinds.filter((k) => k === 'feed').length, 6);
  for (let i = 0; i + 2 < kinds.length; i += 1) {
    assert.ok(!(kinds[i] === 'feed' && kinds[i + 1] === 'feed' && kinds[i + 2] === 'feed'), `第 ${i} 轮起连着三轮首页`);
  }
});

test('首页队列：调一次存一页，按轮慢慢取，取过的不再出现', async () => {
  let calls = 0;
  const api = {
    async homeFeed() {
      calls += 1;
      return [...fakeVideos(9, calls * 100), { bvid: 'BV1LONG000001', title: '99集合集', duration: 66988 }];
    },
  };
  const now = new Date('2026-10-26T10:00:00');
  assert.equal(feedStale(readFeedQueue(), now), true, '空队列算旧');
  const first = await refreshFeed(api, { now, config: { feedMaxDuration: 7200 } });
  assert.equal(calls, 1);
  assert.equal(first.added.length, 9, '超过 2 小时的跳过');
  assert.equal(first.dropped.length, 1);
  assert.equal(feedStale(first.queue, new Date('2026-10-26T11:00:00'), { feedRefreshHours: 3 }), false, '1 小时内不重调');
  const a = takeFromFeed(2);
  const b = takeFromFeed(2);
  assert.equal(a.taken.length, 2);
  assert.notEqual(a.taken[0].bvid, b.taken[0].bvid);
  assert.equal(readFeedQueue().items.length, 5);
  assert.equal(feedStale(readFeedQueue(), new Date('2026-10-26T13:30:00'), { feedRefreshHours: 3 }), true, '超过 3 小时算旧');
  // 再调一次：已经读过的不会回到队列里
  const usedBefore = readFeedQueue().used;
  const again = await refreshFeed({ homeFeed: async () => fakeVideos(3, 100) }, { now: new Date('2026-10-26T13:30:00') });
  assert.equal(again.added.length, 0, '同一批视频不会重复进队列');
  assert.ok(usedBefore.length === 4);
});

test('@ 间隔：两次 @ 至少隔 60 分钟，额度用完也拦', () => {
  const config = { pushDailyLong: 2, pushDailyShort: 3, pushMinGapMinutes: 60 };
  const t0 = new Date('2026-10-27T10:00:00');
  assert.equal(minutesSinceLastPush(t0, config), Infinity);
  assert.equal(pushGate(t0, config, PUSH_TRACKS.short).ok, true);
  recordPush({ bvid: 'BV1AAAAAAAAA', track: PUSH_TRACKS.short }, t0, config);
  const soon = pushGate(new Date('2026-10-27T10:30:00'), config, PUSH_TRACKS.short);
  assert.equal(soon.ok, false);
  assert.match(soon.reason, /至少隔 60 分钟/);
  assert.equal(pushGate(new Date('2026-10-27T11:05:00'), config, PUSH_TRACKS.short).ok, true);
  recordPush({ bvid: 'BV1BBBBBBBBB', track: PUSH_TRACKS.long }, new Date('2026-10-27T11:05:00'), config);
  recordPush({ bvid: 'BV1CCCCCCCCC', track: PUSH_TRACKS.long }, new Date('2026-10-27T12:10:00'), config);
  const full = pushGate(new Date('2026-10-27T14:00:00'), config, PUSH_TRACKS.long);
  assert.equal(full.ok, false);
  assert.match(full.reason, /额度用完/);
});

test('按口味取词：按权重抽样、大小写不重复；冷启动判断', () => {
  const now = new Date();
  const state = {
    tags: {
      大肥鱼: { fast: 3, slow: 3, seen: 6, likes: 2, updatedAt: now.toISOString() },
      deepseek: { fast: 2, slow: 2, seen: 4, likes: 1, updatedAt: now.toISOString() },
      DeepSeek: { fast: 1, slow: 1, seen: 2, likes: 0, updatedAt: now.toISOString() },
      显卡: { fast: 1, slow: 1, seen: 2, likes: 0, updatedAt: now.toISOString() },
      绝区零: { fast: 1, slow: 1, seen: 2, likes: 0, updatedAt: now.toISOString() },
    },
  };
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const { keywords } = suggestKeywords(3, { state, now, random: () => (i * 0.137) % 1 });
    const lower = keywords.map((k) => k.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, `大小写重复：${keywords.join(',')}`);
    seen.add(keywords.join(','));
  }
  assert.ok(seen.size > 1, '每轮不该都是同一组词');
  const cold = coldState({ state, now });
  assert.equal(cold.cold, true, '只有两个非先验标签，还算冷');
  assert.ok(cold.warm.includes('显卡'));
});
