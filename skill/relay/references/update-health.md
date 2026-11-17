# Relay update health

Part of the Relay skill.

<!-- BEGIN GENERATED RELAY UPDATE HEALTH -->
## Check and repair local update health

When the human asks to check or repair Relay, or a Relay connection failure needs diagnosis, run the installed Companion's `relay doctor --json` and the active skill helper's `status`. Older releases may support only `relay doctor`; an unsupported flag is not evidence that the installation is absent. Read-only diagnosis is covered by the request. Apply existing update permission; otherwise explain the exact repair before asking. Do not turn an ordinary send or contact request into an unsolicited reinstall.

Check the configured channel, active runtime, running daemon, pill and MCP broker versions/counts, recent daemon response, recovery launcher version/last check/desired version/failures, and every managed skill's version and integrity. A CLI version or successful registration alone does not prove update health. A stale report is historical evidence. Multiple server registrations with the same computer name do not prove concurrent copies; use the durable installation ID and actual processes in this OS user/environment. WSL, SSH and other OS users are separate installations.

For an authorized update, prefer `relay update`. If the current updater cannot run, ask the person to download and run the current Relay app installer from https://sendrelays.com/get-started over the existing installation, then use the installed app's supported repair command. Never install a version copied from an old broadcast, a build tag, an unsigned download, or hand-edited installed code. Preserve account, API origin, encryption keys, preferences, queued sends, existing MCP integrations and other tools' hooks. Supported setup and repair retire only Relay-owned hooks. If repair reports cached hooks pointing into an older runtime, restart the affected agent host to clear them. Do not reconnect a working account or change a dev/staging installation to production. Signed-out installs must remain signed out.

Use the supported installation repair to repoint Relay's services and MCP launchers to one canonical runtime per OS user. Inventory old global shims and service registrations; a shim that forwards correctly is not another running runtime. Stop only verified Relay-owned obsolete processes after active calls finish. Do not kill agent hosts, replay interrupted sends, delete credentials, remove other users' installations, or erase rollback releases to make a version list look clean. Keep the canonical rollback release; use only Relay's managed pruning for unused releases. Preserve modified/unmanaged skills and report them instead of overwriting personal edits.

Verify again after repair: one current daemon and pill, no obsolete broker, responsive daemon, active pointer at the exact channel release, working scheduled recovery with a recent successful check, and current managed skill/helper hashes for each authorized host. Verify the live account through the matching helper without exposing credentials. Refresh the current host's skill discovery using its supported mechanism; files on disk do not prove an already-open session loaded them. If a host must reconnect its MCP session, explain that remaining step. Report any unverified component rather than declaring everything current. Do not send a test Relay without explicit message authorization. Offline discovery, missing telemetry or an unavailable scheduler leaves that part unverified.

<!-- END GENERATED RELAY UPDATE HEALTH -->
