---
description: "The webhook group map: outbound notifications from Hydra's goals and agents to webhook, Telegram, and Discord channels, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/webhook

English | [中文](README.zh.md)

## Summary

The webhook group carries Hydra's outbound notifications. `dsh-notify` posts a short message to each configured channel when a goal blocks or completes, the goal round driver gives up after repeated transient failures, or an agent turn errors. It is mounted disabled in `dsh-base`; a deployment enables it and names its channels. Inbound provider events and programmatic rules belong to the experimental webhook packages that the [Webhook subsystem reference](../../docs/subsystems/webhook.md) describes.

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`notify/`](notify/README.md) | Outbound goal, retry, and agent-error notifications to webhook, Telegram, and Discord channels | `ctx.notify` |

<a id="dev-note"></a>
## Dev Note

None.
