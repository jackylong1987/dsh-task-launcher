/**
 * dsh-jiaofei-ledger 服务端半边 —— **故意是空的**。
 *
 * 本插件要解决的问题全在浏览器里：在「会话头部动作区」加一个按钮，点一下把一段固定的提醒文本
 * 当作**用户消息**投递进当前会话，于是 agent 立刻按缴费台账出未缴费清单。投递走的是客户端已有的
 * 远程调用 `ctx.remote.session.prompt(...)`（见 `client/client.js`），**不碰服务端**：
 *   · 不注册路由、不读文件、不落盘 ⇒ 没有可信域名/路径边界这些安全面；
 *   · 不依赖任何 cordis 服务 ⇒ `inject` 为空，profile 里也不需要给它写 config。
 *
 * 它在层栈里存在的唯一理由：客户端 bundle 是按「插件行（row）」组合出来的
 * （`@deepseek-ai/dsh-client-modules` 拿行的包清单去解析 `exports["./client"]`），
 * 所以必须有这个宿主入口 —— 与 `dsh-long-composer` / `dsh-long-cad` 同一个道理。
 */
export const name = 'dsh-jiaofei-ledger'

/** 不依赖任何宿主服务。 */
export const inject = []

/**
 * 空实现：真正的工作在客户端半边。只留一行**加载痕迹**——
 * `dsh web` 的 stdout/stderr 落在实例自己的日志里，排障时能一眼确认插件有没有被层栈加载。
 */
export function apply() {
  try {
    console.log('[dsh-jiaofei-ledger] host half loaded (client button -> conversation.session.header.actions)')
  } catch (error) { /* 忽略：日志失败不能连累加载 */ }
}
