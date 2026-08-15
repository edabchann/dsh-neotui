# dsh-neotui

DeepSeek Harness 的终端界面。它连接 DSH Host，提供会话、流式对话、工具调用、审批、计划审阅、任务、目标、子代理、工作区和设置等能力。

这个项目包含两个包：

- `dsh-neotui`：终端客户端及核心 UI；
- `dsh-neotui-app`：将 TUI、API gateway 和所需 Host 服务装配成 DSH profile 的 bundle。

> 当前版本是发布候选前的开发版本。交互仍在检查中，暂不建议把它当作稳定接口或无人值守环境中的唯一客户端。

## 主要能力

- 工作区与会话树：打开、新建、重命名、移动、分叉、停止和导出会话；
- 流式对话：历史分页、实时状态、会话内搜索、模型与思考强度切换；
- 结构化工具卡：terminal、read、search、web、diff，以及 `run_code` 嵌套子调用树；
- 人机交互：工具审批、AskUser、多选问题、专用 Plan Review；
- Queue / Steering：查看、编辑、删除排队消息，或将消息追加到当前回合；
- Goal、TODO、Plan、后台任务和 Subagent 状态；
- 工作区文件浏览、轨迹视图、Skills 和 Settings；
- 鼠标、bracketed paste、Kitty keyboard、OSC 8 链接和 OSC 52 复制；
- CJK、组合字符和 ZWJ emoji 的 grapheme-aware 渲染；
- dark、light、gruvbox 三套主题；
- 第三方供应商高级配置：route/model 思考强度、上下文与输出上限、输入模态，以及默认 Agent/Subagent 模型目标。

## 运行方式

### 方式一：使用 TUI profile

安装 bundle 后，由 DSH 启动独立 Host 和 TUI：

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

安全限制：`--host 0.0.0.0` 会被拒绝。TUI Host 能执行工具，不应直接暴露到不受信任的网络。

### 方式二：连接已经运行的 Web Host

与当前 WebUI 并行使用：

```bash
dsh --profile dsh-neotui --attach 3080
```

也可以只运行客户端：

```bash
node bin/dsh-tui.js
node bin/dsh-tui.js --base http://127.0.0.1:3080
```

默认地址是 `http://127.0.0.1:3080`，也可通过 `DSH_URL` 或 `DSH_WEB_URL` 指定。

`--attach` 模式不会启动替代 Web 服务；TUI 直接使用现有 Host 的 API。该 profile 自身的持久化路径会重定向到临时目录，避免与正在运行的 Host 同时写入同一套存储。

## 从源码运行

仓库布局：

```text
.
├── app/                 dsh-neotui-app bundle
├── bin/dsh-tui.js       独立客户端入口
├── src/                 TUI 核心
└── test/                单元、脚本化与 PTY 测试
```

如果使用本地 profile，需要让 profile 能按包名解析这两个目录：

```bash
mkdir -p ~/.dsh/profiles/node_modules
ln -sfn "$(pwd)"     ~/.dsh/profiles/node_modules/dsh-neotui
ln -sfn "$(pwd)/app" ~/.dsh/profiles/node_modules/dsh-neotui-app
```

随后启动对应 profile：

```bash
dsh --profile dsh-neotui
```

直接调试纯客户端时不需要 profile symlink，只需保证目标 Host 已运行：

```bash
node bin/dsh-tui.js --base http://127.0.0.1:3080
```

## 界面模型

### NORMAL 与 INSERT

TUI 保留轻量的 Vim 式焦点模型：

- `NORMAL`：字母键用于导航和快捷操作；
- `INSERT`：键盘输入交给消息编辑器；
- 按 `i` 或直接点击输入框进入 INSERT；
- 按 `Esc` 离开 INSERT；
- INSERT 中的 `Esc` **不会**取消正在运行的回合；
- NORMAL 中若当前回合仍在运行，按一次 `Esc` 会请求中断；空闲时则用于返回对话或上一级界面；
- NORMAL 中连续两次 `Ctrl+C` 会退出 TUI；INSERT 中 `Ctrl+C` 只清空输入。

