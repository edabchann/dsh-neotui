# Changelog

## 0.5.0 — 2026-09-14

### Added

- **dsh 0.1.5 协议适配（双协议）**：`src/api.js` 的 `call()`/`rpcCall()` 内新增 wire 级适配层——方法名翻译表（`session.history→session/page`、`agentPreset.*→agentPresets.*`、`skill.list→skills/list`、`subagent.*→subagents.*`、`host.listDirectory→directoryPicker/list`、`host.describe→session/modelCatalog`、`goal.*→goals/*` 等）、args 包裹（`payload:{args:{...}}`，含 `session/list` 的 `_request`、其余 `request` 包裹、`subagent.prompt` 补 `requestId`/`delivery`、`session.prompt` 补 `requestId`）与返回值还原（`records→events`、`{providers}`、`{models}`、`{ref}` 等）。连接后自动探测协议（先试 0.1.5 形式，404/未声明端点回退 legacy），`protocol` 缓存；legacy 路径保持 0.1.2 及更早的旧行为不变（点号方法名 + 平铺 payload）。
- **`workspace.list` 替代**：0.1.5 移除了该端点，改由 `/api/remote.mux` 的 `workspace/follow` 流首帧 `baseline`（`{items, archivedSessionIds}`）还原；`session.history`（含 `subagent.history`）改由 `session/follow` 首帧快照 + `session/page` 游标分页实现（游标取自 `session/list` 的 `projections.asOfSeq` 或快照 cursor）。
- **Host 访问令牌支持**：0.1.5 的 `/api` 需要浏览器会话 cookie，`--token` / `DSH_TUI_TOKEN` / base URL 的 `?token=` 会先做根路径令牌交换再携带 cookie（HTTP 与 WebSocket 均携带）；自托管模式下由 connection 行的 `authenticatedUrl` 自动注入。tui profile 新增 `--token` 选项。
- **实时推送通道迁移到 0.1.5 Remote mux**：0.1.5 移除 `/api/events.mux` / `/api/events.host` 后，审批、提问、会话状态等实时帧改由 `WS /api/remote.mux` 的逻辑流承载——
  - `$events` 流（首帧 `{type:"ready", clientId, host}`）转发 `@deepseek-ai/dsh-api-remotes` 白名单：`approval/request`、`user-questions/request`（阻塞式 waterfall）与 `api-session/added|removed|status|error|activity`、`commands/change` 等 emit 广播；
  - 帧按 TUI 既有词汇还原，`src/views.js` 无需改动：waterfall→`approval/requested`/`question/requested`，emit→`host/session-added|removed|status`、`host/agent-error`，Host `cancel` 帧→`approval/resolved`/`question/resolved`；
  - 回答走一元端点 `POST /api/$events/result`（`{clientId, eventId, outcome}`）：审批结果为 `{kind:"result", value:"allowed-once"|"rejected"}`，提问为 `{kind:"result", value:{answers}}`，取消提问为 `{kind:"rejected", error:{name:"UserQuestionError", code:"ASK_CANCELLED"}}`；未适配的阻塞事件与退出时的挂起项一律回 `{kind:"next"}`，避免 Host 回合被永久挂住；
  - 同一 socket 另开 `session/control` 流，把 `baseline`/`jobs`/`queue`/`projection` 还原为 `session/jobs`、`session/queue`、`session/projection`（`title` 额外补 `session/title`），取代连接期快照轮询；
  - 重连退避 500ms→15s；重连后 Host 会重投同一 `eventId`，已决事件按 `eventId` 去重不再弹窗；mux 不可达时仍保持「一次性 toast + 轮询」降级。
