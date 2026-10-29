// 每周探索池的离线测试：一周只挑一次、挑的是没见过的题材、游标轮着走。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-explore-'));
process.env.BILI_DIGEST_HOME = HOME;

const { weekKey, readExplore, pickWeekly, nextTopic, advanceTopic } = await import('../lib/core/explore.js');
const { suggestKeywords } = await import('../lib/core/weights.js');

// 固定随机：取第一个候选，测试才能断言具体词。
const first = () => 0;

test('weekKey: 同一周同一个键，跨周换键', () => {
  const monday = new Date('2026-10-26T01:00:00Z');
  const sunday = new Date('2026-11-01T20:00:00Z');
  const nextMonday = new Date('2026-11-02T01:00:00Z');
  assert.equal(weekKey(monday), weekKey(sunday));
  assert.notEqual(weekKey(monday), weekKey(nextMonday));
  assert.match(weekKey(monday), /^2026-W\d{2}$/);
});

test('pickWeekly: 挑出没见过的题材，已知的和泛词都排掉', () => {
  const result = pickWeekly({
    now: new Date('2026-10-26T10:00:00Z'),
    config: { explorePerWeek: 2 },
    extra: ['钓鱼', '手工', '日常', '钓鱼'],
    known: ['钓鱼'],
    random: first,
  });
  assert.equal(result.picked, true);
  assert.deepEqual(result.topics, ['手工']);
  assert.equal(readExplore().week, weekKey(new Date('2026-10-26T10:00:00Z')));
});

test('pickWeekly: 一周内再算一次不会换题（换来换去等于哪个都没试）', () => {
  const now = new Date('2026-10-26T10:00:00Z');
  const again = pickWeekly({ now, config: { explorePerWeek: 2 }, extra: ['露营', '爬山'], known: [], random: first });
  assert.equal(again.picked, false);
  assert.deepEqual(again.topics, ['手工'], '本周已经定过了，不该改');
});

test('pickWeekly: explorePerWeek 为 0 就不探索', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-explore-zero-'));
  process.env.BILI_DIGEST_HOME = fresh;
  const result = pickWeekly({ now: new Date('2026-10-26T10:00:00Z'), config: { explorePerWeek: 0 }, extra: ['钓鱼'], random: first });
  assert.deepEqual(result.topics, []);
  process.env.BILI_DIGEST_HOME = HOME;
});

test('nextTopic / advanceTopic: 轮着用，不一直同一个词霸屏', () => {
  const state = { week: 'x', topics: ['甲', '乙'], cursor: 0 };
  assert.equal(nextTopic(state), '甲');
  assert.equal(nextTopic({ ...state, cursor: 1 }), '乙');
  assert.equal(nextTopic({ ...state, cursor: 2 }), '甲', '游标超了回到第一个');
  assert.equal(nextTopic({ week: 'x', topics: [], cursor: 0 }), '');
  // 落盘后游标推进一格
  const advanced = advanceTopic(readExplore());
  assert.equal(advanced.cursor, 1);
});

test('pickWeekly: 先挑真题材（视频标签），不够再用热词补位', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-explore-hot-'));
  process.env.BILI_DIGEST_HOME = fresh;
  const result = pickWeekly({
    now: new Date('2026-10-26T10:00:00Z'),
    config: { explorePerWeek: 2 },
    extra: ['手工'],
    hot: ['库里为什么成了罚球高手', 'TheShy赛后回应晋级八强'],
    known: [],
    random: first,
  });
  assert.deepEqual(result.topics, ['手工', '库里为什么成了罚球高手'], '热词只补位，不该挤掉真题材');
  process.env.BILI_DIGEST_HOME = HOME;
});

test('suggestKeywords: 空表也能从外面给的题材里取到词（清空后不至于只能乱刷首页）', () => {
  const empty = { tags: {}, updatedAt: '' };
  const got = suggestKeywords(2, { state: empty, extra: ['露营', '手冲咖啡'], random: first });
  assert.deepEqual(got.keywords, ['手冲咖啡', '露营'].sort((a, b) => got.keywords.indexOf(a) - got.keywords.indexOf(b)));
  assert.equal(got.keywords.length, 2);
  assert.equal(got.cold, true);
  assert.deepEqual(got.keywords.slice().sort(), ['手冲咖啡', '露营'].sort());
});

test('suggestKeywords: 有自己口味时，外面题材只当补充，不会顶掉主力', () => {
  const state = {
    tags: { 大肥鱼: { fast: 0.8, slow: 1.2, seen: 20, likes: 20, updatedAt: new Date().toISOString() } },
    updatedAt: new Date().toISOString(),
  };
  // random 固定 0：exploreRate 那只骰子永远命中，探索位一定会补一个外面的题材。
  const got = suggestKeywords(1, { state, extra: ['露营'], random: first });
  assert.ok(got.keywords.includes('大肥鱼'), `主力应该还是自己的口味，实际 ${got.keywords}`);
});
