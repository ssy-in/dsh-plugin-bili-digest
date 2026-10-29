// 标签库与偏好识别的离线测试（文件写到临时目录，不碰真实数据）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-tags-'));
process.env.BILI_DIGEST_HOME = HOME;

const { addToTagBook, readTagBook, entriesFromSections, topTags, renderTagBook, syncTagBook, detectPreference, detectNudge } = await import(
  '../lib/core/tagbook.js'
);

test('addToTagBook 同一个 BV 只留一条，后到的标签合并', () => {
  addToTagBook([{ bvid: 'BV1aa411c7aa', title: '第一条', tags: ['deepseek', 'AI'] }], 'mine', new Date('2026-10-24T10:00:00Z'));
  addToTagBook([{ bvid: 'BV1aa411c7aa', title: '第一条（改过标题）', tags: ['科普'] }], 'mine', new Date('2026-10-24T11:00:00Z'));
  const book = readTagBook();
  assert.equal(book.mine.length, 1);
  assert.deepEqual(book.mine[0].tags, ['科普']);
  assert.equal(book.mine[0].title, '第一条（改过标题）');
});

test('两栏互不影响：人类的喜欢进 his，不进 mine', () => {
  addToTagBook([{ bvid: 'BV1bb411c7bb', title: '人类点的', tags: ['大肥鱼'] }], 'his');
  const book = readTagBook();
  assert.equal(book.his.length, 1);
  assert.equal(book.mine.length, 1);
  assert.equal(book.his[0].bvid, 'BV1bb411c7bb');
});

test('entriesFromSections 从一轮结果里抽条目（meta.bvid / meta.tags）', () => {
  const sections = [
    { meta: { bvid: 'BV1cc411c7cc', title: '标题一', tags: ['a', 'b'] }, picked: [] },
    { bvid: 'BV1dd411c7dd', meta: { title: '标题二' } },
    { meta: { title: '没有 BV，丢掉' } },
  ];
  const entries = entriesFromSections(sections, { note: '心情：低电量' });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].tags, ['a', 'b']);
  assert.equal(entries[0].note, '心情：低电量');
  assert.equal(entries[1].tags.length, 0);
});

test('topTags 按出现次数排序，同数量按名字', () => {
  const hot = topTags([
    { tags: ['x', 'y'] },
    { tags: ['x', 'z'] },
    { tags: ['x', 'z'] },
  ]);
  assert.deepEqual(hot[0], ['x', 3]);
  assert.deepEqual(hot[1], ['z', 2]);
  assert.deepEqual(hot[2], ['y', 1]);
});

test('renderTagBook 两栏都在，空栏有提示', () => {
  const markdown = renderTagBook({
    mine: [{ bvid: 'BV1ee411c7ee', title: '甲|乙', tags: ['标签1'] }],
    his: [],
    generatedAt: new Date('2026-10-24T12:00:00Z'),
  });
  assert.match(markdown, /# 标签库/);
  assert.match(markdown, /我喜欢的（我看上的）/);
  assert.match(markdown, /人类喜欢的（你说喜欢的）/);
  assert.match(markdown, /还没有。你在评论里说喜欢/);
  assert.match(markdown, /甲\\\|乙/); // 竖线被转义，不会破坏表格
  assert.match(markdown, /高频标签：标签1×1/);
});

test('syncTagBook 在输出目录里生成「标签库.md」', () => {
  const { file } = syncTagBook(new Date('2026-10-24T13:00:00Z'));
  assert.ok(fs.existsSync(file));
  assert.match(path.basename(file), /标签库\.md$/);
  assert.match(fs.readFileSync(file, 'utf8'), /标签库/);
});

test('detectPreference 只认明确表态', () => {
  assert.equal(detectPreference('这个我喜欢，多来点'), 'like');
  assert.equal(detectPreference('不错 好看'), 'like');
  assert.equal(detectPreference('这种别推荐了，不喜欢'), 'dislike');
  assert.equal(detectPreference('刚刚回你了'), null);
  assert.equal(detectPreference(''), null);
  assert.equal(detectPreference(null), null);
});

test('detectNudge 认出「教口味」的话，且必须排在喜欢之前', () => {
  assert.equal(detectNudge('多看点这样的'), 'nudge_up');
  assert.equal(detectNudge('这种可以多来点'), 'nudge_up');
  assert.equal(detectNudge('这条线加权重'), 'nudge_up');
  assert.equal(detectNudge('少看点这类'), 'nudge_dn');
  assert.equal(detectNudge('这种降点权重'), 'nudge_dn');
  // 关键：这句话两边都命中，必须先当指令（否则会被当成人类自己喜欢，错收进他的收藏夹）。
  assert.equal(detectPreference('多来点这种的'), 'like');
  assert.equal(detectNudge('多来点这种的'), 'nudge_up');
  // 不带指向词的话不算指令（「我喜欢」不是「我教你怎么调」）。
  assert.equal(detectNudge('这个我喜欢'), null);
  assert.equal(detectNudge(''), null);
  assert.equal(detectNudge(null), null);
});
