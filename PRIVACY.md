# Privacy notes for operators

RepoRoo is self-hosted. The person or organization running a deployment is responsible for its privacy notice, retention policy, access controls, and legal obligations. This file describes the default application's data flow; it is not a ready-made legal policy.

## Data processed

- Telegram sends the bot message text, chat metadata, and user metadata needed to handle an update.
- RepoRoo sends the question and relevant repository context to the user's selected analyst, Codex or Claude, so it can produce an answer.
- GitHub CLI clones configured repositories onto the operator's host.
- The local SQLite registry stores product and repository configuration, the Telegram user ID of the administrator who created each record, and each user's selected analyst.

## Retention

- Repository snapshots and registry data remain on disk until the operator deletes them.
- Pending product selections expire after 10 minutes, answer context after 24 hours, and rate-limit counters after one minute. All disappear on restart.
- Structured logs do not include question text or credentials. They do include Telegram user and chat IDs, repository names, request IDs, timing, and error details; the operator controls log retention.

## Operator checklist

- Tell users who operates the bot and where their data is processed.
- Set an appropriate log retention period and restrict log access.
- Restrict access to `.env`, `data/`, GitHub credentials, Codex credentials, and the Anthropic API key.
- Do not configure repositories whose content should not be processed by the available OpenAI or Anthropic service.
- Provide a contact and process for access or deletion requests where required.
