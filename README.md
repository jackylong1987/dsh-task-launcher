# dsh-task-launcher

给 DSH（DeepSeek Harness）Web GUI 加一个**「任务」入口**：落在**会话标题下面那行页签**里
（位置＝「会话文件」标签的**左边**，图标 `IconChecklistOutlineRegular` + 文字「任务」）。

- 点一下弹出下拉，**自动列出所有 `status === 'active'` 的定时任务**（`title` ＋ 下次执行时间）。
- 点某条任务 ⇒ **先弹确认框**（写清任务名 + "将在当前会话立即执行" + 当前会话标题）；
  确认后才把**该任务自己的 `prompt` 原文**当成用户消息投进**当前会话**。
- 以后用户新建任何启用任务，都会自动出现在下拉里，**零代码改动**。
- 下拉里另有一条**内置兜底项**「未缴费清单（缴费台账）」走原来的硬编码文本，
  作为读不到定时任务时的兜底（两组之间有小标题分隔）。
- **待确认清单**：下拉里另有一条内置项，读工作区的 `dsh-confirm-board.json`，逐条勾「执行／暂缓／不做」，勾完一次性投进当前会话（详见下文）。
- **纯客户端插件**：宿主半边（`lib/index.js`）故意是空的，不注册路由、不读文件、不落盘。
- **不改核心**：DSH 自带包一个字节都没动；**不碰台账文件**。

## 落点（关键：为什么走 DOM 注入）

| 项 | 值 |
|---|---|
| 落点 | 会话页签行 `div[role=tablist][data-conversation-tabs]`（核心 `dsh-client-ui-conversation` 渲染） |
| 位置 | 「会话文件」按钮（`#dsh-long-session-files-btn`）**紧左边**；它不在时退回「轨迹」右边 |
| 会话 id | 从宿主写在正文容器上的 `[data-conversation-session]` 现取 |
| 图标 | `@deepseek-ai/dsh-client-ui-primitives` 的 `IconChecklistOutlineRegular`，`size: 16`（与旁边页签口径一致） |
| 组件 | `createTaskMenuView(host)` —— **与 slot 无关**，只依赖 host 注入的读/投递/会话能力 |

**核心没有"往那行塞一个按钮"的 slot**（`conversation.view` 是 list 型页签，但登记进去＝**把会话正文
整体换成那个视图**，不是"加一个入口"）。而「会话文件」本身就是第三方插件 `dsh-long-plugins`
用 DOM 注入放进去的，所以本插件沿用同一机制：

- 注入节点 `#dsh-task-launcher-task-tab`，`MutationObserver` 保证被宿主重渲染抹掉后能补回；
- React 树用 `reactDom.createPortal` 渲染进注入节点（事件照常工作，宿主重渲染抹不掉 React 树）；
- 外观**不硬凑 padding**：从旁边真实页签读 `fontSize/fontWeight/lineHeight/letterSpacing/fontFamily/color`
  同步过来；垂直位置由 CSS 的 `align-self:flex-start` + `padding:0 0 9px` 保证
  （页签容器是 `display:flex` 且没有 `align-items` ⇒ 默认 `stretch`；不写 `align-self` 会被拉满整行高
  再被 `align-items:center` 居中，就会**偏高约半行**——这是用户实测到的偏移，已修）。

## 数据来源（两个远程都读，取并集）

| 远程 | 作用 | 返回 |
|---|---|---|
| `ctx.remote.schedule.catalog()` | **全局**任务表（所有会话） | `Result<ScheduleCatalogEntry[]>`，含 `status` / `sessionId` |
| `ctx.remote.schedule.list({ sessionId })` | 该会话的任务 | `Result<ScheduleRecord[]>` |

**为什么必须两个都读**：宿主 `list` 的实现是
`task.sessionId === request.sessionId && task.status === 'active'`（**严格相等**，见
`dsh-schedule/lib/index.js` 的 `async list`）。客户端解析出来的 sessionId 只要与任务绑定的那个
不完全一致（换过会话、子会话、DOM 上读到别的会话），`list` 就返回**空数组**——而任务其实在
`catalog` 里。只读 `list` 的结果就是用户看到的那句误导文案「还没有自动化任务」（**已修**）。

两条支路各自回收成败，视图层区分：

- 任一支路读失败 ⇒ 显示 `任务读取失败：<code>`（内置兜底项仍可用）；
- 两支路都成功且确实没有 ⇒ 才显示「还没有自动化任务」。

