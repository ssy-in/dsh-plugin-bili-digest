// 标题拆词：目前只记录、不参与排序（titleTokenWeight=0）。
// 这里钉住的是切法本身：整词优先、废词丢弃、情绪词单列、日志可汇总。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-titles-'));
process.env.BILI_DIGEST_HOME = HOME;

const { splitTitle, recordTitleTokens, readTitleLog, summarizeTitles, resetTitleLog, TITLE_EMOTION } = await import('../lib/core/titles.js');

test('词典里的整词优先，不会被切成碎词', () => {
  const { tokens } = splitTitle('大肥鱼 harware 修复实录｜DeepSeek 新玩具', { dictionary: ['大肥鱼', 'deepseek'] });
  const words = tokens.map((item) => item.token);
  assert.ok(words.includes('大肥鱼'));
  assert.ok(words.includes('deepseek'));
  assert.ok(!words.includes('大肥'), '已知整词不该再被切成 bigram');
});

test('废词与情绪词不进词元，情绪词单独一栏', () => {
  const { tokens, emotion } = splitTitle('震惊！这个视频为什么这么离谱');
  const words = tokens.map((item) => item.token);
  for (const stop of ['视频', '这个', '为什么']) assert.ok(!words.includes(stop), `${stop} 是废词`);
  assert.deepEqual(emotion.sort(), ['震惊', '离谱'].sort());
  assert.ok(TITLE_EMOTION.includes('震惊'));
});

test('英文按词、中文按 2-gram，且每块最多 4 个', () => {
  const { tokens } = splitTitle('千星奇域 lua 脚本教程');
  const words = tokens.map((item) => item.token);
  assert.ok(words.includes('lua'));
  assert.ok(words.some((word) => word.length === 2));
  assert.ok(words.length <= 12);
});

test('recordTitleTokens 写进 cache/titles.jsonl，并标出命中已有权重的词', () => {
  resetTitleLog();
  const entry = recordTitleTokens({ bvid: 'BV1aa411c7aa', title: '大肥鱼 又来整活了', known: ['大肥鱼', '整活'] });
  assert.ok(entry.tokens.includes('大肥鱼'));
  assert.ok(entry.hits.includes('大肥鱼'));
  const log = readTitleLog(10);
  assert.equal(log.length, 1);
  assert.equal(log[0].bvid, 'BV1aa411c7aa');
  assert.equal(log[0].title, '大肥鱼 又来整活了');
  const file = path.join(HOME, 'cache', 'titles.jsonl');
  assert.ok(fs.existsSync(file));
});

test('summarizeTitles 汇总出高频词与命中率', () => {
  resetTitleLog();
  recordTitleTokens({ bvid: 'BV1aa411c7aa', title: '大肥鱼 整活', known: ['大肥鱼'] });
  recordTitleTokens({ bvid: 'BV1bb411c7bb', title: '大肥鱼 直播', known: ['大肥鱼'] });
  const summary = summarizeTitles({ limit: 50 });
  assert.equal(summary.entries, 2);
  assert.equal(summary.hitEntries, 2);
  assert.equal(summary.hitRate, 1);
  assert.equal(summary.top[0][0], '大肥鱼');
  assert.ok(summary.distinctTokens >= 2);
});

test('resetTitleLog 清空日志，空日志汇总不炸', () => {
  resetTitleLog();
  const summary = summarizeTitles({});
  assert.equal(summary.entries, 0);
  assert.equal(summary.hitRate, 0);
  assert.deepEqual(summary.top, []);
});
