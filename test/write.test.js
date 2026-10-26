// 写操作层的纯逻辑测试：不联网、不发请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-write-'));
process.env.BILI_DIGEST_HOME = home;

const { roleForVideo, oneLine, buildComment, pushState, recordPush, pushPlan, markPushStart, maybeMarkPushStart, localDayStartIso, ownLedger, recordOwn, FOLDER_ROLES } = await import('../lib/core/write.js');
const { validateCsrf } = await import('../lib/core/config.js');

const section = {
  bvid: 'BV1xxxxxxxxx',
  meta: { title: '凝胶假人实测' },
  picked: [{ text: '从电锯惊魂的钻头陷阱说起，用凝胶假人替真人挨，第一刀就把南瓜劈成两半，后面假人的头整个掉下去。' }],
};

test('roleForVideo: deepseek 相关的进 deepseek 夹', () => {
  assert.equal(roleForVideo({ title: '关于 DeepSeek 的语音朗读', summary: '' }), 'deepseek');
  assert.equal(roleForVideo({ title: '大肥鱼日常', summary: '' }), 'deepseek');
  assert.equal(roleForVideo({ title: 'deepseek-harness 上手', summary: '' }), 'deepseek');
});

test('roleForVideo: 和心情关键词对上的进 mood 夹', () => {
  const mood = { tone: '低电量', keywords: ['轻松', '治愈'] };
  assert.equal(roleForVideo({ mood, title: '一个很治愈的下午', summary: '' }), 'mood');
  assert.equal(roleForVideo({ mood, title: '别的视频', summary: '' }), 'misc');
  assert.equal(roleForVideo({}), 'misc');
});

test('roleForVideo: 判负的内容进 reject 夹', () => {
  assert.equal(roleForVideo({ rejected: true }), 'reject');
  assert.equal(roleForVideo({ rejected: true, title: '关于 deepseek 的割韭菜教程' }), 'reject');
  assert.equal(roleForVideo({ title: '关于 deepseek 的教程' }), 'deepseek');
});

test('oneLine: 取第一句有意义的，长句退到逗号', () => {
  const line = oneLine(section);
  assert.ok(line.length > 0);
  assert.ok(line.length <= 71, `应当被截断，实际 ${line.length}`);
  assert.ok(!line.includes('。'), '不应残留句号');
  assert.equal(oneLine({}), '');
});

test('buildComment: 心情 + 为什么 + 一句话 + @', () => {
  const text = buildComment({ mood: { tone: '低电量', keywords: ['轻松', '治愈'] }, section, atName: '主公' });
  assert.ok(text.startsWith('@主公 '));
  assert.ok(text.includes('今天低电量'));
  assert.ok(text.includes('轻松、治愈'));
  assert.ok(text.includes('值得给人类看看'));
  assert.ok(!text.includes('主人'), '不该再叫主人');
  assert.ok(text.split('\n').length === 2, '应当是两行：心情一行、总结一行');
  // 心情值不外显：评论里不能出现分数。
  assert.ok(!/心情分|0\.\d{2}/.test(text), `评论不该出现分数：${text}`);
});

test('buildComment: 传了心情话就直接用那句话，不再拼档位词', () => {
  const text = buildComment({ mood: { tone: '低电量', keywords: [] }, section, atName: '主公', phrase: '今天有点蔫' });
  assert.ok(text.includes('今天有点蔫'), text);
  assert.ok(!text.includes('今天心情：'), text);
});

test('buildComment: 关键词模式不说「按关键词」这种机器话', () => {
  const text = buildComment({ mood: { tone: '按关键词', keywords: ['deepseek'] }, section });
  assert.ok(!text.includes('按关键词'));
  assert.ok(text.includes('今天心情还不错'));
  assert.ok(text.startsWith('今天心情'), '没给 @ 名字时不该有 @ 前缀');
});

test('validateCsrf: 只收 cookie 安全字符', () => {
  assert.equal(validateCsrf(' 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d '), '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d');
  assert.throws(() => validateCsrf('abc; other=1'), /非法字符/);
  assert.throws(() => validateCsrf(123), /字符串/);
  assert.throws(() => validateCsrf(''), /非法字符/);
});

