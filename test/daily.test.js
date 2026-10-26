// 一天两个文件：追加而不是每轮新建；画面按天归档。不联网。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-daily-'));
const OUT = path.join(HOME, '我看视频');
process.env.BILI_DIGEST_HOME = HOME;
process.env.BILI_DIGEST_OUT = OUT;

const { appendDailyDiary, appendDailyReport, readLatestDiary, paths } = await import('../lib/core/store.js');
const { saveFrames } = await import('../lib/core/visual.js');

test('追加：同一天多次调用只留一个文件，每轮一段', () => {
  const day1 = new Date('2026-10-26T09:05:00');
  const day1b = new Date('2026-10-26T14:40:00');
  const a = appendDailyDiary('# 2026-10-26 · 心情日记\n\n第一轮内容', { generatedAt: day1 });
  const b = appendDailyDiary('# 2026-10-26 · 心情日记\n\n第二轮内容', { generatedAt: day1b });
  assert.equal(a, b, '同一天应该是同一个文件');
  const text = fs.readFileSync(a, 'utf8');
  assert.match(text, /^# 2026/);
  assert.equal((text.match(/^## /gm) || []).length, 2, '两轮两个小节');
  assert.match(text, /09:05/);
  assert.match(text, /14:40/);
  assert.ok(!/^# .*心情日记.*\n[\s\S]*^# /m.test(text), '不该再出现第二个一级标题');
  // 第二天另起一个文件
  const day2 = appendDailyDiary('# 2026-10-27 · 心情日记\n\n新的一天', { generatedAt: new Date('2026-10-27T08:00:00') });
  assert.notEqual(day2, a);
  assert.equal(fs.readdirSync(paths().diary).filter((n) => n.endsWith('_日记.md')).length, 2);
  // 日报单独一个文件
  const r = appendDailyReport('# 日报\n\n内容', { generatedAt: day1 });
  assert.match(r, /_日报\.md$/);
  assert.match(fs.readFileSync(r, 'utf8'), /09:05/);
});

test('readLatestDiary 认得新命名', () => {
  const latest = readLatestDiary();
  assert.ok(latest, '应该能读到');
  assert.match(latest.file, /_日记\.md$/);
});

test('画面按天归档，文件名带 BV', () => {
  const saved = saveFrames('BV1AAAAAAA', [{ second: 65, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }], {
    generatedAt: new Date('2026-10-26T10:00:00'),
  });
  assert.match(saved.dir, /画面[\\/]20261026$/);
  assert.match(saved.files[0].file, /BV1AAAAAAA_0065s\.jpg$/);
  assert.ok(fs.existsSync(saved.files[0].file));
});
