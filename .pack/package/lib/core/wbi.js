// B 站 wbi 签名：img_key/sub_key 由 nav 接口下发，经固定置换表折叠成 32 位 mixin key。
import crypto from 'node:crypto';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export const md5 = (input) => crypto.createHash('md5').update(input).digest('hex');

export function mixinKeyFrom(navData) {
  const img = navData?.wbi_img?.img_url;
  const sub = navData?.wbi_img?.sub_url;
  if (typeof img !== 'string' || typeof sub !== 'string') throw new Error('nav 接口没有返回 wbi_img');
  const raw = img.split('/').pop().split('.')[0] + sub.split('/').pop().split('.')[0];
  if (raw.length < 64) throw new Error('wbi key 长度异常');
  return MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 生成签名 query（按键排序 + wts + w_rid）。 */
export function signQuery(mixinKey, params, now = Date.now()) {
  const withTs = { ...params, wts: Math.floor(now / 1000) };
  const base = Object.keys(withTs)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(withTs[key]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${base}&w_rid=${md5(base + mixinKey)}`;
}
