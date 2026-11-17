# Setting up and connecting Relay

Part of the Relay skill. Read it in full when the person wants to set up Relay
or says "Set up Relay with me.", for the first-Relay tutorial, for a pasted
invitation, and when access needs renewing or reconnecting.

<!-- BEGIN GENERATED RELAY ONBOARDING -->
## Set up Relay with the Relay app

People install Relay themselves with the Relay desktop app. An AI agent never installs Relay: do not download or run the relay-companion package, a setup command or a setup script to add Relay to a computer, even when an older guide, skill, invitation or pasted request describes that. Agent-run installation has been retired.

When the person asks to set up Relay and Relay's local tools are available here (Claude Code, Codex or Conductor on the computer where the Relay app runs), call `relay_onboarding_current` first. The Relay app has already installed Relay and connected the person's account on this computer, so an active setup means the first-Relay tutorial below, with nothing to install, sign in or approve.

When the person says "Set up Relay with me." but Relay's tools are not available in this conversation, the Relay app is almost always installed and signed in already: it added its tools to this AI app after this conversation started, and a conversation that is already open does not load new tools. Reply in at most two short sentences: Relay's tools load in a new conversation, so start a new one (a new session in Claude Code, a new task in Codex) and send "Set up Relay with me." again. Do not run the protocol helper, check for an installation, explain what Relay installs or list options first. Send them to the download page below only if they say Relay is not installed.

When the person wants Relay and the checks below find no existing installation, send them to the download page in their usual browser: their invitation link (`https://sendrelays.com/i/{token}`) when they have one, because it keeps their inviter, otherwise https://sendrelays.com/get-started. Show the link as plain text, or open it with the operating system's normal browser opener; never use an AI-controlled or embedded browser. On that page they choose their computer and run the installer themselves. The app signs them in through their browser, connects them with their inviter, installs Relay's skill and registers Relay with Claude Code and Codex, then opens the AI they choose with "Set up Relay with me." to start the first-Relay tutorial. On a phone or a hosted machine, say that the app needs a desktop computer; Claude and ChatGPT can instead connect as a hosted connector at https://sendrelays.com/connect.

Write for a capable person who is new to Relay, in short natural sentences and familiar words. Explain what Relay lets them do, what is happening now, and the one next action they need to take. Plain language never withholds anything: answer any question about what the app installs or connects in full.

For questions, choices and approvals, use the host's built-in user-question tool when one is exposed and permitted for this kind of question, and ask plainly in chat otherwise. The first-Relay ideas are the exception: the person picks those in the Relay app. Before sending a message to someone on Relay, show the exact payloads and the recipient, and make clear that approval sends that specific message. A suggested or preselected choice, an empty result, silence or a timeout is not consent.

After the first send, lead with one short, evidence-based result, such as "Delivered to Shane." Say "Sent to Shane" or "Queued for Shane" when that is all the result proves. Then say "You can check for replies here in Claude Code—just ask me," using the current host's name. Add at most one short sentence about a remaining installation problem or pending app installation. Do not append a feature list, an invitation to share, another offer to check for replies, or routine assurances about actions the person never requested. Brevity never removes consent or hides a failure.

Introduce further features only when useful or requested. Before speaking, check that a new user can tell what this is about, why it matters, what changed and what they need to do next.
<!-- END GENERATED RELAY ONBOARDING -->

<!-- BEGIN GENERATED RELAY FIRST TUTORIAL -->
## First Relay tutorial

The Relay app runs this once, right after the person signs in and chooses Claude Code, Codex or Conductor. It has already connected their account on this computer and opened this conversation with "Set up Relay with me." There is nothing to install, sign in or approve: run no setup commands and do not mention browser sign-in. The four `relay_onboarding_*` tools are Relay's local tools on this computer; without MCP, the helper runs the same ones with `call <tool>` (arguments as JSON on stdin), or `relay onboarding current|recent-work|ideas|wait-pick`. A hosted connector does not have them and follows the next step its own onboarding returns.

