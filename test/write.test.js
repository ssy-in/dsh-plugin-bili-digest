// 写操作层的纯逻辑测试：不联网、不发请求。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-write-'));
process.env.BILI_DIGEST_HOME = home;

const { roleForVideo, oneLine, buildComment, pushState, recordPush, FOLDER_ROLES, PUSH_PER_DAY } = await import('../lib/core/write.js');
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
  assert.ok(text.includes('今天心情：低电量'));
  assert.ok(text.includes('轻松、治愈'));
  assert.ok(text.includes('值得给人类看看'));
  assert.ok(!text.includes('主人'), '不该再叫主人');
  assert.ok(text.split('\n').length === 2, '应当是两行：心情一行、总结一行');
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

test('pushState/recordPush: 每天最多 3 条', () => {
  const day = new Date('2026-10-24T09:00:00');
  const first = pushState(day);
  assert.equal(first.count, 0);
  assert.equal(first.remaining, PUSH_PER_DAY);
  let state = first;
  for (let i = 1; i <= PUSH_PER_DAY; i += 1) state = recordPush({ bvid: `BV${i}` }, day);
  assert.equal(state.count, PUSH_PER_DAY);
  assert.equal(state.remaining, 0);
  assert.equal(pushState(day).count, PUSH_PER_DAY);
  // 换一天账本清零
  const nextDay = pushState(new Date('2026-10-25T00:10:00'));
  assert.equal(nextDay.count, 0);
  assert.equal(nextDay.remaining, PUSH_PER_DAY);
  assert.deepEqual(FOLDER_ROLES.liked.title, '人类主人喜欢的视频');
  assert.deepEqual(FOLDER_ROLES.reject.title, '我不喜欢的视频');
});

test('cleanup', () => {
  fs.rmSync(home, { recursive: true, force: true });
});
