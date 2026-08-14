# dsh-neotui — 鼠标驱动 Neo-TUI 客户端

DeepSeek Harness 的终端客户端（B 档范围，按 `../dsh-tui-design.md`）。纯 Node 标准库，零依赖。

## 安装（推荐：从 npm 装成 profile）

```bash
npm i -g pnpm                              # 首次需要 pnpm（dsh plugin 通过它安装）
dsh plugin --profile dsh-neotui add dsh-neotui-app   # 装 bundle，自动加入 profile 层栈
dsh --profile dsh-neotui                   # 启动
```

## 本地开发（从源码跑）

克隆后先自链核心包（app bundle 通过包名 `dsh-neotui` 引核心，Node 会从真实路径向上找 `node_modules`）：

```bash
ln -sfn .. node_modules/dsh-neotui        # 仓库根自链，让 app/src 能 import "dsh-neotui"
```

然后把 profile 的两条软链指到本仓库（`~/.dsh/profiles/node_modules/`）：

```bash
ln -sfn "$(pwd)"        ~/.dsh/profiles/node_modules/dsh-neotui
ln -sfn "$(pwd)/app"    ~/.dsh/profiles/node_modules/dsh-neotui-app
```

启动（本地开发 profile `~/.dsh/profiles/dsh-neotui`）：

```bash
dsh --profile dsh-neotui
dsh --profile dsh-neotui --session <id>
dsh --profile dsh-neotui --cwd ~/work
dsh --profile dsh-neotui --port 3981
dsh --profile dsh-neotui --attach 3080     # 共存调试：连已运行的 web 宿主（存储隔离，不碰 $DSH_HOME）

node bin/dsh-tui.js                        # 纯客户端模式：连接已运行的 web 宿主（默认 3080）
node bin/dsh-tui.js --base http://host:port
```

**共存调试**：web UI 和 TUI 同时跑用 `--attach`——TUI 直连 web 宿主的 API（两边实时互见对方消息），自身的内嵌宿主存储重定向到 `/tmp/dsh-neotui-attach`，绝不写共享的 `$DSH_HOME`。纯客户端 `node bin/dsh-tui.js --attach 3080` 同理。

## 结构

```
tui/                TUI 核心（src/） + 独立入口（bin/） + 测试（test/）
tui/app/            dsh-neotui-app bundle：cordis.patch.yml + tui-startup/tui-runtime 插件
                    （~/.dsh/profiles/ntui 通过 profiles/node_modules 软链解析它）
```

## 操作

| 鼠标 | 键盘等价 |
|---|---|
| 左键点击会话（工作区树内） | ↑↓ + Enter |
| 点击/Enter/←→ 折叠工作区文件夹 | 右键「折叠全部/展开全部」 |
| 隐藏/显示侧栏（nvim 式整体收起） | **Ctrl+B** |
| 控制面板（三页） | **F7**/Ctrl+Space 打开（首页快捷键），**Ctrl+P** 直达命令页；**Tab** 翻页：快捷键 / 命令 / 设置 |
| 设置次级页 | 在「设置」页内 **Shift+Tab** 翻次级页（常规 / 插件） |
| 主页切换 | **Shift+Tab** 在对话 ↔ 轨迹之间切换；顶部标签页（对话/轨迹/工作区/设置/技能/子代理）可点击直达 |
| 输入模式 | `i` 或点击进入，**Esc 退出**（nvim normal/insert）；未聚焦时字母=快捷键，多字粘贴直接输入 |
| 思考/工具折叠 | `t` 思考块展开折叠，`b` 工具块（bash 等）展开折叠；右键消息 →「展开 / 折叠」折叠单个输出块 |
| 对话 ↔ 轨迹转跳 | 对话里右键消息 →「转跳轨迹」定位到对应 step（自动展开+高亮）；轨迹里右键 step →「转跳对话」回到该消息 |
| 右键文件夹 → 新建会话（归属该工作区） | `n` |
| 滚轮翻页 / 拖拽 | PgUp / PgDn / gg / G |
| 点击展开思考块/工具卡 | — |
| 点击输入框输入 | i / 直接打字 |
| 滚轮到顶加载更早记录 | PgUp 到顶 |
| — | `/` 搜索会话，`n` 新建会话，Ctrl+B/N 切换焦点 |
| — | Ctrl+P 命令面板，Ctrl+M 模型，Ctrl+W 工作区，Ctrl+T 轨迹，Ctrl+J 任务，Ctrl+G 目标 |
| — | Ctrl+S 设置（JSON 树编辑器，settings.mutate 保存），Ctrl+A 子代理（历史/发消息/中断） |
| — | Ctrl+K 技能列表（详情/复制名） |
| — | 输入框 `@/路径/图.png` 附带图片发送（base64 image 内容部件） |
| — | nvim 式按键：聊天聚焦时字母=快捷键（`t` 思考/`i` 输入/`g g` 顶/`G` 底/`/` 搜索），其余字母自动进输入栏 |
| — | 命令面板「切换主题」：dark / light / gruvbox 实时切换 |
| — | 会话右键菜单：打开/重命名/停止/复制 ID/分叉/导出日志 |
| — | Ctrl+Q 退出 |