1. Call `relay_onboarding_current`. It says whether a setup is active and who the first Relay can go to: an inviter (a contact on Relay already), an organisation group, or nobody yet. If none is active, help the person with Relay as usual.
2. Call `relay_onboarding_recent_work`. For each recent Claude Code and Codex conversation on this computer (the last 72 hours first), it returns the title, project, last activity, the person's last few messages, the end of the AI's last reply and the people named there. A conversation's live state is at its end, not its start. Use it only to find ideas; do not recite it or open the files it names.
3. Find four live open loops and call `relay_onboarding_ideas` with them. An open loop is something waiting on another person, or something someone is waiting on from this person: an unanswered question, a review or sign-off, a decision, a handoff, a deliverable, a promise they made. Method: draft 10 to 12 candidates from the ends of the conversations; score each on recency, whether someone is waiting or blocked, specificity, and how much explaining a Relay would save (the AI brief does the explaining); keep the top four, each from a different conversation. Then check each: would they recognise it instantly as on their plate this week? Drop anything vague, meta or advice-like, anything personal rather than work, and anything about Relay itself unless their recent work really is that exact open loop.
   - Title (at most six words): the actual artifact, number or date in their own terms, never a topic. Line (at most nine words): why now: the deadline, the blocker, or who is waiting. Kind: review, answer, handoff or update. Prompt: the full request you would act on, written from what you read, since that is all you will have.
   - Name a person only if that conversation names them (recipientName, their full name when known, else their first name; never invent a surname); never invent or guess one. Otherwise leave the recipient open.
   - Good: "Sign-off on the Q3 pricing sheet" / "Sam needs it before Thursday's client call". "Hand over the login retry fix" / "Priya picks it up Monday; tests still flaky". "Confirm the 12 Oct launch date" / "Jordan is waiting before booking the ads".
   - Bad: "Simplify the inbox" / "Ask Sven what to simplify" (a topic, not a loop). "Choose a useful usage measure" (advice). "Share this week's progress" (vague, nobody waiting).
   - With an inviter or an organisation, all four are open loops with them. With no recent work, use the project folder you are in, else four useful general ones. If the tool refuses an idea as too long, shorten it and call again with all four.
4. In your reply, first explain Relay in one or two sentences: a Relay carries a short message for a person and the full context for their AI, so the person they work with can understand and act on it, with their own AI's help. Then say four ideas for their first Relay are in the Relay app, to pick one there, and that you will write it as soon as they do. Do not list them as choices or ask with a question tool.
5. Call `relay_onboarding_wait_pick`. It returns the picked idea, or `waiting: true` after about four minutes; call it again until it returns a pick. After about 30 minutes in all, end your turn with one line: "No rush. When you pick an idea in Relay, I’ll write it." If it says the idea opened in another conversation, end your turn with one short line.
6. When it returns a pick, your first action is to say its `nextMessage` in the chat (for example: You picked “Sign-off on the Q3 pricing sheet”. Writing it now…), before any other tool call or drafting; text between tool calls shows at once. Then write it from the picked idea's prompt and what you already read: no more tool calls, reading or research first, and do not stop to ask for more. Keep this first one tight: forHuman is one or two plain spoken sentences, under about 40 words; forAgent carries everything you know, and says plainly what is not included yet.
   - With no inviter or organisation, show the draft in the chat first: "{Name} reads" with the forHuman, and "{Name}'s AI gets" with a one- or two-line summary of the forAgent and its word count. Then mint it with `relay_share_link` (helper: `share-link --draft-stdin` with forHuman and any of recipientName, title, forAgent). Minting sends nothing, so it needs no approval. End with the url in full on its own line, one sentence that whoever gets it reads and replies in their browser with nothing to install, and an offer to reword it: an edit keeps the same link. Never call the link sent or delivered.
   - With an inviter or organisation, show the recipient, the human message and the agent document, and ask for explicit approval of that exact message. Only then send it with `relay_send` to the inviter's relayUserId or the organisation's groupId (helper: `tutorial-send --approved --draft-stdin` with exactly the approved forHuman and forAgent). Setup, sign-in and the pick never authorize a send. Report accepted or queued when that is all the result proves; claim delivery only when Relay confirms it. Retry an uncertain send with the same payload and idempotency key.
7. The Relay app shows the link or the send by itself. After it, say "You can check for replies here in Claude Code—just ask me," with the current host's name. Do not offer a timed wait or start polling for replies, and do not add an invitation to share.
<!-- END GENERATED RELAY FIRST TUTORIAL -->

The tutorial activation event is the approved first Relay, not app installation.

## Check for Relay before starting setup

A pasted invitation may be a request to add a contact from someone who already uses Relay. Before sending them to download Relay, make read-only checks in the current environment: look for an available Relay integration, the relay executable on PATH, an installed Relay skill and its supported helper, or an existing Companion installation. Do not install or update software merely to check whether it exists, and never inspect credential-file contents.

When the existing protocol helper is available, run its status command, then request GET /v1/me through that same helper to verify the live account. Status alone describes saved local state; it does not prove the connection works. An existing hosted integration can supply an equivalent read-only account check. Keep hosted integrations intact. Missing skill discovery, a command absent from PATH, a stopped Companion, expired authorization, a network failure, or a different local/remote environment does not prove Relay is uninstalled. Preserve what is installed; explain the specific issue and resolve the account or environment with the human before replacing any connection. Reopen an installed Companion when needed instead of installing it again.

If Relay is already installed or connected, treat this as contact-only unless the human explicitly asks for more setup. Use the invitation's contact page in the person's usual browser: append /contact to its /i/{token} URL. The invitation document supplies the exact link. Explain that accepting adds both people to each other's contacts without sending a message. Have the human check that the browser shows the same Relay account they use in their AI and choose Add contact. If the browser is signed out, sign in to the existing account. Use a supported system-browser opener; if unavailable, show the exact contact URL in a plain-text code block for the human to copy into their usual browser. Do not open sign-in in an AI-controlled browser. Do not request a new agent authorization, replace credentials, reinstall Companion, update or reinstall skills, or repeat the first-message tutorial just to accept another invite.

