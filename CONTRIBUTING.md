# Contributing to Hydra

English | [中文](CONTRIBUTING.zh.md)

Hydra is an unofficial community fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Unlike upstream, Hydra accepts issues and pull requests in this repository.

## Report a problem

Open an issue with what you ran, what you expected, and what happened. Include the output of `/doctor`, your operating system, and the model provider you use. Never paste API keys or the contents of a `.env` file.

A problem that also happens in unmodified DeepSeek Harness belongs upstream, in [its discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).

Do not post a security problem in a public issue; report it privately as described in [SECURITY.md](SECURITY.md).

Hydra is developed and tested on Linux. Reports from macOS and Windows are especially welcome, because those platforms are not tested yet.

## Send a pull request

- Keep each pull request to one change, and add or update tests for any change in behavior.
- Before opening it, run `pnpm run typecheck`, `pnpm run lint`, and the tests of the packages you changed, for example `pnpm exec vitest run packages/learning/memory`.
- Follow the conventions in [AGENTS.md](AGENTS.md); coding agents read the same file.
- Hydra does not maintain the Chinese translations of its documentation, so the translation-pairing check is expected to fail. Every other check should pass.

Contributions are released under the [MIT License](LICENSE), the same license as DeepSeek Harness.

## Build a plugin

Hydra and DeepSeek Harness are built to be extended. A plugin can live in its own repository; add the `dsh-plugin` topic to it so others can find it.

## Learn the code

Start with the [development guide](docs/development.md) and the [architecture documentation](docs/architecture.md).

## For maintainers

### Take an upstream release

The `master` branch mirrors DeepSeek Harness; `main` is Hydra.

1. Bring `master` up to date: `gh repo sync zez-dev/hydra --branch master`, or **Sync fork** on GitHub while viewing `master`.
2. On a new branch from `main`, merge `master` and resolve the conflicts. Regenerate what the checks name as stale; `pnpm run check:ci:static` lists every generated file that is out of date (translation pairing is expected to fail).
3. Open a pull request. The Hydra check must pass before it is merged.

### Publish a release

1. Raise `HYDRA_VERSION` in [packages/boot/doctor/src/checks.ts](packages/boot/doctor/src/checks.ts); `/doctor` prints it first.
2. Merge that change, then tag the merge with the same version (`v<version>`) and publish release notes that list what changed and the known limits.
