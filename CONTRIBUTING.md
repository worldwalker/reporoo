# Contributing to RepoRoo

Thanks for helping RepoRoo explain codebases to humans.

## Before you start

- Search existing issues before opening a new one.
- Use a GitHub Security Advisory for vulnerabilities; do not disclose them publicly.
- Never submit credentials, private repository content, Telegram messages, or production data.
- Discuss large behavior or architecture changes in an issue first.

## Local development

RepoRoo requires Node.js 22.13 or newer.

```bash
npm ci
cp .env.example .env
npm run check
npm run build
```

Use `npm run dev` only after adding your own Telegram and authentication settings. The full `npm run setup` flow can install system packages and start interactive GitHub and Codex login.

## Pull requests

Keep changes focused and explain the user-visible effect. Before opening a pull request, run:

```bash
npm run check
npm run build
```

Update documentation when configuration, commands, security boundaries, or visible behavior change. The package remains marked `private` to prevent accidental npm publication; that does not prevent repository contributions.
