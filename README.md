# Skill2Plugin

把一个或多个 Skill 放入 `Skills/<skill-name>/`，构建脚本会检查并整理为 ChatGPT 可导入的 Skill 清单。Cloudflare Worker 与 OAuth 接入仍在开发和本地验证阶段；这里的五个 Skill 是用于演示目录结构和导入限制的样例。

## Chat 示例

这些示例从 `Skills/skills-main.zip` 中的 OpenAI Skills 仓库挑选并改写为可依据聊天中提供的文字、代码或附件工作的版本。每个目录都包含带 `name` 和 `description` 的 `SKILL.md`，以及实际需要的资源；源仓库的 Apache-2.0 许可证保留在各目录的 `LICENSE.txt`。

| Skill | 在 Chat 中的用途 |
| --- | --- |
| `pdf` | 阅读、比较和制作用户提供的 PDF |
| `jupyter-notebook` | 根据用户的数据和要求设计或制作 Notebook |
| `openai-docs` | 查阅官方文档并回答 OpenAI 产品问题 |
| `security-best-practices` | 审阅用户提供的代码片段并给出安全修复建议 |
| `security-threat-model` | 根据用户描述的系统或架构图制作威胁模型 |

`skills-main.zip` 是完整仓库归档，不是单个 Skill；它列在 `Skills/.exampleignore`，因此不会随上述五个示例导入。替换示例时，删除不需要的 Skill 目录，再放入自己的目录或同名 ZIP。当前构建限制为最多 5 个 Skill，每个 Skill 最多 100 个文件，单个附件不超过 1 MiB。超过限制时构建会明确报错。

本地检查：`npm ci`、`npm run build`、`npm run typecheck`、`npm test`。实际 Cloudflare 与 ChatGPT 端到端接入尚未验证。
