window.__ModuleLoader__.load({
  id: 'dsh-task-launcher',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    // 官方 UI 原子（菜单 / 确认框 / 按钮 / 图标）。**不自己造样式**，全部复用宿主已有观感。
    // `dsh.client.inject` 里列了它，`exports.inject` 不需要列（那是**服务名**，不是模块名）。
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // 只用来把菜单/确认框 portal 到宿主 DOM 里（与 ui-jobs / ui-schedule 同一用法）。
    const reactDom = require('react-dom')
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ===== dsh-task-launcher：会话头部动作区的「任务」下拉菜单 =====
    // 一个按钮 + 一个下拉：下拉内容**自动来自定时任务**（`ctx.remote.schedule.list` 里
    // `status === 'active'` 的全部任务），点某条任务 ⇒ **先弹确认** ⇒ 确认后才把**该任务的 `prompt` 原文**
    // 当成用户消息投进**当前会话**（走既有的 `ctx.remote.session.prompt`，`mode: 'queue'`）。
    // 以后用户新建任何定时任务，都会自动出现在下拉里，**零代码改动**。
    //
    // 分层（本文件刻意分成两半）：
    //   ⓐ **视图层（与 slot 无关）**：`createTaskMenuView(host)` —— 只依赖 host 传进来的
    //      `getSessionId` / `listSchedules` / `sendPrompt` / `subscribeChanged` / `t`，
    //      **完全不知道自己在哪个 slot 里**。桩 ctx 下可直接渲染与点击（见 `exports.__test__`）。
    //   ⓑ **登记层**：`SLOT_BINDINGS` 表 + `registerSlotBindings(ctx)` —— 把 ⓐ 挂到某个 slot。
    //      当前**故意留空**（用户尚未选定落点）；候选落点的契约与最小注册写法见文件末尾的
    //      `CANDIDATE_SLOTS`，选定后把对应一行填进 `SLOT_BINDINGS` 即可。
    //
    // 契约（全是官方扩展点，不碰核心、不碰别的插件）：
    //   · 读任务：`ctx.remote.schedule.list({ sessionId })`（`@deepseek-ai/dsh-schedule` 的远程命名空间）。
    //     ⚠️ 返回也是 **Result 信封** `{ ok: true, value: ScheduleCatalogEntry[] }`。
    //     ⚠️ 客户端要能 `ctx.remote.schedule.*`，**`exports.inject` 必须含 `'remote.schedule'`**
    //        （照 `dsh-client-ui-schedule` 的 inject 列表：`remote` + `remote.schedule` 两个都要）。
    //     ⚠️ `dsh.client.inject` 里是否要写 `@deepseek-ai/dsh-schedule`：**不写也能跑**
    //        （该名字在客户端模块图里没有对应行，客户端模块系统对 inject 里认不出的名字是
    //        `graphRows.get(name)` 存在性判断，认不出就忽略；见 ui-schedule 自己的 inject 列表，
    //        它列的是**别的客户端包**，`@deepseek-ai/dsh-schedule` 不在其中）。
    //        这里只列真正要在浏览器里 `require()` 的客户端包。
    //   · 投递：`ctx.remote.session.prompt(request)`（`@deepseek-ai/dsh-api-session-controller`）。
    //     ⚠️ 真实返回是 **Result 信封** `{ ok: true, value: { accepted: true } }` / `{ ok: false, error: {...} }`，
    //        不是裸的 `{ accepted: true }`。所以下面按 `.ok` 判。
    //     ⚠️ `requestId` 的类型是 `SessionRequestId = Branded<'session-request-id'>`，**运行时就是字符串**，
    //        官方自己也是 `randomUUID()` 造的 ⇒ 这里照做。
    //   · `mode`：'queue' ＝接在当前回合后面；'steer' ＝打断当前回合。这里用 **'queue'**：
    //        会话空闲时它直接进正文并立刻开跑（就是"立即"），会话忙时它排队不打断 agent。
    //   · 确认交互：**复用** `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（`footer` 确认行），
    //        与 `dsh-client-ui-schedule/lib/client.js` 里删除提醒的 `confirming`/`onConfirm`/`footerRef`
    //        那一套**同一个写法**：`Modal(title/description/onClose/footer)` + footer 里
    //        「取消」（outline）+「执行」（primary），`data-modal-autofocus` 让焦点落在执行按钮上，
    //        Esc / 遮罩点击 / 关闭按钮都走 `onClose`（＝取消，什么都不做）。
    //
    // 边界：不改核心、不改别的插件；插件停用即整体撤销（登记挂在 ctx.effect / slots.inject 上）。
    // 迭代期注意：本文件是**客户端 bundle**，改完刷新页面即可，不用重启 DSH。

    /** 本插件的 locale 命名空间。 */
    const NS = 'task-launcher'
    /** 投递模式：'queue'（不打断）或 'steer'（打断/抢插队）。 */
    const MODE = 'queue'
    /** 用户没给时区时的兜底（本机在国内）。 */
    const FALLBACK_TIME_ZONE = 'Asia/Shanghai'
    /** 成功提示保留时长；失败提示保留时长（失败留久一点，好读错误码）。 */
    const OK_HINT_MS = 4000
    const FAIL_HINT_MS = 9000
    /** 下拉里"内置兜底项"的固定 id（与定时任务的 id 不会撞：任务 id 是宿主发的 uuid）。 */
    const BUILTIN_ID = 'dsh-task-launcher:builtin-unpaid-list'
    /** `schedule/list` 只返回该会话相关的任务；`status` 为 'active' 的才列进下拉。 */
    const ACTIVE = 'active'
    /** 「会话标签行」落点的 DOM 标记（核心 ui-conversation 写的稳定标记）。 */
    const TABS_SELECTOR = '[data-conversation-tabs]'
    /** 「会话文件」标签按钮的 id（`dsh-long-plugins` 自己注入的，就是它把「会话文件」放进那行）。 */
    const SESSION_FILES_BTN_ID = 'dsh-long-session-files-btn'
    /** 本插件注入的「任务」标签按钮 id。 */
    const TASK_TAB_BTN_ID = 'dsh-task-launcher-task-tab'
    /** 宿主写在会话正文容器上的 sessionId 标记（页签行里没有 sessionId，只能从这里取）。 */
    const SESSION_ATTR = 'data-conversation-session'

    /**
     * 待确认清单（确认单）的数据文件名 —— 落在**工作区**里，由主会话（agent）维护，本插件**只读**。
     *
     * 为什么走「工作区文件」而不是插件自己的路由/落盘：
     *   · 本插件是纯客户端的（宿主半边故意为空），加路由＝改服务端 ⇒ 要重启 dsh 才生效；
     *   · 清单的产生方是 agent（按交接单写），勾选结果也由 agent 执行后回写 ⇒ 文件是唯一真源，
     *     插件只负责"读出来给人选"，选完把选择当成一条消息投进会话。
     * 读取复用 dsh-long-plugins 的既有只读接口 GET /api/dsh-uploads/workspace-file，
     * 不新开任何服务端能力、不碰核心。
     */
    const BOARD_FILE = 'dsh-confirm-board.json'
    /** 固定投递目标记在浏览器本地：存的是**会话标题**（不是 id），换会话改同名即可接上。 */
    const BOARD_TARGET_KEY = 'dsh-task-launcher:board-target-title'
    /** 「绑定固定会话时跳过二次确认」的开关（同样记在本地，默认关＝每次都要确认）。 */
    const BOARD_SKIP_ASK_KEY = 'dsh-task-launcher:board-skip-ask'
    /** 确认单条目在下拉里的固定 id（与定时任务的 uuid 不会撞）。 */
    const BOARD_ITEM_ID = 'dsh-task-launcher:confirm-board'
    /** 三档选择：执行 / 暂缓 / 不做；'none' ＝ 还没定。 */
    const CHOICE_RUN = 'run'
    const CHOICE_DEFER = 'defer'
    const CHOICE_SKIP = 'skip'
    const CHOICE_NONE = 'none'

    /**
     * 台账在**当前工作区**里的相对路径（交付包/仓库里只留相对路径与说明，
     * 不写死本机绝对路径——绝对路径会把机器与客户标识带出去）。
     * 台账不在当前工作区时，由模型按这个名字去找、找不到就问用户要路径。
     */
    const LEDGER_REL = '05-流程事务/缴费台账/缴费台账.csv'

    /**
     * 内置兜底项的要投递的提醒文本（**逐字固定**，不要在这里"顺手改口径"）。
     * 里面的列名/阈值都是台账那边的既有约定，改这里等于改行为。
     */
    const PROMPT_TEXT = `【缴费台账·手动触发】生成未缴费清单（只读，不改文件、不写远程）：
1. 读当前工作区下的 ${LEDGER_REL}（不在当前工作区就先按这个相对路径找，找不到向用户确认台账路径），取「状态＝待缴」的行，按缴费期限升序列出：申请号/专利号、名称、费用类型、应缴合计(元)、缴费期限、剩余天数；剩余 ≤7 天的标「急」。
2. 「状态＝已逾期」的行单列，注明请人工核实。
3. 只输出清单；不要改台账。`

    /** 中文文案（也是 `t` 不可用时的兜底字典）。 */
    const zh = {
      'action.label': '任务',
      'action.aria': '自动化任务',
      'action.title': '选一条自动化任务，确认后立刻在当前会话执行它',
      'menu.loading': '读取任务…',
      'menu.empty': '还没有自动化任务',
      'menu.error': '任务读取失败：{code}',
      'menu.retry': '重试',
      'menu.group.schedule': '自动化任务',
      'menu.group.builtin': '内置兜底',
      'menu.next': '下次 {time}',
      'menu.nextNow': '即将执行',
      'menu.builtin.label': '未缴费清单（缴费台账）',
      'menu.builtin.note': '兜底项：正常应走定时任务',
      'state.sending': '投递中…',
      'state.sent': '已投递',
      'state.failed': '投递失败：{code}',
      'confirm.title': '执行这条任务？',
      'confirm.body': '将在当前会话立即执行。',
      'confirm.session': '当前会话：{title}',
      'confirm.cancel': '取消',
      'confirm.run': '执行',
      'confirm.close': '取消并关闭',
      'tab.label': '任务',
      'tab.aria': '任务：选一条自动化任务，确认后在当前会话执行',
      // ── 待确认清单（确认单）────────────────────────────────
      'board.group': '待确认清单',
      'board.item': '{count} 项',
      'board.itemPending': '{count} 待定',
      'board.loading': '读取确认单…',
      'board.error': '确认单读取失败：{code}',
      'board.empty': '还没有确认单（agent 写 {file} 后出现在这里）',
      'board.title': '待确认清单',
      'board.subtitle': '本批 {count} 项 · {batch}',
      'board.hint': '「执行」这次做　「暂缓」下次再提　「不做」归档',
      'board.run': '执行',
      'board.defer': '暂缓',
      'board.skip': '不做',
      'board.selectAll': '全选',
      'board.clearAll': '全不选',
      'board.summary': '执行 {run} · 暂缓 {defer} · 不做 {skip} · 待定 {none}',
      'board.summaryDone': '已完成 {done} · 已归档 {archived}',
      'board.nothingOpen': '本批没有待决条目，结案记录见下。',
      'board.cancel': '取消',
      'board.confirm': '确认并执行（{count}）',
      'board.nothing': '一项都没标（至少标一个「执行」「暂缓」或「不做」）',
      'board.confirmSubmit': '提交选择',
      'board.askBodyNoRun': '这次没有要执行的条目：只把你标的「暂缓 / 不做」写进确认单（不做的会被归档）。',
      'board.sending': '投递中…',
      'board.askTitle': '在当前会话执行？',
      'board.askBody': '这 {count} 条会立刻投进下面选定的会话（默认当前会话），不新建会话。',
      'board.askSession': '当前会话：{title}',
      'board.askHint': '开错会话的话，先取消，切到目标会话再点一次。',
      'board.targetLabel': '投递到',
      'board.targetCurrent': '当前会话（{title}）',
      'board.targetNone': '不绑定：投给当前会话',
      'board.sentTo': '已投递到「{title}」',
      'board.targetHelp': '在框里打字就能筛会话名（也可以直接手打，例如「任务清单」）；选好失焦或回车即生效。以后换会话，把新会话改成同名就自动接上。',
      'board.targetEmpty': '（没读到别的会话，点 ⟳ 刷新）',
      'board.targetPlaceholder': '不绑定＝投当前会话；打字可筛会话名',
      'board.targetCount': '共 {count} 个会话',
      'board.targetHint': '按标题绑定：以后换会话，把新会话改成同名就自动接上（同名会话取最近更新的那个）。',
      'board.targetMissing': '没找到标题为「{title}」的会话——是不是改名或归档了？',
      'board.skipAsk': '绑定固定会话时不再弹二次确认',
      'board.skipAskNeedTarget': '先在左边「投递到」选一个固定会话，这个开关才有意义',
      'board.targetRefresh': '刷新会话列表',
      'board.skipAskNow': '投递到：{title}',
      'board.skipAskOff': '投递到：当前会话（始终要确认）',
      'board.askRun': '就在这个会话执行',
    }

    /** 英文文案（UI 语言切到 en 时用）。 */
    const en = {
      'action.label': 'Tasks',
      'action.aria': 'Automation tasks',
      'action.title': 'Pick an automation task and run it in this session right away',
      'menu.loading': 'Loading tasks…',
      'menu.empty': 'No automation tasks yet',
      'menu.error': 'Could not load tasks: {code}',
      'menu.retry': 'Retry',
      'menu.group.schedule': 'Scheduled tasks',
      'menu.group.builtin': 'Built-in fallback',
      'menu.next': 'Next {time}',
      'menu.nextNow': 'Due now',
      'menu.builtin.label': 'Unpaid fees (fee ledger)',
      'menu.builtin.note': 'Fallback: normally a scheduled task',
      'state.sending': 'Posting…',
      'state.sent': 'Posted',
      'state.failed': 'Post failed: {code}',
      'confirm.title': 'Run this task?',
      'confirm.body': 'It will run in the current session immediately.',
      'confirm.session': 'Current session: {title}',
      'confirm.cancel': 'Cancel',
      'confirm.run': 'Run',
      'confirm.close': 'Cancel and close',
      'tab.label': 'Tasks',
      'tab.aria': 'Tasks: pick an automation task and run it in this session after confirming',
      // ── confirm board ─────────────────────────────────────
      'board.group': 'Pending confirmations',
      'board.item': '{count} items',
      'board.itemPending': '{count} undecided',
      'board.loading': 'Loading…',
      'board.error': 'Could not load: {code}',
      'board.empty': 'No confirmation board yet (agent writes {file})',
      'board.title': 'Pending confirmations',
      'board.subtitle': '{count} items · {batch}',
      'board.hint': 'Run = do it now · Defer = raise again next time · Skip = archive',
      'board.run': 'Run',
      'board.defer': 'Defer',
      'board.skip': 'Skip',
      'board.selectAll': 'All run',
      'board.clearAll': 'Clear',
      'board.summary': 'Run {run} · Defer {defer} · Skip {skip} · Undecided {none}',
      'board.summaryDone': 'Done {done} · Archived {archived}',
      'board.nothingOpen': 'Nothing left to decide in this batch; closed records below.',
      'board.cancel': 'Cancel',
      'board.confirm': 'Confirm and run ({count})',
      'board.nothing': 'Nothing marked (pick at least one: Run / Defer / Skip)',
      'board.confirmSubmit': 'Submit choices',
      'board.askBodyNoRun': 'Nothing to run: this only records your Defer / Skip picks (skipped ones get archived).',
      'board.sending': 'Posting…',
      'board.askTitle': 'Run in the current session?',
      'board.askBody': 'These {count} items will be posted into the session chosen below (current by default); no new session is created.',
      'board.askSession': 'Current session: {title}',
      'board.askHint': 'If this is the wrong session, cancel, switch, then click again.',
      'board.targetLabel': 'Deliver to',
      'board.targetCurrent': 'Current session ({title})',
      'board.targetNone': 'Not bound: deliver to the current session',
      'board.sentTo': 'Delivered to "{title}"',
      'board.targetHelp': 'Type to filter session titles (or type one directly, e.g. "任务清单"); blur or Enter to apply. Rename a new session to the same title later and it takes over.',
      'board.targetEmpty': '(no sessions loaded — click ⟳)',
      'board.targetPlaceholder': 'Empty = current session; type to filter',
      'board.targetCount': '{count} sessions',
      'board.targetHint': 'Bound by title: rename a new session to the same title and it takes over (latest match wins).',
      'board.targetMissing': 'No session titled "{title}" — renamed or archived?',
      'board.skipAsk': 'Skip the second confirmation when a fixed session is bound',
      'board.skipAskNeedTarget': 'Pick a fixed session in Deliver to first',
      'board.targetRefresh': 'Refresh session list',
      'board.skipAskNow': 'Deliver to: {title}',
      'board.skipAskOff': 'Deliver to: current session (always confirmed)',
      'board.askRun': 'Run here',
    }

    /** 样式。用核心的设计令牌，跟宿主其它头部控件同一个观感（下拉卡片本身由 primitives 画）。 */
    const CSS = `
.dsh-task-launcher{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsh-task-launcher-btn{font:inherit;font-size:12px;line-height:18px;min-height:28px;padding:3px 10px;white-space:nowrap;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-task-launcher-btn:hover:not(:disabled),.dsh-task-launcher-btn:focus-visible{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-l1)}
.dsh-task-launcher-btn:disabled{cursor:default;opacity:.55}
.dsh-task-launcher-btn.is-ok{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent)}
.dsh-task-launcher-btn.is-err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.dsh-task-launcher-caret{font-size:9px;line-height:1;opacity:.7}
.dsh-task-launcher-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.dsh-task-launcher-hint.is-err{color:var(--dsw-alias-state-error-primary)}
.dsh-task-launcher-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-quaternary)}
/* 会话标签行落点：只包住一个按钮，提示用绝对定位，避免把页签行挤动。
   对齐的关键：页签容器 .wSkVaW_tabs 是 display:flex 且没有 align-items
   ⇒ 默认 stretch，每个直接子元素都被拉到整行高。旁边那些页签是「按钮本身」当 flex 子项：
   内容盒在顶部 + padding:0 0 9px ⇒ 文字落在「行顶 + 9px」处。
   所以这里必须 align-self:flex-start（＝自己不被拉伸），否则外层容器被拉到整行高、再
   align-items:center 把按钮垂直居中，就会比旁边页签偏高约半行（用户实测的偏移）。
   第三方「会话文件」页签也是这么解决的（dsh-long-plugins 给按钮 align-self:flex-start）。 */
.dsh-task-launcher.is-tab{position:relative;display:inline-flex;align-self:flex-start;align-items:flex-start;margin:0}
/* 外观尽量对齐旁边页签：与核心 .tab 同口径（padding:0 0 9px、13px/500/16px 行高、无边框）。
   下面 syncTabGeometry() 还会把宿主页签的实测排版（字号/行高/字重/字距/颜色）盖上来，
   所以核心改版后也不会错位；不再从按钮上量 padding（避免把"stretch 后的盒子"量进来）。 */
.dsh-task-launcher-tab{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;margin:0;padding:0 0 9px;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:500;line-height:16px;cursor:pointer}
.dsh-task-launcher-tab:hover:not(:disabled),.dsh-task-launcher-tab:focus-visible{color:var(--dsw-alias-label-secondary)}
.dsh-task-launcher-tab:disabled{cursor:default;opacity:.55}
.dsh-task-launcher-tab.is-ok{color:var(--dsw-alias-state-business-primary)}
.dsh-task-launcher-tab.is-err{color:var(--dsw-alias-state-error-primary)}
.dsh-task-launcher-tab .dsh-task-launcher-caret{font-size:8px}
.dsh-task-launcher.is-tab .dsh-task-launcher-hint{position:absolute;left:0;top:100%;max-width:220px}
.dsh-task-launcher-item{display:inline-flex;align-items:center;gap:8px;min-width:0}
/* 列表项前导圆点：**纯装饰，不表达启用状态**（用户明确）。固定中性灰。 */
.dsh-task-launcher-dot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-quaternary,currentColor);opacity:.75}
/* 内置兜底项用描边圈，只是跟真任务视觉上区分。 */
.dsh-task-launcher-dot.is-outline{background:0 0;box-shadow:inset 0 0 0 1px var(--dsw-alias-label-quaternary,currentColor)}
.dsh-task-launcher-item-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-task-launcher-state{padding:4px 8px}
.dsh-task-launcher-confirm-actions{display:flex;gap:8px;justify-content:flex-end}
.dsh-task-launcher-confirm-title{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
/* ── 确认单（待确认清单）────────────────────────────────── */
.dsh-board-rows{display:flex;flex-direction:column;gap:2px;max-height:52vh;overflow-y:auto;margin-top:4px}
.dsh-board-row{display:flex;align-items:flex-start;gap:10px;padding:8px 2px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-width:0}
.dsh-board-row:last-child{border-bottom:none}
.dsh-board-rowText{flex:1;min-width:0}
.dsh-board-rowTitle{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-board-rowHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:1px}
.dsh-board-rowRisk{font-size:11px;line-height:16px;color:var(--dsw-alias-label-quaternary);margin-top:1px}
.dsh-board-row.is-skip .dsh-board-rowTitle,.dsh-board-row.is-defer .dsh-board-rowTitle{color:var(--dsw-alias-label-tertiary);font-weight:400}
.dsh-board-rowActions{flex:none;display:flex;gap:4px}
.dsh-board-pill{font:inherit;font-size:11px;line-height:16px;min-height:24px;padding:3px 8px;white-space:nowrap;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-board-pill:hover:not(:disabled),.dsh-board-pill:focus-visible{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary)}
.dsh-board-pill:disabled{cursor:default;opacity:.55}
.dsh-board-pill.is-run.is-on{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}
.dsh-board-pill.is-defer.is-on{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
.dsh-board-pill.is-skip.is-on{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsh-board-summary{margin-right:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
/* footer：上行汇总、下行按钮；按钮固定宽度 + nowrap，绝不换行/压缩。 */
.dsh-board-switch{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none}
.dsh-board-switch input{width:13px;height:13px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.dsh-board-switch input:disabled{cursor:not-allowed;opacity:.5}
.dsh-board-switch .is-muted{opacity:.55}
.dsh-board-setting{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-board-settingLabel{flex:none}
.dsh-board-btn.is-mini{min-height:22px;padding:1px 8px;font-size:12px;line-height:16px}
.dsh-board-target{display:flex;align-items:center;gap:8px;margin:10px 0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-board-select{flex:1;min-width:0;max-width:100%;font:inherit;font-size:12px;padding:2px 6px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.dsh-board-footer{display:flex;flex-direction:column;gap:8px;width:100%}
.dsh-board-footerLine{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-board-footerActions{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:nowrap}
.dsh-board-btn{font:inherit;font-size:12px;line-height:18px;min-height:30px;padding:5px 14px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;flex:none;min-width:64px}
.dsh-board-btn:hover:not(:disabled),.dsh-board-btn:focus-visible{background:var(--dsw-alias-fill-l1)}
.dsh-board-btn:disabled{cursor:default;opacity:.5}
.dsh-board-btn.is-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff;font-weight:500;min-width:132px}
.dsh-board-btn.is-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-state-business-primary)}
`

    /**
     * 客户端自造 `requestId`。与核心 `@deepseek-ai/dsh-util-crypto` 的 `randomUUID` 同一路子
     * （`crypto.getRandomValues`），只是这里不引它的包（纯客户端、零 require 依赖）。
     * 拿不到 WebCrypto 时退回 Math.random，**只为唯一性**，不是安全用途。
     * @returns {string} 形如 UUID v4 的字符串（`SessionRequestId` 运行时就是字符串）。
     */
    const newRequestId = () => {
      try {
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
        bytes[6] = (bytes[6] & 15) | 64
        bytes[8] = (bytes[8] & 63) | 128
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      } catch (error) {
        const rnd = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1)
        return `${rnd()}${rnd()}-${rnd()}-${rnd()}-${rnd()}-${rnd()}${rnd()}${rnd()}`
      }
    }

    /**
     * 报给宿主的浏览器时区；取不到就用兜底值。核心自己也是这么算的
     * （`resolvedClientTimeZone()`），这里只是不引它的内部函数。
     * @returns {string} IANA 时区名。
     */
    const resolveClientTimeZone = () => {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
        return typeof zone === 'string' && zone !== '' ? zone : FALLBACK_TIME_ZONE
      } catch (error) {
        return FALLBACK_TIME_ZONE
      }
    }

    /**
     * 造一个翻译函数：优先用框架给的 `t`，没有就退回本地 zh 字典
     * —— **菜单必须永远能显示出来**，不能因为 i18n 哑掉。
     * @param t - 渲染器注入的翻译函数（声明了 `locale: NS` 才有）。
     * @returns {(key: string, params?: Record<string, unknown>) => string} 翻译函数。
     */
    const makeTranslator = (t) => {
      if (typeof t === 'function') return t
      return (key, params) => {
        const template = zh[key] !== undefined ? zh[key] : key
        if (!params) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    }

    /**
     * 从错误信封里取一个能看的短码（`RemoteResult` 的 error 面 / 抛出的异常都能吃）。
     * @param error - `{ code }` / `{ message }` / Error / 任意值。
     * @returns {string} 短码或消息。
     */
    const errorCode = (error) => {
      if (error === undefined || error === null) return 'unknown'
      if (typeof error === 'string') return error
      if (typeof error === 'object') {
        if (typeof error.code === 'string' && error.code !== '') return error.code
        if (typeof error.message === 'string' && error.message !== '') return error.message
      }
      return String(error)
    }

    /**
     * 下游把一条 `ScheduleCatalogEntry` 收成视图层用的形状。**只读下面这几个字段**，
     * 与 `@deepseek-ai/dsh-schedule/lib/types/types.d.ts` 的 `ScheduleRecord` /
     * `ScheduleCatalogEntry` 逐字对齐：
     * `id` / `kind` / `title` / `prompt`（来自 `ScheduleRecord`）＋
     * `sessionId` / `status` / `lastDelivery?`（来自 `ScheduleCatalogEntry`）＋
     * 各 kind 自己的时间字段（`scheduledAt` 全部都有，`everySeconds` / `time` / `weekdays` / `expression` 只有对应 kind 有）。
     * @param entry - `schedule/list` 返回的一条记录。
     * @returns 视图层形状（`title` 为空时用 `prompt` 首行兜底当标签）。
     */
    const taskEntryOf = (entry) => {
      const prompt = typeof entry.prompt === 'string' ? entry.prompt : ''
      const title = typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title : prompt.split('\n')[0]
      return {
        id: String(entry.id),
        title,
        prompt,
        kind: entry.kind,
        scheduledAt: entry.scheduledAt,
        sessionId: entry.sessionId,
        builtin: false,
      }
    }

    /**
     * 内置兜底项。**这是兜底，正常应走定时任务**：只有当用户没有把「未缴费清单」建成定时任务
     * （或 `schedule/list` 读失败）时，用它保证功能仍然可用。
     * @returns 视图层形状的任务条目。
     */
    const builtinTask = () => ({
      id: BUILTIN_ID,
      title: null, // 标签走 locale（menu.builtin.label），不写死中文
      prompt: PROMPT_TEXT,
      kind: 'builtin',
      scheduledAt: null,
      sessionId: null,
      builtin: true,
    })

    /**
     * 把 `schedule/list` 的结果折成下拉要列的任务：**只留 `status === 'active'`**。
     * 不在视图层再按时间过滤（"active" 由宿主判定，客户端不重复判断规则，免得两处口径打架）。
     * @param records - `schedule/list` 的 `value`（应为数组）。
     * @returns {Array} 视图层任务列表（原顺序）。
     */
    const activeTasksOf = (records) => {
      if (!Array.isArray(records)) return []
      return records
        .filter((record) => record !== null && typeof record === 'object' && record.status === ACTIVE)
        .map(taskEntryOf)
    }

    //#region 待确认清单（确认单）：读文件 → 归一化 → 选择 → 投递文本
    /**
     * 终态判定：`done`／`archived` 是**已结案**，只读展示、永不再参与选择。
     * 为什么必须单独认：`normalizeChoice` 对认不出的值一律回 `none`，于是 agent 标了
     * `done`/`archived` 的条目会退回「待定」，每批都得把条目搬出 `items` 才能让界面干净。
     * @param value - 文件里的 `decision` 原文。
     * @returns {'done'|'archived'|'open'}
     */
    const itemState = (value) => {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (text === 'done' || text === 'completed') return 'done'
      if (text === 'archived') return 'archived'
      return 'open'
    }

    /**
     * 把确认单文件（`{ schema, batch, items[] }`）归一化成视图层形状。
     * 容错口径：**坏条目直接丢**（宁可少显示，也不显示一条点不动的空行）；整份坏 ⇒ 空清单 + ok:false。
     * @param raw - 文件原始文本（JSON 字符串）。
     * @returns {{ ok: boolean, error?: string, batch: string, items: Array }}
     */
    const parseBoard = (raw) => {
      const empty = { ok: false, error: 'empty', batch: '', items: [] }
      if (typeof raw !== 'string' || raw.trim() === '') return empty
      let data
      try {
        data = JSON.parse(raw)
      } catch (error) {
        return { ok: false, error: 'bad-json', batch: '', items: [] }
      }
      if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) {
        return { ok: false, error: 'bad-shape', batch: '', items: [] }
      }
      const batch = data.batch && typeof data.batch === 'object' && typeof data.batch.label === 'string'
        ? data.batch.label
        : ''
      const items = []
      for (const item of data.items) {
        if (item === null || typeof item !== 'object') continue
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (id === '' || title === '') continue
        items.push({
          id,
          title,
          hint: typeof item.hint === 'string' ? item.hint : '',
          risk: typeof item.risk === 'string' ? item.risk : '',
          decision: normalizeChoice(item.decision),
          state: itemState(item.decision),
        })
      }
      return { ok: true, error: '', batch, items }
    }

    /**
     * 把任意值收成四档之一；认不出的一律当 `none`（**绝不默认执行**）。
     * @param value - 待收的值。
     * @returns {'run'|'defer'|'skip'|'none'}
     */
    const normalizeChoice = (value) => {
      const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (text === CHOICE_RUN) return CHOICE_RUN
      if (text === CHOICE_DEFER) return CHOICE_DEFER
      if (text === CHOICE_SKIP) return CHOICE_SKIP
      return CHOICE_NONE
    }

    /**
     * 统计各类计数（底部汇总与按钮括号都用它）。
     * @param items - 视图层条目。
     * @param overrides - 本轮点改后的选择（`{ [id]: choice }`）。
     * @returns {{ run: number, defer: number, skip: number, none: number, total: number, done: number, archived: number }}
     */
    const boardCounts = (items, overrides) => {
      const picked = overrides && typeof overrides === 'object' ? overrides : {}
      const counts = { run: 0, defer: 0, skip: 0, none: 0, total: 0, done: 0, archived: 0 }
      for (const item of Array.isArray(items) ? items : []) {
        if (item && (item.state === 'done' || item.state === 'archived')) {
          counts[item.state] += 1
          continue
        }
        const choice = normalizeChoice(picked[item.id] !== undefined ? picked[item.id] : item.decision)
        counts[choice] += 1
        counts.total += 1
      }
      return counts
    }

    /**
     * 按**标题**挑投递目标：同名取最近更新的那个。
     * 为什么按标题不按 id：用户换会话的习惯是把旧的「任务清单」归档、把新会话改名叫同名，
     * 按 id 绑就断了；按标题绑，改名那一刻自动接上（旧的更新时间更早，自然排在后面）。
     * @param rows - `[{ id, title, updatedAt }]`（`host.listSessions()` 的返回）。
     * @param title - 绑定的会话标题；空串＝不绑（返回 null）。
     * @returns 命中的那一行，或 `null`。
     */
    const pickTargetSession = (rows, title) => {
      if (typeof title !== 'string' || title.trim() === '') return null
      const hits = (Array.isArray(rows) ? rows : []).filter((row) => row && row.title === title)
      if (hits.length === 0) return null
      hits.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      return hits[0]
    }

    /**
     * 把本轮选择拼成**要投进会话的那条消息**（agent 照着执行）。
     * 刻意写成人类可读的清单而不是 JSON：agent 读得懂，用户事后翻聊天也看得懂。
     * @param items - 视图层条目。
     * @param overrides - 本轮选择。
     * @param options - `{ batch }`。
     * @returns {string} 投递文本；没有任何「执行」时返回空串（调用方据此拦下）。
     */
    const boardPrompt = (items, overrides, options) => {
      const picked = overrides && typeof overrides === 'object' ? overrides : {}
      const opts = options && typeof options === 'object' ? options : {}
      const pick = (want) => (Array.isArray(items) ? items : []).filter((item) => {
        if (item && (item.state === 'done' || item.state === 'archived')) return false
        const choice = normalizeChoice(picked[item.id] !== undefined ? picked[item.id] : item.decision)
        return choice === want
      })
      const run = pick(CHOICE_RUN)
      const defer = pick(CHOICE_DEFER)
      const skip = pick(CHOICE_SKIP)
      // 只有「暂缓 / 不做」也要能提交：否则点了「不做」却什么都发生不了（用户 2026-11-11 反馈）。
      if (run.length === 0 && defer.length === 0 && skip.length === 0) return ''
      const lines = []
      if (run.length > 0) {
        lines.push(`【待确认清单】按我在确认单上的选择执行（${opts.batch ? opts.batch + ' · ' : ''}执行 ${run.length} 项）：`)
        lines.push('')
        lines.push('要执行的：')
        run.forEach((item, index) => lines.push(`${index + 1}. ${item.title}（${item.id}）`))
      } else {
        lines.push(`【待确认清单】这次没有要执行的条目，只提交选择${opts.batch ? '（' + opts.batch + '）' : ''}：`)
      }
      if (defer.length > 0) {
        lines.push('')
        lines.push('暂缓（本次不做，下次清单开头再提）：')
        defer.forEach((item) => lines.push(`- ${item.title}（${item.id}）`))
      }
      if (skip.length > 0) {
        lines.push('')
        lines.push('不做（归档，以后不再出现）：')
        skip.forEach((item) => lines.push(`- ${item.title}（${item.id}）`))
      }
      lines.push('')
      lines.push(run.length > 0
        ? `执行完请把结果写回 ${BOARD_FILE}：执行过的标 done、暂缓的留到下批、不做的标 archived。`
        : `这次没有要执行的条目：请把标「不做」的直接改成 archived、暂缓的原样留到下批，结果写回 ${BOARD_FILE}。`)
      return lines.join('\n')
    }
    //#endregion

    /**
     * 把 `scheduledAt`（RFC 3339 UTC）排成本地可读的"下次"。
     * 纯函数，便于离线单测；坏值/缺值一律返回空串（不显示这一行）。
     * @param scheduledAt - 记录的 `scheduledAt`。
     * @param now - 当前时间戳（注入以便单测）。
     * @returns {{ text: string, due: boolean }} `text` 为空时渲染层不显示。
     */
    const formatScheduledAt = (scheduledAt, now) => {
      if (typeof scheduledAt !== 'string' || scheduledAt === '') return { text: '', due: false }
      const at = Date.parse(scheduledAt)
      if (!Number.isFinite(at)) return { text: '', due: false }
      const stamp = Number.isFinite(now) ? now : Date.now()
      if (at <= stamp) return { text: '', due: true }
      const date = new Date(at)
      const pad = (value) => String(value).padStart(2, '0')
      return {
        text: `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
        due: false,
      }
    }

    /**
     * 视图层组件工厂 —— **与 slot 无关**。
     *
     * host 契约（由登记层按落点装配）：
     *   · `getSessionId()` ⇒ 目标会话 id（这条任务要投进哪个会话）。slot 无关的关键：**每次点击时现取**，
     *     不在闭包里绑死，换会话/换行都不会投错。取不到 ⇒ 直接报 `no-session`，不发请求。
     *   · `getSessionTitle()` ⇒ 可选，用来在确认框里写清"当前会话"。
     *   · `listSchedules(sessionId)` ⇒ `Promise<{ tasks, sessionResult, catalogResult }>`，
     *     见 `createRemoteHost` 的实现：**两个远程都读**——
     *     `ctx.remote.schedule.catalog()`（**全局**，返回 `ScheduleCatalogEntry[]`，含 `status`）
     *     ＋ `ctx.remote.schedule.list({ sessionId })`（**该会话**，返回 `ScheduleRecord[]`），
     *     再按 id 合并、只留 `status === 'active'`。
     *     为什么要两个：`list` 按 `task.sessionId === request.sessionId` **严格相等**过滤（宿主实现，
     *     见 `dsh-schedule/lib/index.js` 的 `async list`），只要客户端解析出的 sessionId 与任务绑定的
     *     那个不完全一致（换会话、子会话、DOM 上取到别的会话），就会**空列表**——而任务其实在 `catalog` 里。
     *     `sessionResult` / `catalogResult` 各自是 `{ ok, error }`，用来区分"确实为空"与"读不到"。
     *   · `sendPrompt(sessionId, text)` ⇒ `Promise<Result<{accepted:true}>>`，即
     *     `ctx.remote.session.prompt({...})` 的返回。
     *   · `subscribeChanged(listener)` ⇒ 可选，`schedule/changed` 的订阅（返回退订函数）；
     *     变了就把缓存标脏，下次打开下拉重读。
     *   · `t` ⇒ 框架注入的翻译函数（可选，缺了退回本地 zh 字典）。
     *   · `label` ⇒ 可选，覆盖按钮文字（某些落点只放得下一个图标/短词）。
     *
     * @param host - 上述宿主能力集合。
     * @returns 一个 React 组件：按钮 + 下拉 + 确认框。
     */
    const createTaskMenuView = (host) => {
      const TaskMenu = (props) => {
        const t = makeTranslator(props && props.t !== undefined ? props.t : host.t)
        // 落点变体：'inline'（默认，图标/文字按落点自定）｜'tab'（会话标题下面那行页签，图标+文字）。
        const variant = props && props.variant === 'tab' ? 'tab' : 'inline'
        const taskMenu = primitives && primitives.Menu
        const menuItemButton = primitives && primitives.MenuItemButton
        const modal = primitives && primitives.Modal
        const button = primitives && primitives.Button
        const checklistIcon = primitives && primitives.IconChecklistOutlineRegular

        const [open, setOpen] = React.useState(false)
        /** 'idle' | 'loading' | 'ready' | 'empty' | 'error' */
        const [phase, setPhase] = React.useState('idle')
        const [tasks, setTasks] = React.useState([])
        const [loadError, setLoadError] = React.useState('')
        /** 正等确认的条目（null 表示没有确认框）。 */
        const [pending, setPending] = React.useState(null)
        /** 确认框里的"执行"是否在投递中。 */
        const [sending, setSending] = React.useState(false)
        /** 'idle' | 'sent' | 'failed' */
        const [outcome, setOutcome] = React.useState('idle')
        const [detail, setDetail] = React.useState('')
        /** 确认单：'idle' | 'loading' | 'ready' | 'error'；items 是归一化后的条目。 */
        const [boardPhase, setBoardPhase] = React.useState('idle')
        const [boardItems, setBoardItems] = React.useState([])
        const [boardBatch, setBoardBatch] = React.useState('')
        const [boardError, setBoardError] = React.useState('')
        /** 确认单弹框是否打开。 */
        const [boardOpen, setBoardOpen] = React.useState(false)
        /** 本轮改动：`{ [id]: 'run'|'defer'|'skip'|'none' }`；没点过的条目用文件里的 decision。 */
        const [boardPick, setBoardPick] = React.useState({})
        const [boardSending, setBoardSending] = React.useState(false)
        /** 第二道确认：点「确认并执行」先问「在当前会话执行？」，答了才真投递。 */
        const [boardAsk, setBoardAsk] = React.useState(false)
        /** 固定投递目标（**会话标题**；空串＝当前会话）。换会话时把新会话改成同名即可，不需要改绑定。 */
        const [boardTarget, setBoardTarget] = React.useState(() => {
          try { return localStorage.getItem(BOARD_TARGET_KEY) || '' } catch (error) { return '' }
        })
        /** 可选会话（标题 + id；打开确认框时现取）。 */
        const [boardTargets, setBoardTargets] = React.useState([])
        /** 「投递到」输入框里的草稿：可以手打/筛选，失焦或回车才落成绑定。 */
        const [boardDraft, setBoardDraft] = React.useState(boardTarget)
        /** 绑定固定会话时是否跳过第二道确认（默认关）。 */
        const [boardSkipAsk, setBoardSkipAsk] = React.useState(() => {
          try { return localStorage.getItem(BOARD_SKIP_ASK_KEY) === '1' } catch (error) { return false }
        })

        /**
         * 重读可投递会话。会话目录是**异步**到达的：刚打开页面时可能还是空数组，
         * 所以空列表时补读一次（1.5s 后），免得下拉里只有「不绑定」。
         */
        const refreshTargets = () => {
          const read = () => (typeof host.listSessions === 'function' ? host.listSessions() : [])
          const rows = read()
          setBoardTargets(rows)
          if (rows.length === 0) {
            setTimeout(() => {
              if (aliveRef.current) setBoardTargets(read())
            }, 1500)
          }
        }

        /** 把输入框里的草稿落成绑定（空串＝解除绑定）。 */
        const commitTargetDraft = () => {
          const next = String(boardDraft || '').trim()
          setBoardDraft(next)
          if (next !== boardTarget) rememberTarget(next)
        }

        /** 记住「跳过二次确认」开关。 */
        const rememberSkipAsk = (next) => {
          setBoardSkipAsk(next)
          try {
            if (next) localStorage.setItem(BOARD_SKIP_ASK_KEY, '1')
            else localStorage.removeItem(BOARD_SKIP_ASK_KEY)
          } catch (error) { /* 忽略：隐私模式写不进去，本次照样生效 */ }
        }

        /** 记住目标（空串＝清掉绑定，回到当前会话）。 */
        const rememberTarget = (title) => {
          setBoardTarget(title)
          try {
            if (title === '') localStorage.removeItem(BOARD_TARGET_KEY)
            else localStorage.setItem(BOARD_TARGET_KEY, title)
          } catch (error) { /* 忽略：隐私模式下写不进去，本次照样能投 */ }
        }

        const aliveRef = React.useRef(true)
        const timerRef = React.useRef(0)
        const dirtyRef = React.useRef(true)
        const boardSigRef = React.useRef('') // 上次读到的确认单指纹：没变就不清点选

        React.useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
            if (timerRef.current) clearTimeout(timerRef.current)
          }
        }, [])

        // 任务集变了就标脏：下次打开下拉重读（不在后台轮询；用户打开时才读一次）。
        React.useEffect(() => {
          if (typeof host.subscribeChanged !== 'function') return undefined
          let unsubscribe
          try {
            unsubscribe = host.subscribeChanged(() => { dirtyRef.current = true })
          } catch (error) {
            warn('subscribe schedule/changed failed:', error)
          }
          return () => {
            if (typeof unsubscribe === 'function') {
              try { unsubscribe() } catch (error) { /* 忽略：退订失败不能影响卸载 */ }
            }
          }
        }, [])

        /** 落到某个瞬时状态，ms 之后自动回到 idle。 */
        const settle = (next, text, ms) => {
          if (!aliveRef.current) return
          setOutcome(next)
          setDetail(text)
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => {
            if (!aliveRef.current) return
            setOutcome('idle')
            setDetail('')
          }, ms)
        }

        /** 读一次定时任务。失败只影响"定时任务"这一组，内置兜底项照常可用。 */
        const loadTasks = () => {
          const sessionId = typeof host.getSessionId === 'function' ? host.getSessionId() : undefined
          setPhase('loading')
          setLoadError('')
          Promise.resolve()
            .then(() => (typeof host.listSchedules === 'function'
              ? host.listSchedules(sessionId)
              : { tasks: [], sessionResult: { ok: false, error: { code: 'no-list' } }, catalogResult: { ok: false, error: { code: 'no-list' } } }))
            .then((snapshot) => {
              if (!aliveRef.current) return
              dirtyRef.current = false
              const next = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : []
              const sessionFailed = !(snapshot && snapshot.sessionResult && snapshot.sessionResult.ok)
              const catalogFailed = !(snapshot && snapshot.catalogResult && snapshot.catalogResult.ok)
              setTasks(next)
              // 文案口径（用户明确要求）：
              //   · 只要有远程读失败 ⇒ 显示错误（别把"读不到"说成"没有任务"），错误码优先用 catalog 那个；
              //   · 两个都读成功且确实一条都没有 ⇒ 才显示空态。
              if (next.length === 0 && (sessionFailed || catalogFailed)) {
                const failed = catalogFailed && snapshot.catalogResult ? snapshot.catalogResult : snapshot.sessionResult
                setLoadError(errorCode(failed ? failed.error : undefined))
                setPhase('error')
                return
              }
              setPhase(next.length === 0 ? 'empty' : 'ready')
            })
            .catch((error) => {
              if (!aliveRef.current) return
              dirtyRef.current = false
              setTasks([])
              setLoadError(errorCode(error))
              setPhase('error')
            })
        }

        /** 打开/关闭下拉；每次打开都（按需）重读一次任务。 */
        const toggleOpen = () => {
          if (open) {
            setOpen(false)
            return
          }
          setOpen(true)
          if (dirtyRef.current || phase === 'idle' || phase === 'error') loadTasks()
          // 确认单与任务一起读：它可能在会话进行中被 agent 改过（标了 done/archived）⇒ 每次都重读。
          loadBoard()
        }

        /**
         * 读一次确认单（只读文件；失败只影响这一组）。
         * `silent`＝定时/切回窗口时的重读：不闪"读取中"，且**文件内容没变就保留点选**
         * （否则每 10 秒把用户刚点的选择清空）。
         * @param options - `{ silent?: boolean }`
         */
        const loadBoard = (options) => {
          const opts = options || {}
          if (typeof host.loadBoard !== 'function') {
            setBoardPhase('idle')
            return
          }
          if (!opts.silent) setBoardPhase('loading')
          setBoardError('')
          Promise.resolve()
            .then(() => host.loadBoard())
            .then((snapshot) => {
              if (!aliveRef.current) return
              const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
              const sig = items.map((one) => one.id + ':' + (one.state === 'done' || one.state === 'archived' ? one.state : one.decision)).join('|')
              const unchanged = sig !== '' && sig === boardSigRef.current
              boardSigRef.current = sig
              setBoardItems(items)
              setBoardBatch(snapshot && typeof snapshot.batch === 'string' ? snapshot.batch : '')
              if (snapshot && snapshot.ok) {
                setBoardPhase(items.length === 0 ? 'empty' : 'ready')
                // 文件变了 ⇒ 以文件为准，扔掉上一轮点选；没变（定时重读）⇒ 保留
                if (!unchanged) setBoardPick({})
                return
              }
              setBoardError(String((snapshot && snapshot.error) || 'unknown'))
              setBoardPhase(items.length === 0 ? 'error' : 'ready')
            })
            .catch((error) => {
              if (!aliveRef.current) return
              setBoardItems([])
              setBoardError(errorCode(error))
              setBoardPhase('error')
            })
        }

        // 面板开着时自动重读：agent 把结果写回文件后，不用关掉再开就能看到（10 秒一次＋切回窗口即读）。
        React.useEffect(() => {
          if (!boardOpen) return undefined
          const reload = () => {
            if (aliveRef.current && !boardSending) loadBoard({ silent: true })
          }
          const timer = setInterval(reload, 10000)
          window.addEventListener('focus', reload)
          return () => {
            clearInterval(timer)
            window.removeEventListener('focus', reload)
          }
        }, [boardOpen, boardSending])

        /** 打开确认单弹框（先保证内容是最新的）。 */
        const openBoard = () => {
          setOpen(false)
          setBoardOpen(true)
          // 先把可投递会话捞一遍：底部「投递到」下拉要能直接改，不必等二次确认框
          refreshTargets()
          loadBoard()
        }

        /** 点某一档：再点一次同档＝撤销（回到 none）。 */
        const pickChoice = (id, choice) => {
          setBoardPick((current) => {
            const next = { ...current }
            const item = boardItems.find((one) => one.id === id)
            const now = normalizeChoice(current[id] !== undefined ? current[id] : (item ? item.decision : CHOICE_NONE))
            next[id] = now === choice ? CHOICE_NONE : choice
            return next
          })
        }

        /** 全选 / 全不选（只动「执行」，暂缓与归档由人逐条定，避免一键误设）。 */
        const pickAll = (choice) => {
          setBoardPick(() => {
            const next = {}
            for (const item of boardItems) {
              if (item.state === 'done' || item.state === 'archived') continue
              const now = normalizeChoice(item.decision)
              next[item.id] = now === CHOICE_DEFER || now === CHOICE_SKIP ? now : choice
            }
            return next
          })
        }

        /** 关闭确认单弹框（取消 ⇒ 什么都不做，点选保留在内存里但不投递）。 */
        const closeBoard = () => {
          if (boardSending) return
          setBoardAsk(false)
          setBoardOpen(false)
        }

        /**
         * 第一步：先弹「在当前会话执行？」。
         * 为什么要多这一道：清单直接投进**当前会话**，用户切到别的会话后随手点确认，
         * 就把活派给了错的会话——这道框把会话名摆在眼前，答了才发。
         */
        const askBoardConfirm = () => {
          if (boardSending) return
          if (boardPrompt(boardItems, boardPick, { batch: boardBatch }) === '') {
            settle('failed', t('board.nothing'), FAIL_HINT_MS)
            return
          }
          // 绑了固定会话且开关打开 ⇒ 直接投（不再弹第二道框）；选「当前会话」时永远要确认。
          if (boardTarget !== '' && boardSkipAsk) {
            confirmBoard()
            return
          }
          refreshTargets()
          setBoardAsk(true)
        }

        /** 第二步：用户确认过会话，才把「执行」的条目拼成一条消息投进当前会话。 */
        const confirmBoard = () => {
          if (boardSending) return
          const text = boardPrompt(boardItems, boardPick, { batch: boardBatch })
          if (text === '') {
            setBoardAsk(false)
            settle('failed', t('board.nothing'), FAIL_HINT_MS)
            return
          }
          let sessionId = typeof host.getSessionId === 'function' ? host.getSessionId() : undefined
          if (boardTarget !== '') {
            // 按**标题**找目标：换会话后新会话改成同名，就自动接上（同名取最近更新的那个）。
            const rows = typeof host.listSessions === 'function' ? host.listSessions() : []
            const hit = pickTargetSession(rows, boardTarget)
            if (!hit) {
              // 找不到就给条退路：把确认框打开，让他改选目标（跳过确认时也要能自救）
              refreshTargets()
              setBoardAsk(true)
              settle('failed', t('board.targetMissing', { title: boardTarget }), FAIL_HINT_MS)
              return
            }
            sessionId = hit.id
          }
          if (sessionId === undefined || sessionId === null || sessionId === '') {
            setBoardAsk(false)
            settle('failed', t('state.failed', { code: 'no-session' }), FAIL_HINT_MS)
            return
          }
          setBoardSending(true)
          Promise.resolve()
            .then(() => host.sendPrompt(sessionId, text))
            .then((result) => {
              if (!aliveRef.current) return
              setBoardSending(false)
              setBoardAsk(false)
              if (result && result.ok) {
                setBoardOpen(false)
                setBoardPick({})
                // 回显投到哪儿：绑定会话时用标题，否则用当前会话标题（都没有就退回通用文案）
                const where = boardTarget !== ''
                  ? boardTarget
                  : (typeof sessionTitle === 'string' && sessionTitle !== '' ? sessionTitle : '')
                settle('sent', where === '' ? t('state.sent') : t('board.sentTo', { title: where }), OK_HINT_MS)
                return
              }
              settle('failed', t('state.failed', { code: errorCode(result ? result.error : undefined) }), FAIL_HINT_MS)
            })
            .catch((error) => {
              if (!aliveRef.current) return
              setBoardSending(false)
              setBoardAsk(false)
              settle('failed', t('state.failed', { code: errorCode(error) }), FAIL_HINT_MS)
            })
        }

        /** 点某条任务 ⇒ **只打开确认框，不投递**（防误触）。 */
        const askRun = (task) => {
          setOpen(false)
          setOutcome('idle')
          setDetail('')
          setPending(task)
        }

        /** 确认框关闭（Esc / 遮罩 / 关闭按钮 / 取消）⇒ 什么都不做。 */
        const cancelRun = () => {
          if (sending) {
            // 投递在途：不允许再点取消，避免"关了框但消息还是进去了"的错觉。
            return
          }
          setPending(null)
        }

        /** 确认后才真正投递：用该任务的 `prompt` **原文**。 */
        const confirmRun = () => {
          if (sending || !pending) return
          const task = pending
          const sessionId = typeof host.getSessionId === 'function' ? host.getSessionId() : undefined
          if (sessionId === undefined || sessionId === null || sessionId === '') {
            setSending(false)
            setPending(null)
            settle('failed', t('state.failed', { code: 'no-session' }), FAIL_HINT_MS)
            return
          }
          if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
            setPending(null)
            settle('failed', t('state.failed', { code: 'empty-prompt' }), FAIL_HINT_MS)
            return
          }
          setSending(true)
          // 先落 'sending' 再发，避免同步抛错时状态错位；Promise.resolve() 把同步异常也收进 catch。
          Promise.resolve()
            .then(() => host.sendPrompt(sessionId, task.prompt))
            .then((result) => {
              if (!aliveRef.current) return
              setSending(false)
              setPending(null)
              if (result && result.ok) {
                settle('sent', t('state.sent'), OK_HINT_MS)
                return
              }
              settle('failed', t('state.failed', { code: errorCode(result ? result.error : undefined) }), FAIL_HINT_MS)
            })
            .catch((error) => {
              if (!aliveRef.current) return
              setSending(false)
              setPending(null)
              settle('failed', t('state.failed', { code: errorCode(error) }), FAIL_HINT_MS)
            })
        }

        /** 一条任务的显示标签（内置项走 locale）。 */
        const taskLabel = (task) => (task.builtin ? t('menu.builtin.label') : task.title)

        // ---- 下拉条目 ----
        // 分两组，「内置」是**兜底**：判据不是 title 字符串（标题改了就重复），而是
        // **这次有没有真的拿到 active 任务**（`tasks.length > 0`）。
        //   · 拿到任务 ⇒ 只列定时任务组，**整组隐藏「内置」**（用户实测：两条内容重复）；
        //   · 没拿到（读取失败 / 读到确为空 / 无会话）⇒ 才显示「内置」，此时它是唯一可用入口。
        const hasTasks = tasks.length > 0
        const items = []

        // 确认单入口：**永远排在最上面**（它是"这一批要你拍板的事"，比定时任务更该先看到）。
        // 三态：读到条目 ⇒ 可点；读到但为空 ⇒ 灰行提示；读失败 ⇒ 灰行报错（别把"读不到"说成"没有"）。
        const boardCountsNow = boardCounts(boardItems, boardPick)
        if (boardPhase === 'ready') {
          items.push({ type: 'label', id: 'dsh-task-launcher:group-board', text: t('board.group') })
          items.push({
            id: BOARD_ITEM_ID,
            label: React.createElement('span', { className: 'dsh-task-launcher-item' },
              React.createElement('span', { className: 'dsh-task-launcher-dot', 'aria-hidden': 'true' }),
              React.createElement('span', { className: 'dsh-task-launcher-item-title' }, t('board.item', { count: String(boardCountsNow.total) })),
              boardCountsNow.run > 0
                ? React.createElement('span', { className: 'dsh-task-launcher-note' }, t('board.itemPending', { count: String(boardCountsNow.run) }))
                : null),
          })
        }
        if (hasTasks) {
          items.push({ type: 'label', id: 'dsh-task-launcher:group-schedule', text: t('menu.group.schedule') })
          for (const task of tasks) {
            const next = formatScheduledAt(task.scheduledAt, Date.now())
            items.push({
              id: task.id,
              label: React.createElement('span', { className: 'dsh-task-launcher-item' },
                // 前导小圆点：**纯装饰**（用户明确：不表达启用/停用语义），所以固定中性灰，
                // 只有"内置兜底项"那一条套一个描边圈，好跟真任务区分开。
                React.createElement('span', { className: 'dsh-task-launcher-dot', 'aria-hidden': 'true' }),
                React.createElement('span', { className: 'dsh-task-launcher-item-title' }, taskLabel(task)),
                next.text !== ''
                  ? React.createElement('span', { className: 'dsh-task-launcher-note' }, t('menu.next', { time: next.text }))
                  : (next.due ? React.createElement('span', { className: 'dsh-task-launcher-note' }, t('menu.nextNow')) : null)),
            })
          }
        } else {
          // 内置兜底项：**这是兜底，正常应走定时任务**（用户把「未缴费清单」建成定时任务后，
          // 定时任务组里就有同名条目；那时这一组会被整组隐藏，不会重复）。
          items.push({ type: 'label', id: 'dsh-task-launcher:group-builtin', text: t('menu.group.builtin') })
          items.push({
            id: BUILTIN_ID,
            label: React.createElement('span', { className: 'dsh-task-launcher-item' },
              React.createElement('span', { className: 'dsh-task-launcher-dot is-outline', 'aria-hidden': 'true' }),
              React.createElement('span', { className: 'dsh-task-launcher-item-title' }, taskLabel(builtinTask()))),
          })
        }

        // 读取状态行（加载中 / 空 / 失败）——用 `children` 行（不可选）放在最后，
        // 这样它既在菜单键盘走法里可见，又不会被当成"任务"点掉。
        const stateRow = (text) => React.createElement('div', { className: 'dsh-task-launcher-note dsh-task-launcher-state', key: 'state' }, text)

        const anchor = React.createElement('button', {
          type: 'button',
          className: (variant === 'tab' ? 'dsh-task-launcher-tab' : 'dsh-task-launcher-btn') + (outcome === 'sent' ? ' is-ok' : (outcome === 'failed' ? ' is-err' : '')),
          onClick: toggleOpen,
          disabled: sending,
          'aria-label': variant === 'tab' ? t('tab.aria') : t('action.aria'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: t('action.title'),
        },
          // 「任务」入口的图标：与旁边「对话／轨迹／会话文件」口径一致（16px）。
          // 官方那几个页签是纯文字，自己注入的「会话文件」是 16px 图标 + 文字 ⇒ 这里照 **16px**。
          variant === 'tab' && typeof checklistIcon === 'function'
            ? React.createElement(checklistIcon, { size: 16 })
            : null,
          typeof host.label === 'function' ? host.label(t) : (host.label !== undefined ? host.label : t(variant === 'tab' ? 'tab.label' : 'action.label')),
          variant === 'tab' ? null : React.createElement('span', { className: 'dsh-task-launcher-caret', 'aria-hidden': 'true' }, '▾'))

        const menu = taskMenu
          ? React.createElement(taskMenu, {
              open,
              anchor,
              items,
              onSelect: (id) => {
                if (id === BOARD_ITEM_ID) {
                  openBoard()
                  return
                }
                if (id === BUILTIN_ID) {
                  askRun(builtinTask())
                  return
                }
                const found = tasks.find((task) => task.id === id)
                if (found) askRun(found)
              },
              onClose: () => setOpen(false),
              align: 'start',
              portal: true, // 头部/侧栏都有 overflow 裁剪，portaled 才不会被切
            }, (phase === 'loading' || phase === 'error' || phase === 'empty')
              ? stateRow(
                  phase === 'loading'
                    ? t('menu.loading')
                    : (phase === 'error' ? t('menu.error', { code: loadError || 'unknown' }) : t('menu.empty')))
              : null)
          : anchor

        // ---- 确认框（复用 primitives.Modal + footer 确认行）----
        const sessionTitle = typeof host.getSessionTitle === 'function' ? host.getSessionTitle() : undefined
        const confirmFooter = React.createElement('div', { className: 'dsh-task-launcher-confirm-actions' },
          React.createElement(button, {
            variant: 'outline',
            disabled: sending,
            onClick: cancelRun,
          }, t('confirm.cancel')),
          React.createElement(button, {
            variant: 'primary',
            disabled: sending,
            // 焦点落在"执行"上（与 ui-schedule 删除提醒的 footerRef+focus 同一目的，
            // 这里用官方 Modal 约定的 `data-modal-autofocus`，无需自己拿 ref）。
            'data-modal-autofocus': true,
            onClick: confirmRun,
          }, sending ? t('state.sending') : t('confirm.run')))

        const confirmBody = []
        if (pending) {
          confirmBody.push(React.createElement('p', { key: 'title', className: 'dsh-task-launcher-confirm-title' }, taskLabel(pending)))
          confirmBody.push(React.createElement('p', { key: 'body', className: 'dsh-task-launcher-note' }, t('confirm.body')))
          if (typeof sessionTitle === 'string' && sessionTitle !== '') {
            confirmBody.push(React.createElement('p', { key: 'session', className: 'dsh-task-launcher-note' }, t('confirm.session', { title: sessionTitle })))
          }
        }

        const dialog = modal
          ? React.createElement(modal, {
              open: pending !== null,
              title: t('confirm.title'),
              closeLabel: t('confirm.close'),
              onClose: cancelRun, // Esc / 遮罩 / 关闭按钮 ⇒ 取消，什么都不做
              footer: confirmFooter,
            }, confirmBody)
          : null

        const hint = outcome === 'idle'
          ? null
          : React.createElement('span', { className: 'dsh-task-launcher-hint' + (outcome === 'failed' ? ' is-err' : '') },
              detail !== '' ? detail : (outcome === 'sent' ? t('state.sent') : t('state.sending')))

        // ---- 确认单弹框（复用 primitives.Modal；每行三档：执行 / 暂缓 / 不做）----
        const boardCountsNow2 = boardCounts(boardItems, boardPick)
        const boardRowsOpen = boardItems.filter((item) => item.state !== 'done' && item.state !== 'archived')
        const boardRow = (item) => {
          const now = normalizeChoice(boardPick[item.id] !== undefined ? boardPick[item.id] : item.decision)
          const pill = (label, choice, extra) => React.createElement(button, {
            type: 'button',
            key: choice,
            className: 'dsh-board-pill is-' + choice + (now === choice ? ' is-on' : ''),
            disabled: boardSending,
            onClick: () => pickChoice(item.id, choice),
            'aria-pressed': now === choice,
          }, label)
          return React.createElement('div', {
            key: item.id,
            className: 'dsh-board-row' + (now === CHOICE_SKIP ? ' is-skip' : (now === CHOICE_DEFER ? ' is-defer' : '')),
          },
            React.createElement('div', { className: 'dsh-board-rowText' },
              React.createElement('div', { className: 'dsh-board-rowTitle' }, item.title),
              item.hint !== '' ? React.createElement('div', { className: 'dsh-board-rowHint' }, item.hint) : null,
              item.risk !== '' && item.risk !== '无'
                ? React.createElement('div', { className: 'dsh-board-rowRisk' }, item.risk)
                : null),
            React.createElement('div', { className: 'dsh-board-rowActions' },
              pill(t('board.run'), CHOICE_RUN),
              pill(t('board.defer'), CHOICE_DEFER),
              pill(t('board.skip'), CHOICE_SKIP)))
        }

        // 确认单自己的 footer：**两行**（上行汇总、下行按钮）。
        // 为什么不用 primitives 的 Button：宿主的 Modal footer 是个横排 flex，把汇总文字和
        // 两个按钮塞一行时，按钮会被挤到换行、`variant='primary'` 那种黑底大按钮也跟旁边
        // 11px 的小药丸不搭（用户实测："确认执行和取消按钮没有做好"）。
        // 这里改用**自绘 button + 固定宽度**，只用设计令牌取色，宽度不随文案抖动。
        // 可投递的会话标题（去重，保持 listSessions 的"最近更新在前"顺序）；绑定值不在列表里也留一项。
        const boardTitleSeen = new Set()
        const boardOptionTitles = []
        for (const row of boardTargets) {
          if (row && typeof row.title === 'string' && row.title !== '' && !boardTitleSeen.has(row.title)) {
            boardTitleSeen.add(row.title)
            boardOptionTitles.push(row.title)
          }
        }
        if (boardTarget !== '' && !boardTitleSeen.has(boardTarget)) boardOptionTitles.unshift(boardTarget)

        const boardFooter = React.createElement('div', { className: 'dsh-board-footer' },
          React.createElement('div', { className: 'dsh-board-footerLine' },
            t('board.summary', {
              run: String(boardCountsNow2.run),
              defer: String(boardCountsNow2.defer),
              skip: String(boardCountsNow2.skip),
              none: String(boardCountsNow2.none),
            })),
          (boardCountsNow2.done + boardCountsNow2.archived) > 0
            ? React.createElement('div', { className: 'dsh-board-footerLine' },
                t('board.summaryDone', {
                  done: String(boardCountsNow2.done),
                  archived: String(boardCountsNow2.archived),
                }))
            : null,
          React.createElement('div', { className: 'dsh-board-setting' },
            React.createElement('span', { className: 'dsh-board-settingLabel' }, t('board.targetLabel')),
            React.createElement('input', {
              className: 'dsh-board-select',
              type: 'text',
              list: 'dsh-board-targets',
              value: boardDraft,
              placeholder: t('board.targetPlaceholder'),
              disabled: boardSending,
              onChange: (event) => setBoardDraft(event.target.value),
              onBlur: commitTargetDraft,
              onKeyDown: (event) => { if (event.key === 'Enter') commitTargetDraft() },
            }),
            React.createElement('datalist', { id: 'dsh-board-targets' },
              boardOptionTitles.map((title) => React.createElement('option', { key: title, value: title }))),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-board-btn is-ghost is-mini',
              disabled: boardSending,
              title: t('board.targetRefresh'),
              'aria-label': t('board.targetRefresh'),
              onClick: refreshTargets,
            }, '⟳')),
          React.createElement('div', { className: 'dsh-board-setting' },
            React.createElement('label', { className: 'dsh-board-switch' },
              React.createElement('input', {
                type: 'checkbox',
                checked: boardSkipAsk,
                disabled: boardSending || boardTarget === '',
                title: boardTarget === '' ? t('board.skipAskNeedTarget') : undefined,
                onChange: (event) => rememberSkipAsk(!!event.target.checked),
              }),
              React.createElement('span', { className: boardTarget === '' ? 'is-muted' : undefined },
                t('board.skipAsk')))),
          React.createElement('p', { className: 'dsh-task-launcher-note' }, t('board.targetHelp')),
          React.createElement('div', { className: 'dsh-board-footerActions' },
            React.createElement('button', {
              type: 'button',
              className: 'dsh-board-btn is-ghost',
              disabled: boardSending,
              onClick: closeBoard,
            }, t('board.cancel')),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-board-btn is-primary',
              disabled: boardSending || (boardCountsNow2.run + boardCountsNow2.defer + boardCountsNow2.skip) === 0,
              'data-modal-autofocus': boardCountsNow2.run > 0,
              onClick: askBoardConfirm,
            }, boardSending
              ? t('board.sending')
              : (boardCountsNow2.run > 0
                ? t('board.confirm', { count: String(boardCountsNow2.run) })
                : t('board.confirmSubmit')))))

        const boardBody = []
        boardBody.push(React.createElement('p', { key: 'hint', className: 'dsh-task-launcher-note' }, t('board.hint')))
        if (boardPhase === 'loading') {
          boardBody.push(React.createElement('p', { key: 'state', className: 'dsh-task-launcher-note' }, t('board.loading')))
        } else if (boardPhase === 'error') {
          boardBody.push(React.createElement('p', { key: 'state', className: 'dsh-task-launcher-note' }, t('board.error', { code: boardError || 'unknown' })))
        } else if (boardPhase === 'empty') {
          boardBody.push(React.createElement('p', { key: 'state', className: 'dsh-task-launcher-note' }, t('board.empty', { file: BOARD_FILE })))
        }
        if (boardPhase === 'ready') {
          // 已结案的条目**不显示**（用户 2026-11-11 定）：只在底部汇总里留个数字，列表只列还能选的。
          boardBody.push(React.createElement('div', { key: 'rows', className: 'dsh-board-rows' }, boardRowsOpen.map(boardRow)))
          if (boardRowsOpen.length === 0) {
            boardBody.push(React.createElement('p', { key: 'nothing-open', className: 'dsh-task-launcher-note' }, t('board.nothingOpen')))
          }
        }

        const boardDialog = modal
          ? React.createElement(modal, {
              // 第二道确认弹出时先收起本框，避免两个 Modal 叠着（取消后回到这里）
              open: boardOpen && !boardAsk,
              title: t('board.title'),
              closeLabel: t('board.cancel'),
              onClose: closeBoard,
              footer: boardFooter,
            }, boardBody)
          : null


        // 第二道确认：先把「投给谁」摆出来（默认当前会话；可绑一个固定标题，例如「任务清单」）。
        const boardAskFooter = React.createElement('div', { className: 'dsh-board-footer' },
          React.createElement('div', { className: 'dsh-board-footerActions' },
            React.createElement('button', {
              type: 'button',
              className: 'dsh-board-btn is-ghost',
              disabled: boardSending,
              onClick: () => setBoardAsk(false),
            }, t('board.cancel')),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-board-btn is-primary',
              disabled: boardSending,
              'data-modal-autofocus': true,
              onClick: confirmBoard,
            }, boardSending ? t('board.sending') : t('board.askRun'))))

        const boardAskDialog = modal
          ? React.createElement(modal, {
              open: boardAsk,
              title: t('board.askTitle'),
              closeLabel: t('board.cancel'),
              onClose: () => { if (!boardSending) setBoardAsk(false) },
              footer: boardAskFooter,
            }, [
              React.createElement('p', { key: 'body', className: 'dsh-task-launcher-note' },
                t(boardCountsNow2.run > 0 ? 'board.askBody' : 'board.askBodyNoRun', { count: String(boardCountsNow2.run) })),
              React.createElement('div', { key: 'target', className: 'dsh-board-target' },
                React.createElement('span', null, t('board.targetLabel')),
                React.createElement('input', {
                  className: 'dsh-board-select',
                  type: 'text',
                  list: 'dsh-board-targets-ask',
                  value: boardDraft,
                  placeholder: t('board.targetPlaceholder'),
                  disabled: boardSending,
                  onChange: (event) => setBoardDraft(event.target.value),
                  onBlur: commitTargetDraft,
                  onKeyDown: (event) => { if (event.key === 'Enter') commitTargetDraft() },
                }),
                React.createElement('datalist', { id: 'dsh-board-targets-ask' },
                  boardOptionTitles.map((title) => React.createElement('option', { key: title, value: title })))),
              React.createElement('p', { key: 'targetHint', className: 'dsh-task-launcher-note' }, t('board.targetHint')),
              React.createElement('label', { key: 'skip', className: 'dsh-board-switch' },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: boardSkipAsk,
                  disabled: boardSending || boardTarget === '',
                  title: boardTarget === '' ? t('board.skipAskNeedTarget') : undefined,
                  onChange: (event) => rememberSkipAsk(!!event.target.checked),
                }),
                React.createElement('span', { className: boardTarget === '' ? 'is-muted' : undefined },
                  t('board.skipAsk'))),
              React.createElement('p', { key: 'hint', className: 'dsh-task-launcher-note' }, t('board.askHint')),
            ])
          : null

        return React.createElement('span', {
          className: 'dsh-task-launcher' + (variant === 'tab' ? ' is-tab' : ''),
        }, menu, hint, dialog, boardDialog, boardAskDialog)
      }
      return TaskMenu
    }

    /**
     * 用 `ctx` 造一个"投递/读取"宿主（各落点共用这一份，只有 `getSessionId` 的来源不同）。
     * @param ctx - 客户端插件上下文。
     * @param options - `{ getSessionId, getSessionTitle, label, t }`；前两个是**函数**，每次调用现取。
     * @returns `createTaskMenuView` 要的 host。
     */
    const createRemoteHost = (ctx, options) => {
      const opts = options || {}
      /** 现取目标会话：优先调用方给的函数，其次"在屏会话"快照，最后**宿主写在 DOM 上的 sessionId**。 */
      const resolveSessionId = () => {
        if (typeof opts.getSessionId === 'function') {
          const value = opts.getSessionId()
          if (value !== undefined && value !== null && value !== '') return value
        }
        try {
          const mounted = ctx.sidebarRight && ctx.sidebarRight.mounted
          const value = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
          if (value !== undefined && value !== null && value !== '') return value
        } catch (error) { /* 忽略：没有 sidebarRight 服务时走 DOM */ }
        return sessionIdFromDom()
      }
      return {
        getSessionId: resolveSessionId,
        getSessionTitle: opts.getSessionTitle,
        label: opts.label,
        t: opts.t,
        /**
         * 列可投递的会话（标题 + id，最近更新的在前，子会话不算）。
         * 只读 `ctx.sessions.list` 的快照；拿不到就返回空数组（界面上就只剩「当前会话」）。
         * @returns {Array<{id: string, title: string}>}
         */
        listSessions: () => {
          try {
            const store = ctx && ctx.sessions && ctx.sessions.list
            const snap = store && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null
            if (!snap || !Array.isArray(snap.ids) || !snap.byId) return []
            const rows = []
            for (const id of snap.ids) {
              const row = snap.byId[id]
              if (!row || row.origin === 'subagent') continue
              const title = String(row.displayTitle || row.title || id || '')
              if (title === '') continue
              rows.push({ id: String(id), title, updatedAt: Number(row.updatedAt || 0) })
            }
            rows.sort((left, right) => right.updatedAt - left.updatedAt)
            return rows
          } catch (error) {
            return []
          }
        },
        /**
         * 读待确认清单：走 dsh-long-plugins 的只读接口（`GET /api/dsh-uploads/workspace-file`），
         * 只给**文件名**，服务端会按"工作区里唯一同名文件"兜底找到它 —— 这样插件既不用知道
         * 工作区绝对路径、也不依赖会话 cwd（换目录/换机器都不会读错）。
         * 返回 `{ ok, error, batch, items }`（形状见 `parseBoard`），失败不抛。
         * @returns {Promise<{ ok: boolean, error: string, batch: string, items: Array }>}
         */
        loadBoard: () => {
          const url = '/api/dsh-uploads/workspace-file?path=' + encodeURIComponent(BOARD_FILE)
          return fetch(url, { cache: 'no-store', credentials: 'same-origin' })
            .then((response) => {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              return response.json()
            })
            .then((body) => {
              if (body === null || typeof body !== 'object' || body.ok !== true) {
                throw new Error(String((body && body.error) || 'no-content'))
              }
              return parseBoard(typeof body.content === 'string' ? body.content : '')
            })
            .catch((error) => ({ ok: false, error: errorCode(error), batch: '', items: [] }))
        },
        /**
         * 读任务：**catalog（全局）＋ list（该会话）两个都读**，按 id 合并、去重、只留 `status==='active'`。
         *
         * 为什么不能只读 list：宿主 `list` 是 `task.sessionId === request.sessionId`
         * **严格相等**过滤（`dsh-schedule/lib/index.js` 的 `async list`）。客户端解析出来的 sessionId
         * 只要与任务绑定的那个不完全一致（换过会话、子会话、页签行 DOM 上读到的不是当前会话），
         * 就会得到"空列表"——而任务其实在 `catalog` 里（`catalog` 不过滤会话，返回全部记录）。
         * 两个都读、取并集，才能保证"用户新建的任何启用任务都会出现在下拉里"。
         * 两条支路的成败分别回收（`sessionResult` / `catalogResult`），让视图层能区分
         * "读不到" 与 "确实没有"。
         * @param sessionId - 当前会话 id（可为空：那就只读 catalog）。
         * @returns {Promise<{tasks: Array, sessionResult: {ok: boolean, error?: unknown}, catalogResult: {ok: boolean, error?: unknown}}>} 合并后的任务与各支路结果。
         */
        listSchedules: async (sessionId) => {
          const [catalogOutcome, sessionOutcome] = await Promise.all([
            Promise.resolve()
              .then(() => ctx.remote.schedule.catalog())
              .then((result) => ({ result }))
              .catch((error) => ({ result: { ok: false, error } })),
            (sessionId === undefined || sessionId === null || sessionId === '')
              ? Promise.resolve({ result: { ok: false, error: { code: 'no-session' } } })
              : Promise.resolve()
                  .then(() => ctx.remote.schedule.list({ sessionId }))
                  .then((result) => ({ result }))
                  .catch((error) => ({ result: { ok: false, error } })),
          ])
          const catalogResult = catalogOutcome.result
          const sessionResult = sessionOutcome.result
          const catalogTasks = catalogResult && catalogResult.ok ? activeTasksOf(catalogResult.value) : []
          const sessionTasks = sessionResult && sessionResult.ok ? activeTasksOf(sessionResult.value) : []
          // list 的结果对"当前会话"更权威 ⇒ 放后面覆盖同 id 的那份。
          const merged = new Map()
          for (const task of catalogTasks) merged.set(task.id, task)
          for (const task of sessionTasks) merged.set(task.id, task)
          return {
            tasks: [...merged.values()],
            sessionResult: { ok: !!(sessionResult && sessionResult.ok), error: sessionResult ? sessionResult.error : undefined },
            catalogResult: { ok: !!(catalogResult && catalogResult.ok), error: catalogResult ? catalogResult.error : undefined },
          }
        },
        /** 投递：`mode: 'queue'`（不打断），文本用任务 `prompt` 原文。 */
        sendPrompt: (sessionId, text) => ctx.remote.session.prompt({
          requestId: newRequestId(),
          sessionId,
          mode: MODE,
          content: [{ type: 'text', text }],
          clientTimeZone: resolveClientTimeZone(),
        }),
        /** 任务集变化 ⇒ 标脏（拿不到这个事件也不影响主流程）。 */
        subscribeChanged: (listener) => ctx.remote.$on('schedule/changed', listener),
      }
    }

    /**
     * 候选落点清单（**只做契约记录，不自动登记**）。
     * 每条的 `register` 是"选定该落点后，填进 `SLOT_BINDINGS` 的那一行"。
     * 契约字段（`key`/`id`/`order`/`priority`/scope/能否拿到 `sessionId`）都已在
     * DSH 自带包的 `lib/types/client/contract/slots.d.ts` 里现场核对过（调查记录见工作区 `_session-notes/` 下同名插件的会话档）。
     */
    const CANDIDATE_SLOTS = {
      // ① 右侧栏新增一个「任务」标签页（与文档预览/文件并列）。
      //    落点本体是 keyed 型 + session 作用域，但**只登记 body 打不开标签页**：
      //    还要 `ctx.sidebarRightTabs.register({ id, kind, priority, title })`
      //    （照 ui-schedule 的 `scheduleTaskDefinition`），再用 `ctx.sidebarRight.openTab(kind)` 打开。
      //    props 有 `sessionId`；还需要 inject `sidebarRightTabs` / `sidebarRight`。
      'sidebar.right.pane.tab': {
        contract: { kind: 'keyed', scope: 'session', dispatch: 'key', extra: 'priority', inject: 'SidebarRightTabInjected' },
        sessionId: '有（标准 session 席位）',
        register: (ctx, View) => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: 'dsh-task-launcher:task-tab',
          locale: NS,
        }, View)),
      },
      // ② 左下角侧边栏底部图标按钮（与"设置"并排）。list 型 + **root 作用域**
      //    ⇒ owner 只给 `wide`，**props 里没有 sessionId**，只能从别处取（见 host adapter 的 root 版）。
      'sidebar.footer.action': {
        contract: { kind: 'list', scope: 'root', dispatch: 'id/order', owner: 'SidebarFooterActionOwnerProps { wide }' },
        sessionId: '无（root 作用域，需另取当前会话）',
        register: (ctx, View) => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-task-launcher:task-menu',
          order: 40,
          locale: NS,
        }, View)),
      },
      // ③ 输入框上方整宽横排（goal / todo 那个位置）。list 型 + session 作用域 ⇒ 有 sessionId。
      'conversation.input.dock': {
        contract: { kind: 'list', scope: 'session', dispatch: 'id/order', owner: 'InputZone' },
        sessionId: '有（标准 session 席位）',
        register: (ctx, View) => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-task-launcher:task-menu',
          order: 60,
          locale: NS,
        }, View)),
      },
      // ④ 输入卡片下方外围横排（紧贴 composer 下缘）。list 型 + session 作用域 ⇒ 有 sessionId。
      'conversation.composer.dock': {
        contract: { kind: 'list', scope: 'session', dispatch: 'id/order', owner: 'ComposerBarProps' },
        sessionId: '有（标准 session 席位）',
        register: (ctx, View) => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-task-launcher:task-menu',
          order: 60,
          locale: NS,
        }, View)),
      },
      // ⑤ 左侧会话行悬停卡片里的一段。list 型 + **root 作用域**，owner 给的是**那一行的 sessionId**
      //    ⇒ 语义是"这条任务属于被悬停的会话"，与"在当前会话执行"**不一致**（会把别会话的任务
      //    投进当前会话/或反过来），且悬停卡片有裁剪与点击即消失的问题。**不建议**，仅记录。
      'sidebar.session.row.hover': {
        contract: { kind: 'list', scope: 'root', dispatch: 'id/order', owner: 'SessionRowScheduleOwnerProps { sessionId }' },
        sessionId: '有，但是"被悬停那一行"的会话，不是当前会话',
        register: (ctx, View) => ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
          name: 'sidebar.session.row.hover',
          id: 'dsh-task-launcher:task-menu',
          order: 60,
          locale: NS,
        }, View)),
      },
    }

    /**
     * 当前生效的落点。**已定**：会话标题下面那行页签（「会话文件」左边），
     * 走 `'conversationTabs'` 这个特殊键（DOM 注入，见 `conversationTabMount`），
     * 不走 `ctx.slots.register`。
     * 想换成 `CANDIDATE_SLOTS` 里的常规落点，把下面数组换成对应键即可（例如
     * `['conversation.input.dock']`）；想临时全停，置空数组。
     */
    const SLOT_BINDINGS = ['conversationTabs']

    /**
     * session 作用域落点的 host：`sessionId` 由**组件 prop** 每次渲染现取（换会话安全）。
     * @param ctx - 客户端插件上下文。
     * @returns host。
     */
    const sessionScopedHost = (ctx) => createRemoteHost(ctx, {
      getSessionId: () => undefined, // 由 View 包装层用 props.sessionId 覆盖（见 registerSlotBindings）
    })

    /**
     * root 作用域落点的 host：props 里没有 `sessionId`，用 `ctx.sidebarRight.mounted`
     * （"当前在屏的会话"）现取；取不到就当作无会话（按钮仍在，点了报 `no-session`）。
     * @param ctx - 客户端插件上下文。
     * @returns host。
     */
    const rootScopedHost = (ctx) => createRemoteHost(ctx, {
      getSessionId: () => {
        try {
          const mounted = ctx.sidebarRight && ctx.sidebarRight.mounted
          return mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : undefined
        } catch (error) {
          return undefined
        }
      },
    })

    /**
     * 造一个绑定到某个落点的组件：把 props 里的 `sessionId`（session 作用域才有）
     * 塞进 host 的 `getSessionId`，其余 props 原样透传给视图（含框架给的 `t`）。
     * @param View - `createTaskMenuView` 出来的组件。
     * @param ctx - 客户端插件上下文。
     * @param usePropsSessionId - true＝用 `props.sessionId`（session 作用域）；false＝用 root host。
     * @returns 登记用的组件。
     */
    const bindSession = (View, ctx, usePropsSessionId) => {
      const host = usePropsSessionId ? sessionScopedHost(ctx) : rootScopedHost(ctx)
      return (props) => {
        const next = props || {}
        if (usePropsSessionId) {
          host.getSessionId = () => next.sessionId
          host.getSessionTitle = () => sessionTitleOf(next)
        }
        return React.createElement(View, { ...next, host })
      }
    }

    /**
     * 尽力取"当前会话标题"：不同落点的席位来源不同，全都试一遍，取不到就不显示。
     * @param props - 组件 props。
     * @returns {string|undefined} 标题。
     */
    const sessionTitleOf = (props) => {
      const candidates = [props && props.sessionTitle, props && props.title]
      for (const value of candidates) {
        if (typeof value === 'string' && value !== '') return value
      }
      try {
        const session = props && typeof props.useSession === 'function' ? props.useSession() : undefined
        const snapshot = session && typeof session.getSnapshot === 'function' ? session.getSnapshot() : session
        if (snapshot && typeof snapshot.title === 'string' && snapshot.title !== '') return snapshot.title
      } catch (error) { /* 忽略：拿不到标题不影响功能 */ }
      return undefined
    }

    /**
     * 从 DOM 上现取"当前会话 id"。**为什么只能这样**：
     * 「对话｜轨迹｜会话文件」那行页签是核心 ui-conversation 直接渲染的 `div[role=tablist]
     * [data-conversation-tabs]`，其按钮由 `conversation.view` 这个 **list 型 slot** 生成
     * （`entry.options.id` / `label` ⇒ 一个页签），而**核心没有开放"往这行塞一个按钮"的 slot**
     * （`data-conversation-tabs` 只是个标记；grep 过全部 `contract/slots.d.ts`，没有 tab-strip 席）。
     * 而「会话文件」本身就是**第三方插件 dsh-long-plugins 用 DOM 注入**进去的
     * （`#dsh-long-session-files-btn`，`insertBefore` 到「轨迹」后面）——本插件沿用同一机制，
     * 才可能把「任务」放进**同一行**（`conversation.view` 那条路会把会话正文整体换成该视图，不是我们要的）。
     * 代价：这条路上没有 slot 席位 ⇒ `sessionId` 只能从宿主写在正文容器上的
     * `[data-conversation-session]` 读；读不到就是"无会话"，点击会明确报 `no-session`（不盲投）。
     * @returns {string|undefined} 当前会话 id。
     */
    const sessionIdFromDom = () => {
      try {
        const element = document.querySelector('[' + SESSION_ATTR + ']')
        const value = element === null ? null : element.getAttribute(SESSION_ATTR)
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch (error) {
        return undefined
      }
    }

    /**
     * 把本插件注入的「任务」标签搬到「会话文件」标签的**紧左边**。
     * 幂等：已经在正确位置就什么都不做；宿主 React 重渲染或 dsh-long-plugins 重新注入
     * 「会话文件」时，由 MutationObserver 再调一次把位置纠回来。
     * @param strip - `[data-conversation-tabs]` 容器。
     * @returns {boolean} 是否已就位。
     */
    const placeTaskTabBeforeSessionFiles = (strip) => {
      if (strip === null || strip === undefined) return false
      const own = document.getElementById(TASK_TAB_BTN_ID)
      if (own === null) return false
      const files = document.getElementById(SESSION_FILES_BTN_ID)
      if (files !== null && files.parentNode === strip) {
        // 目标位置＝「会话文件」紧左边。已经在那就返回。
        if (own.nextElementSibling === files && own.parentNode === strip) return true
        strip.insertBefore(own, files)
        return own.nextElementSibling === files
      }
      // 「会话文件」还没注入（或不在这一行）⇒ 先落在「轨迹」右边（＝将来「会话文件」的位置），
      // 等它出现后观察器会把我们挪到它左边。
      if (own.parentNode === strip) return true
      const tabs = strip.querySelectorAll('button[role="tab"]')
      let anchor = null
      for (let index = 0; index < tabs.length; index += 1) {
        if (String(tabs[index].textContent || '').trim() === '轨迹') anchor = tabs[index]
      }
      if (anchor === null) return false
      strip.insertBefore(own, anchor.nextSibling)
      return true
    }

    /**
     * 把 DOM 注入的「任务」页签**按旁边真实页签的实测排版**对齐
     * （字号/行高/字重/字距/颜色照抄），这样"看着就是同一行的页签"，
     * 又不必复制核心 CSS 模块的哈希类名（核心改版后仍然对齐）。
     *
     * ⚠️ **刻意不抄 padding 与 align-self**：旁边页签是"按钮直接当 flex 子项、被拉伸到整行高"，
     * 而本插件必须在按钮外面套一层（承载状态提示与 portal 的宿主节点），所以垂直位置由
     * CSS 里的 `align-self:flex-start` + `padding:0 0 9px` 保证。若照抄实测 padding，反而会跟
     * 外层盒子的行为打架（第一版就是这么偏高的）。
     * @param own - 本插件的按钮。
     * @param strip - 页签容器。
     */
    const syncTabGeometry = (own, strip) => {
      if (own === null || strip === null) return
      let sample = null
      const tabs = strip.querySelectorAll('button[role="tab"]')
      for (let index = 0; index < tabs.length; index += 1) {
        if (tabs[index] !== own) { sample = tabs[index]; break }
      }
      if (sample === null) return
      try {
        const computed = window.getComputedStyle(sample)
        for (const property of ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontFamily', 'color']) {
          const value = computed[property]
          if (typeof value === 'string' && value !== '') own.style[property] = value
        }
        // 兜底自愈：万一外层容器仍被拉伸（真机 CSS 变了），只留内容高，避免又被居中抬高。
        const wrapper = own.parentNode
        if (wrapper !== null && wrapper.classList && wrapper.classList.contains('is-tab')) {
          const boxHeight = wrapper.getBoundingClientRect ? wrapper.getBoundingClientRect().height : 0
          const ownHeight = own.getBoundingClientRect ? own.getBoundingClientRect().height : 0
          if (boxHeight > ownHeight + 1) wrapper.style.alignSelf = 'flex-start'
        }
      } catch (error) { /* 忽略：拿不到实测排版就退回 CSS 里的兜底值 */ }
    }

    /**
     * 「会话标题下面那行页签」落点：把「任务」按钮 **DOM 注入**到 `[data-conversation-tabs]`
     * （位置＝「会话文件」左边），按钮上的菜单与确认框用 `reactDom.createPortal` 渲染进这个节点
     * —— 保留 React 事件，又不让宿主重渲染把它抹掉。
     * @param ctx - 客户端插件上下文。
     * @returns {() => void} 卸载函数。
     */
    const conversationTabMount = (ctx) => {
      const node = document.createElement('div')
      node.id = TASK_TAB_BTN_ID
      node.style.cssText = 'display:inline-flex;align-items:center'
      const host = createRemoteHost(ctx, {})
      let translator
      try {
        translator = ctx.locale.bind(NS)
      } catch (error) {
        translator = undefined // 拿不到就用视图里的本地 zh 兜底
      }
      const View = createTaskMenuView(host)
      // 用一个 display:none 的 body 容器承载 React root；真正的 DOM 由 portal 渲染进 node，
      // 而 node 会被放进页签行 ⇒ React 事件照常工作，宿主重渲染也抹不掉 React 树。
      const container = document.createElement('div')
      container.style.display = 'none'
      let root = null
      try {
        document.body.appendChild(container)
        root = typeof reactDom.createRoot === 'function' ? reactDom.createRoot(container) : null
        if (root === null) {
          warn('react-dom 无 createRoot，「任务」页签无法挂载')
          return () => { container.remove() }
        }
        root.render(reactDom.createPortal(React.createElement(View, { variant: 'tab', t: translator }), node))
      } catch (error) {
        warn('「任务」页签挂载失败:', error)
      }
      const mount = () => {
        try {
          const strip = document.querySelector(TABS_SELECTOR)
          if (strip === null) return false
          if (node.parentNode !== strip) strip.appendChild(node)
          const ok = placeTaskTabBeforeSessionFiles(strip)
          syncTabGeometry(node, strip)
          return ok
        } catch (error) {
          warn('注入「任务」页签失败:', error)
          return false
        }
      }
      // 先挂一次；宿主 React 重渲染会把注入节点抹掉 ⇒ 观察器补回（与 dsh-long-plugins 同一套路）。
      mount()
      let observer = null
      try {
        observer = new MutationObserver(() => { mount() })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (error) {
        warn('观察器不可用，页签可能被重渲染抹掉:', error)
      }
      return () => {
        if (observer !== null) {
          try { observer.disconnect() } catch (error) { /* 忽略 */ }
        }
        if (root !== null) {
          try { root.unmount() } catch (error) { /* 忽略 */ }
        }
        if (node.parentNode !== null) {
          try { node.parentNode.removeChild(node) } catch (error) { /* 忽略 */ }
        }
        if (container.parentNode !== null) {
          try { container.parentNode.removeChild(container) } catch (error) { /* 忽略 */ }
        }
      }
    }

    /**
     * 把选定的落点登记上。
     * 两种形态：
     *   · `'conversationTabs'` ⇒ 会话标题下面那行页签（DOM 注入，见 `conversationTabMount`）；
     *   · `CANDIDATE_SLOTS` 里的键 ⇒ 走 `ctx.slots.register` 的常规落点。
     * @param ctx - 客户端插件上下文。
     */
    const registerSlotBindings = (ctx) => {
      for (const slotId of SLOT_BINDINGS) {
        if (slotId === 'conversationTabs') {
          try {
            ctx.effect(() => conversationTabMount(ctx), 'dsh-task-launcher: conversation tabs')
          } catch (error) {
            warn('conversation tabs mount failed:', error)
          }
          continue
        }
        const candidate = CANDIDATE_SLOTS[slotId]
        if (!candidate) {
          warn('unknown slot binding:', slotId)
          continue
        }
        // session 作用域的落点有 `sessionId` 席位；root 作用域的没有。
        const usePropsSessionId = slotId !== 'sidebar.footer.action'
        const View = createTaskMenuView(createRemoteHost(ctx, {}))
        try {
          candidate.register(ctx, bindSession(View, ctx, usePropsSessionId))
        } catch (error) {
          warn('slot registration failed:', slotId, error)
        }
      }
    }

    /** 样式注入（失败不影响登记；插件停用即移除）。 */
    const installStyle = () => {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-task-launcher'
      style.dataset.pluginCss = 'dsh-task-launcher/task-menu'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    /**
     * @param ctx - 客户端插件上下文（用到 `slots` / `remote` / `remote.schedule` / `remote.session` / `locale`）。
     */
    function apply(ctx) {
      // 样式与登记各自兜底：样式注入失败绝不能连累登记（否则界面只表现"没反应"，极难定位）。
      try {
        ctx.effect(() => installStyle(), 'dsh-task-launcher: css')
      } catch (error) {
        warn('css failed:', error)
      }

      // 字典先注册：登记时声明了 `locale: NS`，渲染器要有这套字典才给 `t` 席位。
      // 单独兜底：字典失败也继续登记（组件的 makeTranslator 会退回本地 zh 字典）。
      let localeReady = false
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-task-launcher: dictionaries')
        localeReady = true
      } catch (error) {
        warn('dictionaries failed:', error)
      }

      // 落点＝会话标题下面那行页签（「会话文件」左边）：`'conversationTabs'` 走 DOM 注入，
      // 其余键走 `ctx.slots.register`；`SLOT_BINDINGS` 为空时什么都不挂。
      registerSlotBindings(ctx)
    }

    const warn = (...args) => {
      try { console.warn('[dsh-task-launcher]', ...args) } catch (error) { /* 忽略 */ }
    }

    exports.apply = apply
    // ⚠️ 插件级 inject 必须把用到的**服务名**列全：`slots`（登记落点）、`remote`（远程调用宿主）、
    //    `remote.schedule`（`ctx.remote.schedule.list` 的那半边）、`remote.session`
    //    （`ctx.remote.session.prompt` 的那半边）、`locale`（字典 + 渲染器的 `t` 席位）。
    //    漏了 ⇒ 静默不激活（界面表现＝"没这个菜单"）。`remote.schedule` 这个名字与
    //    `dsh-client-ui-schedule` 的 inject 列表同一口径（它也是 `remote` + `remote.schedule` 都列）。
    // 注意：`sessions` 是**客户端服务名**（`ctx.sessions.list` 的会话目录），不是模块名。
    // 少了它 ⇒ `ctx.sessions` 为 undefined，「投递到」下拉里永远只剩「不绑定」。
    exports.inject = ['slots', 'sessions', 'remote', 'remote.schedule', 'remote.session', 'locale']
    // 离线用例的纯函数钩子（宿主不会用到）。
    exports.__test__ = {
      PROMPT_TEXT, NS, MODE, FALLBACK_TIME_ZONE, BUILTIN_ID, ACTIVE,
      TABS_SELECTOR, SESSION_FILES_BTN_ID, TASK_TAB_BTN_ID, SESSION_ATTR,
      newRequestId, resolveClientTimeZone, makeTranslator, errorCode,
      taskEntryOf, builtinTask, activeTasksOf, formatScheduledAt, sessionTitleOf,
      sessionIdFromDom, placeTaskTabBeforeSessionFiles, syncTabGeometry,
      createTaskMenuView, createRemoteHost, bindSession, conversationTabMount,
      registerSlotBindings, CANDIDATE_SLOTS, SLOT_BINDINGS, zh, en, CSS,
      BOARD_FILE, BOARD_ITEM_ID, CHOICE_RUN, CHOICE_DEFER, CHOICE_SKIP, CHOICE_NONE,
      parseBoard, normalizeChoice, boardCounts, boardPrompt, pickTargetSession, BOARD_TARGET_KEY,
    }
    return module.exports
  },
})
