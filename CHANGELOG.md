# What's new

Each release's notes, newest first. The release page on GitHub shows the same notes.

## 0.39.1

- **Easier on your battery.** A chat's agent that's been idle for 10 minutes now stops, along with the MCP servers it started. Your next message starts it again on the same conversation, a few seconds slower. A chat that's working, waiting on you, or has something running in the background is left alone. Before, every chat you'd used that day kept its agent running.
- Settings now save in the background, at most once a second. Saving a window's tabs no longer sends every folder's tabs and chats to every other window. With a few windows open, that was a lot of work on every small change.
- Folders that tools rewrite constantly no longer wake Switchdesk up, like build caches and Unreal and Unity's generated folders. The phone page stops checking in while it's in the background.

## 0.39.0

- **Other apps can hand work to Switchdesk.** Claude Desktop, Cursor and other apps with MCP can now pass Switchdesk a coding task. It starts a chat in the folder they name, with the agent and mode they ask for, in its own copy if they like. They can then check on it, send follow-ups, stop it and read the result. Switchdesk opens a window for a folder that isn't open, and starts itself if it isn't running. Handed-over work is an ordinary chat, so you can watch it, answer what it asks and stop it yourself. To set it up, go to Settings → Other apps and press Add to Claude Desktop or Add to Cursor (then restart that app), or copy the entry for any other app. It works on this computer only.

## 0.38.0

