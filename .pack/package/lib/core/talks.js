// 对话流水：我跟人类/其他人说的话、他们对我说的话，都记在本地，方便复盘我判断得准不准。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.js';

const MAX = 2000;

function talksPath() {
  return path.join(paths().cache, 'talks.json');
}

/** 读全部对话流水（从旧到新）。 */
export function readTalks() {
  try {
    const raw = fs.readFileSync(talksPath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * 记一句对话。
 * @param {{who: 'me'|'human'|'other', text: string, kind?: string, ref?: string, bvid?: string, at?: Date}} entry
 */
export function appendTalk(entry = {}) {
  const text = String(entry.text || '').trim();
  if (!text) return null;
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: (entry.at instanceof Date ? entry.at : new Date()).toISOString(),
    who: ['me', 'human', 'other'].includes(entry.who) ? entry.who : 'other',
    kind: entry.kind || 'reply',
    text: text.slice(0, 600),
    ref: entry.ref || '',
    bvid: entry.bvid || '',
  };
  const all = readTalks();
  all.push(record);
  const kept = all.slice(-MAX);
  const file = talksPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(kept, null, 2), { mode: 0o600 });
  return record;
}

/** 人类最近 N 句（我复盘时最关心这个）。 */
export function recentHumanTalks(limit = 10) {
  return readTalks()
    .filter((item) => item.who === 'human')
    .slice(-limit);
}

/** 把流水渲染成能直接看的一份文档。 */
export function renderTalks({ limit = 200, generatedAt = new Date() } = {}) {
  const all = readTalks().slice(-limit);
  const lines = [`# 对话流水 · ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')}`, ''];
  if (!all.length) {
    lines.push('> 还没有对话。');
    return lines.join('\n');
  }
  const nameOf = { me: '我', human: '人类', other: '别人' };
  for (const item of all) {
    const time = item.at.slice(5, 16).replace('T', ' ');
    lines.push(`- ${time} ${nameOf[item.who] || item.who}：${item.text}${item.bvid ? `（${item.bvid}）` : ''}`);
  }
  return lines.join('\n');
}

/** 写 `<我看视频>/对话.md`（0600）。 */
export function syncTalks({ generatedAt = new Date() } = {}) {
  const out = paths().out;
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = path.join(out, '对话.md');
  fs.writeFileSync(file, renderTalks({ generatedAt }), { mode: 0o600 });
  return file;
}
