# Stepsemble（简体中文）

[English](README.md) · 简体中文 · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Stepsemble 是一个开源、自托管、移动优先的本地 coding agent 工作区。Pi Agent
使用原生会话路径；同一界面也能启动主机上已安装的 Claude Code、Codex CLI、Grok
Build 和 OpenCode。

## 隐私与安全

仓库只包含应用代码和通用部署模板，不包含 token、会话记录、项目文件、私有网址、账号凭证、模型使用历史、用量统计或任何特定电脑的配置。token 应保存在本机权限为 `600` 的文件中，服务默认只监听回环地址，并通过 Tailscale Serve 或其他 HTTPS 网关访问。

## 快速开始

在每一台需要运行 Stepsemble 的电脑上执行：

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

安装程序会检查 Pi Agent 与 Node.js、下载并验证最新稳定 Release、创建
launchd 服务和自动更新。如果没有 Pi Agent，会先询问是否使用 Pi 官方安装程序。

Linux 可改用 `install-linux.sh`，会创建用户级 systemd 服务和每小时更新计时器：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install-linux.sh)"
```

Windows 可下载 `install-windows.ps1`，会创建用户级计划任务（不需要管理员权限）：

```powershell
irm https://raw.githubusercontent.com/seehow624/stepsemble/master/install-windows.ps1 -OutFile install-windows.ps1
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

Linux 和 Windows 都需要 Node.js 22.19 以上；服务默认只监听本机回环地址。

安装完成后，在运行 Stepsemble 的电脑上打开终端并运行：

```bash
cat ~/.config/stepsemble/token
```

Windows PowerShell：

```powershell
Get-Content $HOME\.config\stepsemble\token
```

Windows 命令提示符：

```bat
type %USERPROFILE%\.config\stepsemble\token
```

将 token 粘贴到登录页；从其他设备使用时，也请从该主机安全地取得 token。若服务明确配置了 `STEPSEMBLE_TOKEN_FILE`，请读取所配置的文件，而不是默认路径。绝不要把 token 写入 Git、问题单、聊天、截图或日志。

在主机本机的浏览器首次打开 Stepsemble 时，会提供类似冷钱包的一次性密钥揭示导览：密钥只在 loopback 连接上显示——绝不会通过 Tailscale Serve、代理或其他设备——并在你完成两项确认后永远不再出现。其他设备一律使用已保存的密钥或 token 文件。

## 独立访问令牌

如果一台电脑由多人或多台设备使用，可在 **Settings → Access tokens** 中使用安装主令牌创建带标签的独立令牌。令牌只显示一次，可以单独撤销，服务器只在 `~/.config/stepsemble/tokens.json` 中保存 SHA-256 哈希（权限 `600`）。它们仍是主机级凭据，不会创建独立的 Pi 账号或项目权限。

## 多台电脑

每台电脑都运行自己的 Stepsemble 实例。在每台额外电脑上安装并启动 Stepsemble，然后在 **Settings → Devices → Add device** 添加 Tailscale 或 HTTPS 地址。手动输入网址仍是旧版共享 Web token 路径，要求两台主机使用相同 token。更推荐使用五分钟有效、只能使用一次的 `STEPSEMBLE3` 配对码：确认候选设备资料后，会创建独立且可撤销的对等凭证，不会把共享 token 发给候选地址。可在设备设置中查看并撤销已授权设备，撤销会立即生效。Stepsemble 3 可接受旧版主机的 `PIHARBOR2` / `PIHARBOR3` 配对码；旧客户端必须先更新才能使用 `STEPSEMBLE3`。不要将公共 3140 端口暴露给不受信任的网络。

添加 LLM 服务商：打开 **Settings → Connection → Models & providers**，选择目录服务、账号/OAuth 登录、API key、本地服务或自定义 Provider，然后选择要显示的模型。

## Agent Hub 连接器

首页的 **Agent Hub** 会发现本机 Pi Agent，以及已安装的 Claude Code、Codex
CLI、Grok Build、OpenCode。创建 **New project** 时可以选择 Agent，并可选启用隔离
Git worktree。CLI 的 stdout/stderr 会流式显示在对话中；macOS/Linux 使用内置
`server/pty-bridge.py` 提供交互式终端，Windows 或没有 Python 的主机则使用安全 pipe。
计时器会在离开页面或关闭浏览器后继续；从任务中心重新打开即可回放有限长度的输出。

通用 CLI 任务由独立的每任务监督器管理，保存在 `~/.config/stepsemble/agent-tasks.json`。
重启 Stepsemble 网页服务后会重新接管监督器，任务计时和输出继续；如果主机或监督器本身被终止，
任务会如实标记为已中断。Agent Hub 的“查看全部”支持搜索、状态筛选、回放和一键停止。

## 自动更新

默认每小时检查 GitHub 的最新稳定 Release，并验证 SHA-256。如果 Pi 正在工作，更新会延后，完成后才替换应用。更新器不会修改 Pi 会话、项目文件、Provider 凭证或 Web token。

## 卸载

```bash
~/.local/share/stepsemble-bin/uninstall.sh
```

可以选择只删除 Stepsemble，或连同 Pi Agent 可执行文件一起删除；会话、凭证和项目文件夹都会保留。

## 开发与测试

```bash
npm run check
npm test
```

更多部署说明、配置项和安全注意事项请参阅[英文文档](README.md)。
