# Contributing to Switchdesk

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Run it locally

You need Node.js 20 or newer and at least one agent CLI (Claude Code, Codex, GitHub Copilot, Cursor's `agent`, Kimi, Gemini CLI or Qwen Code) installed and signed in.

```
git clone https://github.com/SlaterMarketing/switchdesk
cd switchdesk
npm install
npm start
```

## Where things live

- `src/` is the Electron main process: one file per agent connection (`session.js` for Claude Code, `codex-session.js`, `acp-session.js`), plus git snapshots, worktrees, the terminal and the updater.
- `renderer/` is the window: editor, chat panel, review, git panel and settings.
- `site/` is the website at [switchdesk.dev](https://switchdesk.dev). It's plain HTML with no build step; open `site/index.html` in a browser to preview it.

The README's "How it works" section explains how each agent is driven.

## Tests

`npm test` starts the real app with a fresh profile and drives it through its window (Playwright), using a fake agent (`test/fake-agent/`) in place of Cursor and Copilot, so it needs no sign-in and no network. The tests are in `test/app.test.js`; add one when you change how something behaves. On Linux without a screen, run `xvfb-run -a npm test`. They run on GitHub for every push and pull request.

## Sending a change

1. Fork the repo and make a branch.
2. Keep the change focused, and match the style of the code around it.
3. Run `npm test`, then run the app and try what you changed with at least one agent.
4. Open a pull request that says what changed and how you tested it. Screenshots help for anything visual.

## Reporting a bug

Use the bug report form under [Issues](https://github.com/SlaterMarketing/switchdesk/issues/new/choose). Include your Switchdesk version (shown at the top of the Help menu), your operating system, and which agent you were using.

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