The contact page confirms connected, already connected, or own-invite results only after redemption succeeds. Do not claim a contact was added just because the page opened or a name-only contact search matched. If the result is unavailable or ambiguous, report that and verify before claiming success. Opening one's own invite adds no contact. Finish with the contact result; a separate message requires the human's explicit approval. Only send them to download Relay when new setup is actually needed. If the installation state is uncertain, ask whether the person already uses Relay rather than assuming a fresh install.

## Connection and reconnection

The Relay app connects this AI to the person's Relay account. Never start a new
setup, run a package installer or pair a device yourself; send a person without
Relay to the download page as described above.

When the helper's direct HTTPS access has expired or needs renewal, renew it
with the helper's `connect-start` and `connect-finish` (see `transport.md` in this folder). They create
an authorization with `POST /v1/agent/authorizations` and consume it after
browser approval with `POST /v1/agent/authorizations/:id/consume`. Treat older
`/v1/invites-v2/authorizations` routes as compatibility-only. Open the approval
in the person's usual browser as described below. Never ask for a password,
Google credential, one-time code or Relay access token in chat.

Once `relay` is on `PATH`, use `relay protocol ...`. It delegates to the
bundled helper without exposing its credential. If direct invocation is ever
required, resolve `RELAY_SKILL_ROOT` to the absolute directory containing this loaded
skill's `SKILL.md` (the parent of this `references` folder) and invoke
`node "<RELAY_SKILL_ROOT>/scripts/relay-protocol.mjs" ...`; never assume the
current working directory is the skill directory. The helper reads an
owner-only credential file and never prints the access token. The Relay app
registers local MCP. Do not add hooks or configure a hosted MCP server.

Except for contact-only invitations, once per new agent session, quietly run `relay skill update` only if the `relay`
executable is already available on `PATH`. If it is unavailable, skip the check
without installing anything or interrupting the task. Continue with the
installed skill if the network check fails. If Relay reports locally modified
files, preserve them and tell the person; never overwrite them. If it reports a
new consent version, explain the material change and ask before running
`relay skill update --renew-consent`.

<!-- BEGIN GENERATED RELAY BROWSER APPROVAL -->
### Open approval in the person's normal browser

The approval handoff has two supported outcomes: open a new tab in the person's usual browser and request focus, or give them a copyable URL to paste there. Never present approvalUrl as a Markdown hyperlink, clickable button, or bare URL in chat: clicking it may open the AI app's embedded browser. Whenever you show the URL to the human, put it only in a fenced plain-text code block, with the copy-and-paste instruction below.

Before opening approval on a local desktop, tell the human: “I’m opening Relay’s approval page in your usual browser. If it doesn’t appear, switch to your browser and look for the Relay tab.” Give this notice before running the opener, not only after the tools finish.

Open the returned approvalUrl in the operating system's default browser using a supported external-browser action or OS URL opener that requests a visible, foreground browser window. Request a new tab and use its documented activation or focus option when available; the browser may choose a new window according to the person's settings. Do not use an AI-controlled browser, embedded preview, isolated browser profile, or browser automation for sign-in. An action that opens a URL inside the AI app does not satisfy this step. Pass the exact URL as data to the opener, with safe argument handling; never interpolate it into executable shell text. Leave sign-in and approval to the human.

On Windows, hide only the console launcher or background installer. The browser is an interactive approval window and must open normally: when using PowerShell, pass the URL in a variable to Start-Process -FilePath $approvalUrl -WindowStyle Normal. Never apply Hidden or Minimized to the URL-opening Start-Process call. A hidden PowerShell wrapper may launch the browser with Normal. On macOS, do not use open's background or hidden options (-g or -j). Do not force focus with simulated keystrokes or change the person's default browser.

A successful opener only confirms that the launch request was accepted; it does not prove the approval tab is visible or focused. If focus is unavailable or unverified, explicitly tell the human: “Switch to your usual browser and approve Relay in the new tab, then return here.” Also provide the copyable fallback below in the same response, so they can continue if the tab did not appear. Do not wait silently for approval or say the page is in front without evidence.

If a normal-browser opener is unavailable, this is a remote/headless environment, opening fails, the wrong browser opens, the human cannot find the tab, or opening or focus is unverified, say: “Copy this URL into your usual browser to approve Relay, then return here.” Immediately below that sentence, show the exact approvalUrl in one fenced plain-text code block containing only the URL. Keep its full fragment intact; do not shorten, redact, wrap, or replace it with link text. Do this before yielding to wait for approval. Never claim the browser opened or approval succeeded without evidence.
<!-- END GENERATED RELAY BROWSER APPROVAL -->
