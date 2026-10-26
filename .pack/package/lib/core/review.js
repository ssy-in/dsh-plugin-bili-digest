// 评审：把我拿不准的、判错风险高的东西攒起来，隔几天摊给人类看一遍。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';
import { readWeights, coldState } from './weights.js';

const DAY_MS = 86400_000;

function reviewQueue() {
  try {
    const raw = fs.readFileSync(path.join(paths().cache, 'review.json'), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

function reviewDir() {
  return path.join(paths().out, '评审');
}

function lastReviewAt() {
  const dir = reviewDir();
  try {
    const names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort();
    if (!names.length) return 0;
    const stat = fs.statSync(path.join(dir, names.at(-1)));
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 待评审的状态。
 * @param {Date} [now]
 * @param {{reviewEveryDays?: number}} [config]
 */
export function reviewState(now = new Date(), config = {}) {
  const everyDays = Number(config.reviewEveryDays ?? 3) || 3;
  const last = lastReviewAt();
  const nextAt = last ? new Date(last + everyDays * DAY_MS) : now;
  const pending = reviewQueue();
  return {
    pending: pending.length,
    everyDays,
    lastAt: last ? new Date(last).toISOString() : '',
    nextAt: nextAt.toISOString(),
    due: !last || now.getTime() >= nextAt.getTime(),
    items: pending.slice(-15),
  };
}

/** 渲染一份评审清单（10–15 条一行一条，方便人类一眼扫过去）。 */
export function renderReview({ items, generatedAt = new Date(), taste = [], cold = null } = {}) {
  const lines = [`# 评审 · ${generatedAt.toISOString().slice(0, 10)}`, ''];
  lines.push('> 这些是我这阵子自己拿不准的、或者判断可能错的。人类扫一眼，说「对/不对/少看点」就行。');
  lines.push('');
  if (cold?.cold) {
    lines.push(
      `**口味还没热起来**：除了大肥鱼那几个词，我只摸到 ${cold.warm.length} 个自己的标签（要 ${cold.minWarm} 个才算热）。`,
    );
    lines.push('人类方便的话回我几个想看的关键词（比如 cos、二次元、某个游戏），我先拿它们起步。');
    lines.push('');
  } else if (cold) {
    lines.push(`**口味热起来了**：自己长出来的标签有 ${cold.warm.slice(0, 8).join('、')}。`);
    lines.push('');
  }
  if (taste.length) {
    lines.push(`**我现在以为人类喜欢的**：${taste.map((tag) => `${tag.tag}(${tag.weight.toFixed(2)})`).join('、')}`);
    lines.push('');
  }
  if (!items?.length) {
    lines.push('（这轮没有待评审的条目。）');
    return lines.join('\n');
  }
  lines.push('| # | 视频 | 我判断的 | 我为什么这么判 |');
  lines.push('| --- | --- | --- | --- |');
  items.forEach((item, index) => {
    const tag = item.bvid ? `[${item.bvid}](https://www.bilibili.com/video/${item.bvid})` : '（无）';
    lines.push(`| ${index + 1} | ${tag} | ${String(item.guess || item.kind || '').slice(0, 20)} | ${String(item.reason || item.comment || '').slice(0, 80)} |`);
  });
  lines.push('');
  return lines.join('\n');
}

/**
 * 到点就写一份 `<我看视频>/评审/YYYYMMDD.md`。
 * @param {{now?: Date, config?: object, force?: boolean}} [options]
 */
export function syncReview(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const config = options.config || {};
  const state = reviewState(now, config);
  if (!state.due && !options.force) return { ok: false, skipped: '还没到评审时间', state };
  const taste = (readWeights().tags && Object.entries(readWeights().tags)) || [];
  const topTaste = taste
    .map(([tag, value]) => ({ tag, weight: Number(value.slow) || Number(value.fast) || 0 }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8);
  let cold = null;
  try {
    cold = coldState({ now });
  } catch {
    cold = null;
  }
  const markdown = renderReview({ items: state.items, generatedAt: now, taste: topTaste, cold });
  const dir = reviewDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${now.toISOString().slice(0, 10).replace(/-/g, '')}.md`);
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  return { ok: true, file, state };
}