Footer 会显示当前的 `NORMAL` / `INSERT` 状态。

### 输入与发送

| 操作 | 按键 |
|---|---|
| 发送 | `Enter` |
| 换行 | `Shift+Enter` 或 `Ctrl+J` |
| 展开/折叠输入栏 | `Ctrl+L` |
| 输入历史 | `↑` / `↓`（位于首尾行时） |
| Slash 命令补全 | 输入 `/` 后使用 `Tab`、`↑`、`↓` |
| 清空当前输入 | INSERT 中 `Ctrl+C` |
| 复制输入框选区 | `Ctrl+Shift+C` |
| 附带图片 | 在输入中写 `@/path/to/image.png` |

较大的 bracketed paste 会先显示占位提示，再次粘贴才写入完整内容，避免误发送巨量文本。

### 运行中的 Enter：Queue 或 Steering

当模型正在运行时，Enter 的行为由 `busyEnter` 决定：

- `queue`：消息进入下一回合队列；
- `steer`：尝试将消息追加到当前回合。

`Ctrl+Y` 在两种策略之间切换，并持久化到 `$DSH_HOME/tui-config.json`。

`Ctrl+U` 打开消息队列：

| QueuePanel 操作 | 按键 |
|---|---|
| 选择 | `↑` / `↓` 或鼠标点击 |
| 编辑 queued message | `e` |
| 立即 steering | `s` |
| 删除 | `d` |
| 关闭 | `Esc` |

Host 若报告 steering 窗口已关闭，消息会继续保留；若条目已被其他客户端移除，面板会自动收敛本地状态。

## 全局快捷键

以下快捷键主要在 NORMAL 模式工作；INSERT 模式优先保证正常编辑。

| 按键 | 功能 |
|---|---|
| `F7` / `Ctrl+Space` | 控制面板 |
| `Ctrl+P` | 控制面板的命令页 |
| `Ctrl+B` | 显示/隐藏侧栏 |
| `Ctrl+M` | 模型选择 |
| `F8` / `F9` | 权限策略 / 工作模式 |
| `Ctrl+W` | 工作区 |
| `Ctrl+Shift+W` | 新增工作区 |
| `Ctrl+T` | 轨迹视图 |
| `Shift+Tab` | 对话与轨迹切换 |
| `Ctrl+E` | 按 step 快速转跳 |
| `Ctrl+F` | 搜索当前会话 |
| `Ctrl+J` | 后台活动（任务 / Subagent，Tab 或 ←→ 切页） |
| `Ctrl+U` | 消息队列 |
| `Ctrl+G` | Goal / TODO（创建、编辑、轮次、暂停、继续、完成、清除） |
| `Ctrl+S` | Settings |
| `Ctrl+A` | Subagent |
| `Ctrl+K` | Skills |
| `Ctrl+Q` | 退出 TUI |

NORMAL 模式下：

| 按键 | 功能 |
|---|---|
| `i` | 进入输入 |
| `/` | 搜索会话 |
| `t` | 全局展开/折叠思考块 |
| `b` | 全局展开/折叠工具块 |
| `g g` / `G` | 对话顶部 / 底部 |
| `[` / `]` | 上一个 / 下一个提问的终点 |
| `PgUp` / `PgDn` | 翻页；到顶时加载更早历史 |

默认折叠策略是：思考块展开、工具块折叠、TODO 可见。可在 Settings 的“默认展开/折叠”中修改。

## 工具卡与嵌套调用

TUI 使用 Host 随 `tool/call` 和 `tool/result` 提供的 presentation view：

- terminal：命令、工作目录、输出、exit code、signal；
- read：路径、语言、行号和文件总行数；
- search：grep 文件分组、glob 路径、截断数量和恢复位置；
- web：答案、来源、fetch URL 和 HTTP 状态；
- diff：新增、删除和修改内容；
- generic：保留工具提供的文本内容和 sections。

运行中、成功、失败、停止和“结果未保留”分别显示不同状态。`run_code` 产生的 `tool/code-dispatch-start` / `tool/code-dispatch` 会折叠为嵌套子调用树；子调用默认折叠，可独立展开。

