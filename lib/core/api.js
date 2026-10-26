// B 站接口层：wbi 签名、搜索、视频信息、字幕清单、字幕正文、分镜抓帧。所有请求经 ./http.js 的白名单与限速。
import { getJson, getBytes, assertAllowedUrl, HttpError } from './http.js';
import { mixinKeyFrom, signQuery } from './wbi.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const MAX_CUES = 20_000;

export function assertBvid(bvid) {
  const value = String(bvid || '').trim();
  if (!BVID_RE.test(value)) throw new Error(`不是合法的 BV 号：${String(bvid).slice(0, 24)}`);
  return value;
}

/** B 站接口返回的 code 映射成人能看懂的失败原因。 */
function apiError(scope, payload) {
  const code = payload?.code;
  const message = payload?.message || '';
  if (code === -404) return new HttpError(`${scope}：视频不存在或已删除（-404）`, { kind: 'bili' });
  if (code === -403) return new HttpError(`${scope}：无权限访问（-403），可能需要登录或该视频受限`, { kind: 'bili' });
  if (code === -352) return new HttpError(`${scope}：被风控拦截（-352），请降低频率或稍后重试`, { kind: 'ratelimit' });
  return new HttpError(`${scope} 失败 ${code} ${message}`.trim(), { kind: 'bili' });
}

