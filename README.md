# dsh-neotui

`dsh-neotui` 是 DeepSeek Harness 的 keyboard-first 终端客户端：以 Vim/Nvim 风格的 NORMAL / INSERT / VISUAL 只读导航、tmux 风格 pane 焦点和 Yazi 风格文件选择器为主，鼠标作为辅助，访问与 WebUI 相同的 Host 会话、工具、审批、任务和设置能力。

本仓库发布两个 npm 包：

| 包 | 用途 |
|---|---|
| `dsh-neotui` | TUI 客户端、核心界面和 `dsh-neotui` 命令 |
| `dsh-neotui-app` | 将 TUI、API gateway 和 Host 服务装配成 DSH profile 的 bundle |

## 0.2.0 亮点

- 三栏 Yazi 风格文件与工作区选择器：路径编辑、模糊筛选、隐藏项、Nerd Font 图标和 Kitty 图片预览；
- 图片附件栏、附件管理器、`dd` 删除和等比例 Kitty 预览；
- 全屏跨会话全文搜索：工作区→会话→匹配块树、附近内容预览和精确跳转；
- NORMAL / INSERT / VISUAL 只读模式、正文块选择与可编辑的快捷键目录；
- 独立的命令、设置和插件目录，插件支持即时筛选；
- Queue / Steering、Goal、TODO、Plan Review、后台任务和 Subagent 状态；
- grapheme-aware framebuffer、CJK/组合字符、Kitty keyboard、SGR mouse、OSC 8/52。

完整变化见 [`CHANGELOG.md`](CHANGELOG.md)。

## 安装与启动

需要 **Node.js 22 或更高版本**（客户端使用 Node 内置 `fetch`、`WebSocket`、`crypto.randomUUID` 和 `Intl.Segmenter`）。

### 独立 DSH profile

```bash
dsh plugin --profile dsh-neotui add dsh-neotui-app
dsh --profile dsh-neotui
```

常用参数：

```bash
dsh --profile dsh-neotui --session <session-id>
dsh --profile dsh-neotui --cwd ~/work
dsh --profile dsh-neotui --host 127.0.0.1 --port 3981
```

出于安全原因，`--host 0.0.0.0` 会被拒绝。能够执行工具的 Host 不应直接暴露到不受信任的网络。

### 连接已有 Web Host

```bash
dsh --profile dsh-neotui --attach 3080
```

也可以直接运行客户端：

```bash
node bin/dsh-tui.js
node bin/dsh-tui.js --base http://127.0.0.1:3080
```

默认连接 `http://127.0.0.1:3080`；可通过 `--base`、`DSH_URL` 或 `DSH_WEB_URL` 覆盖。`--attach` 不会启动或替换 WebUI。

## 从源码运行

```text
.
├── app/                 dsh-neotui-app bundle
├── bin/dsh-tui.js       客户端入口
├── src/                 TUI 核心
└── test/                单元、终端协议与 PTY 测试
```

使用本地 profile：

```bash
mkdir -p ~/.dsh/profiles/node_modules
ln -sfn "$(pwd)"     ~/.dsh/profiles/node_modules/dsh-neotui
ln -sfn "$(pwd)/app" ~/.dsh/profiles/node_modules/dsh-neotui-app
dsh --profile dsh-neotui
```

只调试客户端时，保证目标 Host 已运行即可：

```bash
node bin/dsh-tui.js --base http://127.0.0.1:3080
```

## 交互模型

### NORMAL / INSERT

- `NORMAL`：单字符用于导航和操作；
- `INSERT`：键盘输入交给消息编辑器；
- `i` 或点击输入框进入 INSERT；
- `Esc` 离开 INSERT；
- INSERT 中 `Esc` 不会中断当前回合；
- NORMAL 中 `Esc` 会中断正在运行的回合，否则返回上一级；
- NORMAL 中连续两次 `Ctrl+C` 退出，INSERT 中 `Ctrl+C` 清空输入。

底栏始终显示当前模式。按 `Ctrl+Space` 打开快捷键、命令、设置和插件目录。

