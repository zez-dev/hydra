---
kind: upgrade-guide
description: "The Web and desktop app default to Claude Sonnet 5.5, onboarding asks for a provider API key instead of a DeepSeek sign-in, and session/initializeDefaultModel takes a provider."
---
# The Web and desktop app default to Claude and onboard with an API key

English | [中文](guide.zh.md)

## Change

The `dsh-web-app` bundle, which the Web and desktop app load, composes an Anthropic route on `llm-pi-ai` with Claude Opus 5.5, Sonnet 5.5, and Haiku 5.5 (`apiKeyEnv: ANTHROPIC_API_KEY`), and its `agent-default-model` row is `anthropic` / `claude-sonnet-5-5` instead of `deepseek-official` / `deepseek-flash`. A saved model selection still overrides the composition default. A profile that never saved a selection and holds only a DeepSeek key now starts new sessions on Claude, which reports its key as missing. The CLI and SDK profiles keep the DeepSeek default.

The Web first-run key step asks for the `ui-settings-models` row's `onboardingProvider` key; the field defaults to `deepseek-official`, and the bundle sets `anthropic`. The step's `settings.onboarding` id is `provider-key` instead of `deepseek-official`.

The desktop welcome offers **Add API key** with a provider choice and **Set up later**; it no longer starts a DeepSeek account sign-in. A stored account sign-in still counts as configured.

`session/initializeDefaultModel` takes the provider route whose first available model it saves, and saves it only while the available catalog does not list the saved default. It used to save the first DeepSeek account model whenever no provider API key was configured.

## Migration

1. To keep DeepSeek as the Web and desktop default, select a DeepSeek model in a session's model menu once, or add this row to the profile's `cordis.patch.yml`:

   ```yaml
   - id: agent-default-model
     config:
       provider: deepseek-official
       model: deepseek-flash
   ```

2. To keep the DeepSeek first-run key step, set `onboardingProvider: deepseek-official` in a profile patch row for `ui-settings-models`, restating `credentialOnboarding` when the row sets it.
3. Replace `openOnboarding('deepseek-official')` with `openOnboarding('provider-key')`.
4. Call `session/initializeDefaultModel` with the route whose credential was stored, for example `ctx.remote.session.initializeDefaultModel('deepseek-account')` after an account sign-in.
5. Confirm the migration: a new session in the Web app shows the intended model as available in the composer.