## 验证过的能力

- 协议：unary RPC（POST `/api/<method>` 信封）+ WS 帧流（`/api/events.mux`）+ `/api/respond`（审批/提问应答）
- 输入：SGR 鼠标（1000/1002/1003/1006）press/release/drag/wheel、修饰键、CJK、bracketed paste、kitty 键盘协议（24/24 单测通过）
- 渲染：cell diff + truecolor、OSC 8 可点击链接、CJK 宽度、滚动缓冲 + 游标分页（beforeSeq）
- 侧栏：web 同款「工作区(文件夹) → 会话(文件)」可折叠树（运行徽标、未分组兜底、右键菜单）
- 降噪：焦点感知高亮（仅聚焦窗格显示选中态）、消息流无粗体标题（用户绿色 gutter、助手空白分隔）、链接无下划线、统一提示样式
- 块式渲染（pi 风格）：输出按块拆分，每块独立底色——思考 `THINKBG`（暗）、工具调用 `TOOLBG`（蓝调 `#1e1e2e`）、工具成功 `TOOLOK`（绿调 `#1e2e1e`）、工具失败 `TOOLERR`（红调 `#2e1e1e`）、正文 `CARD`、用户消息 `USERBG`（`#2d2d30`）；⏳/✓/✗ 状态字形；块间留白；颜色随主题（[pi 主题参考](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md)）
- 工具块**默认展开**（命令 JSON + 结果常显），点击折叠；思考块默认折叠，**`t` 键全局展开/折叠**（pi 式快捷键），点击单个思考块覆盖全局模式
- 稳定性：宽字符贴右缘自动截断（防终端换行损坏）、渲染循环 try/catch 兜底（出错不再杀进程，日志+继续）
- SGR 复位语义：样式分量回到默认值即显式复位（`\x1b[0m`），滚动后背景残留/蔓延彻底消除，块间空隙稳定露出终端背景
- 输入光标：下划线式（不再反显白块）；搜索模式独占输入（IME 多字文本进搜索框、结果实时刷新、退格/leader 可用）
- leader 面板对鼠标 motion 免疫（仅点击关闭），搜索模式内 F7/Ctrl+Space 仍可呼出
- 模型切换支持思考强度：选模型后有 Off/High/Max 二次选择（默认 High）；插件清单页通过 Typert RPC（`pluginInventory/list`，HTTP POST + `{args}` 载荷）读真实 Loader 条目
- 命令页显示真实 slash 命令（`commands/list`）：/compact /export /feedback /goal /permission /plan，点选填入输入框
- 布局：顶部标签页（对话/轨迹，面板以额外活动标签呈现）+ 侧栏「▣ 工作区」标题行
- footer（powerline 风格，2–3 行）：第 1 行身份（工作区/会话/运行态/🎯目标/✎计划/模型），第 2 行用量（ctx 条+%、入/出/缓存/共 token、⚙步/回合/首响），第 3 行任务（有 job 时）
- 折叠块预览：bash 折叠后显示命令概要（view.title 或 command），思考折叠后显示前 3 行
- 会话内搜索：**Ctrl+F** 模糊搜本会话消息/工具名，回车跳转
- 轨迹详情：点击回合行弹窗（工具调用 + 耗时），`/` 过滤回合；**增量加载**（每页 20 回合逐页渲染，最近回合秒开，600 回合封顶，不再阻塞等待全量历史）
- 轨迹 详细/简略：每个 step 右键 →「展开（详细）/ 折叠（简略）」内联展开事件列表（仿对话页）；step 左键单击无反应（详情走右键菜单）；跳转定位的 step 自动展开 + 高亮闪烁
- 工作区文件搜索：工作区面板内直接打字（`/`）模糊搜文件名，回车预览
- 消息反馈：助手消息右键 👍/👎（`messageFeedback/put` Typert RPC），已评状态回显、可删除
- 图片画廊：多图时 ←/→ 切换，标题显示 (N/M) + 尺寸
- 会话内搜索高亮：Ctrl+F 跳转后匹配词高亮（黄底），Esc 清除
- 轨迹逐事件详情：点击回合 → 事件列表 → 选事件看全文
- 用户消息前缀：自己发的消息第一行直接显示内容并带 `用户名 > ` 前缀（默认取系统登录名），环境变量 `DSH_TUI_USER_PREFIX` 可自定义，如 `DSH_TUI_USER_PREFIX=edabchann dsh --profile dsh-neotui`
- 主题持久化：切主题写入 `$DSH_HOME/tui-theme.txt`（或 XDG config），重启保留
- 输入模式标识：标签栏右侧 NORMAL/INSERT 指示，Esc 退出输入
- 实时流：merge 修复（新回合不再覆盖旧回合）、活跃时 500ms 轮询、流式思考/工具自动展开
- footer 增加完整工作路径 + 缓存命中率
- 工作区右键「重命名工作区」（workspace.rename）
- 轨迹回合行加用户消息预览、移除「按 Esc 返回」提示
- 点击击穿修复：弹窗关闭时吞掉配对 release，不再误触下层会话
- footer 离线态：断连时第 1 行显示 ⚠离线
- 功能：会话列表/搜索/新建/重命名、流式对话（历史 + 轮询实时）、推理块折叠、工具卡（diff/通用卡）、审批/提问弹窗
- 面板：命令面板（模糊筛选）、模型选择（真实目录）、工作区文件树（展开/预览）、轨迹视图（braille 三车道时间轴 + 回合统计表）、任务/目标弹窗
- 设置：11 个命名空间通用 JSON 树编辑器（类型着色、布尔点击切换、标量编辑、pending 暂存、settings.mutate 保存、重启生效标记）
- 子代理：列表（activity/mode）、历史日志、continuable 发消息、中断
- 会话操作：分叉（session.fork）、日志导出（ZIP 落盘，已真机验证 1.5MB zip）
- 主题：theme.js 三套调色板（dark/light/gruvbox），全 UI 经 live Proxy 读色，命令面板一键切换
- 实时更新：mux 实时通道在本部署不工作（20s 探测仅 3 个 baseline 帧），改用 web 同款 resync 式轮询（1.2s，活跃时自适应），会话列表状态同步刷新
- 渲染性能：节点级渲染缓存（仅流式尾节点重渲染），冷重建 50 节点 ~3ms，热重建命中缓存
- 鼠标：滚动条点击跳转 + 拖拽 scrubbing、拖拽选区 + OSC 52 复制（nvim 式）、右键上下文菜单
- 技能：skill.list 真实数据（⚡ 模型可调用徽标 + 描述/何时使用详情）
- 图片输入：`@路径` 解析 → image 内容部件（15 项单测，解析/媒体类型/base64/容错全覆盖）
- 图片：消息内 🖼 占位 → kitty 图形协议内联 / chafa 字符预览 / 外部查看器兜底
- 状态栏：上下文压力 (ctx%)、token、目标 🎯、连接态、任务指示