### 输入与附件

| 模式 | 按键 | 功能 |
|---|---|---|
| INSERT | `Enter` | 发送 |
| INSERT | `Shift+Enter` / `Ctrl+J` | 换行 |
| INSERT | `Ctrl+L` | 展开/折叠输入栏 |
| INSERT | `↑` / `↓` | 在首尾行浏览输入历史 |
| INSERT | `Ctrl+Shift+C` | 复制输入框选区 |
| INSERT | `Ctrl+O` | 打开文件选择器 |
| NORMAL | `Ctrl+O` | 打开附件管理器 |

文件选择器支持：

| 按键 | 功能 |
|---|---|
| `↑` / `↓` | 移动光标 |
| `←` / `→` | 返回上级 / 进入目录 |
| `Space` | 选择或取消文件 |
| `Enter` | 确认上传 |
| `/` | 筛选当前目录 |
| `Ctrl+/` | 清除筛选并退出筛选模式 |
| `Ctrl+F` | 编辑路径，支持 `~`、`$HOME` 和环境变量 |
| `Ctrl+.` | 显示/隐藏隐藏项 |
| `Esc` | 关闭 |

附件管理器支持 `Enter` 预览、`Shift+Enter` 或双击用默认程序打开、`dd` 删除。当前 Host 内容协议只接受文本和图片；普通文件不会被伪装成可发送附件。

Kitty graphics 可用时，图片在文件选择器和附件预览中等比例显示；否则回退到 MIME、尺寸和文件大小信息。

### Queue / Steering

模型运行时，Enter 的策略由 `busyEnter` 决定：

- `queue`：加入下一回合队列；
- `steer`：追加到当前回合。

`Ctrl+Y` 切换策略，`Ctrl+N` 打开排队命令详情。队列面板每条命令一行，使用 `↑/↓` 循环选择、`Enter` 展开详情、`Ctrl+↑/↓` 独立滚动详情、`dd` 删除、`Esc` 关闭。

## 快捷键

以下是默认绑定。控制面板中的快捷键页以 `MODE / KEY1 / KEY2 / FUNCTION` 四列显示，每个功能拥有主/备两个槽位，并允许编辑用户覆盖；配置写入 `$DSH_HOME/tui-config.json`。这些绑定是运行时的唯一来源：修改后立即生效（无需重启），全部定义集中在 `src/keybindings.js`。

| 模式 | 按键 | 功能 |
|---|---|---|
| ALL | `Ctrl+Space` / `F7` | 控制面板 |
| NORMAL | `Ctrl+F` / `/` | 打开全屏跨会话全文搜索；Enter 执行，`/` 重新编辑 |
| NORMAL | `Ctrl+B` | 显示/隐藏侧栏 |
| NORMAL | `Ctrl+M` | 模型与思考强度 |
| NORMAL | `F8` | 权限模式轮换 |
| NORMAL | `F9` | Agent 模式 |
| NORMAL | `Ctrl+W` | 工作区 |
| NORMAL | `Ctrl+Shift+W` | 添加工作区 |
| NORMAL | `Ctrl+T` | 轨迹视图 |
| NORMAL | `Ctrl+←` / `Ctrl+→` | 工作区栏 / 对话 / 轨迹 pane 循环聚焦 |
| NORMAL | `Ctrl+E` | 按 step 快速跳转 |
| NORMAL | `Ctrl+J` | 后台任务与 Subagent |
| NORMAL | `Ctrl+N` | 排队命令详情 |
| NORMAL | `Ctrl+Y` | 运行中 Enter 策略（追加 / 排队） |
| NORMAL | `Ctrl+O` | 附件管理 |
| NORMAL | `Ctrl+G` | Goal / TODO |
| NORMAL | `Ctrl+S` | Settings |
| NORMAL | `Ctrl+A` | Subagent |
| NORMAL | `Ctrl+H` | Skills |
| NORMAL | `Ctrl+K` | 用默认编辑器（`$EDITOR` / `$VISUAL` / `vi`）打开 `tui-config.json`；编辑完成后快捷键立即重载 |
| ALL | `Ctrl+Q` | 退出 |
| 正文块 | `↑` / `↓`、`j` / `k` | 上下选择正文块，两端停留不环绕；`Ctrl+↑/↓` 只滚动视口 |
| 正文块 | `Space` / `Enter` / `Ctrl+R` | 折叠块 / 进入只读光标 / 打开上下文菜单 |
| NORMAL 光标 | `h l w b e 0 $`、`v` / `V` | Vim 式只读移动与字符/整行 VISUAL（无 `x` / `d`） |
| NORMAL / VISUAL | `y` / `Ctrl+Shift+C` | 复制当前代码块/正文块或选区 |
| 正文块 | `t` / `b` | 全局展开/折叠思考块 / 工具块 |
| 正文块 | `g g` / `G` | 首个 / 最新正文块；`G` 选中最新块并让块头落在视口底部 |
| NORMAL | `[` / `]` | 上一个 / 下一个提问终点 |
| NORMAL | `PgUp` / `PgDn` | 翻页；到顶时加载更早历史 |