- **降级提示**：工作区分组不可用时一次性提示并按「未分组」渲染；缺少令牌时提示 `--token`；mux 不可达时一次性 toast 提示改为轮询刷新。
- **实时对话流 `session/follow`**：0.1.5 不转发任何 `session/event`，也不落库 `assistant/chunk`（回合结束后才有 `assistant/message`），此前对话只能靠 `pollTail()` 刷新，因此流式回答只有收尾时才能看到。现在打开/切换/恢复/`/reload` 会话时对当前会话开流（`mode:"stream"`，`request:{address, maxMessages, assistantStream:true}`），并把帧还原成既有词汇交给 `views.js`：
  - 首帧 `snapshot`：`cursor`（开场窗口最后一个已提交 seq）→ `session/subscribed`（`lastSeq=cursor`）+ `session/projection*`（含 `title` 的 `session/title`）+ 开场窗口逐条 `session/event`；其后是 `cursor+1` 起严格递增、无缺口的 `{type:"event", event}` 记录；
  - `{type:"assistant-stream", frame}` 是 0.1.5 唯一的分词级实时文本来源，按 `assistant/chunk`（`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`…）还原；帧身份是尝试内稠密 `index`（`revision` 逐帧递增，不是尝试身份）；
  - 回合进行中接入会话时，用快照里的紧凑累积流（`assistantStream.activeAttempt.stream`，`text-chunks`/`reasoning-chunks`/`tool-call-chunks`/`chunk` 记录按 `dt` 还原时间）回放已生成文本，随后 live 帧从 `nextIndex` 续上；
  - 流随共享 mux socket 重连：新连接重开流并重收快照（记录按 seq 游标对账）；流出错/结束一次性 toast 并回退轮询；切换会话会 `cancel` 旧流。
- **单一 seq 游标合并路径（幂等）**：`session/follow` 与 `pollTail()` 共用 `ChatView.acceptRecords()`——只接受 `event.seq` 严格递增的记录，同一事件无论哪一路先到都只应用一次，乱序/重复 seq 直接丢弃；无 seq 的进程内 chunk 以帧上的 `stream:{attemptId,index}` 为身份在同一处按稠密下标去重（mux 重连重投累积流不会重复追加），`open()` 重建会话时重置该游标以便基线回放。
- **轮询策略**：`session/follow` 健康时 `pollTail` 退化为 ~15s 安全网（只对账、不重复应用）；流不可用（旧协议 Host、mux 不可达、流出错）时恢复原有每 tick 节奏，行为不回归。
- **会话列表自适应刷新**：0.1.5 无工作区推送，侧栏只能定时刷新——`会话列表` 窗口聚焦时 ~2s 并在进入该窗口时立即刷一次，其余情况保持原有 ~5s；本地变更（重命名/归档/新建/移动）后的立即刷新不变。README 明确写出「工作区无推送」这一限制。

- **Host 文件访问（文件内容一律来自 Host，而不是本机磁盘）**：新增 `src/host-files.js`，把文件列表/统计/读取/字节读取/补全候选/改动流/附件上传封装为带 TTL 异步缓存与请求去重的 Host 客户端（`workspaceFiles/list`、`stat`、`read`、`readBytes`、`readAll`、`fileReferences/list`、`fileUploads/upload`），并新增 `Api.subscribeRemote()`：UI 侧的长连流（`workspaceFiles/changes`）与 `session/follow` 共用同一个 `/api/remote.mux` socket，重连时自动重开。迁移的调用点：`@` 提及与 Tab 路径补全（`fileReferences/list`，Host 索引，缺失时回退本地扫描）、文件选择器三栏列表与预览（文本 `read`、图片 `readAll` 并以字节直接解析 PNG/JPEG/GIF/WebP 尺寸，Kitty 传输用 Host 字节）、工作区树列表与预览、溢出/截断输出预览（`[output truncated; full output: <path>]` 指向的 Host 文件）、发送时的 `@` 引用内联与图片字节读取。**not-found 由 Host 判定为权威**：Host 说没有就绝不回退本机同名文件；只有 Host 文件接口不可用（旧协议、未声明命名空间、传输失败）或调用点明确处理本机路径（`$EDITOR` 草稿、`tui-config.json`）时才读本地。
- **「文件/改动」主窗口标签**：新增 `ChangesPage`（`对话 | 轨迹 | 子代理 | 后台任务 | 文件/改动`，`Shift+Tab` / `Ctrl+H` / `Ctrl+L` 循环或点击标签）。订阅 Host 的 `workspaceFiles/changes`（`ready` 后每帧 `{absolutePath, version|absent:true}`），按路径累积为 `M/A/D` 行（相对工作区路径、大小，payload 带 `±lines`/patch 时一并渲染）；`Enter` 用 `workspaceFiles/read` 分页读取内容（`PgDn` 续读），`h` 返回列表，`r` 重新订阅并重算每行状态，`q`/`Esc` 返回对话，Host 无改动时显示空状态；任何畸形帧都被忽略而不抛错。
- **非图片附件成为真正的 Host 附件（Item C）**：`fileUploads/upload`（`{agentId, request:{data(base64), name}}` → `{receiptId, file}`）配合 `session/prompt` 的 `{type:"file", receiptId}` 内容块，使任意文件都能随消息上传；Host 缺少该接口时条目退化为原有的「仅元数据」并明确提示。README 的限制说明同步更新。

