# Security policy

## Reporting a vulnerability

Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/worldwalker/reporoo/security/advisories/new). Do not open a public issue with exploit details, credentials, private source code, Telegram messages, or production logs.

Include the affected commit, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days. Timelines for a fix depend on severity and complexity.

If a report contains an exposed credential, revoke or rotate that credential immediately. A GitHub report is not a substitute for containment.

## Supported versions

Until RepoRoo publishes stable releases, security fixes target the latest commit on `main` only.

## Security boundaries

RepoRoo is designed to make repository analysis read-only, but operators remain responsible for:

- limiting the Telegram chats and administrators allowed to use the bot;
- granting GitHub credentials only the repository access they need;
- protecting the host, `.env`, registry database, repository cache, and Codex credentials;
- reviewing OpenAI and Telegram data-handling terms for their deployment; and
- keeping RepoRoo and its dependencies updated.

Repository content is untrusted input. The Codex prompt instructs the analyst to ignore repository instructions, and execution uses a read-only sandbox with network access and web search disabled. These controls reduce risk; they are not a promise that hostile content can never influence a generated answer.
