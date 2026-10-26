// 磁盘侧：字幕缓存（带 TTL/条目上限）、报告落盘（保留最近 N 份）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, loadConfig } from './config.js';

const MAX_CACHE_ENTRIES = 400;

/**
 * 「我看视频」这个人能直接翻的目录：日记、速览、截图都放一起。
 * 可以用配置项 `outputDir` 或环境变量 `BILI_DIGEST_OUT` 指到别处（默认 <dataDir>/我看视频）。
 */
export function outputDir() {
  let configured = '';
  try {
    configured = String(loadConfig({ requireLogin: false }).outputDir || '');
  } catch {
    configured = '';
  }
  const raw = configured || process.env.BILI_DIGEST_OUT || '';
  return raw ? path.resolve(raw) : path.join(dataDir(), '我看视频');
}

export function paths() {
  const root = dataDir();
  const out = outputDir();
  return {
    root,
    out,
    cache: path.join(root, 'cache'),
    reports: out,
    diary: out,
    frames: path.join(out, '画面'),
    lastDigest: path.join(root, 'cache', 'last-digest.json'),
    seen: path.join(root, 'cache', 'seen.jsonl'),
  };
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, value) {
  ensure(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const cacheFile = (key) => path.join(ensure(paths().cache), `${crypto.createHash('sha1').update(key).digest('hex')}.json`);

/** 读缓存：命中且未过期才返回。 */
export function cacheGet(key, ttlMs) {
  const entry = readJson(cacheFile(key));
  if (!entry || typeof entry.at !== 'number') return undefined;
  if (Date.now() - entry.at > ttlMs) return undefined;
  return entry.value;
}

export function cacheSet(key, value) {
  const file = cacheFile(key);
  writeJsonAtomic(file, { at: Date.now(), value });
  pruneDir(paths().cache, MAX_CACHE_ENTRIES, (name) => name.endsWith('.json') && name !== 'last-digest.json');
}

function pruneDir(dir, keep, filter = () => true) {
  let names;
  try {
    names = fs.readdirSync(dir).filter(filter);
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const stats = names
    .map((name) => {
      try {
        return { name, mtime: fs.statSync(path.join(dir, name)).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of stats.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, entry.name));
    } catch {
      /* 忽略清理失败 */
    }
  }
}

/** 本地日期戳：20261023（用户的「年月日」）。 */
function dateStamp(generatedAt = new Date()) {
  const date = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function uniqueFile(dir, base) {
  let file = path.join(dir, base);
  let index = 2;
  while (fs.existsSync(file)) {
    file = path.join(dir, base.replace(/(\.[^.]+)$/, `-${index}$1`));
    index += 1;
  }
  return file;
}


/** 一天一个文件：把这一轮的内容追加到 <out>/<YYYYMMDD>_日记.md。 */
function appendDaily(name, markdown, { generatedAt = new Date(), keep = 90 } = {}) {
  const dir = ensure(paths().diary);
  const day = dateStamp(generatedAt);
  const file = path.join(dir, `${day}_${name}.md`);
  const date = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const body = String(markdown || '')
    .split('\n')
    // 单轮的渲染带一个一级标题，合并进日记里要降级，否则一天会有一堆 h1。
    .filter((line, index) => !(index === 0 && line.startsWith('# ')))
    .join('\n')
    .trim();
  const fresh = !fs.existsSync(file);
  if (fresh) {
    fs.writeFileSync(file, `# ${date.toLocaleDateString('zh-CN')} · ${name}\n\n> 一天一个文件，每轮往后追加。\n\n`, { mode: 0o600 });
  }
  const block = `## ${clock}\n\n${body}\n\n`;
  fs.appendFileSync(file, block, { mode: 0o600 });
  pruneDir(dir, Math.max(1, keep), (entry) => /_日记\.md$|_日报\.md$/.test(entry));
  return file;
}

/** 追加这一轮的日记（给自己看）。 */
export function appendDailyDiary(markdown, options = {}) {
  return appendDaily('日记', markdown, options);
}

/** 追加这一轮的日报（给模型回查）。 */
export function appendDailyReport(markdown, options = {}) {
  return appendDaily('日报', markdown, options);
}

/** 一整轮（可能多条视频）的速览：`20261023_dailyReport.md`。 */
export function saveReport(markdown, { keep = 30, generatedAt = new Date() } = {}) {
  const dir = ensure(paths().reports);
  const file = uniqueFile(dir, `${dateStamp(generatedAt)}_dailyReport.md`);
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  pruneDir(dir, Math.max(1, keep), (name) => /_dailyReport\.md$/.test(name));
  return file;
}

/** 单条视频的日记与速览：`20261023_BV1xx_diary.md` / `20261023_BV1xx_dailyReport.md`，同目录并排。 */
export function saveDiaryFor(bvid, markdown, { keep = 180, generatedAt = new Date() } = {}) {
  const dir = ensure(paths().diary);
  const file = uniqueFile(dir, `${dateStamp(generatedAt)}_${String(bvid || 'BV')}_diary.md`);
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  pruneDir(dir, Math.max(1, keep), (name) => /_diary\.md$/.test(name));
  return file;
}

export function saveReportFor(bvid, markdown, { keep = 180, generatedAt = new Date() } = {}) {
  const dir = ensure(paths().reports);
  const file = uniqueFile(dir, `${dateStamp(generatedAt)}_${String(bvid || 'BV')}_dailyReport.md`);
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  pruneDir(dir, Math.max(1, keep), (name) => /_dailyReport\.md$/.test(name));
  return file;
}

export function saveLastDigest(payload) {
  writeJsonAtomic(paths().lastDigest, payload);
}

export function readLastDigest() {
  return readJson(paths().lastDigest);
}

/** 写一份整轮的心情日记（多条视频版），只保留最近 keep 份。 */
export function saveDiary(markdown, { keep = 180, generatedAt = new Date() } = {}) {
  const dir = ensure(paths().diary);
  const file = uniqueFile(dir, `${dateStamp(generatedAt)}_diary.md`);
  fs.writeFileSync(file, markdown, { mode: 0o600 });
  pruneDir(dir, Math.max(1, keep), (name) => /_diary\.md$/.test(name));
  return file;
}

/** 已推送过的视频（bvid → 最后一次出现的时间与心情）。用于「不重复推同一批」。 */
export function readSeen() {
  const map = new Map();
  let text = '';
  try {
    text = fs.readFileSync(paths().seen, 'utf8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry?.bvid) map.set(String(entry.bvid), entry);
    } catch {
      /* 坏行忽略，不影响去重 */
    }
  }
  return map;
}

export function markSeen(entries) {
  const rows = (entries || []).filter((entry) => entry?.bvid);
  if (!rows.length) return 0;
  const file = paths().seen;
  ensure(path.dirname(file));
  const at = new Date().toISOString();
  const payload = rows.map((entry) => JSON.stringify({ at, bvid: entry.bvid, title: entry.title || '', mood: entry.mood || '' })).join('\n');
  fs.appendFileSync(file, `${payload}\n`, { mode: 0o600 });
  return rows.length;
}

/** 过滤掉最近 withinDays 天内推送过的视频。 */
export function filterFresh(candidates, { withinDays = 14 } = {}) {
  const seen = readSeen();
  const now = Date.now();
  const window = Math.max(0, Number(withinDays) || 0) * 86400_000;
  const fresh = [];
  const repeated = [];
  for (const item of candidates) {
    const entry = seen.get(String(item.bvid));
    const at = entry ? Date.parse(entry.at) : NaN;
    const recent = Number.isFinite(at) && now - at <= window;
    if (recent && window > 0) repeated.push({ ...item, seenAt: entry.at });
    else fresh.push(item);
  }
  return { fresh, repeated };
}

/** 读最近一份心情日记（给界面和模型看）。 */
export function readLatestDiary() {
  const dir = paths().diary;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /_日记\.md$|_diary\.md$/.test(name)).sort();
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const file = path.join(dir, names.at(-1));
  try {
    return { file, markdown: fs.readFileSync(file, 'utf8') };
  } catch {
    return undefined;
  }
}
