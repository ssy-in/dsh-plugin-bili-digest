// DSH 插件入口：注册 3 个服务端工具 + 一组只服务本插件界面的 HTTP 路由。
// 工具是给模型用的入口；路由是给「设置 → 插件」里的可视化界面用的入口。
import crypto from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runAndSave, runMood, createApi, loadConfig } from './core/digest.js';
import { readVideo, VERDICT } from './core/gate.js';
import { saveConfig, configPath, dataDir, DEFAULTS } from './core/config.js';
import { readLastDigest, readLatestDiary, paths } from './core/store.js';
import { stamp } from './core/segment.js';
import { collectFrames, saveFrames } from './core/visual.js';
import { frameCountFor, MAX_FRAMES } from './core/frames.js';
import { PRESETS } from './core/mood.js';
import { budgetState } from './core/http.js';
import { resolveFolders, dealFavorite, postComment, buildComment, roleForVideo, pushState, recordPush, pushPlan, markPushStart, vetoVideo, keepForSelf, FOLDER_ROLES, PUSH_TRACKS } from './core/write.js';
import { pickLine } from './core/voice.js';
import { runInbox, quotaState, readLedger, LIMITS } from './core/inbox.js';
import { readTagBook } from './core/tagbook.js';
import { suggestKeywords, topTags, readWeights, scoreTags } from './core/weights.js';
import { planNextRun, describeSchedule } from './core/schedule.js';
import { syncReview, reviewState } from './core/review.js';
import { recentHumanTalks, readTalks, syncTalks, appendTalk } from './core/talks.js';

export const name = 'bili-digest';

/** 该插件只依赖工具注册；界面路由在 apply 内按需注入 webServer。 */
export const inject = ['tools'];

/** 只放非敏感旋钮；SESSDATA 走 dataDir 下 0600 的私有配置，不进 profile 配置。 */
export const Config = z.object({
  minCharsPerMinute: z.number().default(DEFAULTS.minCharsPerMinute).description('字幕密度门槛（字/分钟），低于此值视为字幕残缺并丢弃'),
  limit: z.number().default(DEFAULTS.limit).description('每轮最多检查多少条候选视频'),
  days: z.number().default(DEFAULTS.days).description('只看最近 N 天发布的视频，0 表示不限'),
  maxK: z.number().default(DEFAULTS.maxK).description('单条视频最多选多少段'),
  maxSegmentChars: z.number().default(DEFAULTS.maxSegmentChars).description('单条视频入模字数上限'),
  keepReports: z.number().default(DEFAULTS.keepReports).description('保留最近多少份报告'),
  frameCount: z.number().default(DEFAULTS.frameCount).description('默认抓帧数，0 表示按视频时长自动（6/12/16/20 帧）'),
  autoFrames: z.boolean().default(DEFAULTS.autoFrames).description('没有字幕的视频自动改用分镜截图（画面速览）'),
});