### Changed

- `test/api.test.mjs`：按 0.1.5 线格式重写传输断言，新增适配表单测（名称翻译、args/结果包裹、协议探测与 legacy 回退、令牌交换、流式替代、`commands/execute` 的 0.1.2 `images` 兼容重试）；新增 Remote mux 单测（`$events`+`session/control` 订阅与 ready、转发事件/控制帧的翻译表、审批与提问的 `$events/result` 回答、重复事件去重、Host `cancel`、断线退避重连、退出时 `next` 释放、不可达降级、白名单覆盖）。
- `test/pty-crash.py`：新增 RPC 数据阶段——起一个私有 `dsh --profile web` 实例、经公开 HTTP API 播种一个带唯一标题与消息标记的会话，再用该实例的令牌 attach TUI，断言渲染帧里出现 Host 返回的标题（`session/list`）与消息文本（`session/page`）；新增审批推送阶段——把模型路由指向本地 SSE 桩（`DEEPSEEK_BASE_URL`），桩请求一次 `danger-full-access` 沙箱提权，从而触发真实 `approval/request` waterfall，断言 TUI 渲染出审批弹窗（推送到位）、按下允许后 Host 记录 `allowed-once` 且提权命令真的执行（回答经 `$events/result` 生效）；新增实时流阶段——桩按 ~1s 间隔分 5 段流式输出（唯一头/尾哨兵 + 中间填充），TUI 在 prompt 之前就已 attach，断言**头哨兵出现在渲染帧时尾哨兵尚不存在**、且尾哨兵 ≥2s 之后才出现：0.1.5 不存在任何持久化的半截文本，轮询最早只能在回合提交后一次性画出整段回答，因此「两个分离时刻」只可能来自实时流。
- `test/api.test.mjs`：新增 `session/follow` 单测（订阅 args、快照→`session/subscribed`+projection+记录、live 记录、assistant-stream 稠密下标去重、中途接入的累积流回放与 `nextIndex` 续接、紧凑流展开、断线重开、切换会话 cancel、restart 重发快照、流出错/不可达/旧协议的一次性降级）。
- `test/click.test.mjs`：新增实时更新单测——「同一事件被流与轮询各投递一次只应用一次」（两种顺序都覆盖）、乱序/重复 seq 丢弃、`session/event` 帧孪生去重、进程内 chunk 的重投去重与跨尝试重置、follow 健康/不健康/他人会话三种情况下的轮询节奏、会话列表 2s/5s 自适应、`openSession` 订阅跟随与陈旧 epoch 不订阅。
- `test/host-files.test.mjs`（新增，17 例）：Host 文件客户端与改动页单测——`workspaceFiles/list`/`read`/`readAll`/`fileUploads/upload` 的 args 与返回值映射、缓存与去重、`not-found` 的权威性与「命名空间未声明即停用」、`fileReferences/list` 候选与缓存、改动帧解析（含畸形载荷）、`parseUnifiedPatch`/`listingRows` 的健壮性、改动页空状态/累加/删除后重建/`Enter` 读内容/`r` 刷新、Host patch 的 diff 配色渲染、补全首按异步生效与二次 Tab 循环不再打 Host、以及旧协议下的本地回退与文件选择器本地预览。
- `test/pty-crash.py`：新增「Host 源文件访问」阶段——TUI 在 bubblewrap 挂载命名空间里运行，把会话工作区路径 bind-mount 到诱饵目录（同名文件、不同内容、缺 Host 独有项），断言 `@` 补全给出本机不存在的 `sub/host-only-file.txt`、`Ctrl+O` 列表出现 Host 独有项、预览显示 Host 内容且从不显示诱饵内容；新增「文件/改动」阶段——桩模型请求一次 `write` 工具调用，Host 经组合文件系统落盘后，已切到该标签的 TUI 帧里出现该文件行（真实 `fs/observed` 帧）。

