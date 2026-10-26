// 心情日记：给自己看的那份。比报告更私人、更细，带情绪脉络与留白。
import { escapeMarkdown, videoUrl } from './render.js';
import { stamp } from './segment.js';
import { explainMood } from './mood.js';
import { renderMoodLine } from './persona.js';
import { describeWeather } from './weather.js';

const firstSentence = (text, maxLength = 70) => {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const cut = value.split(/(?<=[。！？!?；;])/)[0] || value;
  const picked = cut.length > maxLength ? `${cut.slice(0, maxLength)}…` : cut;
  return escapeMarkdown(picked, { maxLength: maxLength + 20 });
};

const densityLabel = (charsPerMinute) => {
  const value = Number(charsPerMinute) || 0;
  if (value >= 25) return '信息很密，得专心';
  if (value >= 14) return '中等，边看边想';
  return '偏轻，可以放着当背景音';
};

const dateLabel = (generatedAt) => {
  const date = generatedAt instanceof Date ? generatedAt : new Date(generatedAt || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** 把几条视频的钩子句串成一条情绪线，而不是罗列。只有一条视频时，用它自己的几个钩子走起/承/转/收。 */
function renderArc(sections) {
  if (!sections.length) return ['> 今天没有读进去任何一条。', ''];
  if (sections.length === 1) {
    const section = sections[0];
    const title = escapeMarkdown(section.meta.title, { maxLength: 40 });
    const beats = (section.picked || []).slice(0, 4);
    if (!beats.length) return [`- **起**｜${title}：${firstSentence(section.meta.title, 80)}`, ''];
    const labels = ['起', '承', '转', '收'];
    return beats.map((segment, index) => {
      const label = labels[Math.min(index, labels.length - 1)];
      return `- **${label}**｜${title}：${firstSentence(segment.text, 80)}（[${stamp(segment.from)}](${videoUrl(section.meta.bvid, segment.from)})）`;
    });
  }
  const hooks = sections.map((section) => ({
    title: escapeMarkdown(section.meta.title, { maxLength: 40 }),
    hook: firstSentence(section.picked?.[0]?.text || section.meta.title, 80),
    at: section.picked?.[0]?.from ?? 0,
  }));
  const lines = [];
  const quarter = Math.max(1, Math.ceil(hooks.length / 4));
  const buckets = [
    ['起', hooks.slice(0, quarter)],
    ['承', hooks.slice(quarter, quarter * 2)],
    ['转', hooks.slice(quarter * 2, quarter * 3)],
    ['收', hooks.slice(quarter * 3)],
  ].filter(([, items]) => items.length);
  for (const [label, items] of buckets) {
    for (const item of items) {
      lines.push(`- **${label}**｜${item.title}：${item.hook}（[${stamp(item.at)}](${videoUrl(sections[hooks.indexOf(item)]?.meta.bvid || '', item.at)})）`);
    }
  }
  return lines;
}

/**
 * 渲染心情日记。
 * @param {{mood: object, sections: object[], skipped: object[], stats: object, generatedAt?: Date}} input
 */
export function renderDiary({ mood, sections, shorts = [], skipped = [], stats, generatedAt = new Date(), feeling, weather, humanLine }) {
  const lines = [];
  const date = dateLabel(generatedAt);
  lines.push(`# ${date} · 心情日记`);
  lines.push('');
  // 两个人分开放：先是我此刻的状态，再是人类主人的处境。
  if (feeling) {
    lines.push(renderMoodLine(feeling, weather));
    lines.push('');
  } else if (weather?.available) {
    lines.push(`**外面的天气**：${escapeMarkdown(describeWeather(weather), { maxLength: 120 })}`);
    lines.push('');
  }
  if (humanLine) {
    lines.push(`**${escapeMarkdown(humanLine, { maxLength: 200 })}**`);
    lines.push('');
  }
  if (mood?.raw) {
    lines.push(`> 我说的是：「${escapeMarkdown(mood.raw, { maxLength: 200 })}」`);
    lines.push('');
  }
  lines.push(`**当时的心情**：${escapeMarkdown(mood?.tone || '未命名', { maxLength: 30 })}${mood?.preset ? `（档位：${escapeMarkdown(mood.preset.label, { maxLength: 30 })}）` : ''}`);
  lines.push('');
  if (mood) {
    lines.push(`**为什么给我找这些**：${explainMood(mood)}`);
    lines.push('');
  }

  lines.push('## 一句话回顾');
  lines.push('');
  lines.push('> （留给现在的我写：今天这轮，值不值得？）');
  lines.push('');

  if (sections.length || shorts.length) {
    lines.push('## 今天看了什么');
    lines.push('');
    lines.push('| # | 标题 | UP | 时长 | 密度 |');
    lines.push('| --- | --- | --- | --- | --- |');
    sections.forEach((section, index) => {
      lines.push(
        `| ${index + 1} | [${escapeMarkdown(section.meta.title, { maxLength: 60 })}](${videoUrl(section.meta.bvid)}) | ` +
          `${escapeMarkdown(section.meta.up, { maxLength: 24 })} | ${stamp(section.meta.duration)} | ${densityLabel(section.charsPerMinute)} |`,
      );
    });
    shorts.forEach((short, index) => {
      lines.push(
        `| ${sections.length + index + 1} | [${escapeMarkdown(short.meta.title, { maxLength: 60 })}](${videoUrl(short.meta.bvid)}) | ` +
          `${escapeMarkdown(short.meta.up || '', { maxLength: 24 })} | ${stamp(short.meta.duration)} | 短视频（看画面） |`,
      );
    });
    lines.push('');
  } else {
    lines.push('## 今天看了什么');
    lines.push('');
    lines.push('> 没有可读的视频（没有字幕的都跳过了）。');
    lines.push('');
  }

  sections.forEach((section, index) => {
    const picked = section.picked || [];
    const hook = picked[0];
    const quote = picked.find((segment) => segment !== hook) || hook;
    lines.push(`### ${index + 1}. ${escapeMarkdown(section.meta.title, { maxLength: 90 })}`);
    lines.push('');
    lines.push(
      `${escapeMarkdown(section.meta.up, { maxLength: 40 })} ｜ ${stamp(section.meta.duration)} ｜ ` +
        `字幕 ${section.chars} 字（${Math.round(section.charsPerMinute)} 字/分，${densityLabel(section.charsPerMinute)}）`,
    );
    lines.push('');
    if (hook) lines.push(`- **看点**：[${stamp(hook.from)}](${videoUrl(section.meta.bvid, hook.from)}) ${escapeMarkdown(hook.text, { maxLength: 200 })}`);
    if (quote && quote !== hook) {
      lines.push(`- **金句**：[${stamp(quote.from)}](${videoUrl(section.meta.bvid, quote.from)}) > ${escapeMarkdown(quote.text, { maxLength: 200 })}`);
    }
    for (const segment of picked.slice(2, 5)) {
      lines.push(`- 顺带：[${stamp(segment.from)}](${videoUrl(section.meta.bvid, segment.from)}) ${escapeMarkdown(segment.text, { maxLength: 140 })}`);
    }
    lines.push(`- **我记一笔**：`);
    lines.push('');
  });

  shorts.forEach((short, index) => {
    lines.push(`### ${sections.length + index + 1}. ${escapeMarkdown(short.meta.title, { maxLength: 90 })}`);
    lines.push('');
    const tags = (short.tags || short.meta.tags || []).slice(0, 10).join('、') || '（没拿到标签）';
    lines.push(
      `${escapeMarkdown(short.meta.up || '', { maxLength: 40 })} ｜ ${stamp(short.meta.duration)} ｜ 标签：${escapeMarkdown(tags, { maxLength: 160 })}`,
    );
    if (short.frames?.length) {
      lines.push('');
      lines.push(`- **画面**：${short.frames.length} 帧${short.frameDir ? `（${escapeMarkdown(short.frameDir, { maxLength: 120 })}）` : ''}`);
    }
    lines.push(`- **我记一笔**：`);
    lines.push('');
  });

  lines.push('## 情绪脉络');
  lines.push('');
  const arc = renderArc(sections);
  lines.push(...arc);
  lines.push('');
  if (sections.length) {
    const densities = sections.map((section) => Math.round(section.charsPerMinute));
    const average = Math.round(densities.reduce((sum, value) => sum + value, 0) / densities.length);
    const longest = sections.reduce((best, section) => (section.meta.duration > (best?.meta.duration || 0) ? section : best), undefined);
    lines.push(
      `- 这 ${sections.length} 条平均 ${average} 字/分，${densityLabel(average)}；最长的一条是《${escapeMarkdown(longest.meta.title, { maxLength: 40 })}》（${stamp(longest.meta.duration)}）。`,
    );
    if (stats) {
      lines.push(`- 一共扫了 ${stats.candidates} 条候选，读进去 ${sections.length} 条，字幕 ${stats.charsIn} 字里只留了 ${stats.charsOut} 字（省 ${stats.saved}%），花了 ${(stats.ms / 1000).toFixed(1)} 秒。`);
    }
  }
  lines.push('');

  if (skipped.length) {
    lines.push('## 今天没看的');
    lines.push('');
    for (const item of skipped.slice(0, 20)) {
      lines.push(`- ${escapeMarkdown(item.title || item.bvid, { maxLength: 60 })}（${escapeMarkdown(item.reason || item.verdict || '跳过', { maxLength: 60 })}）`);
    }
    lines.push('');
  }

  lines.push('## 下次想刷什么');
  lines.push('');
  lines.push('> （留一句给下次的心情）');
  lines.push('');
  return lines.join('\n');
}
