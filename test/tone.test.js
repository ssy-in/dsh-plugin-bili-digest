// 价值观/氛围评估的纯逻辑测试：不联网。
import assert from 'node:assert/strict';
import test from 'node:test';

const { assess } = await import('../lib/core/tone.js');

test('干净的标题 + 干净弹幕：不判负', () => {
  const result = assess({ title: '用凝胶假人实测电影里的死亡陷阱', desc: '物理科普', danmaku: ['哈哈哈', '这个真有意思', '知识增加了'] });
  assert.equal(result.reject, false);
  assert.deepEqual(result.reasons, []);
});

test('标题里堆了引导性话术就判负', () => {
  const result = assess({ title: '教你骗过系统还割韭菜的智商税项目', desc: '' });
  assert.equal(result.reject, true);
  assert.ok(result.reasons[0].includes('引导性话术'));
  assert.ok(result.stats.flags.length >= 2);
});

test('弹幕骂人密度高就判负', () => {
  const danmaku = new Array(100).fill('好').map((_, index) => (index % 5 === 0 ? '这人真是个傻逼' : '还不错'));
  const result = assess({ title: '普通标题', danmaku });
  assert.equal(result.reject, true);
  assert.ok(result.reasons.some((line) => line.includes('骂人密度')));
  assert.ok(result.stats.per100 >= 3);
});

test('弹幕太少时不靠密度下判断', () => {
  const result = assess({ title: '普通标题', danmaku: ['傻逼', '傻逼'] });
  assert.equal(result.reject, false);
  assert.equal(result.stats.lines, 2);
});

test('单条骂人词在大量弹幕里不足以判负', () => {
  const danmaku = new Array(200).fill('好啊');
  danmaku[7] = '这个人是傻子吧';
  const result = assess({ title: '普通标题', danmaku });
  assert.equal(result.reject, false);
});

test('tags 也参与话术判断，且大小写无关', () => {
  const result = assess({ title: '一期节目', tags: ['带节奏', '引战'] });
  assert.equal(result.reject, true);
});

test('完全空输入也安全', () => {
  const result = assess();
  assert.equal(result.reject, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.stats, { lines: 0, profanity: 0, per100: 0, flags: [] });
});