关键字段（`@deepseek-ai/dsh-schedule` 的 `lib/types/types.d.ts`）：`id` / `kind` / `title` / `prompt`
（`ScheduleRecord`）＋ `sessionId` / `status` / `lastDelivery?`（`ScheduleCatalogEntry`）＋
`Record` 永远有的 `scheduledAt`。

## 投递请求

```js
ctx.remote.session.prompt({
  requestId: <客户端造的 UUID v4 字符串>,   // SessionRequestId = Branded<'session-request-id'>
  sessionId: <当前会话 id>,
  mode: 'queue',                            // 'queue' 不打断；'steer' 抢插队（改 client.js 的 MODE）
  content: [{ type: 'text', text: <该任务的 prompt 原文> }],
  clientTimeZone: 'Asia/Shanghai',
})
```

返回是 **Result 信封** `{ ok: true, value: { accepted: true } }` / `{ ok: false, error }` —— 按 `.ok` 判。

## 待确认清单（确认单）

下拉里另有一条 **「待确认清单 · N 项」**：读工作区里的 `dsh-confirm-board.json`，把 agent 列出的待办逐条摆出来让人勾，勾完一次性投进当前会话。

- **读法**：`GET /api/dsh-uploads/workspace-file?path=dsh-confirm-board.json`（dsh-long-plugins 的只读接口，按"工作区里同名唯一文件"兜底定位，插件不需要知道绝对路径）；面板开着时**每 10 秒＋切回窗口自动重读**，agent 写回文件后不用关掉再开——文件指纹没变则保留你已经点的选择。
- **每行三档**：执行 / 暂缓 / 不做。确认后拼成一条人类可读的清单（不是 JSON）投进当前会话，agent 照单执行。
- **只提交、不执行**：一个「执行」都没标、但有「暂缓 / 不做」时，按钮变成「提交选择」，消息里只交代归档与留档——不会误跑任何条目。
- **两种终态**：agent 执行完在文件里把该条 `decision` 写成 `done`（或 `archived`）⇒ 这些条目**不再出现在列表里**，只在底部留一个「已完成 N · 已归档 M」的计数。
- **投递目标可绑定（按标题）**：首项是「不绑定：投给当前会话」，下面一行文字说明怎么用（自建一个叫 `任务清单` 的会话 → 在「投递到」里选它）；确认单底部（和二次确认框里）都有一行「投递到」下拉＋`⟳` 刷新，默认「当前会话」；随时可改，改完立刻记住，选回「当前会话」就是取消绑定；选某个会话（例如叫 `任务清单` 的）就记在浏览器里，以后都投给它。绑定存的是**标题**不是 id：换会话时把新会话改成同名即可自动接上（同名取最近更新的那个）；找不到同名会话会明确报「没找到标题为「X」的会话」，不会投错地方。
- **跳过二次确认（可选）**：确认单底部与二次确认框里各有一个勾选「绑定固定会话时不再弹二次确认」，默认**关**。勾上后只在「投递到」选了固定会话时直接投；选「当前会话」时**永远**要确认。勾选框放在确认单底部是刻意的——跳过后还能在这里关掉，不会变成关不回去。
- **文件形状**：`{ schema, batch: { id, label }, items: [{ id, title, hint, risk, decision }] }`；`decision` 取 `run|defer|skip|done|archived`（不认识的值一律按"未选"处理，不会自动执行）。

## 安装

```bash
# 1) profile 依赖里加 link:
#    $DSH_HOME/profiles/web/package.json
#    dependencies["dsh-task-launcher"] = "link:<插件所在目录>"
cd "$DSH_HOME/profiles/web" && pnpm install

# 2) 再把 "dsh-task-launcher" 加进 dsh.profile.bundles
#    （分两步是刻意的：先有 symlink、再改 bundles）
```

## 让用户看到

**刷新浏览器页面**（Ctrl/Cmd-R 或 F5）。不需要重启 `dsh web`。

## 自检（离线，桩 React / 桩 primitives / 桩 DOM / 桩 ctx）

```bash
node <工作区>/plugin-lab/_verify/verify.mjs
# 期望：通过 N / 失败 0
```

## 回滚

```bash
cd "$DSH_HOME/profiles/web"
cp -p package.json.bak-tasks-<时间戳> package.json
pnpm install          # HMR 会把插件行摘掉
```

只想临时停用：把插件 `client/client.js` 的 `SLOT_BINDINGS` 置成 `[]`（改完刷新页面即生效）。

## 许可

MIT。
