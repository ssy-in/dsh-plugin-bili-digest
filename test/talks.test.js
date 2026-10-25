// 对话流水与评审清单的离线测试（都写临时目录，不碰真实数据）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-talks-'));
process.env.BILI_DIGEST_HOME = HOME;

const { appendTalk, readTalks, recentHumanTalks, renderTalks, syncTalks } = await import('../lib/core/talks.js');
const { reviewState, renderReview, syncReview } = await import('../lib/core/review.js');
const { noteUnclear } = await import('../lib/core/inbox.js');
const { paths } = await import('../lib/core/store.js');

test('appendTalk 记下谁说了一句什么，读回来顺序不乱', () => {
  appendTalk({ who: 'human', text: '我喜欢这种', at: new Date('2026-10-24T10:00:00Z') });
  appendTalk({ who: 'me', text: '好，我记下了', at: new Date('2026-10-24T10:01:00Z') });
  const all = readTalks();
  assert.equal(all.length, 2);
  assert.equal(all[0].who, 'human');
  assert.equal(all[1].text, '好，我记下了');
});

test('recentHumanTalks 只挑人类说的，且只留最近几条', () => {
  appendTalk({ who: 'other', text: '路人甲' });
  appendTalk({ who: 'human', text: '第二句人类的话' });
  const human = recentHumanTalks(2);
  assert.equal(human.length, 2);
  assert.ok(human.every((item) => item.who === 'human'));
  assert.equal(human.at(-1).text, '第二句人类的话');
});

test('空内容不记；renderTalks 与 syncTalks 落到「我看视频/对话.md」', () => {
  const before = readTalks().length;
  appendTalk({ who: 'human', text: '   ' });
  assert.equal(readTalks().length, before);
  const file = syncTalks({ generatedAt: new Date('2026-10-24T10:05:00Z') });
  assert.equal(file, path.join(paths().out, '对话.md'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('人类：'));
  assert.ok(renderTalks({ limit: 1 }).includes('对话流水'));
});

test('noteUnclear 之后评审清单里能看到这条，syncReview 写出当天的 md', () => {
  noteUnclear({ comment: '这个视频不错', bvid: 'BV1aa411c7aa', guess: '喜欢', reason: '不太确定' });
  const state = reviewState(new Date(), { reviewEveryDays: 3 });
  assert.ok(state.pending >= 1);
  const wrote = syncReview({ config: { reviewEveryDays: 3 }, force: true, now: new Date('2026-10-24T10:10:00Z') });
  assert.equal(wrote.ok, true);
  const text = fs.readFileSync(wrote.file, 'utf8');
  assert.ok(text.includes('BV1aa411c7aa'));
  assert.ok(text.includes('评审'));
});

test('renderReview 没有条目时给一句人话，不是空表格', () => {
  const text = renderReview({ items: [], generatedAt: new Date('2026-10-24T10:10:00Z') });
  assert.ok(text.includes('这轮没有待评审的条目'));
});
