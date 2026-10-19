# What's new

Each release's notes, newest first. The release page on GitHub shows the same notes.

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