侧栏聚焦后，`↑/↓` 循环选择工作区或会话，`Space` 展开/折叠工作区，`Enter` 打开会话且保持侧栏焦点，`n` 新建会话，`i` 进入输入，`Ctrl+R` 打开当前项菜单。轨迹聚焦后，`↑/↓` 循环选择 step，`Space` 展开完整事件，`Enter` 跳回对话，`Ctrl+R` 打开 step 菜单。

搜索 buffer 中，输入阶段 `↑/↓` 回溯最近 20 条持久化查询；Enter 执行查询或跳转结果，`/` 返回查询编辑，`s` 在相关度 / 最近更新 / 命中数排序间循环，`Space` 折叠工作区/会话，`t` / `b` 折叠思考/工具匹配，`PgUp` / `PgDn` / `Home` / `End` 翻页结果列表，`Ctrl+↑/↓` 与 `Ctrl+PgUp/PgDn` 滚动右侧预览。解析期间显示逐会话进度（Host 候选显示已解析数，本地扫描显示已扫描与命中数；`Esc` 可随时取消），结果行与预览都会跟随选中项滚动并高亮查询词，会话行显示命中数、会话内匹配最新优先。排序切换保留当前选中会话/匹配行。跳转后只高亮命中块内的查询词，`Esc` 清除高亮。若 Host 未挂载搜索索引（`session.search` 不可用），会自动降级为对最近 20 个会话近期历史的有界本地扫描，并在 buffer 顶部提示。

快捷键目录中：`Enter` 编辑当前 JSON 配置项（`{"mode":"normal|insert|all","key":"…","key2":"…"}`，`key2` 可为空），`Shift+Tab` 在 NORMAL / INSERT / ALL 间轮换，`Alt+Enter` 恢复默认。保存前会校验 JSON、模式和两个按键槽位；错误文本会保留以便继续修改。两按组合键（如 `g g`）以空格分隔书写。

## Slash 命令

输入 `/` 后使用 `Tab`、`↑`、`↓` 补全。TUI 本地命令包括：

| 命令 | 功能 |
|---|---|
| `/reload` | 重新绘制并载入界面状态 |
| `/restart` | 重启 TUI 并恢复会话 handoff |
| `/model` | 模型选择 |
| `/theme` | 切换主题 |
| `/permission` | 权限选择 |
| `/goal` | Goal 面板 |

Host 提供的 `/compact`、`/export`、`/feedback`、`/plan` 等命令会动态出现在命令页；实际清单以当前 Host 的 `commands/list` 为准。

## 面板与工具卡

TUI 支持：

- 工作区和分组会话树：新建、打开、重命名、移动、归档、删除和导出；
- terminal、read、search、web、diff 和 generic presentation；
- `run_code` 嵌套子调用树；
- 工具审批、AskUser 单选/多选、Plan Review；
- Goal、TODO、后台任务和 Subagent；
- 独立插件清单及 `/` 筛选；
- dark、light、gruvbox 主题。