## 0.4.4 — 2026-08-26

### Fixed

- **兼容 dsh 0.1.2-rc.1**：dsh-base 收编 storage 行与 session-projection-cache 后，组合树同 id 条目按新加载器规则去重（app 补丁仅保留裸 id 覆盖行做 attach 隔离）；`dsh-host-apiproxy` 包停更，其 /api 网关职责并入 connection 行的 node 半端（旧包在新版下启动即崩）；补挂 message-feedback 行。

### Added

- **统一前缀体系**：Ctrl+Space 面板前缀页与前缀引擎共用同一张表（which-key 模式）——面板内按键与 NORMAL 前缀同义，`p` 在面板内链入窗格子表（权限迁至 `a`）；`Ctrl+H`/`Ctrl+L` 切换主窗口标签页（上一/下一，`Shift+Tab` 保留；`Ctrl+H` 原技能键释放）；前缀触发字符可在 tui-config.json `prefixKeys` 段重定义（`Ctrl+K` 打开配置）。

- **窗口/标签页操作模型重构**：会话列表/窗口模式——`Ctrl+←→` 或 `Tab` 在「会话列表 ↔ 主窗口」间切换，`Shift+Tab` 在主窗口内循环标签页（对话/轨迹/子代理/后台任务，顶部标签条）；INSERT 内所有结构键保持编辑语义不冲突；侧栏预览卡片触发键 `p`（仅列表窗口作用域生效）。
- **nvim 式逐层前缀键**：NORMAL 下按 `p` 进入待定层（状态栏提示 + Esc/2s/错误键取消），
  - `p r/l/u/n`：把当前窗口向 右/左/上/下 分屏（新窗口自动成为**空白会话**窗口，窗口=会话容器；(p c) 关窗后会话保留在侧栏，关掉全部主窗口自动生成空白会话保底）；
  - `p c`：关闭当前窗口（焦点自动落到相邻窗口，布局合并恢复）；
  - 硬护栏：最小 40 列×12 行、窗口 ≤8、嵌套深度 ≤4，超限拒绝并提示。
- **`Ctrl+W` 回收为工作区选择小 buffer**：为当前会话选择/移动工作区（`workspace.insertSessionBefore`），附带 重命名/新建 工作区管理行；旧的大面板仍可从命令面板进入。
- **分屏分隔线鼠标拖动调节比例**（0.2–0.8 夹紧，实时重排）。
- **状态栏会话标题前实时显示窗口号前缀**（`W1 · <标题> · …`，多窗导航一目了然）。
- **子代理窗格续接输入**：`i`/`Tab` 聚焦、Enter 发送 `subagent.prompt(mode:"continuable")`（Esc 回列表；`i` 仅在子代理窗格局部生效）。
- **`@` 文件提及**：输入中 `@src/…` Tab 补全（目录内扫描、可循环），发送时非图片文件/目录自动附加为有界文本块（图片走原图片通道，不存在的 `@` 静默忽略）。
- **终端 cell 几何探测**（CSI 14t/16t）：启动探测像素/字符尺寸，Kitty 预览按真实 cell 比例（非假设 2:1）计算，无响应回退。
- 既有未发布功能一并进入本 pre：Tab 路径补全、`/rewind` 回退分支、Ctrl+Space 前缀面板（s/m/d/p/h/r/c/?/G/e）、键位释放（Ctrl+F///M/D/A/J/N/T/F8）、输入历史持久化+搜索、`/btw` 侧问（一次性密钥子进程，密钥不进 TUI）、来源徽标（●提问/◇注入/◆目标轮）、侧栏会话预览卡片、场景化帮助（Shift+/?）、外部编辑器草稿（前缀 `G`）。



