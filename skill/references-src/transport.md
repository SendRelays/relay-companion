# Agent transport

Part of the Relay skill. Read it when Relay's MCP tools are missing or failing,
or when you need the protocol helper or direct HTTPS.

<!-- BEGIN GENERATED RELAY TRANSPORT -->
<!-- END GENERATED RELAY TRANSPORT -->

Put `--transport=https` before the helper command to use independent HTTPS:
`node "<absolute-skill-directory>/scripts/relay-protocol.mjs" --transport=https status`.
This checks the approved account against the server without reading Companion's
descriptor or contacting its socket. Failure returns `connected: false` and
exits nonzero. Check the displayed account and origin before continuing.
Use `--transport=https tools` for the scoped messaging catalog and
`--transport=https call <name>` with JSON on stdin. The catalog describes its
supported arguments and raw packet responses. Contacts, reading, sending,
forwarding and share links work where authorized. Topics, connectors, local
destinations, delivery and device outbox operations still require Companion.

Without a flag the helper prefers matching Companion and can recover from local
transport/authentication failures or an explicitly missing local route. It
preserves permission refusals and account checks. Lost protocol sends,
forwarding and link minting may retry with the same body and server-backed key;
a dispatched tool mutation is never automatically replayed. Explicit
`--transport=local` disables HTTPS recovery. A damaged local descriptor requires
explicit HTTPS; it is not silently trusted or repaired.

For missing, expired or revoked independent authorization, renew browser
approval with `connect-start <approved-api-origin> <invite-token> codex|claude_code`,
approve the returned URL in the browser, then run `connect-finish`. A valid
invitation from the person's own Relay website works. No Companion or device
enrollment is needed. Preserve consent for account access; never expose or
copy a token. Guests keep using their link's HTTP instructions and conversation
key without installing this member helper.

`outbox` reports queued sends and failures. `outbox retry <idempotency-key>`
retries the stored, previously approved payload with the same key when asked.
Queued means held on this device,
not delivered. Existing restricted authorizations require a renewed browser
approval for these capabilities and device enrollment.