工作区（`Ctrl+W`）、设置（`Ctrl+S`）、模型供应商（模型选择器里的 `⚙ 管理供应商…`）、子代理（`Ctrl+A`）和技能（`Ctrl+H`）都是**全屏模态 Buffer**：打开后覆盖整个界面，`Esc` 逐级返回并最终关闭。它们不再占用“标签页模式”，因此关闭后 `Ctrl+←/→` 的 pane 聚焦立即恢复，两者互不冲突。轨迹仍是 pane 序列的一部分，由 `Ctrl+T` 或 `Ctrl+←/→` 进入。

模型选择器（`Ctrl+M` / `/model`）是供应商文件夹 → 具体模型的层级结构：`Space` 展开/折叠文件夹，`↑/↓` 移动，`Enter` 确认具体模型（带思考强度时再选一档），当前模型以 `●` 标记并默认展开、默认选中。筛选与其他 buffer 一致：`/` 进入筛选、`Ctrl+/` 退出筛选，普通字符在浏览模式下不会误触发筛选。

所有 Buffer 都是模态的：点击外部只会吞掉事件，不会关闭 Buffer。退出必须使用界面明确提示的按键或操作。

## 鼠标与终端能力

- 点击工作区、会话、标签、工具块和输入框；
- 拖动侧栏分隔线；
- 滚轮浏览对话、列表和弹窗；
- 输入框拖选并通过 OSC 52 复制；
- 右键消息、轨迹 step 和工作区树打开菜单；
- SGR mouse、bracketed paste、Kitty keyboard、OSC 8、OSC 52；
- ANSI truecolor 差量 framebuffer；
- CJK、组合字符和 ZWJ emoji 的 grapheme-aware 渲染。

不同终端、tmux 和 SSH 环境对 Kitty graphics、keyboard、OSC 52 的支持不同。WezTerm 和 Kitty 是图片预览的推荐终端。

## 配置

TUI 设置：

```text
$DSH_HOME/tui-config.json
```

包含显示名、默认折叠状态、运行中 Enter 策略和快捷键覆盖。主题保存在：

```text
$DSH_HOME/tui-theme.txt
```

`DSH_TUI_USER_PREFIX` 可覆盖默认用户名。

## 测试

```bash
npm test          # 单元与协议测试
npm run test:pty  # 真实 PTY 生命周期
npm run test:rc   # 完整发布候选验证
```

PTY 测试会验证 alternate screen、SGR mouse、界面渲染、退出恢复和常见运行时错误。需要可用的 DSH Host；Host 不可用时测试会明确输出 `SKIP`。

脚本化 smoke：

```bash
node bin/dsh-tui.js --script test/smoke.script --plain
```

## 当前限制

- TUI 与 Host 必须使用兼容的事件、RPC 和内容块契约；
- 当前 Host 不支持通用二进制文件内容块，文件选择器只会发送图片；
- Kitty 图片效果受终端实现、cell 尺寸和复用器支持影响；
- 超长工具输出可能由 Host 截断，TUI 会显示工具提供的恢复位置；
- 快捷键覆盖配置已持久化并经过校验，部分旧 handler 仍使用内置 dispatch，后续版本会继续统一动态绑定。

## 代码结构

```text
src/api.js          HTTP RPC、WebSocket 和 respond
src/term.js         raw mode、鼠标、paste、Kitty keyboard
src/screen.js       cell framebuffer 与 ANSI diff
src/text.js         grapheme、显示宽度和截断
src/md.js           Markdown、代码块和 OSC 8
src/keybindings.js  可编辑快捷键注册表（每个功能主/备两个槽位）
src/widgets.js      Input、Popup、ScrollView、Menu、StatusBar
src/views.js        App、ChatView、会话树和主路由
src/panels.js       Workspace、Trajectory、Queue、Jobs、Settings
src/file-picker.js  三栏文件/目录选择器与图片预览
app/                DSH bundle 与 Cordis patch
```

## 许可证

MIT