### Added

- 欢迎页改版：**吉祥物 logo 默认关闭**（此前的 40×19 象限块/58×27 半块等实现保留，`Ctrl+R` 面板可随时启用预设/自定义/关闭；视觉迭代未能达成理想效果，先回退到仅标题）（真实色 255 色调色板，数据内嵌 `src/logo.js`，去背景、无残块、裁剪掉原图底部黑条）；自定义 logo JSON 支持象限格式（`[mask,fg,bg]`）与旧半块格式（`[top,bottom]`）；品牌行用 **`█▀▄` 半块像素字** 绘制（`DEEPSEEK` / `DSH NEOTUI` 两行大字标，5×7 像素字模），**每约 3.5 秒一道斜向高光扫过字标**（0.9s 扫程，纯 TUI 渲染并随主题语义色，扫过字标全宽含末尾 `I`；`DSH NEOTUI` 用深灰底保证白色高光可见）；**logo 三态** `Ctrl+R` buffer：预设（内置）/ 自定义（复用 Ctrl+O 与新建工作区的 `UploadPicker` 单选 `{palette, grid}` 40×19 JSON）/ 关闭（仅标题），持久化到配置文件；版本更新提示收敛到底部（仅「可更新/失败/检查中」时显示，可点击检查，**最新则不提示**）；模式选择从内联 4 列表收敛为底部提示「模式: <当前> · F9 打开模式选择（支持自定义）」——与 WebUI 鼓励自定义预设的方向一致；矮视口（<32 行或 <62 列）回退为普通文本品牌行。

- 启动动画（经典游戏启动器风格，**opt-in meme**）：纯黑 → 白色从屏幕中心圆形扩散至全屏（1s）→ 四行健康游戏忠告逐句淡入（2s）→ 忠告淡出的同时 `DEEPSEEK` 半块大字交叉淡入（2s）→ 底部闪烁「按任意键进入游戏」，任意键进入主界面——全程纯 ANSI（`█▀▄`），无图片协议；默认关闭，`--launcher-anime`（或 `DSH_TUI_LAUNCHER_ANIME=1`）显式启用，`DSH_TUI_NO_SPLASH=1` 强制关闭；`--script` 模式不播放，窄小终端自动跳过。

## 0.4.2 — 2026-08-23

### Added

- 欢迎页改版：40×19 半块渲染的 DeepSeek 吉祥物 logo（真实色 255 色调色板 + 逐格上下半色，数据内嵌 `src/logo.js`，去背景、无残块、裁剪掉原图底部黑条）；品牌行用 **`█▀▄` 半块像素字** 绘制（`DEEPSEEK` / `DSH NEOTUI` 两行大字标，5×7 像素字模），**每约 3.5 秒一道斜向高光扫过字标**（0.9s 扫程，纯 TUI 渲染并随主题语义色，扫过字标全宽含末尾 `I`；`DSH NEOTUI` 用深灰底保证白色高光可见）；**logo 三态** `Ctrl+R` buffer：预设（内置）/ 自定义（复用 Ctrl+O 与新建工作区的 `UploadPicker` 单选 `{palette, grid}` 40×19 JSON）/ 关闭（仅标题），持久化到配置文件；版本更新提示收敛到底部（仅「可更新/失败/检查中」时显示，可点击检查，**最新则不提示**）；模式选择从内联 4 列表收敛为底部提示「模式: <当前> · F9 打开模式选择（支持自定义）」——与 WebUI 鼓励自定义预设的方向一致；矮视口（<32 行或 <62 列）回退为普通文本品牌行。
- 启动动画（经典游戏启动器风格，**opt-in meme**）：纯黑 → 白色从屏幕中心圆形扩散至全屏（1s）→ 四行健康游戏忠告逐句淡入（2s）→ 忠告淡出的同时 `DEEPSEEK` 半块大字交叉淡入（2s）→ 底部闪烁「按任意键进入游戏」，任意键进入主界面——全程纯 ANSI（`█▀▄`），无图片协议；默认关闭，`--launcher-anime`（或 `DSH_TUI_LAUNCHER_ANIME=1`）显式启用，`DSH_TUI_NO_SPLASH=1` 强制关闭；`--script` 模式不播放，窄小终端自动跳过。

