# Skill2Plugin

把一个或多个标准 OpenAI Skill 放进仓库，部署成一个带 OAuth 的私人 ChatGPT Plugin。运行时只暴露 Skill/Resource 读取能力：**0 MCP Tools、0 远程代码执行、0 任意 API 转发**。

> 设计目标：Cloudflare Workers Free 可运行；Skill 内容随 Workers Static Assets 部署；只使用一个 Workers KV 保存 OAuth 状态，不依赖 D1、R2、Zero Trust。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sunforwork/Skill2Plugin)

## 一键部署

Cloudflare 的 Deploy to Cloudflare 会克隆这个**公开模板仓库**、自动创建并绑定 `OAUTH_KV`，然后配置 Workers Builds。建议在部署页面把新生成的个人仓库设为 **Private**，再向其中加入自己的 Skill。

1. 点击上面的 **Deploy to Cloudflare**。
2. 选择 Cloudflare 账号和 GitHub/GitLab 账号，建议创建 **Private** 仓库。
3. 部署页面会要求填写 `OWNER_PASSPHRASE`。使用至少 32 个字符的随机唯一口令；它会作为 Cloudflare Worker Secret 保存，不会写入部署后的 Git 仓库。
4. 创建并部署。KV namespace 会由 Cloudflare 自动 provision，无需手工填写 namespace ID。
5. 在 Cloudflare 新建出的私有仓库中，删除不需要的示例，把自己的 Skill 放到 `Skills/<skill-name>/`，然后 push/commit。
6. Workers Builds 会自动重新构建和部署。打开 Worker 首页即可看到 MCP 地址：`https://<worker>.<subdomain>.workers.dev/mcp`。
7. 在 ChatGPT 的插件设置中添加该地址，完成 OAuth 授权，并在授权页输入部署时设置的 `OWNER_PASSPHRASE`。

> Deploy 按钮的源模板仓库必须是公开 GitHub/GitLab 仓库；用户部署后生成的个人仓库可以设为私有。

## Skill 目录

```text
Skills/
├── my-skill/
│   ├── SKILL.md
│   ├── agents/
│   │   └── openai.yaml
│   ├── references/
│   └── assets/
└── another-skill/
    └── SKILL.md
```

也支持 `Skills/<skill-name>.zip`。`SKILL.md` 必须包含 YAML frontmatter，至少有 `name` 和 `description`，其中 `name` 必须与目录名/ZIP 文件名一致。

当前按照 OpenAI Skill import 的边界进行构建校验：最多 5 个 Skill；每个 Skill 最多 100 个文件；`SKILL.md` 最大 256 KiB；单个 supporting file 最大 1 MiB；单 Skill 总资源最大 5 MiB；一次生成的 Skill archive 最大 8 MiB。

`Skills/.exampleignore` 可列出仅用于仓库展示、不参与构建的条目。仓库中的 `Skills/skills-main.zip` 就通过这个机制排除。

## 隐私与安全模型

- Skill 内容构建到 `/_content/*` Static Assets，但该路径强制先进入 Worker；匿名公网请求不会直接拿到这些文件。
- Worker 通过内部 `ASSETS` binding 读取 Skill，再由 OAuth 保护的 `/mcp` 返回给 ChatGPT。
- OAuth 使用 Cloudflare `@cloudflare/workers-oauth-provider`，启用 CIMD、PKCE 与 RFC 9207 issuer identification。
- 只允许 OpenAI 的稳定 ChatGPT CIMD client：`https://chatgpt.com/oauth/client.json`，稳定回调地址为 `https://chatgpt.com/connector_platform_oauth_redirect`。
- MCP server 不声明任何 Tools capability；`tools/list` 返回空数组，`tools/call` 一律拒绝。
- 登录失败会使用 KV 做短期速率限制。KV 只承载 OAuth/认证状态，不保存 Skill 正文。

## MCP / Skill 兼容

为了兼容不同阶段的客户端，服务同时处理：

- legacy `initialize` 流程（`2025-11-25` / `2025-06-18`）；
- modern `2026-07-28` 的 `server/discover`；
- `io.modelcontextprotocol/skills`；
- `skills/list`、`skills/get`、`resources/read`。

现代 discovery 只声明 `resources` + Skills extension，不声明 Tools。

## 本地开发

```bash
npm ci
npm run build
npm run typecheck
npm test
```

本地开发：

```bash
cp .env.example .dev.vars
# 把 OWNER_PASSPHRASE 改成至少 32 字符的随机值
npm run dev
```

本机直接部署：

```bash
npm run deploy:local
```

## 示例 Skill

仓库中的示例来自/改写自 OpenAI 官方 Skills 仓库，用于验证目录结构和导入边界：

| Skill | 用途 |
| --- | --- |
| `pdf` | 阅读、比较和制作 PDF |
| `jupyter-notebook` | 设计或制作 Notebook |
| `openai-docs` | 查阅 OpenAI 官方文档 |
| `security-best-practices` | 代码安全实践 |
| `security-threat-model` | 威胁建模 |

`skills-main.zip` 是完整仓库归档，不是单个 Skill，因此在 `Skills/.exampleignore` 中排除。

## 当前状态

构建器、Skill 边界校验、零 Tools MCP 兼容层和 OAuth 代码已经具备测试用例。发布前仍建议用真实 Cloudflare 账号和 ChatGPT 插件入口做一次完整 E2E：Deploy 按钮 → OAuth → Scan/Import Skills → Chat 中触发 Skill。

## 发布前检查

- [ ] 添加明确的开源 `LICENSE`（当前仓库尚未包含项目级许可证；示例 Skill 各自保留其原许可证）。
- [ ] 用真实 Cloudflare Deploy Button 跑一次全新账号部署。
- [ ] 用 ChatGPT 实测 OAuth 连接、Skill import 与更新后的重新扫描。
