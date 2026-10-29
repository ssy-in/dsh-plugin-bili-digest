import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-weights-cap-'));
process.env.BILI_DIGEST_HOME = HOME;

const { addSignal, tagWeight, scoreTags, readWeights, resetWeights } = await import('../lib/core/weights.js');

test('常看的标签不会无限涨：写入时先衰减，且有上限', () => {
  resetWeights('whale');
  // 模拟 180 天里每天看一条 5 标签的视频，其中都含 deepseek
  let day = new Date('2026-01-01T10:00:00');
  for (let i = 0; i < 180; i += 1) {
    addSignal({
      tags: ['deepseek', 'harness', 'agent', '编程', 'AI'],
      signal: 'like',
      now: day,
    });
    day = new Date(day.getTime() + 86_400_000);
  }
  const state = readWeights('whale');
  const entry = state.tags.deepseek;
  assert.ok(entry.fast <= 0.8 + 1e-9, `fast 应被上限压住，实际 ${entry.fast}`);
  assert.ok(entry.slow <= 1.2 + 1e-9, `slow 应被上限压住，实际 ${entry.slow}`);
  const weight = tagWeight('deepseek', state, day);
  // 单标签权重有天花板（快慢两层合起来 + 人设先验），不该像以前那样一路涨到 20+
  assert.ok(weight < 2.2, `标签权重应有天花板，实际 ${weight}`);
  const score = scoreTags(['deepseek', 'harness', 'agent', '编程', 'AI'], { state, now: day }).score;
  assert.ok(score < 4, `标签组得分应有天花板，实际 ${score}`);
  // 但确实比只看了几次的标签高
  const rare = tagWeight('harness', state, day);
  assert.ok(weight > 0);
  assert.ok(rare > 0);
});
