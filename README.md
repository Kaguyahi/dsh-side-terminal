# dsh-side-terminal

> 让 DeepSeek Harness（DSH）的模型完全接管本会话的侧边栏终端：读取屏幕内容、发送输入命令、新建/关闭终端，危险命令执行前强制用户确认。附带【终端模式】Agent 预设。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D%200.2.1--rc.2-green.svg)](#兼容性)

---

## ✨ 功能特性

| 功能 | 说明 |
|---|---|
| 📟 `side_terminal_list` | 列出本会话所有侧边栏终端（id、标题、shell、尺寸、状态） |
| 👁️ `side_terminal_read` | 读取终端当前可见屏幕（纯文本，含提示符行），**零侵入**——不抢输入控制权、不产生只读横幅 |
| ⌨️ `side_terminal_write` | 向终端发送输入（自动追加回车提交），**直接写入 PTY**——不经过 attach 流，不打断用户正在进行的输入 |
| ➕ `side_terminal_open` | 在侧边栏新建终端，UI 自动弹出标签页 |
| ❌ `side_terminal_close` | 关闭终端并终止其进程树，UI 标签自动消失 |
| ⚠️ 危险命令确认 | `rm -rf`、`git reset --hard`、`sudo`、`shutdown`、`curl \| sh` 等 19 类危险模式，发送前强制用户审批，拒绝则一个字节都不会到达终端 |
| 🎨 悬浮状态胶囊 | 接管/重连/退出等状态提示改为右上角悬浮胶囊，不再挤占布局、不遮挡终端最后一行 |
| 🧭 【终端模式】预设 | Agent 预设：移除沙箱 bash/pwsh 工具，所有命令都走侧边栏终端；guard 兜底拒绝任何漏网的沙箱 shell 调用 |

---

## 📦 安装

### 方式一：本地目录安装（开发/私有）

1. 克隆本仓库到本地：

```bash
git clone https://github.com/<你的用户名>/dsh-side-terminal.git
cd dsh-side-terminal
```

2. 在 DSH 的 Web GUI 中打开 **设置 → 插件**，或通过 CLI 安装：

```bash
# 通过插件管理器安装本地目录（link 模式）
dsh --profile <你的profile> plugin install link:/path/to/dsh-side-terminal
```

> 本地链接安装后修改源码，重装即可生效（插件管理器会重新扫描 bundle）。

### 方式二：GitHub 直接安装

DSH 插件市场/插件管理器支持从 GitHub 仓库直接安装：

```
github:<你的用户名>/dsh-side-terminal
```

在 **设置 → 插件 → 已安装** 页面输入上述地址即可。

### 安装后验证

1. 重启 DSH（`preset-terminal` 行的 agent 预设内部插件树不受 HMR 管理，需重启生效）
2. 打开一个会话，让模型执行 `side_terminal_list`，应返回终端列表（或 `No sidebar terminals`）
3. 在 **设置 → 插件** 中应看到「Side Terminal Control」条目

---

## 🚀 使用

### 基本使用

安装后模型自动获得 5 个工具，直接用自然语言吩咐即可：

| 你说 | 模型做 |
|---|---|
| 「看看侧边栏终端里现在是什么」 | `side_terminal_list` → `side_terminal_read` |
| 「在侧边栏终端里执行 `npm test`」 | `side_terminal_write` |
| 「在侧边栏开一个新终端」 | `side_terminal_open` |
| 「把那个终端关掉」 | `side_terminal_close`（先请你确认） |

### 危险命令确认

当模型要执行的命令命中危险模式时，界面会弹出确认框：

- ✅ **批准** → 命令才真正发到终端
- ❌ **拒绝** → 一个字节都不会到达终端

内置危险模式（19 类）：`rm -rf`、`git reset --hard`、`git push --force`、`sudo`/`doas`、`shutdown`/`reboot`、`mkfs`/`dd of=/dev/`、`curl|sh` 远程代码管道、`chmod 777`、`kill -9`、shell 历史篡改等。

### 【终端模式】预设

重启 DSH 后，新建会话时在预设选择器中选择 **终端模式**：

- 沙箱 `bash`/`pwsh` 工具从模型工具目录中移除
- 所有命令必须通过 `side_terminal_*` 在侧边栏终端执行
- guard 插件兜底：即使 bash 工具被其他层塞回，执行也会被硬拒绝

---

## ⚙️ 配置

在 profile 的 `cordis.patch.yml` 中覆盖 `side-terminal` 行的 config：

```yaml
- id: side-terminal
  config:
    # 追加自定义危险正则（命中则要求确认）
    dangerousPatterns:
      - '\\b(reboot|init 6)\\b'
    # 单次读取最大字符数（默认 40000）
    maxReadChars: 40000
    # 写入后等待送达确认的最长时间（毫秒，默认 15000）
    waitForEchoMs: 15000
    # 读取时清除终端颜色/控制码（默认 true）
    stripAnsi: true
```

所有配置项均有默认值，不配置也完全可用。

---

## 🔧 工作原理

### 零侵入读取

`side_terminal_read` 不打开 `terminal/attach` 流，而是在 Host 进程内直接序列化 xterm 屏幕（读 `TerminalController` 私有 owners 注册表拿 `BrowserTerminal`，调 `serializer.serialize()`）。浏览器保持输入控制权，无只读横幅。

### 直写 PTY

`side_terminal_write` 直接 `handle.write(data)` 写入 PTY——与浏览器 attach 后写输入的底层路径完全一致（`BrowserTerminal.consumeInput` 内部也是调 `handle.write`）。不抢输入控制权、不产生横幅。

### UI 同步 watcher

客户端模块在会话 header 挂载 watcher，每 3 秒轮询 `terminal/list`：

- Host 有新终端 → 自动 `openTabIn` 打开标签并展开右栏
- Host 终端已关闭 → 自动关闭对应标签

### 状态胶囊

客户端 CSS 覆盖编译类名 `_5D1QAq_status`（及属性选择器兜底），把状态行从 flex 布局改为右上角 `position: absolute` 悬浮胶囊，终端最后一行始终可见。

---

## 🏗️ 项目结构

```
dsh-side-terminal/
├── package.json          # bundle 清单（含 dsh.bundle + dsh.client 声明）
├── cordis.patch.yml      # Loader patch：工具行 + 【终端模式】预设声明
├── index.js              # Host 插件：5 个 side_terminal_* 工具
├── guard.js              # 预设守卫：拒绝沙箱 shell 工具
├── client.js             # 客户端插件：状态胶囊 CSS + 终端标签 watcher
├── locale/
│   ├── en.json           # 英文元数据
│   └── zh.json           # 中文元数据
└── icon.svg              # 插件图标
```

---

## 🔗 兼容性

| 项 | 要求 |
|---|---|
| DSH 版本 | `>= 0.2.1-rc.2` |
| Node.js | `>= 22` |
| 平台 | Linux / macOS / Windows（侧边栏终端功能） |

> 本插件依赖 DSH 内置服务（`terminalController`、`typertGateway`、`connection.browserPeer`、`approval` 等），均为 DSH Web profile 的标准组件，无需额外安装。

---

## ⚠️ 注意事项

1. **读取/写入的终端是当前会话的侧边栏终端**——与模型工具 `terminal_*`（PTY 注册表）是两套独立系统
2. **写入后立即归还控制权**——用户可以在模型操作间隙继续手动输入
3. **危险命令确认是 fail-closed**——审批服务不可用时拒绝执行，绝不静默放行
4. 会话切换时 watcher 只同步当前会话的终端

---

## 🐛 已知限制

- `side_terminal_read` 依赖 Host 进程内的 `TerminalController` 私有字段（`owners`、`serializer`），DSH 内部结构变化时可能需要适配（有 attach 流回退路径兜底）
- 悬浮胶囊定位依赖编译类名 `_5D1QAq_status`，若 DSH 重新构建导致类名哈希变化，属性选择器仍可兜底（胶囊可能不显示但不会挤占布局）

---

## 📄 License

MIT

---

## 🙏 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 插件所依赖的运行时平台