- **Stop really stops a long run.** Stop (on the run's page, or "Stop the Long Run" in the command palette) now halts the agent mid-step and sends nothing more. Before, it only stopped the run from moving on, and the agent kept working. Finished milestones stay committed on the run's branch, and unfinished work stays in its copy.
- **Long runs can stop for you.** The plan can now include milestones only you can do, like play-testing or making a call. When the run reaches one, it asks you on a card in the run's chat, on its page and on your phone, and meanwhile carries on with anything that doesn't depend on it. Press Done (with a note if you like) or Skip it. What you say is passed on to the milestones after it.
- **Switchdesk runs each milestone's check itself.** A milestone can have a check command, like `npm test`. Switchdesk runs it before committing, and if it fails, the agent gets the output and fixes it. So "the tests pass" no longer rests on the agent's word. The run's page shows each check's result.
- **Long runs re-plan as they go.** After each milestone, the planner looks at what's left in light of what was learned. It can drop a milestone that's no longer needed or add one that's missing. The run's page lists any plan changes. You can turn this off when starting a run.

## 0.37.2

- **Long runs no longer get stuck sending "Carry on".** When the agent left something running in the background, such as an editor or a server, Switchdesk waited for it to finish before reading the milestone report. It never finished, so the run sat still and kept being told to carry on. Long runs now read the report as soon as the turn ends. A report with a Windows path in it (C:\Users\…), which isn't valid as written, is read too. A run picking up again now uses a report the agent already gave, rather than asking again.

## 0.37.1

- **A plan's to-dos tick off one at a time, as each is really done.** Before, finishing a turn ticked every to-do at once, even ones not started, like later stages waiting for your play-test. Now each to-do follows the agent's own to-do list and ticks only when the agent marks that one finished. The one being worked on shows as in progress. Ticks carry over to later turns in the same chat (say, "start stage 2"). When a turn ends partway, the plan's header says how far it got, like "4 of 11 done", rather than "Built ✓". Agents are now asked to keep their to-do list worded like the plan's, so the two match up.

## 0.37.0

- **A chat that hits its limit carries on when the limit resets.** When an agent runs out partway through and no other agent has room, the chat says when it will carry on, then picks up by itself once the limit resets. That's at the time the agent gives, or its plan window's reset, or every half hour when neither is known. It checks the clock, so it still goes after your computer has slept. Cancel stops it, and sending a message yourself does too. When other agents are ready you still get to pick one, with "wait and carry on at …" beside them. Turn it off in Settings → Usage. Long runs now wait for the reset too, rather than trying every 15 minutes.

## 0.36.0

- **Long runs have a page of their own.** It opens beside your files when the run starts, and 🌙 in the chat header shows how far it's got (like 🌙 3/7) and opens it again. A bar across the top shows every milestone, green when done and red when it didn't work out. The milestone being worked on shows what the agent is doing right now. Each milestone opens to show what it was meant to do, what it did, what its check found and the questions it answered for itself, with its commit and how long it took. When the run ends, a "Worth a look" box at the top lists anything that didn't work out and every assumption it made, next to Review and Merge.
- **A run no longer leaves a tab per step.** Each milestone's chats close once it's settled. They stay in your past chats, and "Open its chat" on the run's page brings one back. The run's chat keeps a small card instead of the long list.

## 0.35.0

- **Long runs, for leaving a big job overnight.** Press 🌙 in the chat header and say what you want done. The agent plans it as milestones, each with a "done when", and the plan opens as a document to edit. Press Build it and each milestone runs in a fresh chat, so the work doesn't get worse as one conversation fills up. A second agent checks each one against its "done when", sends it back for fixes if needed, and Switchdesk commits it on the run's own branch. Questions never stop the run: the agent picks what it would recommend and notes the question. Risky commands on your always-ask list are refused rather than left waiting. At a usage limit the run carries on in another agent, or waits for one to reset, and your computer stays awake while it works (keep the lid open and plugged in). In the morning you get a summary of every milestone, commit, question and assumption, with Review and Merge. Nothing is in your folder until you merge.

## 0.34.7

- **The mode and agent menus stay on screen.** In a narrow chat panel the menus under the composer ran past its right edge and cut off their descriptions. They now slide left and narrow to fit.

## 0.34.6

- **The usage meter in the status bar is right in every window.** Each window kept the plan limits from its own last chat turn, so with several windows open the status bar could show a reading from days ago while Settings → Usage showed the latest. Now every window shows the newest reading from any of them, and a 5-hour or weekly window that has reset since shows as empty until the next report.

## 0.34.5

- **Auto mode is now part of Agent.** The mode menu has Ask, Plan, Agent and Debug. Agent edits files and runs commands, and Settings → Permissions decides what asks you first, so there's one place for that instead of two. Chats that were on Auto carry on in Agent.

## 0.34.4

- **Claude's questions explain their options.** Each option now shows what it means under its name, instead of only on hover, so "Both" says both of what. Questions that take several answers let you pick several, and the card shows what you answered.
- Empty "Thought for a moment" blocks are gone. Those were thinking the model keeps to itself, so there was nothing to open. The empty AskUserQuestion row above a question is gone too.

## 0.34.3

- **Scroll up to read while the agent works.** New messages no longer pull you back to the bottom while you're reading further up. A **↓ Latest** button appears instead, and the chat follows along again once you're back at the end. Sending a message still takes you to the end.

## 0.34.2

- **Skip all permission prompts can now skip everything.** With prompts skipped, commands in "Always ask first" (rm -rf, git push --force and so on) still asked. That's still the default, but a new switch under Skip all turns those off too, and a prompt from one of those rules now offers "Allow, and stop asking about …".
- **Always allow no longer saves lines of code as commands.** A command that wrote a file with a here-document (`cat > file <<'EOF' …`) was read line by line, so Always allow saved things like "import" and "const p", and could save "rm", which would allow any rm without asking. Here-documents are now read as text, and Always allow never saves a rule for rm and other commands that delete or can't be undone. Rules like these already saved are removed when you update.

## 0.34.1

- **A chat started with no folder open now carries on when you open one.** Before, opening a folder cleared it. Now the conversation stays in its tab, and the agent gets everything so far with your next message, so it can pick up the work in that folder.

## 0.34.0

- **Every window on your phone.** Your phone now shows the chats from every Switchdesk window, with a tab for each folder (a dot marks one that needs you). Start a new chat in any of them from the phone.
- **Opening Switchdesk again opens a new window** in the one that's already running, instead of a second copy of the app. All your windows share one phone view, one set of settings and one usage count.
- **Switchdesk on your home screen.** The phone page has Switchdesk's icon and name, opens full screen from the home screen, and shows how to add it until you have.

## 0.33.1

- **Sign your phone in without the camera.** Settings → Phone now shows the address to open and a six-digit code to type on your phone, as well as the QR code. A code works once, for 10 minutes, and stops working after five wrong tries.

## 0.33.0

- **Check in from your phone.** Turn it on in Settings → Phone and scan the QR code. Your phone's browser then shows every chat and what it's doing. You can allow or deny what an agent is waiting on, read its latest messages, send it a message or start a new chat. It's off until you turn it on, and a phone has to scan the code once before it can see anything. Sign out every phone from the same page.
- **From anywhere, with Tailscale.** With Tailscale (free) on your computer and phone, check-in works on mobile data and public Wi-Fi too, encrypted and without opening anything to the internet. Tick Tailscale only so no Wi-Fi network can reach it at all.

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
