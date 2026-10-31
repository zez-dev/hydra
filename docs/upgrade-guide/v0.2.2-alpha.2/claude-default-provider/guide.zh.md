---
kind: upgrade-guide
description: "Web 与桌面应用默认使用 Claude Sonnet 5.5，首次使用引导改为索要提供商 API 密钥而非 DeepSeek 登录，且 session/initializeDefaultModel 需要传入提供商。"
---
# Web 与桌面应用默认使用 Claude，并通过 API 密钥完成引导

[English](guide.md) | 中文

## 变更

Web 与桌面应用加载的 `dsh-web-app` 包在 `llm-pi-ai` 上组合了一条 Anthropic 路由，提供 Claude Opus 5.5、Sonnet 5.5 和 Haiku 5.5（`apiKeyEnv: ANTHROPIC_API_KEY`）；其 `agent-default-model` 条目为 `anthropic` / `claude-sonnet-5-5`，不再是 `deepseek-official` / `deepseek-flash`。已保存的模型选择仍会覆盖组合默认值。从未保存过选择、且只有 DeepSeek 密钥的 profile，新会话现在会使用 Claude，并提示其密钥缺失。CLI 与 SDK profile 仍以 DeepSeek 为默认。

Web 首次运行的密钥步骤索要 `ui-settings-models` 条目中 `onboardingProvider` 所指提供商的密钥；该字段默认为 `deepseek-official`，此包将其设为 `anthropic`。该步骤的 `settings.onboarding` id 由 `deepseek-official` 改为 `provider-key`。

桌面欢迎页提供带有提供商选择的“添加 API Key”和“稍后配置”，不再发起 DeepSeek 账号登录。已存储的账号登录仍视为已配置。

`session/initializeDefaultModel` 接受一个提供商路由，并只在可用目录未列出已保存的默认模型时，保存该提供商的第一个可用模型。此前它会在未配置任何提供商 API 密钥时保存第一个 DeepSeek 账号模型。

## 迁移

1. 如需在 Web 与桌面应用中继续以 DeepSeek 为默认，在会话的模型菜单中选择一次 DeepSeek 模型，或在 profile 的 `cordis.patch.yml` 中加入以下条目：

   ```yaml
   - id: agent-default-model
     config:
       provider: deepseek-official
       model: deepseek-flash
   ```

2. 如需保留 DeepSeek 首次运行密钥步骤，在 `ui-settings-models` 的 profile 补丁条目中设置 `onboardingProvider: deepseek-official`；该条目已设置 `credentialOnboarding` 时一并保留。
3. 把 `openOnboarding('deepseek-official')` 改为 `openOnboarding('provider-key')`。
4. 调用 `session/initializeDefaultModel` 时传入刚存储凭据的路由，例如账号登录后调用 `ctx.remote.session.initializeDefaultModel('deepseek-account')`。
5. 确认迁移成功：在 Web 应用中新建会话时，输入框显示的目标模型为可用状态。
