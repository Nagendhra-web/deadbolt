# Deadbolt for Claude Code

Stop your coding agent deleting the wrong thing. Before it runs.

[![Tests](https://img.shields.io/badge/tests-130%20passing-brightgreen)](tests)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![No dependencies](https://img.shields.io/badge/dependencies-0-blue)](src/deadbolt.js)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](README.md)

**Deadbolt is a deterministic guardrails hook pack for Claude Code. It blocks destructive commands before they run, in plain language, with a safe alternative every time.**

Your agent is fast, and it runs the commands it writes. When it gets a path, a variable, or a database wrong, the result is not a typo. It is lost work.

```text
Agent: rm -rf /
Deadbolt: Blocked. This would delete the root of the filesystem.
          Safe alternative: Delete one named folder inside the project,
          for example rm -rf ./tmp, and check the path first with ls.

Agent: rm -rf node_modules
Deadbolt: Allowed.
```

## Why this exists

Coding agents delete things. In September to November 2026, reported agent deletions included an `rm -rf` that deleted about 600GB, an `rm -rf` that included `.git` and lost about 12 months of history, a `prisma migrate reset` run against production, and a `git reset --hard` that lost uncommitted work. Deadbolt blocks all of those patterns.

No model call. No prompt. No server. No API key. No network. Just 117 tested rules, running locally before every tool call.

## What it blocks

117 rules in 12 groups:

- Recursive delete of protected paths: `/`, `~`, home, `.`, `.git`, `src`, project root, `*`, `..`
- Empty variable delete: `rm -rf $VAR`, `rm -rf ${VAR}`, `rm -rf "$VAR"`
- Command substitution delete: `rm -rf $(...)`, `` rm -rf `...` ``
- Git destructive: `git push --force` to main, master, or prod, `git reset --hard`, `git clean -fd`, `git branch -D main`
- SQL destructive: `DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, `DELETE` without `WHERE`
- Database reset tools: `prisma migrate reset`, `rails db:reset`, `artisan migrate:fresh`, `manage.py flush`
- Pipe to shell: `curl ... | sh`, `curl ... | bash`, `wget ... | sh`
- Permissions and disk: `chmod -R 777`, `mkfs`, `dd` to `/dev/`
- Secret reads: `.env`, `*.pem`, `id_rsa`, `.aws/credentials`
- Secret writes: AWS keys (`AKIA`), Anthropic keys (`sk-ant-`), OpenAI keys (`sk-proj-`), GitHub tokens (`ghp_`), Slack tokens (`xoxb`), JWTs, private keys
- Settings tamper: edits to `.claude/settings.json` that disable hooks
- Production database strings: Postgres, MySQL, and MongoDB URLs pointing at prod

Safe deletes are allowed: `rm -rf node_modules`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `tmp`, `temp`, `__pycache__`, `.pytest_cache`.

See the full list with `node src/deadbolt.js --list-rules`.

## Install in under 5 minutes

You need Node.js 18 or later. No other install is needed.

```bash
git clone https://github.com/Nagendhra-web/deadbolt.git
cd deadbolt
node src/install.js --global
```

For one project only, run this inside that project folder instead:

```bash
node src/install.js --project
```

The installer finds your Claude Code `settings.json`, backs the original up, and adds one PreToolUse hook. It keeps every existing hook and setting. It never deletes anything. Run it twice and the second run changes nothing.

Check what it would do first, without changing anything:

```bash
node src/install.js --global --dry-run
```

Restart Claude Code if it was already running, then use it as normal. Deadbolt runs before every tool call.

## Test it

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node src/deadbolt.js --dry-run
```

You should see a deny decision with a plain language reason. Then try a safe command:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | node src/deadbolt.js --dry-run
```

You should see an allow decision.

Test one command directly, without building JSON by hand:

```bash
node src/deadbolt.js --command "rm -rf /" --dry-run
node src/deadbolt.js --command "rm -rf node_modules" --dry-run
```

## Proof: tests

130 tests, 130 pass, 0 fail. Node built-in test runner only, no dependencies.

```bash
node --test tests/*.test.js
```

Verified November 18, 2026, with 15 hook cases checked live: 8 blocked correctly, 4 allowed correctly, plus installer and report checks on a temp project. One real bug was found and fixed in testing: the hook blocked `.env.example` while telling users to use it instead. That is now exempted, with 3 regression tests added.

## Audit log and report

Deadbolt only writes a log when you tell it where to write it. Set `DEADBOLT_LOG` to a file path, or pass `--log <path>`:

```bash
DEADBOLT_LOG=~/.claude/deadbolt.log
```

Each decision is one JSON line with `timestamp`, `tool`, `command`, `decision`, `rule_id`, and `reason`.

Read the summary any time:

```bash
node src/report.js
node src/report.js --log ~/.claude/deadbolt.log
node src/report.js --json
```

## How it works

Claude Code calls a PreToolUse hook before it runs a tool. It sends a JSON object on stdin with `tool_name` and `tool_input`. Deadbolt reads that JSON, checks it against its rules, and writes a JSON decision to stdout.

Deadbolt splits compound commands on `&&`, `||`, `;`, and `|`, and re-scans the inside of `bash -c`, `sh -c`, `powershell -Command`, `$(...)`, and backticks. A dangerous part hidden inside a longer command is still blocked.

It fails closed for `rm -rf` and `DROP`: if the target cannot be checked, it blocks rather than allowing it. For other unknown commands it allows by default, so normal work is not interrupted.

Deadbolt makes no network calls. It does not need an API key. It does not send your commands anywhere.

## Uninstall

```bash
node src/install.js --global --uninstall
```

Uninstall removes only the Deadbolt hook. It backs the settings file up first, and it keeps every other hook and setting.

## What Deadbolt does not do

- It does not stop prompt injection. It stops destructive tool calls at runtime. Use a skill scanner for that job, and keep Deadbolt as the runtime gate.
- It does not promise to catch every dangerous command. It is a guardrail, not a guarantee.
- It works with Claude Code only. The rule logic is plain Node, so a developer can adapt it, but only Claude Code is supported in this pack.

## FAQ

**Does Deadbolt slow Claude Code down?**
No, in any way you will notice. It is one small Node script, it runs locally, and it checks text patterns only.

**Does it need jq, bash, or Python?**
No. Node.js is the only requirement. It uses the Node standard library only, so it works on Windows, macOS, and Linux.

**Will it block my normal work?**
It allows normal commands by default. It only blocks the patterns in the rule list, and it allows the safe `rm -rf` targets in the allowlist.

**Can I allow a blocked command once?**
Yes. Run the command yourself in your own terminal, after you have checked it. Deadbolt only stops Claude Code from running it for you.

## Star this repo if it saved you once

If Deadbolt blocks one bad command for you, star it, share it with a developer who runs Claude Code in auto mode, and open an issue with the command it should have blocked. That is how this stays alive.

## License

MIT. See [LICENSE](LICENSE).

## Topics

claude-code, ai-agents, guardrails, hooks, developer-tools, safety, nodejs, cli, open-source, code-safety
