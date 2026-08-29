# Pi Harbor（简体中文）

[English](README.md) · 简体中文 · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor 是一个开源、移动优先的 Pi coding agent 网页客户端。它支持查看和继续会话、创建项目、预览图片，以及从手机或桌面浏览器切换多台 Pi Harbor 电脑。

## 隐私与安全

仓库只包含应用代码和通用部署模板，不包含 token、会话记录、项目文件、私有网址、账号凭证、模型使用历史、用量统计或任何特定电脑的配置。token 应保存在本机权限为 `600` 的文件中，服务默认只监听回环地址，并通过 Tailscale Serve 或其他 HTTPS 网关访问。

## 快速开始

在每一台需要运行 Pi Harbor 的电脑上执行：

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

安装程序会检查 Pi Agent 与 Node.js、下载并验证最新稳定 Release、创建
launchd 服务和自动更新。如果没有 Pi Agent，会先询问是否使用 Pi 官方安装程序。

安装完成后，在运行 Pi Harbor 的电脑上打开终端并运行：

```bash
cat ~/.config/pi-harbor/token
```

将 token 粘贴到登录页；从其他设备使用时，也请从该主机安全地取得 token。若服务明确配置了 `PI_HARBOR_TOKEN_FILE`，请读取所配置的文件，而不是默认路径。绝不要把 token 写入 Git、问题单、聊天、截图或日志。

## 多台电脑

每台电脑都运行自己的 Pi Harbor 实例。在每台额外电脑上安装并启动 Pi Harbor，使用 Tailscale 或 HTTPS，然后在 **Settings → Devices → Add device** 添加地址，也可以使用五分钟有效的一次性配对码。两台电脑使用相同的 Web token；凭证保留在选定的主机上。不要将公共 3140 端口暴露给不受信任的网络。

添加 LLM 服务商：打开 **Settings → Connection → Models & providers**，选择目录服务、账号/OAuth 登录、API key、本地服务或自定义 Provider，然后选择要显示的模型。

## 自动更新

默认每小时检查 GitHub 的最新稳定 Release，并验证 SHA-256。如果 Pi 正在工作，更新会延后，完成后才替换应用。更新器不会修改 Pi 会话、项目文件、Provider 凭证或 Web token。

## 卸载

```bash
~/.local/share/pi-harbor-bin/uninstall.sh
```

可以选择只删除 Pi Harbor，或连同 Pi Agent 可执行文件一起删除；会话、凭证和项目文件夹都会保留。

## 开发与测试

```bash
npm run check
npm test
```

更多部署说明、配置项和安全注意事项请参阅[英文文档](README.md)。
