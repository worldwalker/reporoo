# RepoRoo 🦘

RepoRoo is a read-only Telegram codebase Q&A bot powered by Codex or Claude. It hops across one or more authorized GitHub repositories, investigates a question, and returns a short answer for non-technical readers.

> **Project status:** early-stage and suitable for careful self-hosting. Interfaces and registry data may change before the first stable release.

## What it does

1. Responds only in allowlisted Telegram chats when mentioned or replied to.
2. Routes questions to a product and its likely components.
3. Clones or refreshes disposable repository snapshots using GitHub CLI.
4. Runs the selected analyst with read-only repository tools, no edits, and no web search.
5. Combines multi-repository findings into one plain-language answer.
6. Keeps technical file evidence behind the admin-only `/details` command.

RepoRoo cannot edit source repositories or push to GitHub.

## Requirements

- macOS or Ubuntu Linux
- Node.js 22.13+
- A Telegram bot token from BotFather
- Access to the configured GitHub repositories
- Codex authentication
- Optional: an Anthropic API key to enable Claude

GitHub CLI and the bundled Codex CLI are installed or verified by the setup flow.

## Install

```bash
git clone https://github.com/worldwalker/reporoo.git
cd reporoo
./install.sh
```

The installer:

- installs Node dependencies;
- installs Bubblewrap and its narrow AppArmor profile on Ubuntu for Codex sandboxing;
- installs GitHub CLI using Homebrew or apt when missing;
- uses the Codex CLI bundled with `@openai/codex-sdk`;
- opens GitHub and Codex login when required;
- creates `.env` from `.env.example`.

On Ubuntu, setup uses `sudo` to install required sandbox and GitHub CLI packages. If you prefer to review each system change, run `npm ci` and then inspect `src/cli/setup.ts` before running `npm run setup`.

Then edit `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace-me
TELEGRAM_ALLOWED_CHAT_IDS=-1001234567890
TELEGRAM_ADMIN_USER_IDS=123456789
REGISTRY_DATABASE=./data/registry.sqlite
# Optional: enables /model claude
ANTHROPIC_API_KEY=
```

Keep Telegram BotFather privacy mode enabled if members will always mention or reply to RepoRoo. This prevents ordinary group conversation from reaching the bot.

All supported settings are documented in [`.env.example`](.env.example). An empty `TELEGRAM_ALLOWED_CHAT_IDS` blocks every chat; an empty `TELEGRAM_ADMIN_USER_IDS` disables registry changes and technical details.

## Configure products and repositories

An ID listed in `TELEGRAM_ADMIN_USER_IDS` manages the registry from Telegram. A **product** is the app or business being discussed; a **repository** is one GitHub codebase belonging to it.

Create a product, then attach a repository:

```text
/product add Acme Shop
/repo add acme-shop acme/shop-api
```

RepoRoo generates the product ID `acme-shop`, verifies GitHub access, detects the repository's default branch, and saves everything in `data/registry.sqlite`. Changes work immediately without a restart.

Teach RepoRoo how people describe the product and repository:

```text
/product alias acme-shop acme, shop
/repo alias acme/shop-api backend, server, api
/repo topics acme/shop-api orders, payment, cancellation
/repo component acme/shop-api shared backend API
```

Aliases are alternative names. Topics are business concepts that help RepoRoo select the right repository. Link a repository when questions about it should always inspect another repository too:

```text
/repo link acme/shop-mobile acme/shop-api
```

Use `/product` or `/repo` without arguments to see all admin commands. Use `/product list` and `/repo list` to inspect the current registry.

## Run locally

```bash
npm run dev
```

For production:

```bash
npm run build
npm start
```

The example systemd unit is available at `deploy/reporoo.service`. It expects RepoRoo in `/opt/reporoo`, a dedicated `reporoo` user and group, and a writable home directory at `/var/lib/reporoo`. Authenticate GitHub and Codex as that service user, then copy the unit to `/etc/systemd/system/`. Review every path and hardening option for your host before enabling it.

## Logs

Runtime logs are structured as one JSON object per line. They cover startup, admin commands, question routing and completion, repository clone/refresh operations, rate limits, and failures. Question text, Telegram tokens, and authentication credentials are never logged.

Logs do contain Telegram user and chat IDs, repository names, and error details. See [PRIVACY.md](PRIVACY.md) before operating a bot for other people.

On a systemd deployment:

```bash
sudo journalctl -u reporoo -f -o cat
```

## Telegram usage

```text
/ask How do I buy points?
/ask@RepoRooBot What happens when an order is cancelled?
```

Replies to RepoRoo inherit the previous product selection. Administrators can reply with `/details` to see repository commits and supporting file locations.

Each user can select their analyst independently. The preference is saved in the local registry database:

```text
/model
/model codex
/model claude
```

Codex is always the default. Claude appears only when `ANTHROPIC_API_KEY` is configured; `CLAUDE_MODEL` defaults to `claude-sonnet-5` and can be overridden. Questions analyzed by Claude send relevant repository content to Anthropic's API.

## Security model

- Only allowlisted chat IDs are accepted.
- Per-user rate limiting is enabled.
- Repository names and cache paths are validated.
- Product and repository changes are restricted to configured Telegram administrators.
- Git commands use argument arrays rather than a shell.
- Codex runs with a read-only sandbox, disabled network, and `approvalPolicy: never`.
- Claude receives only read/search tools whose paths are constrained to the selected repository; file edits, shell commands, settings, MCP servers, and web tools are unavailable.
- Public answers and technical evidence are separated.
- GitHub credentials should have read-only access to only the configured repositories.

Read [SECURITY.md](SECURITY.md) for the trust boundaries and private vulnerability-reporting process.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please keep private repository content and production data out of issues and pull requests.

## License

RepoRoo is available under the [MIT License](LICENSE).
