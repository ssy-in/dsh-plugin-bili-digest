// 硬门槛：一条视频要么"有可用字幕"进入 L2，要么当场丢弃（无字幕/字幕残缺/取不到/价值观不合格）。
import { pickTrack } from './api.js';
import { assess, fetchAtmosphereSample } from './tone.js';

export const VERDICT = {
  OK: 'ok',
  SHORT: 'short',
  NO_SUBTITLE: 'no-subtitle',
  NEEDS_LOGIN: 'needs-login',
  BAD_SUBTITLE: 'bad-subtitle',
  REJECTED: 'rejected',
  ERROR: 'error',
};

/**
 * 判定一条视频能否读。
 * @param {ReturnType<import('./api.js').createApi>} api
 * @param {string} bvid
 * @param {{minCharsPerMinute?: number, page?: number, checkTone?: boolean, toneOptions?: object, shortVideoMax?: number}} [options]
 * @returns {Promise<{meta: object, verdict: string, reason?: string, assessment?: object, track?: object, cues?: Array, chars?: number, charsPerMinute?: number}>}
 */
export async function readVideo(api, bvid, options = {}) {
  const { minCharsPerMinute = 60, page, checkTone = true, toneOptions } = options;
  let meta;
  try {
    meta = await api.view(bvid);
  } catch (error) {
    return { meta: { bvid }, verdict: VERDICT.ERROR, reason: error.message };
  }
  const target = page ? meta.pages.find((item) => item.page === page) : undefined;
  const cid = target ? target.cid : meta.cid;
  const duration = target ? target.duration : meta.duration;

  // view 接口不带 tags，得单独取一次：价值观判定和标签库都要用（取不到就算了）。
  if ((!Array.isArray(meta.tags) || meta.tags.length === 0) && typeof api.tags === 'function') {
    meta.tags = await api.tags(meta.bvid).catch(() => []);
  }

  // 先看它值不值得看：话术 + 评论区氛围。不合格的直接归档，不花 token 读字幕。
  if (checkTone) {
    const samples = await fetchAtmosphereSample(api, meta.aid).catch(() => []);
    const assessment = assess({ title: meta.title, desc: meta.desc || '', tags: meta.tags || [], samples }, toneOptions);
    if (assessment.reject) {
      return {
        meta,
        assessment,
        verdict: VERDICT.REJECTED,
        reason: `内容不推：${assessment.reasons.join('；')}`,
      };
    }
  }

  // 短视频（默认 ≤5 分钟）：先探一次字幕清单（一次请求、~50ms）。
  // 有字幕就照字幕读（视频短，只取 1–3 段）；没有字幕才退回「标签 + 画面」，并把帧数调高。
  const shortMax = Number(options.shortVideoMax) || 0;
  const isShort = shortMax > 0 && duration > 0 && duration <= shortMax;
  if (isShort && options.probeShortSubtitle !== false) {
    let listing;
    try {
      listing = await api.subtitleList(meta.bvid, cid);
    } catch {
      listing = { tracks: [], needsLogin: false };
    }
    const track = listing?.tracks?.length ? pickTrack(listing.tracks) : null;
    if (track) {
      try {
        const cues = await api.fetchSubtitle(track.url);
        const chars = cues.reduce((sum, cue) => sum + cue.text.length, 0);
        const minutes = Math.max(0.2, duration / 60);
        const charsPerMinute = chars / minutes;
        const floor = Math.min(minCharsPerMinute, Number(options.shortMinCharsPerMinute ?? 20));
        if (cues.length && charsPerMinute >= floor) {
          return {
            meta: { ...meta, cid },
            track,
            cues,
            chars,
            charsPerMinute,
            short: true,
            verdict: VERDICT.OK,
            reason: `短视频（${Math.round(duration)} 秒）但有字幕：${chars} 字`,
          };
        }
      } catch {
        /* 字幕坏了就退回画面 */
      }
    }
    return {
      meta: { ...meta, cid },
      short: true,
      hasSubtitle: false,
      verdict: VERDICT.SHORT,
      reason: track
        ? `短视频（${Math.round(duration)} 秒）：字幕太少，改看标签和画面`
        : `短视频（${Math.round(duration)} 秒 ≤ ${shortMax}）：没有字幕，看标签和画面`,
    };
  }
  if (isShort) {
    return {
      meta: { ...meta, cid },
      short: true,
      verdict: VERDICT.SHORT,
      reason: `短视频（${Math.round(duration)} 秒 ≤ ${shortMax}）：不看字幕，看标签和画面`,
    };
  }

  let listing;
  try {
    listing = await api.subtitleList(meta.bvid, cid);
  } catch (error) {
    return { meta, verdict: VERDICT.ERROR, reason: error.message };
  }
  if (!listing.tracks.length) {
    return {
      meta,
      verdict: listing.needsLogin ? VERDICT.NEEDS_LOGIN : VERDICT.NO_SUBTITLE,
      reason: listing.needsLogin ? '需要登录态才能看到字幕清单（SESSDATA 缺失或已失效）' : '该视频没有字幕轨',
    };
  }

  const track = pickTrack(listing.tracks);
  let cues;
  try {
    cues = await api.fetchSubtitle(track.url);
  } catch (error) {
    return { meta, verdict: VERDICT.ERROR, reason: `字幕下载失败：${error.message}` };
  }
  if (!cues.length) return { meta, verdict: VERDICT.NO_SUBTITLE, reason: '字幕轨是空的' };

  const chars = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  const minutes = Math.max(0.2, duration / 60);
  const charsPerMinute = chars / minutes;
  if (charsPerMinute < minCharsPerMinute) {
    return {
      meta,
      track,
      cues,
      chars,
      charsPerMinute,
      verdict: VERDICT.BAD_SUBTITLE,
      reason: `字幕残缺：${chars} 字 / ${Math.round(minutes)} 分钟 = ${charsPerMinute.toFixed(0)} 字每分钟 < ${minCharsPerMinute}`,
    };
  }
  return { meta, track, cues, chars, charsPerMinute, verdict: VERDICT.OK };
}
