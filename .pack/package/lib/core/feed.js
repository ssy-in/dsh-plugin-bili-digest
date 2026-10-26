// 首页推荐的待看队列。
//
// 人类 m06243：首页刷过去的视频以后大概率刷不到了，所以少调首页、把一页的数据用足。
// 做法：调一次首页存成队列，每轮从队列里取一两条；队列空了、或者存了太久（默认 3 小时），才再调一次。
// 刷新出来的条目还是要走完整的机制（去重 → 价值观 → 长短 → 字幕/画面 → 权重 → 要不要 @）。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';

export const FEED_DEFAULTS = {
  feedRefreshHours: 3, // 队列存了这么久就算旧了，重新调一次首页
  feedMaxDuration: 7200, // 首页里超过 2 小时的直接跳过（人类：不喜欢太长的）
  feedPerRound: 2, // 每轮最多从队列里取几条去读
};

function feedFile() {
  return path.join(paths().cache, 'feed.json');
}

export function readFeedQueue() {
  try {
    const raw = JSON.parse(fs.readFileSync(feedFile(), 'utf8'));
    return {
      fetchedAt: raw.fetchedAt || '',
      fetches: Number(raw.fetches) || 0,
      freshIdx: Number(raw.freshIdx) || 0,
      items: Array.isArray(raw.items) ? raw.items : [],
      used: Array.isArray(raw.used) ? raw.used : [],
    };
  } catch {
    return { fetchedAt: '', fetches: 0, freshIdx: 0, items: [], used: [] };
  }
}

export function writeFeedQueue(queue) {
  const file = feedFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ ...queue, items: queue.items.slice(0, 40), used: (queue.used || []).slice(-300) }, null, 2),
  );
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows 上没有 POSIX 权限位 */
  }
}

/** 队列需不需要重新调首页：空了，或者存得太久了。 */
export function feedStale(queue, now = new Date(), config = {}) {
  const hours = Number(config.feedRefreshHours ?? FEED_DEFAULTS.feedRefreshHours) || FEED_DEFAULTS.feedRefreshHours;
  if (!queue.items.length) return true;
  const at = Date.parse(queue.fetchedAt || '') || 0;
  return !at || now.getTime() - at >= hours * 3600_000;
}

/** 调一次首页，把新视频追加进队列（已用过、已在队列里、超长的都不要）。 */
export async function refreshFeed(api, { now = new Date(), config = {}, queue = readFeedQueue() } = {}) {
  const maxDuration = Number(config.feedMaxDuration ?? FEED_DEFAULTS.feedMaxDuration) || 0;
  const freshIdx = (queue.freshIdx || 0) + 1;
  const items = await api.homeFeed({ ps: 12, freshIdx });
  const known = new Set([...queue.items.map((item) => item.bvid), ...(queue.used || [])]);
  const added = [];
  const dropped = [];
  for (const item of items) {
    if (known.has(item.bvid)) continue;
    if (maxDuration > 0 && item.duration > maxDuration) {
      dropped.push({ ...item, reason: `太长了（${Math.round(item.duration / 60)} 分钟）` });
      continue;
    }
    known.add(item.bvid);
    added.push({ ...item, queuedAt: now.toISOString() });
  }
  // 旧队列不扔：剩下没读的接着读，新的排在后面。
  const next = {
    fetchedAt: now.toISOString(),
    fetches: (queue.fetches || 0) + 1,
    freshIdx,
    items: [...queue.items, ...added],
    used: queue.used || [],
  };
  writeFeedQueue(next);
  return { queue: next, added, dropped, total: items.length };
}

/** 从队列头部取 n 条，并标记为已用（下一轮不会再拿到）。 */
export function takeFromFeed(n = FEED_DEFAULTS.feedPerRound, { queue = readFeedQueue() } = {}) {
  const count = Math.max(0, Math.floor(n));
  const taken = queue.items.slice(0, count);
  const next = {
    ...queue,
    items: queue.items.slice(count),
    used: [...(queue.used || []), ...taken.map((item) => item.bvid)],
  };
  writeFeedQueue(next);
  return { taken, queue: next };
}

/** 每 5 轮的安排：首页、首页、热门搜索、首页、新视频搜索（首页 6 成）。 */
export const ROUND_PLAN = ['feed', 'feed', 'hot', 'feed', 'new'];

export function roundKind(runIndex) {
  const index = ((Math.floor(runIndex) % ROUND_PLAN.length) + ROUND_PLAN.length) % ROUND_PLAN.length;
  return ROUND_PLAN[index];
}