## 测试

```bash
node test/term.test.mjs                 # 输入解码器单测 (24 项)
node test/image.test.mjs                # 图片输入解析单测 (15 项)
# 真机脚本（10 个）：smoke live panels final settings edit theme skills select poll
node bin/dsh-tui.js --script test/smoke.script --plain   # 真机冒烟
node bin/dsh-tui.js --script test/live.script --plain    # 实时流验证
node bin/dsh-tui.js --script test/panels.script --plain  # 面板全流程
node bin/dsh-tui.js --script test/final.script --plain   # 目标/模型
```

真 tty 端到端（raw 模式 + alt-screen）：`script -qec "node bin/dsh-tui.js" /dev/null`

脚本语法：`wait <ms>` / `key <name>` / `text ...` / `mouse <kind> <btn> <x> <y>` / `frame <json>` / `quit`。

## 结构（TUI 核心）

```
src/text.js       Unicode 宽度、braille、bars
src/screen.js     cell 帧缓冲 + ANSI diff 渲染
src/term.js       raw 模式、SGR/kitty 输入解码
src/api.js        RPC + WS + respond
src/md.js         Markdown → 终端行（OSC 8 链接、轻量高亮）
src/widgets.js    List/ScrollView/Input/Popup/Menu/StatusBar
src/views.js      App + 会话列表 + ChatView + 审批弹窗
bin/dsh-tui.js    入口（交互 / 脚本化测试台）
```

## 路线图（剩余 B 档模块）

图片插件端到端验证（需真实附件）、kitty 图形协议实机验证（需 kitty/wezterm 终端）、TUI slot 契约三层（见设计文档 §2）、子代理完整流程验证（需真实子代理）、交付物/反馈面板（无对应投影数据）、locale 切换。
