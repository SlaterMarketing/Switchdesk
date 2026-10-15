# Claude Desk

A personal, Cursor-style desktop editor that drives **your own Claude Code CLI**. Every message runs the unmodified `claude` binary on your machine, signed in with your own Claude subscription, so there's no API key and no extra billing.

## What you get

- **Editor:** a Monaco (VS Code) editor with tabs, a file explorer, quick open (`Ctrl+P`) and save (`Ctrl+S`). The theme follows your system, or pick one in Settings.
- **Chat panel** with four modes. Cycle them with `Ctrl+.` or `Shift+Tab` in the chat box.
  - **Ask:** answers questions and never edits files. Any action that would change something is refused automatically.
  - **Plan:** researches first, then shows the plan as a card. Choose **Build it**, **Edit plan** (change the plan before approving it), or **Keep planning** (send feedback).
  - **Agent:** edits files without asking. Before Claude runs a shell command, you get an Allow / Always allow / Deny card.
  - **Auto:** Claude Code's auto mode. A safety classifier approves actions, and anything it won't approve comes to you as a card.
- **Chat tabs:** run several conversations side by side, each with its own Claude process. A spinner shows which ones are working, and the usage line shows turns and context size per chat.
- **Images:** paste a screenshot (`Ctrl+V`) or drag one onto the chat box.
- **Changes card after each turn:** shows every file the turn changed, including files changed by shell commands, with +/− counts and a diff. You can **Undo** each file or **Undo all**. In the diff, every change has its own **Undo** and **Keep** buttons.
- **Terminal:** `Ctrl+`` opens a real terminal (PowerShell on Windows) in the project folder. Open several with +.
- **Git panel** (`Ctrl+Shift+G`): changed files with diffs against the last commit, discard, commit (with a ✨ button that asks Claude Haiku to write the message), branches, push and pull.
- **Settings** (`Ctrl+,`): your CLAUDE.md instructions (this project and all projects), saved permission rules, and MCP servers. These are Claude Code's own files, so they apply in the terminal too.
- **Context**
  - `@` in the chat box mentions a file.
  - `Ctrl+L` adds the editor selection to the chat.
  - `Ctrl+K` edits the selection in place.
- **History:** the Chats tab lists your Claude Code conversations for the open folder, including ones started in the terminal. Click one to continue it.
- **Status bar:** shows the CLI version, how you're signed in, and your 5-hour and 7-day usage.
- **Model and effort pickers:** Opus, Sonnet, Haiku and Fable, and Low to Max effort.

## Install (Windows, no terminal needed)

1. Download **ClaudeDesk-Setup-x.y.z.exe** from the [latest release](https://github.com/SlaterMarketing/claude-desk/releases/latest) and run it. It installs for your user (no admin rights), adds Desktop and Start Menu shortcuts, and opens the app.
2. On first launch, a setup screen offers **Install Claude Code** (Anthropic's official installer) and **Sign in with Claude**, which opens your browser. When both are ticked, click **Start using Claude Desk**.

Uninstall it from Windows Settings → Apps like any other app.

## Updates

The app checks this repo's Releases at start-up and every four hours, downloads new versions in the background, and shows **Restart to update** in the status bar. Help → Check for Updates checks straight away. If you ignore the button, the update installs the next time you quit.

To publish a new version: `npm run release`. That bumps the patch version, tags it and pushes, and the GitHub Action in `.github/workflows/release.yml` builds the Windows installer and publishes the release.

## Requirements (running from source)

1. **Claude Code CLI**, installed and signed in. The app's setup screen can do both for you.
2. **Node.js 20 or newer**, only if you run the app from source.

## Run it

```
npm install
npm start
```

## Build an installer

```
npm run dist:win     # Windows installer in dist/ (GitHub Actions builds the released one)
npm run dist:mac     # needs a Mac
```

The build is unsigned, so the first install shows "Windows protected your PC". Click **More info**, then **Run anyway**. Updates after that install without the warning.

## How it works

- `src/session.js` keeps one `claude -p --input-format stream-json --output-format stream-json` process per chat tab, so follow-up messages skip start-up. Modes map to `--permission-mode` (`default`, `plan`, `acceptEdits`, `auto`) and switch live.
- Approvals use Claude Code's stdio permission prompts (`--permission-prompt-tool stdio`): the CLI asks, the app shows a card, and your click goes straight back.
- `src/snapshots.js` takes a git snapshot of the folder (into a temporary index, without touching your staging area or history) before and after each turn. That's what the changes card, diffs and Undo use, so shell-made changes are covered too. Folders that aren't git repositories fall back to copies of files Claude edits.
- `src/updater.js` uses electron-updater against GitHub Releases.
- `src/terminal.js` runs the terminal through node-pty. `src/gitops.js` runs your own git, so it uses your existing credentials.
- Conversations are Claude Code's own transcripts in `~/.claude/projects/`, so the terminal and the app share history.

## Limits

- There's no Cursor-style Tab autocomplete, because Claude Code doesn't offer it.
- In a folder that isn't a git repository, Undo only covers files changed by Edit and Write. The git panel can turn the folder into a repository in one click.
- The app isn't code-signed (that needs a paid certificate).
- In Plan mode, Claude's question cards send your answer back as text.

## Terms

This app runs the unmodified Claude Code binary, which you sign in to yourself, for your own use. That matches what Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) allows. Don't ship it to other people as a product on your subscription: anything you offer to others has to use their own login or API keys.