## 0.4.1 — 2026-08-22

### Added

- 11 套常用配色主题：dark、light、gruvbox 之外新增 nord、solarized-dark、solarized-light、dracula、onedark、catppuccin-mocha、tokyonight、monokai（全套语义键补齐；新增回归测试保证每个主题键集完整、循环覆盖全部方案）。
- 主题改为**选择器**而非轮换：`Ctrl+D`、`/theme` 或命令面板打开「外观 · 配色方案」面板，每行渲染该方案的色板（面板/用户/强调/成功/警告/错误六色），**光标移动即对整套 TUI 即时预览**（`setThemePreview`，不持久化，标题栏提示「预览: <name>」），`Enter` 或双击应用后**停留**继续调整（控制类 buffer 不再因选择而退出），`Esc` 恢复已提交主题并关闭；快捷键可重映射（`themePicker`）。
- pane 焦点切换拆分为两个独立命令：`panePrev`（`Ctrl+←`）与 `paneNext`（`Ctrl+→`）——与 `[` / `]` 一样各自可重映射，不再共用一个主/备槽位绑定；旧配置里的 `homeSwitch`（如 `"Ctrl+Left/Right"` 或自定义方向映射）自动迁移为两个方向。

## 0.4.0 — 2026-08-21

### Changed

- 搜索 buffer 优化：顶栏精简为 `Shift+/ 帮助`，完整快捷键与索引/降级边界移入可滚动帮助页；解析候选会话时显示逐会话进度与命中数量；结果行与右侧预览跟随选中项滚动（长邻近块不再把命中项挤出视口）；跳转后仅高亮命中块内的查询词；命中词在结果行与预览内高亮；`PgUp/PgDn/Home/End` 翻页结果列表、`Ctrl+↑/↓` 预览步进 3 行、`Ctrl+PgUp/PgDn` 预览翻页；会话行显示命中数、会话内匹配最新优先、仅 Host 摘要的结果明确标注；持久化最近 20 条查询（输入阶段 `↑/↓` 回溯）；`s` 在相关度 / 最近更新 / 命中数排序间循环，并保持当前选中行。
- 搜索支持鼠标：点击结果行选中、双击跳转（工作区/会话双击切换折叠）、滚轮在列表/预览/帮助页间按位置滚动、点击查询行回到输入阶段；终端 resize 后预览重新锚定到命中块；结果行高亮只扫描可见窗口、预览高亮一次计算并跨换行边界着色（巨型工具结果不再逐帧重复扫描）；Host 命中会话若不在侧栏列表中，用其历史尾页的最新事件时间参与“最近更新”排序。

### Added

