import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-own-cap-'));
process.env.BILI_DIGEST_HOME = HOME;

const { keepForSelf, ownLedger } = await import('../lib/core/write.js');
const { readWeights, resetWeights } = await import('../lib/core/weights.js');

// 假的「B 站」：只记下收藏动作和评论，不联网。
const calls = { fav: [], comment: [] };
const deps = {
  resolveFolders: async () => ({ own: 4380950785 }),
  dealFavorite: async (_config, { aid, add }) => {
    calls.fav.push({ aid, add });
    return { code: 0 };
  },
  postComment: async (_config, { oid, message }) => {
    calls.comment.push({ oid, message });
    return { code: 0 };
  },
};

const reset = () => {
  calls.fav.length = 0;
  calls.comment.length = 0;
  fs.rmSync(path.join(HOME, 'own'), { recursive: true, force: true });
  for (const name of ['own.json', 'weights.json']) fs.rmSync(path.join(HOME, name), { force: true });
};

function fakeConfig(extra = {}) {
  return { sessdata: 'x'.repeat(20), buvid3: 'B', csrf: 'c'.repeat(20), favFolders: { own: 4380950785 }, ...extra };
}

const meta = (bvid, tags) => ({
  aid: Number(bvid.replace(/\D/g, '')) || 1,
  bvid,
  tags,
  title: `样本 ${bvid}`,
  owner: { mid: 42 },
});

test('keepForSelf：收进收藏夹才教口味，且一天有额度', async () => {
  reset();
  resetWeights('whale');
  const config = fakeConfig({ ownFavoritePerDay: 2, ownFavoriteCommentPerDay: 0, learnOnCollect: true });
  const day = new Date('2026-10-29T10:00:00');

  const first = await keepForSelf(config, { meta: meta('BV1', ['二次元', 'cos']), now: day, deps });
  assert.equal(first.favorited, true);
  assert.equal(first.keptToday, 1);
  assert.equal(calls.fav.length, 1);
  const afterFirst = readWeights('whale');
  assert.ok((afterFirst.tags['二次元']?.fast || 0) > 0, '收进收藏夹应该给标签记分');

  const second = await keepForSelf(config, { meta: meta('BV2', ['二次元', 'coser']), now: day, deps });
  assert.equal(second.favorited, true);
  assert.equal(second.keptToday, 2);

  // 额度满了：不碰收藏夹、不评论、也不教权重
  const third = await keepForSelf(config, { meta: meta('BV3', ['从未出现过的标签']), now: day, deps });
  assert.equal(third.favorited, false);
  assert.equal(third.capped, true);
  assert.equal(calls.fav.length, 2, '收满以后不该再动收藏夹');
  const afterThird = readWeights('whale');
  assert.equal(afterThird.tags['从未出现过的标签'], undefined, '收满额度后不该再记分');

  // 第二天额度重置
  const nextDay = new Date('2026-10-30T09:00:00');
  const resetOne = await keepForSelf(config, { meta: meta('BV4', ['二次元']), now: nextDay, deps });
  assert.equal(resetOne.favorited, true);
  assert.equal(resetOne.keptToday, 1);
});

test('keepForSelf：learnOnCollect 关掉就只收藏、不记分', async () => {
  reset();
  resetWeights('whale');
  const config = fakeConfig({ ownFavoritePerDay: 5, ownFavoriteCommentPerDay: 0, learnOnCollect: false });
  const kept = await keepForSelf(config, { meta: meta('BV9', ['编程']), now: new Date('2026-11-01T10:00:00'), deps });
  assert.equal(kept.favorited, true);
  const state = readWeights('whale');
  assert.equal(state.tags['编程'], undefined, '关掉以后不该写权重表');
});

test('ownLedger：只数真收进去的，收满的不算', async () => {
  reset();
  const day = new Date('2026-12-01T10:00:00');
  const config = fakeConfig({ ownFavoritePerDay: 1, ownFavoriteCommentPerDay: 0 });
  await keepForSelf(config, { meta: meta('BV21', ['甲']), now: day, deps });
  await keepForSelf(config, { meta: meta('BV22', ['乙']), now: day, deps });
  const ledger = ownLedger(day);
  const favored = ledger.kept.filter((row) => row.favorited !== false);
  assert.equal(favored.length, 1, '只有一条真进了收藏夹');
});

test('cleanup', () => {
  fs.rmSync(HOME, { recursive: true, force: true });
});
