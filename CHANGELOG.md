# What's new

Each release's notes, newest first. The release page on GitHub shows the same notes.

## 0.32.0

- **Babysit a pull request.** Click Babysit it on a pull request and Switchdesk watches it until it's merged. Failing checks, new review comments and merge conflicts go to an agent in the PR's own copy, its fix is pushed for you, and the comments it fixed get a "Fixed in …" reply. It tells you when checks pass, stops after three tries on the same failing check, and stops when the PR is merged or closed.
- **Auto picks the agent for you.** Choose Auto at the top of the agent menu and Switchdesk runs each new chat on the agent or Claude account with the most room left on its plan. When one gets low or runs out mid-task, the chat carries on in the next one with the conversation so far, without you clicking anything.
- **Talk instead of typing.** The mic button next to the paperclip starts your computer's own dictation in the chat box (Win+H on Windows, Dictation on a Mac).

## 0.31.0

- **Carry on when an agent hits its limit.** When Claude, Codex or another agent runs out of usage, the error now offers buttons to carry on in another agent you're signed in to, or another Claude account, with the conversation so far. One click switches the chat and picks up where it stopped.

## 0.30.0

- **Every agent can connect services now.** Ask Codex, Cursor, Copilot, Kimi, Gemini, Qwen or DeepSeek to "connect me to Linear" (or Jira, Notion, Sentry, Asana, Stripe…), and Switchdesk opens the sign-in in your browser, keeps the sign-in safe, and gives that agent the service's tools from your next message. Switchdesk knows the address of well-known services; for others the agent can give it one. Switching agents mid-chat keeps the same connections.
- Settings → MCP servers has a section for these, with Sign in and Remove.
- claude.ai connectors (Gmail, Google Drive, Google Sheets and so on) still only work in Claude chats. If you ask another agent for one, it says so and suggests switching the chat to Claude.

## 0.29.2

- **Connecting a service takes one prompt.** Ask Claude to connect you to something, like Google Sheets. If you have it, Switchdesk signs you in. If you don't, it opens claude.ai's connector page so you can add it, waits, and picks it up as soon as it's there.
- A connector you turn on partway through a chat now works in that chat: it loads its tools with your next message, so you don't need to start a new chat.
- Claude now knows it can connect services itself in Switchdesk, instead of telling you to run /mcp or start a new session.

## 0.29.1

- Asking Claude to connect you to a claude.ai connector (like Atlassian Rovo for Jira) now works. In 0.29.0 Claude was told no servers were set up, because the sign-in ran in a fresh copy of Claude Code that hadn't loaded your connectors. It now signs in through the chat that asked, and falls back to Claude Code's own sign-in if that chat can't see the server either.

## 0.29.0

- **Connect services from the chat.** Ask Claude "connect me to Jira" (or Linear, Notion, a claude.ai connector…) and Switchdesk opens the sign-in page in your browser, then the server's tools are ready in the same chat. Claude adds the server first if it isn't set up yet.
- Settings → MCP servers has a **Sign in** button for servers that need it, lists your claude.ai connectors too, and signs in to a server you've just added straight away.
- Typing `/mcp` opens Settings → MCP servers, instead of saying to use the terminal.

## 0.28.2

- Switching to another chat tab opens it at its latest messages, instead of wherever the last chat was scrolled to.

## 0.28.1

- The chat list shows chats that are open now, so a new chat appears there straight away instead of "No chats in this folder yet".
- The website has a section on the Desk view.

## 0.28.0

- **Desk view, part two.** Files the agent makes or changes are listed beside the chat, with a preview of each (documents as text, images as images), and buttons to open it in its own app or show it in its folder. Permission cards say what the agent wants in plain words, with the command or change tucked underneath. A new chat offers a few starting points, like summarising a document or drafting an email.
- **About** in Settings (and Help → About Switchdesk, or the Switchdesk menu on a Mac): the version, links, and who makes Switchdesk.
- "Always allow" buttons name commands in quotes instead of showing stray backticks.

## 0.27.1

- The Mac downloads are back. 0.27.0 went out without them while Apple's signing service was refusing requests. Everything from 0.27.0 is in this release.

## 0.27.0

- **Desk view.** A Code | Desk switch in the top right. Desk hides the editor and puts the chat in the middle, with your chats down the left, closer to Claude's desktop app. Working in a folder is optional, and anything the agent opens shows beside the chat. Both views share the same chats, so you can switch mid-conversation.
- Connecting GitHub while Switchdesk was still checking the folder could leave the pull requests and issues empty until the next refresh. They now load straight away.
- The buttons under the chat box no longer wrap onto a second line when the chat panel is narrow.

## 0.26.3

- Mac installers are signed with a Developer ID and notarised.

## 0.26.2

- (Build only.)

## 0.26.1

- **Attach any file.** Files Switchdesk can't turn into text, such as certificates, zips, old .doc files or scanned PDFs, now attach anyway. The agent is told where the file is and opens it with its own tools. The paperclip's file picker shows all files by default.

## 0.26.0

- **Report a problem** from the Help menu, or from any error in a chat. It opens a GitHub issue with your version, system and agents already filled in. You read it and send it yourself.
- **Screenshots and a demo** in the README, so you can see what Switchdesk does before you download it.
- **A privacy section** in the README: Switchdesk has no account, no analytics and no telemetry.
- Signing for the Mac and Windows installers is ready to switch on.
- Fixes: the sidebar tabs fit again when Git has changes, the board shows a chat with a background task as running, long board titles end in "…", and the buttons under an agent's changes no longer wrap.

## 0.25.2

- **Chat with no folder open.** Any agent works as a plain AI chat, in a folder of its own, so nothing it writes lands in your files.

## 0.25.1

- A clean-up of the whole interface: checkboxes in dialogs sit next to their labels, Esc closes dialogs, notifications no longer cover the chat box, and small windows keep room for the editor.

## 0.25.0

- **The board**: every chat's work at a glance, and start several issues or tasks at once, each in its own copy of the folder.
- **Always ask first**: commands like `rm -rf` and `git push --force` ask you every time, even when prompts are skipped or the agent is in Auto.
- **✨ commit messages and pull requests** are written by the chat's own agent.
- **SSH folders**: code intelligence, tests, notebooks, the debugger and comparing agents all run on the host.

## 0.24.0

- **Pull request comments in the editor**: read, reply and comment on a line, or hand a comment to an agent to fix.
- **Pull requests from forks**: fixes are pushed to the fork's branch.
- **Linear**: start work on an issue assigned to you, and its pull request says it fixes it.

Earlier releases are on [GitHub](https://github.com/SlaterMarketing/switchdesk/releases).