export function createApi(config) {
  const headers = {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: `SESSDATA=${config.sessdata}; buvid3=${config.buvid3}`,
  };
  let mixin = null;

  async function nav() {
    const payload = await getJson('https://api.bilibili.com/x/web-interface/nav', { headers });
    if (!payload?.data) throw apiError('nav', payload);
    return payload.data;
  }

  async function mixinKey(force = false) {
    if (mixin && !force) return mixin;
    mixin = mixinKeyFrom(await nav());
    return mixin;
  }

  async function signed(path, params) {
    const query = signQuery(await mixinKey(), params);
    const payload = await getJson(`https://api.bilibili.com${path}?${query}`, { headers });
    if (payload?.code === -403 && !payload?.data) {
      // wbi key 过期或 Cookie 失效时重取一次
      const retry = signQuery(await mixinKey(true), params);
      const second = await getJson(`https://api.bilibili.com${path}?${retry}`, { headers });
      if (second?.code !== 0) throw apiError(path, second);
      return second;
    }
    if (payload?.code !== 0) throw apiError(path, payload);
    return payload;
  }

  return {
    headers,
    nav,
    async me() {
      const data = await nav();
      return {
        isLogin: Boolean(data.isLogin),
        uname: data.uname || '',
        mid: data.mid || 0,
        vip: data.vipStatus ?? 0,
      };
    },
    async search(keyword, { page = 1, pageSize = 20, order = 'pubdate', days = 0 } = {}) {
      const text = String(keyword || '').trim().slice(0, 60);
      if (!text) throw new Error('关键词不能为空');
      const payload = await signed('/x/web-interface/wbi/search/type', {
        search_type: 'video',
        keyword: text,
        page: Math.max(1, Math.min(50, page)),
        page_size: Math.max(1, Math.min(50, pageSize)),
        order,
      });
      const now = Date.now() / 1000;
      return ((payload.data && payload.data.result) || [])
        .filter((item) => BVID_RE.test(item.bvid || ''))
        .map((item) => ({
          bvid: item.bvid,
          title: String(item.title || '').replace(/<[^>]+>/g, ''),
          up: item.author,
          mid: item.mid,
          duration: item.duration,
          play: Number(item.play) || 0,
          favorites: Number(item.favorites) || 0,
          like: Number(item.like) || 0,
          danmaku: Number(item.danmaku ?? item.video_review) || 0,
          pubdate: item.pubdate,
          ageHours: Math.max(0, Math.round((now - item.pubdate) / 3600)),
        }))
        .filter((item) => !days || item.ageHours <= days * 24);
    },
    /**
     * 视频标签：`view` 接口默认不返回 tags，得走 `view/detail` 的 `data.Tags`。
     * 标签库和价值观判定都要它，取不到就当空数组，不阻塞主流程。
     */
    async tags(bvid) {
      const id = assertBvid(bvid);
      const payload = await getJson(`https://api.bilibili.com/x/web-interface/view/detail?bvid=${id}`, { headers });
      const list = payload?.data?.Tags;
      if (!Array.isArray(list)) return [];
      return list
        .map((tag) => (typeof tag === 'string' ? tag : tag?.tag_name))
        .map((tag) => String(tag || '').trim())
        .filter(Boolean)
        .slice(0, 20);
    },
    async view(bvid) {
      const id = assertBvid(bvid);
      const payload = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${id}`, { headers });
      if (payload?.code !== 0) throw apiError('view', payload);
      const data = payload.data;
      const pages = Array.isArray(data.pages) ? data.pages : [];
      return {
        bvid: id,
        aid: data.aid,
        cid: data.cid,
        title: data.title,
        up: data.owner?.name || '',
        mid: data.owner?.mid || 0,
        duration: data.duration,
        pubdate: data.pubdate,
        desc: data.desc || '',
        tags: Array.isArray(data.tags) ? data.tags.map((tag) => (typeof tag === 'string' ? tag : tag?.tag_name)).filter(Boolean) : [],
        videoCount: data.videos || 1,
        pages: pages.map((page) => ({ cid: page.cid, page: page.page, part: page.part, duration: page.duration })),
        stat: data.stat || {},
        rights: { pay: Boolean(data.rights?.pay), arcPay: Boolean(data.rights?.arc_pay) },
      };
    },
    /**
     * 评论区 top 回复正文，用来判断「引战/骂人多」这种氛围。
     * 弹幕接口（dm/list.so、dm/seg.so）现在要么返回空、要么要解 protobuf，
     * 评论区的信号更稳定，也更能代表一个视频下面的气氛。
     */
    async comments(aid, { ps = 20, mode = 3 } = {}) {
      if (!aid) return [];
      const payload = await signed('/x/v2/reply/wbi/main', { oid: String(aid), type: '1', mode, ps, next: '0' });
      const replies = payload?.data?.replies || [];
      const lines = [];
      for (const reply of replies) {
        const text = String(reply?.content?.message || '').trim();
        if (text) lines.push(text);
        for (const sub of reply?.replies || []) {
          const subText = String(sub?.content?.message || '').trim();
          if (subText) lines.push(subText);
        }
      }
      return lines.slice(0, 200);
    },
    async subtitleList(bvid, cid) {
      const id = assertBvid(bvid);
      const payload = await signed('/x/player/wbi/v2', { bvid: id, cid });
      const data = payload.data || {};
      const subs = data.subtitle?.subtitles || [];
      return {
        needsLogin: Boolean(data.need_login_subtitle),
        tracks: subs.map((track) => ({
          lan: track.lan,
          label: track.lan_doc,
          url: track.subtitle_url,
          ai: track.ai_type === 1 || track.ai_status === 1,
        })),
      };
    },
    async fetchSubtitle(url) {
      const absolute = String(url || '').startsWith('//') ? `https:${url}` : String(url || '');
      assertAllowedUrl(absolute);
      const payload = await getJson(absolute, { headers, maxBytes: 8 * 1024 * 1024 });
      const body = Array.isArray(payload?.body) ? payload.body.slice(0, MAX_CUES) : [];
      return body
        .map((cue) => ({ from: Number(cue.from), to: Number(cue.to), text: String(cue.content || '').trim() }))
        .filter((cue) => cue.text && Number.isFinite(cue.from) && Number.isFinite(cue.to) && cue.to >= cue.from);
    },
    /**
     * 取分镜（storyboard）：B 站把整片缩略图拼成若干张 10×10 的大图，
     * index 里是每格对应的时间戳。无需登录、无需 wbi 签名。
     */
    async storyboard(bvid, cid) {
      const id = assertBvid(bvid);
      const page = Number(cid);
      if (!Number.isInteger(page) || page <= 0) throw new Error(`cid 不合法：${String(cid).slice(0, 24)}`);
      const payload = await getJson(`https://api.bilibili.com/x/player/videoshot?bvid=${id}&cid=${page}&index=1`, {
        headers,
        maxBytes: 2 * 1024 * 1024,
      });
      if (payload?.code !== 0) throw apiError('videoshot', payload);
      return payload.data;
    },
    /** 取一张分镜图的原始字节（JPEG）。 */
    async fetchImage(url) {
      const absolute = String(url || '').startsWith('//') ? `https:${url}` : String(url || '');
      assertAllowedUrl(absolute);
      const { body, contentType } = await getBytes(absolute, { headers, maxBytes: 8 * 1024 * 1024 });
      if (!/^image\//i.test(contentType || '')) {
        throw new HttpError(`分镜图类型异常：${contentType || '未知'}`, { kind: 'parse', url: absolute });
      }
      return body;
    },
  };
}

/** 在字幕轨里挑一条中文优先的轨道。 */
export function pickTrack(tracks) {
  const order = ['zh-CN', 'ai-zh', 'zh-Hans', 'zh', 'zh-Hant'];
  for (const lan of order) {
    const hit = tracks.find((track) => track.lan === lan);
    if (hit) return hit;
  }
  return tracks.find((track) => /^zh/i.test(track.lan || '')) || tracks[0];
}
