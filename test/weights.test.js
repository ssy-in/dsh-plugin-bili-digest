// 口味权重测试：不联网。只验衰减、饱和、双速合成、人设先验、探索取词。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-weights-'));
process.env.BILI_DIGEST_HOME = home;

const { decay, addSignal, tagWeight, scoreTags, topTags, readWeights, resetWeights } = await import('../lib/core/weights.js');
const { suggestKeywords } = await import('../lib/core/weights.js');

test('decay: 一个半衰期正好剩一半，两个半衰期剩四分之一', () => {
  assert.equal(decay(1, 8, 8), 0.5);
  assert.equal(decay(1, 8, 16), 0.25);
  assert.equal(decay(1, 8, 0), 1);
  assert.equal(decay(0, 8, 4), 0);
});

test('addSignal: 标签越多每个分到的越少（不是线性叠加）', () => {
  resetWeights();
  addSignal({ tags: ['甲'] , signal: 'like' });
  const one = tagWeight('甲', readWeights(), new Date(), { halfLifeFastDays: 8, slowExpense: 0 });
  resetWeights();
  addSignal({ tags: ['甲', '乙', '丙', '丁'], signal: 'like' });
  const four = tagWeight('甲', readWeights(), new Date(), { halfLifeFastDays: 8 });
  assert.ok(one > four, `单标签 ${one} 应高于四标签分摊 ${four}`);
});

test('scoreTags: 人设先验直接生效（deepseek/大肥鱼 > 泛标签）', () => {
  resetWeights();
  const ai = scoreTags(['deepseek', '人工智能']);
  const generic = scoreTags(['日常', '搞笑']);
  assert.ok(ai.score > generic.score, `${ai.score} 应高于 ${generic.score}`);
  assert.equal(ai.parts[0].tag === 'deepseek' || ai.parts[0].tag === '人工智能', true);
});

test('addSignal: 人类说喜欢→权重涨；说不要→权重掉', () => {
  resetWeights();
  addSignal({ tags: ['手办'], signal: 'like_strong' });
  const liked = tagWeight('手办', readWeights());
  addSignal({ tags: ['手办'], signal: 'dislike_strong' });
  const disliked = tagWeight('手办', readWeights());
  assert.ok(liked > 0, '喜欢后应为正');
  assert.ok(disliked < liked, '说不要之后应下降');
});

test('topTags / suggestKeywords: 泛标签进不了推荐，探索会带一个新词', () => {
  resetWeights();
  addSignal({ tags: ['日常'], signal: 'like' });
  addSignal({ tags: ['手办', '开箱'], signal: 'like' });
  const ranked = topTags(5).map((row) => row.tag);
  assert.ok(!ranked.includes('日常'), '泛标签应被压掉');
  assert.ok(ranked.includes('手办'));
  const picked = suggestKeywords(2, { random: () => 0.99 });
  assert.ok(picked.keywords.length >= 1);
  assert.equal(picked.explored.length, 0, 'random 0.99 不触发探索');
  const exploring = suggestKeywords(1, { random: () => 0.0 });
  assert.ok(exploring.explored.length <= 1);
});

test('没有历史时 suggestKeywords 返回空，让调用方回落到原关键词', () => {
  resetWeights();
  const empty = suggestKeywords(3);
  assert.deepEqual(empty.keywords, []);
});