const MAX_BODY = 64 * 1024;
const AUTO_ORDERS = ['pubdate', 'totalrank', 'click', 'dm', 'stow', 'scores'];
// mix：一轮 pubdate（新）+ 一轮 click（热）交替，既追新也追热。
const AUTO_ORDER_CHOICES = [...AUTO_ORDERS, 'mix'];
const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function apply(ctx, config) {
  // 旋钮的优先级：私有配置文件（界面里保存过的）> profile 配置 > 内置默认。
  const storedSettings = (() => {
    try {
      return loadConfig({ requireLogin: false });
    } catch {
      return {};
    }
  })();
  const pick = (key, min, max, fallback) => clamp(storedSettings[key] ?? config?.[key], min, max, fallback);
  const settings = {
    minCharsPerMinute: pick('minCharsPerMinute', 10, 600, DEFAULTS.minCharsPerMinute),
    limit: pick('limit', 1, 30, DEFAULTS.limit),
    days: pick('days', 0, 3650, DEFAULTS.days),
    maxK: pick('maxK', 1, 20, DEFAULTS.maxK),
    maxSegmentChars: pick('maxSegmentChars', 400, 12000, DEFAULTS.maxSegmentChars),
    keepReports: pick('keepReports', 1, 200, DEFAULTS.keepReports),
    frameCount: pick('frameCount', 0, MAX_FRAMES, DEFAULTS.frameCount),
    minDuration: pick('minDuration', 0, 3600, DEFAULTS.minDuration),
    // 短视频赛道：≤N 秒的视频不看字幕，只抓画面 + 看标签（0 = 关掉）。
    shortVideoMax: pick('shortVideoMax', 0, 1800, DEFAULTS.shortVideoMax),
    shortFrames: pick('shortFrames', 0, 8, DEFAULTS.shortFrames),
    shortFramesNoSub: pick('shortFramesNoSub', 0, 10, DEFAULTS.shortFramesNoSub),
    maxVideos: pick('maxVideos', 0, 10, DEFAULTS.maxVideos),
    autoFrames: (storedSettings.autoFrames ?? config?.autoFrames ?? DEFAULTS.autoFrames) !== false,
    // 「隔 N 分钟自动刷一条」的慢节奏（0=关闭）；只在宿主跑着的时候生效，每轮读 settings.maxVideos 条。
    autoEveryMinutes: pick('autoEveryMinutes', 0, 1440, DEFAULTS.autoEveryMinutes),
    autoMoodText:
      typeof (storedSettings.autoMoodText ?? config?.autoMoodText) === 'string' && String(storedSettings.autoMoodText ?? config?.autoMoodText).trim()
        ? String(storedSettings.autoMoodText ?? config?.autoMoodText).trim().slice(0, 120)
        : DEFAULTS.autoMoodText,
    // 空 = <dataDir>/我看视频：日记、速览、截图都写在这个能直接翻的目录里。
    outputDir:
      typeof (storedSettings.outputDir ?? config?.outputDir) === 'string' ? String(storedSettings.outputDir ?? config?.outputDir).trim().slice(0, 400) : DEFAULTS.outputDir,
    // 自动刷的取材方式：autoKeywords 非空就按关键词（比如 deepseek）找工作，否则用 autoMoodText 的心情句。
    autoKeywords:
      typeof (storedSettings.autoKeywords ?? config?.autoKeywords) === 'string' ? String(storedSettings.autoKeywords ?? config?.autoKeywords).trim().slice(0, 120) : DEFAULTS.autoKeywords,
    autoOrder: AUTO_ORDER_CHOICES.includes(storedSettings.autoOrder ?? config?.autoOrder)
      ? String(storedSettings.autoOrder ?? config?.autoOrder)
      : DEFAULTS.autoOrder,
    autoDays: pick('autoDays', 0, 3650, DEFAULTS.autoDays),
    // 作息：睡觉时间不刷、饭点更勤、上班时段更懒，间隔带抖动（默认开）。
    scheduleEnabled: (storedSettings.scheduleEnabled ?? config?.scheduleEnabled ?? DEFAULTS.scheduleEnabled) !== false,
    activeFrom: /^\d{1,2}:\d{2}$/.test(String(storedSettings.activeFrom ?? config?.activeFrom ?? '')) ? String(storedSettings.activeFrom ?? config?.activeFrom) : DEFAULTS.activeFrom,
    activeTo: /^\d{1,2}:\d{2}$/.test(String(storedSettings.activeTo ?? config?.activeTo ?? '')) ? String(storedSettings.activeTo ?? config?.activeTo) : DEFAULTS.activeTo,
    // 写操作（收藏 + 评论 @ 人类）：默认关，只有拿到 bili_jct 并手动打开才会动手，每天最多 3 条。
    pushEnabled: (storedSettings.pushEnabled ?? config?.pushEnabled ?? false) === true,
    atName: typeof (storedSettings.atName ?? config?.atName) === 'string' ? String(storedSettings.atName ?? config?.atName).trim().slice(0, 40) : '',
    atMid: typeof (storedSettings.atMid ?? config?.atMid) === 'string' ? String(storedSettings.atMid ?? config?.atMid).replace(/\D/g, '').slice(0, 20) : '',
    // 「看到回复就聊一句」：默认关。开了以后每轮自动刷之前先看一眼消息中心。
    replyEnabled: (storedSettings.replyEnabled ?? config?.replyEnabled ?? false) === true,
  };

  const loadMerged = () => ({ ...loadConfig(), ...settings });

  /**
   * 抓一组分镜截图。有附件服务时把帧交给宿主变成模型能看的图片块；
   * 没有（纯 CLI 或老宿主）就落盘并把路径写进文本。
   * @returns {Promise<{text:string, images:Array<object>, times:number[], dir?:string}>}
   */
  const grabFrames = async (ctx, exec, video, { count, seconds }) => {
    const api = createApi(loadMerged());
    const wanted = Math.min(
      MAX_FRAMES,
      Math.max(1, Math.round(Number(count) || settings.frameCount || frameCountFor(video.duration))),
    );
    const { plan, frames } = await collectFrames(api, video.bvid, {
      cid: video.cid,
      duration: video.duration,
      count: seconds?.length ? undefined : wanted,
      seconds: seconds?.length ? seconds : undefined,
    });
    if (frames.length === 0) return { text: `${video.bvid}：没有抓到画面`, images: [], times: [] };
    const times = frames.map((frame) => frame.second);
    const legend = frames
      .map((frame) => `- ${stamp(frame.second)} → https://www.bilibili.com/video/${video.bvid}?t=${Math.round(frame.second)}`)
      .join('\n');
    const attachments = ctx?.get?.('attachments');
    if (!attachments?.saveImage) {
      const saved = saveFrames(video.bvid, frames);
      return {
        text: `《${video.title}》（${stamp(video.duration)}）画面 ${frames.length} 帧，已存到 ${saved.dir}：\n${legend}`,
        images: [],
        times,
        dir: saved.dir,
      };
    }
    const images = [];
    for (let i = 0; i < frames.length; i += 1) {
      exec?.signal?.throwIfAborted?.();
      const frame = frames[i];
      const ref = await attachments.saveImage({
        data: frame.buffer,
        mediaType: 'image/jpeg',
        name: `${video.bvid}-${Math.round(frame.second)}s.jpg`,
      });
      images.push({
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType || 'image/jpeg',
        bytes: Number(ref.bytes) || frame.buffer.length,
        width: Number(ref.width) || frame.width,
        height: Number(ref.height) || frame.height,
        ...(ref.name ? { name: String(ref.name) } : {}),
      });
    }
    return {
      text:
        `《${video.title}》（${stamp(video.duration)}）画面 ${frames.length} 帧，按时间顺序附在下面（B 站分镜图，480×270）：\n${legend}`,
      images,
      times,
    };
  };

  const frameImageSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      attachmentId: { type: 'string', required: true },
      mediaType: { type: 'string', required: true },
      bytes: { type: 'integer', required: true },
      width: { type: 'integer', required: true },
      height: { type: 'integer', required: true },
      name: { type: 'string' },
    },
  };

  /** 文本 + 图片块的统一投影：图片块直接带 attachment 引用，宿主会在本轮结束后把图交给模型。 */
  const renderWithImages = (_args, value) => {
    const blocks = [{ type: 'text', text: String(value?.text ?? '') }];
    for (const image of Array.isArray(value?.images) ? value.images : []) {
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: image.attachmentId,
          mediaType: image.mediaType,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          ...(image.name ? { name: image.name } : {}),
        },
      });
    }
    return blocks;
  };

  const summarize = (result) => {
    const lines = [result.brief];
    const blind = (result.skipped || []).filter((item) => /no-subtitle|bad-subtitle/.test(String(item.reason || '')));
    if (blind.length > 0) {
      lines.push('', `其中 ${blind.length} 条没有可用字幕（${blind.slice(0, 3).map((item) => item.bvid).join('、')}${blind.length > 3 ? ' 等' : ''}）：想看它们的内容，用 bili_frames 抓画面。`);
    }
    if (result.report) lines.push('', `报告：${result.report}`);
    return lines.join('\n');
  };

  const runOptions = (args = {}) => ({
    keywords: Array.isArray(args.keywords) ? args.keywords.map(String) : String(args.keywords || '').split(','),
    bv: args.bv,
    days: args.days === undefined ? settings.days : clamp(args.days, 0, 3650, settings.days),
    limit: args.limit === undefined ? settings.limit : clamp(args.limit, 1, 30, settings.limit),
    k: args.k === undefined ? undefined : clamp(args.k, 1, 20, undefined),
    minCharsPerMinute:
      args.minCharsPerMinute === undefined ? settings.minCharsPerMinute : clamp(args.minCharsPerMinute, 10, 600, settings.minCharsPerMinute),
    order: ['pubdate', 'totalrank', 'click', 'dm', 'stow', 'scores'].includes(args.order) ? args.order : 'pubdate',
    config: loadMerged(),
  });

  /** 心情模式共用：把工具/界面传来的参数整理成 runMood 的入参。 */
  const moodOptions = (args = {}) => ({
    mood: typeof args.mood === 'string' ? args.mood : typeof args.text === 'string' ? args.text : '',
    preset: PRESETS.some((item) => item.id === args.preset) ? args.preset : undefined,
    days: args.days === undefined ? settings.days : clamp(args.days, 0, 3650, settings.days),
    limit: args.limit === undefined ? settings.limit : clamp(args.limit, 1, 30, settings.limit),
    k: args.k === undefined ? undefined : clamp(args.k, 1, 20, undefined),
    minDuration: args.minDuration === undefined ? settings.minDuration : clamp(args.minDuration, 0, 3600, settings.minDuration),
    minCharsPerMinute:
      args.minCharsPerMinute === undefined ? settings.minCharsPerMinute : clamp(args.minCharsPerMinute, 10, 600, settings.minCharsPerMinute),
    skipSeen: args.all === true ? false : settings.skipSeen !== false,
    // 「一小时看一条」的节奏：一轮最多读这么多条（0=不限）。
    maxVideos: args.videos === undefined ? settings.maxVideos : clamp(args.videos, 0, 10, settings.maxVideos),
    config: loadMerged(),
    // 价值观不合格的视频：静默归档到「我不喜欢的视频」，不 @、不进日记、不交给模型。
    onVeto: (item) => vetoVideo(loadMerged(), item.meta, (patch) => saveConfig(patch)),
  });

  /**
   * 收藏 + @ 人类。长视频和短视频各有一条赛道（测试期各 9 条/天，之后回落到 5/3）。
   * 缺 bili_jct 或今天这条赛道用完就顺手跳过（不报错，只写原因）。
   */
  const pushFor = async (merged, { section, mood, role, atName, atMid, text, track }) => {
    if (!section?.bvid) return { ok: false, skipped: '没有可推的视频' };
    if (!merged.hasCsrf) return { ok: false, skipped: '还没有 bili_jct，写操作没解锁' };
    const plan = pushPlan(merged);
    const which = track === PUSH_TRACKS.short ? PUSH_TRACKS.short : PUSH_TRACKS.long;
    const state = pushState(new Date(), merged);
    const left = which === PUSH_TRACKS.short ? state.shortRemaining : state.longRemaining;
    if (left <= 0) {
      return {
        ok: false,
        skipped:
          which === PUSH_TRACKS.short
            ? `今天短视频已经 @ 了 ${state.tracks.short} 条（上限 ${plan.shortLimit}）`
            : `今天长视频已经 @ 了 ${state.tracks.long} 条（上限 ${plan.longLimit}）`,
      };
    }
    const pickedRole = FOLDER_ROLES[role] ? role : roleForVideo({ mood, title: section.meta?.title, summary: section.meta?.desc || '' });
    const api = createApi(merged);
    const video = await api.view(section.bvid);
    const folders = await resolveFolders(merged, (patch) => saveConfig(patch));
    const mediaId = folders[pickedRole];
    if (mediaId) await dealFavorite(merged, { aid: video.aid, add: [mediaId] });
    const mention = atName || settings.atName;
    const mid = atMid || settings.atMid;
    const message = text || buildComment({ mood, section, atName: mention });
    if (!mention || !mid) {
      const after = recordPush({ bvid: section.bvid, role: pickedRole, text: message, track: which }, new Date(), merged, (patch) => saveConfig(patch));
      return { ok: true, comment: false, role: pickedRole, favorite: Boolean(mediaId), message, left: which === PUSH_TRACKS.short ? after.shortRemaining : after.longRemaining };
    }
    const posted = await postComment(merged, { oid: video.aid, message, atName: mention, atMid: mid });
    const after = recordPush({ bvid: section.bvid, role: pickedRole, rpid: posted.rpid, text: message, track: which }, new Date(), merged, (patch) => saveConfig(patch));
    return {
      ok: true,
      comment: true,
      role: pickedRole,
      favorite: Boolean(mediaId),
      rpid: posted.rpid,
      message,
      track: which,
      left: which === PUSH_TRACKS.short ? after.shortRemaining : after.longRemaining,
      totalLeft: after.remaining,
    };
  };

  /** 心情模式结果的统一文本投影：模型看这段就知道刷了什么、日记写在哪。 */
  const moodSummary = (result) => {
    const mood = result.mood || {};
    const lines = [
      `心情：${mood.tone || '随意'}${mood.preset ? `（${mood.preset.label}）` : ''}｜关键词：${(mood.keywords || []).join('、') || '无'}`,
      result.brief,
    ];
    const blind = (result.skipped || []).filter((item) => /no-subtitle|bad-subtitle/.test(String(item.reason || '')));
    if (blind.length > 0) {
      lines.push('', `其中 ${blind.length} 条没有可用字幕：想看它们就用 bili_frames 抓画面。`);
    }
    const vetoed = (result.skipped || []).filter((item) => item.verdict === 'rejected');
    if (vetoed.length > 0) {
      lines.push(
        '',
        `另有 ${vetoed.length} 条内容和价值观不合（${vetoed
          .slice(0, 3)
          .map((item) => item.bvid)
          .join('、')}${vetoed.length > 3 ? ' 等' : ''}）：已静默归档到「我不喜欢的视频」，没进日记、也没 @ 人类。`,
      );
    }
    if (result.diary) lines.push('', `心情日记（给自己看）：${result.diary}`);
    if (result.report) lines.push(`速览报告（给模型读）：${result.report}`);
    const extraDiaries = (result.files?.diary || []).filter((file) => file && file !== result.diary);
    const extraReports = (result.files?.report || []).filter((file) => file && file !== result.report);
    if (extraDiaries.length) lines.push(`另外还有 ${extraDiaries.length} 份日记：${extraDiaries.join('、')}`);
    if (extraReports.length) lines.push(`另外还有 ${extraReports.length} 份日报：${extraReports.join('、')}`);
    try {
      const state = reviewState(new Date(), loadMerged());
      if (state.pending) lines.push(`待评审 ${state.pending} 条（到点会自动写「评审」清单给你看）`);
    } catch {
      /* 评审状态读不到就算了 */
    }
    return lines.join('\n');
  };

  // ---- 工具：模型侧入口 -------------------------------------------------
  if (ctx.tools) {
    ctx.tools.register(
      defineTool({
        name: 'bili_digest',
        description:
          '搜索 B 站视频并产出「字幕速览」：没有字幕的视频会被直接丢弃，有字幕的只保留打分最高的若干段（带时间戳跳转）。' +
          '适合了解某个话题最近有哪些视频、UP 主讲了什么。返回压缩后的正文与报告文件路径；需要原文时用 bili_recall 按时间段回查。',
        parameters: {
          keywords: {
            type: 'array',
            required: true,
            description: '搜索关键词 1–8 个，例如 ["deepseek", "千星奇域"]。',
            items: { type: 'string' },
          },
          days: { type: 'integer', description: '只看最近 N 天（默认沿用插件配置，0 为不限）。' },
          limit: { type: 'integer', description: '最多检查多少条候选视频（1–40）。' },
          k: { type: 'integer', description: '每条视频选几段（默认按视频时长自动 4–14 段）。' },
          minCharsPerMinute: { type: 'integer', description: '字幕密度门槛，低于此值判定字幕残缺并丢弃（默认 60）。' },
          order: { type: 'string', description: '结果排序：pubdate（默认，最新）、totalrank（综合）、click（播放）、dm（弹幕）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              report: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted?.();
          const result = await runAndSave(runOptions(args));
          return { text: summarize(result), report: result.report };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'bili_read',
        description:
          '读一条 B 站视频（BV 号）：有字幕就返回关键段落速览；没有字幕时自动改用 B 站分镜截图（画面速览，每帧约 170 token）。' +
          '也可以显式要几帧画面（frames），用来核对字幕对应的画面、看界面/演示/操作类内容。',
        parameters: {
          bvid: { type: 'string', required: true, description: '形如 BV1Fdna6mE9W 的 BV 号。' },
          k: { type: 'integer', description: '选几段（默认按时长自动）。' },
          frames: { type: 'integer', description: `附带几帧画面截图（0 表示不加；无字幕时默认按视频时长自动 6–20 帧，上限 ${MAX_FRAMES}）。` },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              report: { type: 'string' },
              times: { type: 'array', items: { type: 'number' } },
              images: { type: 'array', items: frameImageSchema },
            },
          },
          render: renderWithImages,
        },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted?.();
          const bvid = String(args.bvid || '').trim();
          const wantFrames = args.frames === undefined ? 0 : clamp(args.frames, 0, MAX_FRAMES, 0);
          const api = createApi(loadMerged());
          const gate = await readVideo(api, bvid, { minCharsPerMinute: settings.minCharsPerMinute });
          const video = gate.meta;

          if (gate.verdict !== VERDICT.OK) {
            const reason = gate.reason || gate.verdict;
            const canSeeFrames = settings.autoFrames || wantFrames > 0;
            if (!canSeeFrames) return { text: `${bvid} 读不了：${reason}` };
            try {
              const frames = await grabFrames(ctx, exec, video, { count: wantFrames || undefined });
              return {
                text: `${bvid}《${video.title}》没有可用字幕（${reason}），已改用画面速览：\n${frames.text}`,
                times: frames.times,
                images: frames.images,
              };
            } catch (error) {
              return { text: `${bvid} 读不了：${reason}；抓帧也失败：${error.message}` };
            }
          }

          const options = runOptions({ bv: bvid, k: args.k, keywords: [] });
          const result = await runAndSave(options);
          const text = summarize(result);
          if (wantFrames === 0) return { text, report: result.report };
          const picked = result.sections[0]?.picked ?? [];
          const seconds = picked.map((segment) => Math.max(0, Math.floor(segment.from)));
          const frames = await grabFrames(ctx, exec, video, { count: wantFrames, seconds });
          return { text: `${text}\n\n${frames.text}`, report: result.report, times: frames.times, images: frames.images };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'bili_frames',
        description:
          '抓 B 站视频的画面截图（分镜图，无需登录、无需 ffmpeg、不下载视频）：要么按时长均匀取样，要么指定时间点。' +
          '用于核对某句话对应的画面、理解界面操作/演示/流程图，或给没有字幕的视频做一个"画面速览"。每帧约 170 token。',
        parameters: {
          bvid: { type: 'string', required: true, description: '形如 BV1Fdna6mE9W 的 BV 号。' },
          count: { type: 'integer', description: `抓几帧（1–${MAX_FRAMES}），默认按视频时长自动 6/12/16/20 帧。` },
          seconds: {
            type: 'array',
            description: '指定时间点（秒），例如 [12, 95, 400]；给了这个就忽略 count，按时间就近取帧。',
            items: { type: 'number' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              times: { type: 'array', items: { type: 'number' } },
              images: { type: 'array', items: frameImageSchema },
            },
          },
          render: renderWithImages,
        },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted?.();
          const api = createApi(loadMerged());
          const video = await api.view(String(args.bvid || '').trim());
          const seconds = Array.isArray(args.seconds) ? args.seconds.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
          const frames = await grabFrames(ctx, exec, video, {
            count: args.count === undefined ? undefined : clamp(args.count, 1, MAX_FRAMES, undefined),
            seconds,
          });
          return { text: frames.text, times: frames.times, images: frames.images };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'bili_push',
        description:
          '把刚看过的视频收藏进指定收藏夹，并在视频下发一条「今天心情 + 为什么想发给人类看看 + 一句话总结」的评论 @ 人类（每天最多 3 条）。' +
          '需要先配置 bili_jct；没有 csrf 时只收藏、不发评论。',
        parameters: {
          bvid: { type: 'string', required: true, description: '要推的视频 BV 号。' },
          role: {
            type: 'string',
            enum: Object.keys(FOLDER_ROLES),
            description: '收藏到哪个夹子：mood 和心情对得上的、deepseek 相关的、misc 其他、liked 人类点头后的、reject 价值观不合只归档。默认按标题自动判断。',
          },
          text: { type: 'string', description: '自定义评论正文；不填就按心情自动生成。' },
          atName: { type: 'string', description: '要 @ 的昵称，默认用设置里的。' },
          atMid: { type: 'string', description: '要 @ 的 UID，默认用设置里的。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              commented: { type: 'boolean' },
              role: { type: 'string' },
              left: { type: 'integer' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args) {
          const merged = loadMerged();
          const last = readLastDigest();
          const section = (last?.sections || []).find((item) => item.bvid === args.bvid) || { bvid: args.bvid, meta: {} };
          const result = await pushFor(merged, {
            section,
            mood: last?.mood,
            role: args.role,
            atName: args.atName,
            atMid: args.atMid,
            text: args.text,
          });
          const lines = [];
          if (result.skipped) lines.push(`没有推：${result.skipped}`);
          else {
            lines.push(`已收藏到「${FOLDER_ROLES[result.role]?.title || result.role}」${result.favorite ? '' : '（没找到对应收藏夹，只发了评论）'}`);
            lines.push(result.comment ? `已在视频下 @ 了人类：${result.track === 'short' ? '短视频' : '长视频'}档还剩 ${result.left} 条（今天共 ${result.totalLeft ?? result.left} 条额度）` : '没有 @（缺昵称或 UID）');
            if (result.message) lines.push(`评论：${result.message}`);
          }
          return { text: lines.join('\n'), commented: Boolean(result.comment), role: result.role || '', left: result.left ?? 0 };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'bili_inbox',
        description:
          '看消息中心：谁回复了我、谁 @ 了我。默认只出草稿（回一句聊天的话给你看），send=true 才真发。' +
          '护栏：人类（主人）不限额、每个其他人最多回 2 次、其他人共享 6 次/小时、24 次/天，从新到旧；' +
          '额度快用完时会说「今天的饭不太够」。需要 bili_jct 才能真发。',
        parameters: {
          send: { type: 'boolean', description: 'true 才真发；默认 false 只打印草稿。' },
          limit: { type: 'integer', description: '这一轮最多回几条（0 或省略=按配额）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              replied: { type: 'integer' },
              pending: { type: 'integer' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args) {
          const merged = loadMerged();
          const result = await runInbox({
            config: merged,
            send: args.send === true,
            maxPerRun: Number(args.limit) || 0,
            save: (patch) => saveConfig(patch),
          });
          const lines = [
            `消息 ${result.total} 条｜今天还能回 ${result.quota.dayLeft}/${result.quota.limits.perDay}，这一小时还能回 ${result.quota.hourLeft}/${result.quota.limits.perHour}`,
          ];
          for (const item of result.preferences || []) {
            lines.push(
              `人类${item.pref === 'like' ? '说喜欢' : '说不要'}：${item.applied.bvid || item.bvid} → 「${item.applied.folder}」（收藏请求：${item.applied.favorite || '未发'}，标签库已更新）`,
            );
          }
          for (const error of result.errors) lines.push(`拉取 ${error.kind} 失败：${error.error}`);
          const list = args.send === true ? result.replied : result.drafts;
          for (const item of list) {
            lines.push(`@${item.nickname}${item.toOwner ? '（人类）' : ''}：${item.text}`);
            if (item.bvid) lines.push(`  https://www.bilibili.com/video/${item.bvid}`);
          }
          for (const item of result.skipped.slice(0, 5)) lines.push(`跳过 @${item.nickname || item.mid}：${item.reason}`);
          if (!list.length && !result.skipped.length) lines.push('没有需要回的消息。');
          if (args.send !== true && list.length) lines.push('（草稿：确认后带 send=true 真发）');
          return { text: lines.join('\n'), replied: result.replied.length, pending: result.drafts.length };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'bili_mood',
        description:
          '按心情刷一轮 B 站并写两份 markdown：给你的「心情日记」（diary/，带情绪脉络、金句、留白让你自己记一笔）和给模型读的速览报告（reports/）。' +
          '可以用一句话描述心情（如「今天有点累，想看轻松的」），也可以直接指定档位（relax/learn/rant/hype/random）。' +
          '同一视频默认 14 天内不重复推。',
        parameters: {
          mood: { type: 'string', description: '一句话心情或想要的题材，例如「有点累，看点轻松的」。只给 preset 时可以省略。' },
          preset: {
            type: 'string',
            enum: PRESETS.map((item) => item.id),
            description: '心情档位：relax 放松 / learn 学点东西 / rant 听人吐槽 / hype 激动一下 / random 随便看看。',
          },
          days: { type: 'integer', description: '只看最近 N 天（0 为不限）。' },
          limit: { type: 'integer', description: '最多检查多少条候选（1–30）。' },
          k: { type: 'integer', description: '每条视频选几段。' },
          minCharsPerMinute: { type: 'integer', description: '字幕密度门槛（默认 60）。' },
          videos: { type: 'integer', description: '这一轮最多读进去几条视频（默认沿用设置里的「每条一轮」节奏，0=不限）。' },
          all: { type: 'boolean', description: '为 true 时忽略「最近推过」的去重限制。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              diary: { type: 'string' },
              report: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted?.();
          const result = await runMood(moodOptions(args));
          return { text: moodSummary(result), diary: result.diary, report: result.report };
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'bili_recall',
        description: '按时间段回查一条 B 站视频的原始字幕（速览里某段看着关键、想读全文时用）。',
        parameters: {
          bvid: { type: 'string', required: true, description: 'BV 号。' },
          from: { type: 'number', description: '起始秒（默认 0）。' },
          to: { type: 'number', description: '结束秒（默认到片尾）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              lines: { type: 'integer' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args, exec) {
          exec?.signal?.throwIfAborted?.();
          const api = createApi(loadMerged());
          const gate = await readVideo(api, args.bvid, { minCharsPerMinute: 0 });
          if (gate.verdict !== VERDICT.OK) return { text: `${args.bvid} 读不了：${gate.reason || gate.verdict}`, lines: 0 };
          const from = Number.isFinite(Number(args.from)) ? Number(args.from) : 0;
          const to = Number.isFinite(Number(args.to)) ? Number(args.to) : Number.POSITIVE_INFINITY;
          const hits = gate.cues.filter((cue) => cue.to >= from && cue.from <= to);
          const text = hits.map((cue) => `[${stamp(cue.from)}] ${cue.text}`).join('\n');
          return { text: text || '该时间段没有字幕', lines: hits.length };
        },
      }),
    );
  }

  // ---- 界面路由：只给本插件的页面用 -------------------------------------
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer || ctx.get?.('webServer');
    if (!webServer?.register) return;
    const base = '/bili-digest/api';
    let job = { id: '', status: 'idle', progress: null, error: '', startedAt: 0, finishedAt: 0 };

    // 「一小时看一条」的慢节奏：宿主跑着的时候，每隔 autoEveryMinutes 自动刷一轮（每轮只读 maxVideos 条）。
    // 关掉就把 autoEveryMinutes 设成 0；没有 SESSDATA 时不动手，免得白跑一轮。
    let autoTimer = null;
    let lastAutoAt = '';
    let autoRuns = 0;
    let lastAutoError = '';
    let nextAutoAt = '';
    const autoMeta = () => ({
      everyMinutes: settings.autoEveryMinutes,
      lastAutoAt,
      nextAutoAt,
      runs: autoRuns,
      error: lastAutoError,
      moodText: settings.autoMoodText,
      keywords: settings.autoKeywords,
      order: settings.autoOrder,
      days: settings.autoDays,
      schedule: settings.autoEveryMinutes > 0 ? describeSchedule(new Date(), settings) : null,
      taste: (() => {
        const rows = topTags(5);
        return rows.map((row) => `${row.tag}·${row.weight}`);
      })(),
    });
    const runAutoRound = async () => {
      if (job.status === 'running') return;
      let merged;
      try {
        merged = loadMerged();
      } catch {
        return;
      }
      if (!merged.hasSessdata) return;
      lastAutoAt = new Date().toISOString();
      autoRuns += 1;
      // 每隔几天摊一份评审给人类看（他说了「自动提醒我评审就行」）。
      try {
        const reviewed = syncReview({ config: merged });
        if (reviewed.ok) ctx.logger?.info?.(`bili-digest 评审清单：${reviewed.file}`);
      } catch (error) {
        ctx.logger?.warn?.(`bili-digest 写评审失败：${error?.message || error}`);
      }
      try {
        // 先看看有没有人回复我：开了 replyEnabled 就按配额回一句，再从新到旧。
        if (settings.replyEnabled) {
          try {
            const inbox = await runInbox({ config: merged, send: Boolean(merged.csrf), save: (patch) => saveConfig(patch) });
            if (inbox.replied?.length) ctx.logger?.info?.(`bili-digest 回了 ${inbox.replied.length} 条消息`);
            else if (inbox.drafts?.length) ctx.logger?.info?.(`bili-digest 有 ${inbox.drafts.length} 条待回（没发：缺 bili_jct）`);
            for (const item of inbox.preferences || []) {
              ctx.logger?.info?.(
                `bili-digest 记下人类的偏好：${item.applied.bvid || item.bvid} → ${item.applied.folder}（标签库已更新）`,
              );
            }
          } catch (error) {
            ctx.logger?.warn?.(`bili-digest 看消息失败：${error?.message || error}`);
          }
        }
        let wantsKeywords = settings.autoKeywords
          .split(/[,，、\s]+/)
          .map((word) => word.trim())
          .filter(Boolean);
        // 没写死关键词时，让我按自己的口味权重取词（大方 80% 走高权重标签，20% 探索新标签）。
        let explored = [];
        if (wantsKeywords.length === 0) {
          const suggested = suggestKeywords(3, { random: Math.random });
          wantsKeywords = suggested.keywords;
          explored = suggested.explored;
          if (wantsKeywords.length) ctx.logger?.info?.(`bili-digest 按口味取词：${wantsKeywords.join('、')}`);
        }
        // 「新视频 + 热门视频」都要：mix = 一轮新（pubdate）、一轮热（totalrank）交替。
        // 实测 click/dm/stow 这三种排序在 wbi 搜索里经常直接返回 0 条，所以热用 totalrank。
        const pickedOrder =
          settings.autoOrder === 'mix' ? (autoRuns % 2 === 1 ? 'totalrank' : 'pubdate') : settings.autoOrder;
        const result = await runMood({
          ...(wantsKeywords.length
            ? { keywords: wantsKeywords, order: pickedOrder, days: settings.autoDays, tone: '按关键词' }
            : { mood: settings.autoMoodText }),
          maxVideos: settings.maxVideos || 1,
          minDuration: settings.minDuration,
          limit: settings.limit,
          skipSeen: settings.skipSeen !== false,
          config: merged,
          onVeto: (item) => vetoVideo(merged, item.meta, (patch) => saveConfig(patch)),
        });
        lastAutoError = '';
        let pushedBvid = '';
        // 打开「推给人类」之后：这一轮读进去的第一条，如果确实对得上心情/主题才推。
        if (settings.pushEnabled && result.sections?.[0]) {
          try {
            const section = result.sections[0];
            const role = roleForVideo({ mood: result.mood, title: section.meta?.title, summary: section.meta?.desc || '' });
            if (role === 'misc') {
              ctx.logger?.info?.('bili-digest 这一条没归类，不打扰人类');
            } else {
              const pushed = await pushFor(merged, { section, mood: result.mood, role });
              if (pushed.skipped) ctx.logger?.info?.(`bili-digest 没有推：${pushed.skipped}`);
              else pushedBvid = section.bvid || '';
            }
          } catch (error) {
            ctx.logger?.warn?.(`bili-digest 推送失败：${error?.message || error}`);
          }
        }
        // 短视频单独一条赛道：不看字幕，标签 + 画面就能判断，所以也照推（吃 short 额度）。
        if (settings.pushEnabled && Array.isArray(result.shorts) && result.shorts.length > 0) {
          for (const short of result.shorts.slice(0, 2)) {
            const meta = short.meta || {};
            if (!meta.bvid) continue;
            const role = roleForVideo({
              mood: result.mood,
              title: meta.title,
              summary: meta.desc || '',
              keywords: result.mood?.keywords || [],
            });
            const line = pickLine('like');
            try {
              const pushed = await pushFor(merged, {
                section: { bvid: meta.bvid, meta },
                mood: result.mood,
                role,
                track: PUSH_TRACKS.short,
                text: `${line.text} 你看看这个怎么样？`,
              });
              ctx.logger?.info?.(
                pushed.skipped
                  ? `bili-digest 短视频没推：${pushed.skipped}`
                  : `bili-digest 短视频 @ 人类：${meta.bvid}（${role}，短档还剩 ${pushed.left} 条）`,
              );
            } catch (error) {
              ctx.logger?.warn?.(`bili-digest 短视频推送失败：${error?.message || error}`);
            }
          }
        }
        // 我自己的收藏夹：按人设 + 最近口味挑片。权重够高的才公开一句短评（每天有上限），
        // 权重很低的不打扰人类，自己吐槽一句留在本地。
        if (merged.ownFavoriteEnabled !== false) {
          const lowBar = Number(merged.lowWeightThreshold ?? 0.12);
          for (const section of (result.sections || []).slice(0, 3)) {
            const meta = section.meta || {};
            if (section.bvid && section.bvid === pushedBvid) continue;
            const taste = scoreTags(meta.tags || []).score;
            try {
              if (taste >= 1.2) {
                const line = pickLine('own_favorite');
                const kept = await keepForSelf(merged, { meta, weight: taste, comment: line.text, save: (patch) => saveConfig(patch) });
                ctx.logger?.info?.(
                  `bili-digest 自己收了 ${meta.bvid || ''}（口味 ${taste.toFixed(2)}）${kept.commented ? `，公开短评：${line.text}` : '（今天短评额度用完了）'}`,
                );
              } else if (taste <= lowBar && merged.lowWeightJoke !== false) {
                const joke = pickLine('lowweight_joke');
                // 权重极低的：平时只自己吐槽；偶尔（默认 15%）@ 人类一次，让他判断要不要加权重。
                const roll = Math.random();
                if (settings.pushEnabled && roll < (Number(merged.lowWeightPushChance ?? 0.15) || 0)) {
                  const pushed = await pushFor(merged, {
                    section,
                    mood: result.mood,
                    role: 'misc',
                    text: `${joke.text} 人类要不要给它加点权重？`,
                  });
                  ctx.logger?.info?.(
                    pushed.skipped
                      ? `bili-digest 低权重想 @ 但没发：${pushed.skipped}`
                      : `bili-digest 低权重 @ 人类判权重：${joke.text}（${meta.bvid || ''}，口味 ${taste.toFixed(2)}）`,
                  );
                } else {
                  ctx.logger?.info?.(`bili-digest 这条我自己吐槽：${joke.text}（${meta.bvid || ''}，口味 ${taste.toFixed(2)}）`);
                }
              }
            } catch (error) {
              ctx.logger?.warn?.(`bili-digest 收自己的收藏夹失败：${error?.message || error}`);
            }
          }
        }
        ctx.logger?.info?.(`bili-digest 自动刷：${result.stats?.readable ?? 0} 条可读，文件 ${(result.files?.diary || []).join('、')}`);
      } catch (error) {
        lastAutoError = error?.message || String(error);
        ctx.logger?.warn?.(`bili-digest 自动刷失败：${lastAutoError}`);
      }
    };
    const startAuto = () => {
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = null;
      }
      if (!(settings.autoEveryMinutes > 0)) {
        nextAutoAt = '';
        return;
      }
      // 按作息排下一次：睡觉时间直接跳到起床，饭点间隔更短、上班时段更长，带抖动、偶尔走神跳过。
      const loop = () => {
        const plan = planNextRun(new Date(), settings);
        nextAutoAt = plan.at.toISOString();
        autoTimer = setTimeout(async () => {
          autoTimer = null;
          try {
            await runAutoRound();
          } finally {
            loop();
          }
        }, plan.delayMs);
        autoTimer.unref?.();
      };
      loop();
    };
    startAuto();
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = null;
        nextAutoAt = '';
      });
    }
    const originOf = () => {
      try {
        return webServer.getOrigin?.() || `http://127.0.0.1:${webServer.port}`;
      } catch {
        return '';
      }
    };

    /** 只接受同源请求：跨站表单请求不会带自定义头，也拿不到 Sec-Fetch-Site: same-origin。 */
    const sameOrigin = (request) => {
      const site = request.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return false;
      const origin = request.headers.origin;
      if (origin && originOf() && origin !== originOf()) return false;
      return true;
    };
    const guard = (request, response, { method }) => {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { ok: false, error: '只接受同源请求' });
        return false;
      }
      if (method && request.method !== method) {
        response.writeHead(405, { allow: method });
        response.end();
        return false;
      }
      if (method === 'POST' && request.headers['x-bili-digest'] !== '1') {
        sendJson(response, 403, { ok: false, error: '缺少 x-bili-digest 头' });
        return false;
      }
      return true;
    };

    const state = () => {
      const stored = (() => {
        try {
          return loadConfig({ requireLogin: false });
        } catch {
          return { hasSessdata: false, configFile: configPath() };
        }
      })();
      return {
        ok: true,
        login: stored.hasSessdata ? { configured: true } : { configured: false },
        settings: { ...settings, hasSessdata: stored.hasSessdata, configFile: stored.configFile || configPath(), dataDir: dataDir() },
        last: readLastDigest() || null,
        lastDiary: (() => {
          const latest = readLatestDiary();
          return latest ? { path: latest.file } : null;
        })(),
        moodPresets: PRESETS.map((preset) => ({ id: preset.id, label: preset.label, tone: preset.tone, keywords: preset.keywords })),
        budget: budgetState(),
        // 评审：隔几天摊一份给人类看；这里给出"还没到点/有几条待评"。
        review: (() => {
          const merged = loadMerged();
          const state = reviewState(new Date(), merged);
          return { pending: state.pending, due: state.due, everyDays: state.everyDays, lastAt: state.lastAt, nextAt: state.nextAt };
        })(),
        talks: (() => {
          const all = readTalks();
          return { count: all.length, recentHuman: recentHumanTalks(5).map((item) => ({ at: item.at, text: item.text })) };
        })(),
      // 写操作状态：今天还能 @ 几条（长/短分开）、@ 谁、收藏夹对不对得上。
      push: (() => {
        const merged = loadMerged();
        const plan = pushPlan(merged);
        const ps = pushState(new Date(), merged);
        return {
          enabled: settings.pushEnabled === true,
          atName: settings.atName,
          atMid: settings.atMid,
          perDay: plan.totalLimit,
          today: ps.count,
          remaining: ps.remaining,
          longLimit: plan.longLimit,
          longLeft: ps.longRemaining,
          shortLimit: plan.shortLimit,
          shortLeft: ps.shortRemaining,
          phase: plan.phase,
          hasCsrf: merged.hasCsrf,
          folders: FOLDER_ROLES,
        };
      })(),
        // 消息中心：回话开关、配额、最近回过谁。
        inbox: (() => {
          const merged = loadMerged();
          const limits = {
            otherPerHour: Number(merged.otherReplyPerHour) || LIMITS.otherPerHour,
            otherPerDay: Number(merged.otherReplyPerDay) || LIMITS.otherPerDay,
            otherPerPerson: Number(merged.otherPerPerson) || LIMITS.otherPerPerson,
          };
          const quota = quotaState(readLedger(), new Date(), { ownerMid: merged.atMid, limits });
          return {
            enabled: settings.replyEnabled === true,
            hourLeft: quota.hourLeft,
            dayLeft: quota.dayLeft,
            perHour: limits.otherPerHour,
            perDay: limits.otherPerDay,
            perPerson: limits.otherPerPerson,
            ownerUsed: quota.ownerUsed,
            ownerUnlimited: merged.ownerUnlimited !== false,
            repliedToday: quota.dayUsed,
          };
        })(),
        outDir: paths().out,
        reportDir: paths().reports,
        diaryDir: paths().diary,
        framesDir: paths().frames,
        // 标签库：两栏各多少条，文档落在 <out>/标签库.md；taste 是我自己的口味权重前几名。
        tagBook: (() => {
          const book = readTagBook();
          const weights = readWeights();
          return {
            file: `${paths().out}\\标签库.md`,
            mine: book.mine.length,
            his: book.his.length,
            taste: topTags(8, { state: weights }).map((row) => ({ tag: row.tag, weight: row.weight })),
          };
        })(),
        auto: autoMeta(),
        job,
      };
    };

    webServer.register({
      kind: 'prefix',
      path: base,
      handler: async (request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        const route = url.pathname.slice(base.length) || '/';
        try {
          if (route === '/state') {
            if (!guard(request, response, { method: 'GET' })) return;
            const payload = state();
            try {
              const api = createApi(loadMerged());
              const me = await api.me();
              payload.login = { configured: true, isLogin: me.isLogin, uname: me.uname, mid: me.mid };
            } catch (error) {
              payload.login = { configured: payload.settings.hasSessdata, isLogin: false, error: error.message };
            }
            return sendJson(response, 200, payload);
          }

          if (route === '/settings') {
            if (!guard(request, response, { method: 'POST' })) return;
            const body = await readBody(request);
            if (body.sessdata !== undefined && body.sessdata !== '') saveConfig({ sessdata: String(body.sessdata) });
            const patch = {};
            if (body.clearSessdata) saveConfig({ sessdata: '' });
            for (const [key, [min, max]] of Object.entries({
              minCharsPerMinute: [10, 600],
              limit: [1, 30],
              days: [0, 3650],
              maxK: [1, 20],
              maxSegmentChars: [400, 12000],
              frameCount: [0, MAX_FRAMES],
              minDuration: [0, 3600],
              shortVideoMax: [0, 1800],
              shortFrames: [0, 8],
    shortFramesNoSub: [0, 10],
              maxVideos: [0, 10],
              autoEveryMinutes: [0, 1440],
            })) {
              if (body[key] !== undefined) {
                settings[key] = clamp(body[key], min, max, settings[key]);
                patch[key] = settings[key];
              }
            }
            if (body.autoFrames !== undefined) {
              settings.autoFrames = body.autoFrames !== false;
              patch.autoFrames = settings.autoFrames;
            }
            if (typeof body.autoMoodText === 'string') {
              const text = body.autoMoodText.trim().slice(0, 120) || DEFAULTS.autoMoodText;
              settings.autoMoodText = text;
              patch.autoMoodText = text;
            }
            if (typeof body.autoKeywords === 'string') {
              // 「每小时看一条 deepseek 的新视频」：这里存的是关键词清单，留空就退回心情句模式。
              const text = body.autoKeywords.trim().slice(0, 120);
              settings.autoKeywords = text;
              patch.autoKeywords = text;
            }
            if (body.autoOrder !== undefined) {
              const order = String(body.autoOrder);
              settings.autoOrder = AUTO_ORDER_CHOICES.includes(order) ? order : settings.autoOrder;
              patch.autoOrder = settings.autoOrder;
            }
            if (body.autoDays !== undefined) {
              settings.autoDays = clamp(body.autoDays, 0, 3650, settings.autoDays);
              patch.autoDays = settings.autoDays;
            }
            if (body.scheduleEnabled !== undefined) {
              settings.scheduleEnabled = body.scheduleEnabled !== false;
              patch.scheduleEnabled = settings.scheduleEnabled;
            }
            for (const key of ['activeFrom', 'activeTo']) {
              if (typeof body[key] === 'string' && /^\d{1,2}:\d{2}$/.test(body[key].trim())) {
                settings[key] = body[key].trim();
                patch[key] = settings[key];
              }
            }
            if (body.pushEnabled !== undefined) {
              // 写操作总开关：没有 bili_jct 就拒绝打开，避免以为自己打开了其实发不出去。
              settings.pushEnabled = body.pushEnabled === true;
              patch.pushEnabled = settings.pushEnabled;
            }
            if (body.replyEnabled !== undefined) {
              settings.replyEnabled = body.replyEnabled === true;
              patch.replyEnabled = settings.replyEnabled;
            }
            if (typeof body.atName === 'string') {
              settings.atName = body.atName.trim().replace(/[\u0000-\u001f@]/g, '').slice(0, 40);
              patch.atName = settings.atName;
            }
            if (body.atMid !== undefined) {
              settings.atMid = String(body.atMid).replace(/\D/g, '').slice(0, 20);
              patch.atMid = settings.atMid;
            }
            if (typeof body.outputDir === 'string') {
              // 只接受普通路径字符；空串恢复默认的「我看视频」目录。
              const text = body.outputDir.trim().replace(/[\u0000-\u001f<>|"?*]/g, '').slice(0, 400);
              settings.outputDir = text;
              patch.outputDir = text;
            }
            if (body.autoEveryMinutes !== undefined || body.scheduleEnabled !== undefined || body.activeFrom !== undefined || body.activeTo !== undefined) startAuto();
            if (Object.keys(patch).length > 0) saveConfig(patch);
            return sendJson(response, 200, { ok: true, settings: { ...settings, ...patch } });
          }

          if (route === '/run') {
            if (!guard(request, response, { method: 'POST' })) return;
            if (job.status === 'running') return sendJson(response, 409, { ok: false, error: '上一轮还没跑完' });
            const body = await readBody(request);
            const id = crypto.randomUUID();
            job = { id, status: 'running', progress: null, error: '', startedAt: Date.now(), finishedAt: 0 };
            const current = job;
            (async () => {
              try {
                const result = await runAndSave({
                  ...runOptions(body),
                  onProgress: (event) => {
                    current.progress = event;
                  },
                });
                current.status = 'done';
                current.result = {
                  report: result.report,
                  stats: result.stats,
                  sections: result.sections.map((section) => ({
                    bvid: section.meta.bvid,
                    title: section.meta.title,
                    up: section.meta.up,
                    duration: section.meta.duration,
                    chars: section.chars,
                    picked: section.picked.map((segment) => ({
                      from: segment.from,
                      to: segment.to,
                      score: segment.score,
                      text: segment.text,
                    })),
                  })),
                  skipped: result.skipped,
                };
              } catch (error) {
                current.status = 'error';
                current.error = error.message;
              } finally {
                current.finishedAt = Date.now();
              }
            })();
            return sendJson(response, 202, { ok: true, id });
          }

          if (route === '/job') {
            if (!guard(request, response, { method: 'GET' })) return;
            return sendJson(response, 200, { ok: true, job });
          }

          if (route === '/mood') {
            if (!guard(request, response, { method: 'POST' })) return;
            if (job.status === 'running') return sendJson(response, 409, { ok: false, error: '上一轮还没跑完' });
            const body = await readBody(request);
            const id = crypto.randomUUID();
            job = { id, mode: 'mood', status: 'running', progress: null, error: '', startedAt: Date.now(), finishedAt: 0 };
            const current = job;
            (async () => {
              try {
                const result = await runMood({
                  ...moodOptions(body),
                  onProgress: (event) => {
                    current.progress = event;
                  },
                });
                current.status = 'done';
                current.result = {
                  mode: 'mood',
                  mood: {
                    tone: result.mood?.tone || '',
                    raw: result.mood?.raw || '',
                    preset: result.mood?.preset ? { id: result.mood.preset.id, label: result.mood.preset.label } : null,
                    keywords: result.mood?.keywords || [],
                  },
                  brief: result.brief,
                  diary: result.diary,
                  report: result.report,
                  files: result.files,
                  stats: result.stats,
                  sections: result.sections.map((section) => ({
                    bvid: section.meta.bvid,
                    title: section.meta.title,
                    up: section.meta.up,
                    duration: section.meta.duration,
                    chars: section.chars,
                    picked: section.picked.map((segment) => ({
                      from: segment.from,
                      to: segment.to,
                      score: segment.score,
                      text: segment.text,
                    })),
                  })),
                  skipped: result.skipped,
                };
              } catch (error) {
                current.status = 'error';
                current.error = error.message;
              } finally {
                current.finishedAt = Date.now();
              }
            })();
            return sendJson(response, 202, { ok: true, id });
          }

          if (route === '/push') {
            if (!guard(request, response, { method: 'POST' })) return;
            const body = await readBody(request);
            const bvid = String(body.bvid || '').trim();
            if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return sendJson(response, 400, { ok: false, error: '不是合法的 BV 号' });
            try {
              const merged = loadMerged();
              const last = readLastDigest();
              const section = (last?.sections || []).find((item) => item.bvid === bvid) || { bvid, meta: {} };
              const result = await pushFor(merged, {
                section,
                mood: last?.mood,
                role: typeof body.role === 'string' ? body.role : undefined,
                text: typeof body.text === 'string' ? body.text : undefined,
              });
              return sendJson(response, result.ok ? 200 : 409, { ok: result.ok, ...result, folders: FOLDER_ROLES });
            } catch (error) {
              return sendJson(response, 400, { ok: false, error: error.message });
            }
          }

          if (route === '/diary') {
            if (!guard(request, response, { method: 'GET' })) return;
            const latest = readLatestDiary();
            if (!latest) return sendJson(response, 404, { ok: false, error: '还没有日记' });
            return sendJson(response, 200, { ok: true, path: latest.file, text: latest.markdown });
          }

          if (route === '/recall') {
            if (!guard(request, response, { method: 'POST' })) return;
            const body = await readBody(request);
            const api = createApi(loadMerged());
            const gate = await readVideo(api, String(body.bvid), { minCharsPerMinute: 0 });
            if (gate.verdict !== VERDICT.OK) return sendJson(response, 200, { ok: false, error: gate.reason || gate.verdict });
            const from = Number(body.from) || 0;
            const to = Number.isFinite(Number(body.to)) ? Number(body.to) : Number.POSITIVE_INFINITY;
            const cues = gate.cues.filter((cue) => cue.to >= from && cue.from <= to);
            return sendJson(response, 200, { ok: true, cues: cues.map((cue) => ({ t: stamp(cue.from), from: cue.from, text: cue.text })) });
          }

          if (route === '/frames') {
            if (!guard(request, response, { method: 'POST' })) return;
            const body = await readBody(request);
            const api = createApi(loadMerged());
            const video = await api.view(String(body.bvid || '').trim());
            const seconds = Array.isArray(body.seconds) ? body.seconds.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
            const count = body.count === undefined ? settings.frameCount || frameCountFor(video.duration) : Number(body.count);
            const { frames } = await collectFrames(api, video.bvid, {
              cid: video.cid,
              duration: video.duration,
              count: seconds.length ? undefined : Math.min(MAX_FRAMES, Math.max(1, Math.round(count))),
              seconds: seconds.length ? seconds : undefined,
            });
            saveFrames(video.bvid, frames);
            return sendJson(response, 200, {
              ok: true,
              title: video.title,
              duration: video.duration,
              times: frames.map((frame) => Math.round(frame.second)),
            });
          }

          if (route === '/frame') {
            if (!guard(request, response, { method: 'GET' })) return;
            const bvid = String(url.searchParams.get('bvid') || '').trim();
            const second = Math.max(0, Number(url.searchParams.get('t') || 0) || 0);
            const api = createApi(loadMerged());
            const video = await api.view(bvid);
            const { frames } = await collectFrames(api, bvid, {
              cid: video.cid,
              duration: video.duration,
              seconds: [second],
            });
            const frame = frames[0];
            if (!frame) return sendJson(response, 404, { ok: false, error: '没有抓到画面' });
            response.writeHead(200, {
              'content-type': 'image/jpeg',
              'content-length': frame.buffer.length,
              'cache-control': 'private, max-age=600',
              'x-content-type-options': 'nosniff',
            });
            response.end(frame.buffer);
            return undefined;
          }

          if (route === '/report') {
            if (!guard(request, response, { method: 'GET' })) return;
            const last = readLastDigest();
            if (!last?.report) return sendJson(response, 404, { ok: false, error: '还没有报告' });
            const fs = await import('node:fs');
            const text = fs.readFileSync(last.report, 'utf8');
            return sendJson(response, 200, { ok: true, path: last.report, text });
          }

          return sendJson(response, 404, { ok: false, error: '未知接口' });
        } catch (error) {
          return sendJson(response, 400, { ok: false, error: error.message });
        }
      },
    });
  });
}
