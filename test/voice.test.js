// 人设话术池测试：不联网。保证「像活人、不重复、不自称 AI」。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-voice-'));
process.env.BILI_DIGEST_HOME = home;

const { PACKS, SELF, pickLine, peekLine, commitLine, readHistory, resetHistory, poolSize } = await import('../lib/core/voice.js');

test('话术池：每句都短、一句、不带 @、不自称 AI', () => {
  for (const [intent, pack] of Object.entries(PACKS)) {
    assert.ok(pack.length >= 3, `${intent} 至少 3 条`);
    for (const line of pack) {
      assert.ok(line.length >= 8 && line.length <= 40, `${intent} 长度不合规：${line}`);
      assert.doesNotMatch(line, /@/);
      assert.doesNotMatch(line, /AI|人工智能|模型|机器人|助手|系统/);
      assert.equal(line.trim().split('\n').length, 1);
      // 人类定的：少用标点，一句 0–2 个，用空格断句
      const marks = (line.match(/[，。、；：！？,.;:!?…「」（）()]/g) || []).length;
      assert.ok(marks <= 2, `${intent} 标点太多：${line}`);
    }
  }
});

test('推视频的问尾：短而口语，有时干脆不问', async () => {
  const { ASK_TAILS, withTail } = await import('../lib/core/voice.js');
  for (const tail of ASK_TAILS) assert.ok(tail.length <= 4, `问尾太长：${tail}`);
  assert.ok(ASK_TAILS.includes(''), '要有不问的情况');
  assert.equal(withTail('鲸鲸挖到宝了', 0), '鲸鲸挖到宝了 怎么样？');
  assert.equal(withTail('鲸鲸挖到宝了', 0.99), '鲸鲸挖到宝了');
  assert.doesNotMatch(withTail('x', 0.1), /你看看这个怎么样/);
});

test('pickLine: 30 天内不重复，自称在 SELF 里，{self} 被替换掉', () => {
  resetHistory();
  const seen = new Set();
  const total = poolSize('like');
  for (let index = 0; index < total; index += 1) {
    const line = pickLine('like', { seed: 0 });
    assert.ok(!seen.has(line.key), '同一句不该连着抽到两次');
    seen.add(line.key);
    assert.ok(SELF.includes(line.self));
    assert.doesNotMatch(line.text, /\{self\}/);
  }
  // 池子用光之后能从头再来，不会抛错。
  const again = pickLine('like', { seed: 0 });
  assert.ok(again.text.length > 0);
});

test('commitLine: 说出去的那句会被记住，之后不再挑到', () => {
  resetHistory();
  const peeked = peekLine('guest', { seed: 0 });
  const before = readHistory().lines.length;
  peekLine('guest', { seed: 0 });
  assert.equal(readHistory().lines.length, before, 'peek 不记账');
  commitLine(peeked);
  assert.equal(readHistory().lines.length, before + 1);
  const next = peekLine('guest', { seed: 0 });
  assert.notEqual(next.key, peeked.key);
});

test('疲劳话术说的是饭和力气，不是「额度/API」这种机器话', () => {
  for (const line of PACKS.fatigue) {
    assert.match(line, /饭|力气|劲儿/);
    assert.doesNotMatch(line, /额度|配额|API|token/);
  }
});

test('自己收藏时那句短评带「人类主人」，不 @ 他', () => {
  for (const line of PACKS.own_favorite) {
    assert.match(line, /人类主人|人类/);
    assert.doesNotMatch(line, /@/);
  }
});

test('未知意图直接报错，不要静默返回空话', () => {
  assert.throws(() => pickLine('nope'), /未知的话术意图/);
});