## Plan Review、审批和提问

- 工具审批会显示工具名、原因以及能够解析到的命令；默认安全选择是拒绝；
- 同时到达的审批和问题会排队，不会互相覆盖；
- AskUser 支持单选、多选、自定义回答和取消；
- Plan Review 使用专用界面，固定保留“执行计划 / 继续规划”选项；
- 长计划可使用 `PgUp`、`PgDn`、`Home`、`End` 或鼠标滚轮审阅；
- `Esc` 会取消当前审阅，不会暗中批准计划。

## 鼠标操作

- 点击工作区、会话、标签页、工具块和输入框；
- 拖动侧栏分隔线调整宽度；
- 滚轮浏览对话、面板和弹窗；
- 拖动输入框选区，再用 `Ctrl+Shift+C` 通过 OSC 52 复制；
- 右键消息或轨迹 step 打开上下文菜单；
- 点击滚动条跳转，拖动滚动条快速浏览。

终端较窄时侧栏会自动隐藏；极小尺寸会显示最小尺寸提示，而不是生成负布局。

## 设置与持久化

TUI 本地设置位于：

```text
$DSH_HOME/tui-config.json
```

包括：

- 用户消息显示名；
- 思考、工具和 TODO 默认折叠策略；
- 运行中 Enter 的 queue / steer 行为。

主题保存在：

```text
$DSH_HOME/tui-theme.txt
```

环境变量 `DSH_TUI_USER_PREFIX` 可覆盖默认用户名。

## 测试

普通测试：

```bash
npm test
```

真实 PTY 生命周期测试：

```bash
npm run test:pty
```

完整 RC 验证：

```bash
npm run test:rc
```

PTY 测试要求 `http://127.0.0.1:3080` 存在可连接的 DSH Host。Host 不可用时明确输出 `SKIP`。测试会验证 alternate screen、SGR mouse、真实界面渲染、退出恢复和常见运行时错误。

连接现有 Host 的脚本化 smoke：

```bash
node bin/dsh-tui.js --script test/smoke.script --plain
```

脚本支持：

```text
wait <ms>
key <name> [mods]
text <text>
mouse <kind> <button> <x> <y>
resize <width> <height>
frame <json>
quit
```

## 终端兼容性

已自动覆盖的协议和行为：

- SGR mouse 1000/1002/1003/1006；
- bracketed paste；
- Kitty keyboard protocol；
- ANSI truecolor cell-diff rendering；
- OSC 8 links；
- OSC 52 clipboard；
- resize / SIGWINCH；
- raw mode、alternate screen 和退出恢复。

图片显示按能力降级：Kitty graphics → `chafa` 字符预览 → 外部查看器或文本占位。

不同终端、tmux 配置和 SSH 环境对 Kitty keyboard、OSC 52、链接及图片协议的支持不同。自动测试通过不等于所有终端组合都已人工验收。

## 当前限制

- 目前仍在进行人机交互检查，快捷键和局部布局可能继续调整；
- PTY RC 测试依赖本机已有 DSH CLI 和一个运行中的 Host；
- `--attach` 只连接现有 Host，不会启动或替换 WebUI；
- 图片完整体验取决于终端能力和可选外部程序；
- 超长工具输出和搜索结果可能由 Host 截断，TUI 会显示恢复位置（若工具提供）；
- TUI 与 Host 必须使用兼容的事件与 RPC 契约。

## 代码结构

```text
src/api.js        HTTP RPC、mux/host WebSocket、respond
src/term.js       raw mode、鼠标、paste、Kitty keyboard 输入解码
src/screen.js     cell framebuffer 与 ANSI diff
src/text.js       grapheme、显示宽度、截断和格式化
src/md.js         Markdown 到终端行、代码块、OSC 8 链接
src/widgets.js    Input、Popup、ScrollView、Menu、StatusBar
src/views.js      App、ChatView、时间线、审批与 Plan Review
src/panels.js     Workspace、Trajectory、Queue、Jobs、Settings 等面板
app/              DSH bundle 与 Cordis patch
```

## 许可证

MIT