- 快捷键 dispatch 收尾：输入阶段 `Ctrl+O` 文件选择、`Ctrl+Shift+V` 图片粘贴、`Ctrl+Shift+C` 复制选区、`Ctrl+L` 展开/折叠、退出输入（Esc）均可重映射；`Ctrl+Shift+W` 添加工作区、`Ctrl+P` 命令面板、`F9` 模式选择器、普通模式 `Ctrl+Shift+C` 复制正文选区、`Ctrl+C` 双击退出也纳入注册表（控制面板快捷键页可见可改）。`Esc` 仍保留为退出输入的兜底键。
- Host 截断输出恢复：工具卡内检测 `[output truncated; full output: <path>]` / `stored at: <path>` 类溢出提示并显示完整输出文件路径；选中该块的 `Ctrl+R` 菜单提供“打开完整输出文件”（`host.openPath`，失败时回退本地 `xdg-open`/`open`）、“复制完整输出路径”，以及本地部署下的“TUI 内预览完整输出”（可滚动查看，上限 256 KB / 500 行）。
- 二进制仅显示元数据：非图片文件不再跳过或伪装发送，选择后作为「仅元数据」条目（名称/大小）进入附件列表；工具结果含原始二进制字节（NUL/控制字符）时，工具卡只显示数据大小等元数据，不渲染原始字节。
- WebUI 功能对齐：输入框撤销/重做（`Ctrl+Z`/`Ctrl+Y`，发送后清空历史，可重映射）；输入草稿按会话镜像（切换会话保存/恢复未发送文本）；Host 帧同步（`workspace-changed`/`workspace-removed`/`workspace-order-changed`/`archived-sessions-changed` 立即刷新侧栏，`host/agent-error` 与 host 流 `stream/error` 以 toast 呈现，不再静默丢弃）；max-tokens 截断回合提示「发送『继续』」且右键菜单可直接草稿填入；工具参数/结果中的本地文件路径提供「文件预览」动作（工作区面板打开）；未知流式内容块渲染为有界「未知内容块」卡片而非伪 markdown 文本。
- WebUI 功能对齐（二）：按消息分叉会话——消息级右键「从此消息之后分叉」携带 `session.fork` 的 `atSeq` 从指定点分支（整会话分叉保持原样）；回合尾部指标——从 `step/start→首token` 推导 TTFT、解码窗口与输出 token（`usage` chunk），回合结束在最后一块下方显示 `⌁ 用时 · TTFT · 解码 · 输出 tok · tok/s`；斜杠候选栏合并 Host 命令目录（`commands/list`，含 `input.hint` 参数提示，TUI 本地命令作为兜底）。命令的「选项弹窗」为 Web 客户端插件贡献（client-side），wire 契约不包含 options，TUI 无法经 Host 获得，已标注为客户端私有能力。
- JSON 可读化：所有直接展示压缩 JSON 的位置（workflow/通用工具卡的结果与内容字段、工具参数预览、未知内容块、搜索结果块文本、任务与子代理详情）统一按 2 空格缩进多行排布并标 `code` 样式；正文输出与思考内容中的 JSON 代码块保持原样不重排。

## 0.3.0 — 2026-08-17

### Added

- tmux 风格 pane 焦点：`Ctrl+←/→` 在工作区栏、对话和轨迹间循环。
- 正文块 `=>` 游标、只读 NORMAL / VISUAL 导航、原子代码块与 `y` / `Ctrl+Shift+C` 复制。
- 全屏跨会话全文搜索：工作区→会话→匹配块树、附近内容预览和按 seq 精确跳转；Host 索引不可用时降级为有界本地扫描。
- Host 供应商目录选项预览，模型选择器默认定位当前会话模型。
- 可编辑快捷键改为真正的动态 dispatch：定义独立于 `src/keybindings.js`，每个功能主/备两个槽位，修改后立即生效。
- `Ctrl+K` 用默认编辑器打开 `tui-config.json`，关闭编辑器后快捷键自动重载；Skills 移至 `Ctrl+H`。
- 控制面板快捷键页升级为 `MODE / KEY1 / KEY2 / FUNCTION` 四列，JSON 编辑同时校验两个槽位。
- 模型选择器改为供应商文件夹 → 具体模型的层级结构：`Space` 展开/折叠、`Enter` 确认、当前模型默认展开并选中；`/` 进入筛选、`Ctrl+/` 退出筛选，与其它 buffer 一致。
- 代码块标题行重排：语言标签移入框内、按钮字段按固定宽度预留，`[按y复制]` 切换不再推动右边框；整框每行严格等宽。
- 旧版单槽位快捷键配置自动迁移（`sessionFilter "/"`、`homeSwitch "Ctrl+Left/Right"`、`skills "Ctrl+K"`），避免旧配置让 `Ctrl+F`、`Ctrl+←/→`、`Ctrl+H` 失效。

### Changed

