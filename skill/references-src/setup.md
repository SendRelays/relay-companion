# Setting up and connecting Relay

Part of the Relay skill. Read it in full when the person wants to set up Relay
or says "Set up Relay with me.", for the first-Relay tutorial, for a pasted
invitation, and when access needs renewing or reconnecting.

<!-- BEGIN GENERATED RELAY ONBOARDING -->
<!-- END GENERATED RELAY ONBOARDING -->

<!-- BEGIN GENERATED RELAY FIRST TUTORIAL -->
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
<!-- END GENERATED RELAY BROWSER APPROVAL -->