test('pushState/recordPush: 长/短两条赛道，测试期各 9 条，10 天后回落到 5/3', () => {
  const day = new Date('2026-10-24T09:00:00');
  const config = { pushTestStart: new Date('2026-10-24T09:00:00').toISOString(), pushReduceAfterDays: 10 };
  const first = pushState(day, config);
  assert.equal(first.count, 0);
  assert.equal(first.plan.phase, 'test');
  assert.equal(first.plan.longLimit, 9);
  assert.equal(first.plan.shortLimit, 9);
  assert.equal(first.remaining, 18);

  let state = first;
  for (let i = 1; i <= 9; i += 1) state = recordPush({ bvid: `BVlong${i}`, track: 'long' }, day, config);
  assert.equal(state.tracks.long, 9);
  assert.equal(state.longRemaining, 0);
  assert.equal(state.shortRemaining, 9);
  for (let i = 1; i <= 9; i += 1) state = recordPush({ bvid: `BVshort${i}`, track: 'short' }, day, config);
  assert.equal(state.remaining, 0);

  // 换一天账本清零
  const nextDay = pushState(new Date('2026-10-25T00:10:00'), config);
  assert.equal(nextDay.count, 0);
  assert.equal(nextDay.remaining, 18);

  // 10 天之后回落到长 5 + 短 3
  const later = pushPlan(config, new Date('2026-11-05T09:00:00'));
  assert.equal(later.phase, 'normal');
  assert.equal(later.longLimit, 5);
  assert.equal(later.shortLimit, 3);

  assert.deepEqual(FOLDER_ROLES.liked.title, '人类主人喜欢的视频');
  assert.deepEqual(FOLDER_ROLES.reject.title, '我不喜欢的视频');
});

test('markPushStart/maybeMarkPushStart: 只在「一天真发够一半额度」时落定测试起点', () => {
  const saved = [];
  const forced = markPushStart({}, (patch) => saved.push(patch), new Date('2026-10-24T09:00:00Z'));
  assert.equal(forced, '2026-10-24T09:00:00.000Z');
  assert.equal(markPushStart({ pushTestStart: 'x' }, (patch) => saved.push(patch)), 'x', '已经有起点就不再写');

  // 当天只发了 8 条（不到 18 的一半）→ 不开始倒计时
  const day = new Date('2026-12-01T09:00:00');
  let config = {};
  for (let i = 1; i <= 8; i += 1) {
    recordPush({ bvid: `BVhalf${i}`, track: 'long' }, day, config, (patch) => Object.assign(config, patch));
  }
  assert.equal(maybeMarkPushStart(config, () => {}, day), '', '没发够量就不落起点');
  assert.equal(config.pushTestStart, undefined);

  // 另一天先发 8 条仍不落定，第 9 条才落定当天 0 点
  const day2 = new Date('2026-12-02T10:00:00');
  const writes = [];
  let cfg2 = {};
  for (let i = 1; i <= 8; i += 1) {
    recordPush({ bvid: `BVnine-${i}`, track: 'long' }, day2, cfg2, (patch) => Object.assign(cfg2, patch));
  }
  assert.equal(cfg2.pushTestStart, undefined, '第 8 条还不落定');
  const after = recordPush({ bvid: 'BVnine', track: 'long' }, day2, cfg2, (patch) => writes.push(patch));
  assert.equal(writes.length, 1, '第 9 条落定起点');
  assert.equal(writes[0].pushTestStart, localDayStartIso(day2));
  assert.equal(after.plan.phase, 'test', '刚落定仍在测试期');
  assert.equal(pushPlan({ pushTestStart: writes[0].pushTestStart }, new Date('2026-12-13T10:00:00')).phase, 'normal', '10 天后转常态');
});

test('ownLedger/recordOwn: 只给公开短评计数，收藏照收，跨日清零', () => {
  const day = new Date('2026-10-24T09:00:00');
  assert.equal(ownLedger(day).comments, 0);
  recordOwn({ bvid: 'BV1', commented: true }, day);
  recordOwn({ bvid: 'BV2', commented: false }, day);
  const ledger = ownLedger(day);
  assert.equal(ledger.comments, 1);
  assert.equal(ledger.kept.length, 2);
  assert.equal(ownLedger(new Date('2026-10-25T09:00:00')).comments, 0);
  assert.deepEqual(FOLDER_ROLES.own.title, '鲸鲸自己收藏的');
});

test('cleanup', () => {
  fs.rmSync(home, { recursive: true, force: true });
});
