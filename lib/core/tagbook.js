// 标签库文档：把看过的视频的标签攒起来，分成「我看上的」和「人类喜欢的」两栏。
//
// 为什么单独一份：标签比标题更能说明「这类内容是什么」，攒多了就能反推出偏好。
// 文件写到 <out>/标签库.md，原始数据在 cache/tagbook.json（去重、可重渲染）。

import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';

const MAX_TAGS = 12;

function storeFile() {
  return path.join(paths().cache, 'tagbook.json');
}

function emptyBook() {
  return { mine: [], his: [], updatedAt: '' };
}

/** 读原始账本：{mine:[{bvid,title,tags,note,at}], his:[...]}。 */
export function readTagBook() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return {
      mine: Array.isArray(parsed.mine) ? parsed.mine : [],
      his: Array.isArray(parsed.his) ? parsed.his : [],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return emptyBook();
  }
}

function cleanTags(tags) {
  const list = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || '').trim())
    .filter((tag) => tag && tag.length <= 30);
  return [...new Set(list)].slice(0, MAX_TAGS);
}

/** 加一条：同一个 BV 只留一条，后来者补标签/改标题。 */
export function addToTagBook(entries, who = 'mine', now = new Date()) {
  const key = who === 'his' ? 'his' : 'mine';
  const book = readTagBook();
  const existing = new Map(book[key].map((entry) => [entry.bvid, entry]));
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    if (!entry?.bvid) continue;
    const tags = cleanTags(entry.tags);
    const prev = existing.get(entry.bvid);
    existing.set(entry.bvid, {
      bvid: entry.bvid,
      title: String(entry.title || prev?.title || '').slice(0, 120),
      tags: tags.length ? tags : prev?.tags || [],
      note: String(entry.note || prev?.note || '').slice(0, 80),
      at: prev?.at || now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }
  book[key] = [...existing.values()];
  book.updatedAt = now.toISOString();
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(book, null, 2));
  fs.chmodSync(storeFile(), 0o600);
  return book;
}

/** 从一轮结果里抽出条目（digest 的 sections 就够：meta 里有标题和标签）。 */
export function entriesFromSections(sections, { note = '' } = {}) {
  return (Array.isArray(sections) ? sections : [])
    .map((section) => ({
      bvid: section?.bvid || section?.meta?.bvid || '',
      title: section?.meta?.title || '',
      tags: section?.meta?.tags || [],
      note,
    }))
    .filter((entry) => entry.bvid);
}

/** 标签热度：哪几个词出现得最多。 */
export function topTags(entries, limit = 20) {
  const counts = new Map();
  for (const entry of entries) for (const tag of entry.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function videoLine(entry) {
  const tags = (entry.tags || []).join(' / ') || '（没拿到标签）';
  const name = String(entry.title || entry.bvid).replace(/\|/g, '\\|');
  return `| [${name}](https://www.bilibili.com/video/${entry.bvid}) | ${tags.replace(/\|/g, '\\|')} | ${entry.note || ''} |`;
}

/** 渲染成给人看的 markdown。 */
export function renderTagBook({ mine = [], his = [], generatedAt = new Date() } = {}) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${generatedAt.getFullYear()}-${pad(generatedAt.getMonth() + 1)}-${pad(generatedAt.getDate())} ${pad(generatedAt.getHours())}:${pad(generatedAt.getMinutes())}`;
  const lines = [];
  lines.push('# 标签库');
  lines.push('');
  lines.push(`> 更新于 ${stamp}｜我看上的 ${mine.length} 条／人类喜欢的 ${his.length} 条`);
  lines.push('');
  lines.push('标签比标题更能说明「这是什么内容」。攒够之后，我的取材方向就该从这里面长出来，而不是靠猜关键词。');
  lines.push('');

  const render = (title, entries, hint) => {
    lines.push(`## ${title}`);
    lines.push('');
    if (!entries.length) {
      lines.push(`_还没有。${hint}_`);
      lines.push('');
      return;
    }
    lines.push('| 视频 | 标签 | 备注 |');
    lines.push('| --- | --- | --- |');
    for (const entry of entries) lines.push(videoLine(entry));
    lines.push('');
    const hot = topTags(entries, 15);
    if (hot.length) {
      lines.push(`高频标签：${hot.map(([tag, count]) => `${tag}×${count}`).join('、')}`);
      lines.push('');
    }
  };

  render('我喜欢的（我看上的）', mine, '等我看完几条，这里会自动长出来。');
  render('人类喜欢的（你说喜欢的）', his, '你在评论里说喜欢，我就会把那条记到这里，并收藏进「人类主人喜欢的视频」。');

  const all = [...mine, ...his];
  const hot = topTags(all, 20);
  lines.push('## 两栏合起来的热度');
  lines.push('');
  if (!hot.length) lines.push('_还没有标签。_');
  else {
    lines.push('| 标签 | 次数 |');
    lines.push('| --- | --- |');
    for (const [tag, count] of hot) lines.push(`| ${tag.replace(/\|/g, '\\|')} | ${count} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 渲染并存到 <out>/标签库.md，返回文件路径。 */
export function syncTagBook(now = new Date()) {
  const book = readTagBook();
  const markdown = renderTagBook({ mine: book.mine, his: book.his, generatedAt: now });
  const file = path.join(paths().out, '标签库.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown);
  fs.chmodSync(file, 0o600);
  return { file, mine: book.mine.length, his: book.his.length };
}

/**
 * 从人类的话里判断偏好。只认「明确说喜欢/不喜欢」，模棱两可就返回 null。
 * @returns {'like'|'dislike'|null}
 */
export function detectPreference(text) {
  const said = String(text || '').replace(/\s+/g, '');
  if (!said) return null;
  if (/(不喜欢|不好看|难看|别推荐|别再|反感|无聊|不行)/.test(said)) return 'dislike';
  if (/(喜欢|好看|不错|对味|收藏|想看|有意思|可以多来)/.test(said)) return 'like';
  return null;
}
