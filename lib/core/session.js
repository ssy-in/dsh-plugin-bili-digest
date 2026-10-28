/**
 * 登录态这一层的兜底：SESSDATA 掉了以后，读接口会一路 needs-login、写接口一路 -101，
 * 但表面上日记照样写、@ 一声不响全失败。所以每轮开头先验一次，掉了就当场停下来写一行提醒。
 */

/** 登录失效时写进当天日记/日报的那一行（纯文本，不含敏感信息）。 */
export function loginAlertText(now = new Date()) {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return [
    `## ${hhmm}`,
    '',
    '> ⚠️ B 站登录态失效（`nav` 返回未登录）：这一轮没刷、也没 @。',
    '> 去更新 `SESSDATA`（必要时连 `bili_jct` 一起）之后我就接着跑。',
    '',
  ].join('\n');
}

/** 这一轮到底能不能干活：能就返回 true，掉登录态就 false。 */
export function sessionUsable(session) {
  return Boolean(session && session.isLogin);
}

/** 给界面/日志看的一句话。 */
export function describeSession(session) {
  if (!session) return '登录态未知（没取到 nav）';
  if (session.isLogin) return `已登录：${session.uname || '（无名）'}`;
  return '登录态失效：需要更新 SESSDATA';
}