- 所有有限选项列表统一首尾循环；文本光标和纯滚动位置保持有界。
- 侧栏、轨迹和欢迎页改为 keyboard-first 导航；全局 Tab/Shift+Tab 切换由 `Ctrl+←/→` / F8 取代。
- 轨迹展开直接呈现全部事件，移除重复且未实现完整的“查看详情”入口。
- 鼠标正文拖选固定为自由字符选择，不再由 `v` 切换整行模式。
- 工作区、设置、模型供应商、子代理和技能从“标签页模式”改为全屏模态 Buffer（`Esc` 关闭），与 `Ctrl+←/→` pane 聚焦不再冲突；轨迹仍是 pane 序列成员。
- 正文块游标改为两端停留（`j`/`k`、`↑`/`↓` 不环绕）；`Shift+G` 选中最新块并让块头落在视口底部。
- 清除未使用的 `List` 导入与死字段 `expandedTools`。

## 0.2.2 — 2026-08-16

### Added

- 底栏在子代理状态后显示“有 x 条命令正在排队 Ctrl+N 查看详情”。
- Ctrl+N 打开精简排队命令面板；每条命令一行，支持 `dd` 删除。

### Changed

- AskUser 窗口按实际内容自适应高度，长内容才启用滚动。
- 选项标签与描述只显示一次，完整描述按终端宽度换行。
- 自定义答案常驻在选项下一行并支持最多六行自动换行。
- 长正文使用 Ctrl+↑/Ctrl+↓、PgUp/PgDn、Home/End 和滚轮翻页。
- 权限审批窗口保留完整原因和命令，明确显示滚动提示与位置。

### Fixed

- AskUser 自定义回答、真实跳过项、精确鼠标 hitbox 和文本光标编辑。
- 权限申请窗口支持 ↑/↓ 逐行滚动，不改变安全默认“拒绝”。
- 超长审批命令不再只保留前六行。
- Queue 面板移除未要求的编辑与 steering 操作，`dd` 同时兼容 text/key 事件。

## 0.2.1 — 2026-08-16

### Fixed

- AskUser 问题始终显示“输入自己的回答”和常驻输入栏。
- “跳过此问题”改为真实、可导航的列表项，不再使用重复的底部按钮。
- 自定义回答支持左右键、Home、End、Backspace、Delete 和光标位置插入。
- 鼠标只在选项实际文字区域内生效，同行空白区域不再误提交。
- 自定义输入栏固定在自定义回答项下一行，跳过项固定在输入栏下方。

## 0.2.0 — 2026-08-16

### Added

- Yazi 风格三栏文件选择器和工作区目录选择器。
- 路径编辑、目录筛选、隐藏项切换、内容型文件识别和 Nerd Font 图标。
- Kitty 图片附件、附件管理器和等比例图片预览。
- 会话树筛选和跨会话模糊定位。
- Ctrl+Space 控制面板中的快捷键、命令、设置和插件页面。
- 可校验、可恢复默认的快捷键覆盖配置。
- 插件清单筛选。
- Goal、Queue / Steering、后台任务、Subagent 和附件状态界面。

### Changed

- Buffer 改为严格模态：点击外部不再隐式关闭。
- 历史分页不再受渲染层固定消息数量上限影响。
- 输入附件只显示在固定附件栏，不再写入消息文本。
- 工具和思考块交互、会话跳转与状态栏信息统一为 Nvim 风格操作。
- README 重构为安装、交互、快捷键、命令、配置和限制的完整指南。

### Fixed

- 历史向上分页递归与 viewport 锚点。
- bracketed paste 和图片粘贴路由。
- Kitty 图片传输、placement、清理、返回和 framebuffer 重绘。
- 文件选择器 Space 多选、返回定位、居中滚动、筛选固定和路径展开。
- 附件管理器 `dd` 删除。
- 宽字符覆盖和附件图标 cell 宽度。
- PTY 退出、鼠标控制序列和 Kitty keyboard 尾部解析。

### Known limitations

- 当前 Host prompt 内容协议只接受文本和图片，不支持通用文件块。
- 快捷键覆盖已安全持久化，但部分旧 handler 尚未完全迁移到动态 dispatch。
- 图片体验取决于 Kitty graphics 兼容终端及其 cell 几何信息。
