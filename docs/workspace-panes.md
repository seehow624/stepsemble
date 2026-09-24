# Managed workspace and session panes

Implementation branch: `codex/workspace-panes`. This changes source only; the installed Host is not restarted or upgraded.

## Product behavior

- `/` opens the workspace shell. The sidebar reads only the Host's explicit workspace registry. Adding a folder records the project without importing history or launching an agent.
- New Stepsemble conversations join automatically. Older conversations stay under **History from other apps** until explicitly added. Viewing and adding history do not launch, stop, or take control of an external process. Resume remains dependent on the connector's existing capabilities.
- Click a session to open it in the focused pane. Drag from the sidebar to a pane's center to add a tab, or to its four edges to split. Drag a tab to move it. The divider supports pointer dragging and arrow keys.
- Up to eight panes and 32 tabs per window. **New window** in a pane moves its current session to a separate browser window, once the destination has saved and acknowledged its layout. Popup blocking keeps the source intact. Existing windows can accept dragged tabs through the same-origin transfer channel.
- Closing a tab/pane/window detaches its viewer. It does not issue a stop/close command to the Host. Stop remains an explicit action inside the conversation.
- Layouts persist per browser window identity, independently of the Host's session registry. A simultaneous second copy of a window URL receives a new identity when Web Locks are supported. On mobile, one focused pane is shown with **Next pane** for navigation.
- Codex/Claude subscription windows appear in the footer when available. Missing data is `—`, never zero. The detail dialog includes reset times and last confirmation.

## State and runtime boundaries

`~/.config/stepsemble/workspaces.json` stores versioned project paths and stable membership UUIDs with a small allowlist of native identity metadata. It contains no transcripts or credentials. Atomic replacement protects writes; a corrupt file fails closed instead of being overwritten. Removing membership preserves native session files.

The shell owns a binary split tree and placement only. Same-origin conversation frames reuse the established agent renderer and authenticated Host APIs, with frame-specific host/session identities. Loaded frames remain mounted during local tab moves and resizing. Unvisited tabs are mounted lazily; restoring a layout does not launch every hidden tab. The embedded renderer skips global history inventories and never restores an unrelated last-opened conversation.

Pi learns its persistent file identity after launch. Claude records its native identity when observed and retains the same membership after resume; simultaneous resume requests are serialized to avoid duplicate processes. This does not add a daemon or alter the existing Host's process lifetime guarantees.

Cross-window moves use `BroadcastChannel`, a one-use pending transfer token, and destination persistence before acknowledgment. The source remains when destination startup or storage fails. A destination reload reattaches through existing provider APIs; it does not clone a native session. Browsers without BroadcastChannel cannot acknowledge a cross-window move and retain the source view.

Only `/index.html?pane=1` permits same-origin framing. Ordinary pages retain `X-Frame-Options: DENY`; API authentication, origin checks, and browse-root restrictions remain in force.

Quota reads use Codex's native `account/rateLimits/read` through its history connection without allocating a thread. When that connection cannot answer, for example because the installed Codex CLI speaks an app-server schema this release has not reviewed, the same allowance is read from ChatGPT's usage endpoint: first with the account the Codex CLI is signed in to, then with the ChatGPT account signed in under Settings. Claude uses its existing OAuth credential on the Host (credential file, or macOS Keychain when applicable), then the Claude account signed in under Settings, against Anthropic's usage endpoint. OpenCode Go and MiniMax API keys saved under Settings are probed on their own platform's host; a MiniMax China key goes to the China host. The Codex CLI's token is only read and never renewed, and an expired token is never sent. A Settings sign-in close to expiry is renewed through Pi's own locked refresh, as a Pi run would renew it. Saved keys that run a command or refer to an environment variable are left to Pi. Credentials stay on the Host and are never returned to the browser or registry. `STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE=0` disables Keychain reads. Provider errors are isolated; requests coalesce and cache for five minutes on success or one minute on failure. The ChatGPT fallback through both sign-ins and a saved MiniMax key were read live on a signed-in Host; the Claude Settings sign-in path is covered by tests only.

## Validation and preview

Run `npm run preview:workspace` for an isolated loopback Host with disposable synthetic sessions and no provider credentials or executable agents. The script prints its URL and a synthetic local-only login token; Ctrl-C stops its child and removes its temporary fixture. Build/test copies and generated data belong on a local disk, not SMB.

Automated tests cover registry persistence, corrupt-state handling, stable native identity, split/layout bounds and host isolation, authenticated HTTP membership/history operations, unchanged task records, iframe headers, quota normalization/caching, Codex quota transport/pool routing, and concurrent Claude resume. Existing browser suites deliberately visit `/index.html` to continue testing the original conversation controller. Local UI verification uses Codex Computer Use; browser automation suites remain CI-only.

Manual synthetic verification: sidebar-to-right-edge drag; two independent session panes; layout reload; mobile single-pane layout; opening an independent window and removing the source only after acknowledgment; external history remaining outside membership. No real model prompts, installed-service restart, or production deployment were used.

## Release candidate validation (2026-09-21)

Source version: `3.1.0-rc.1`. No installed Host has been upgraded and no public release has been published. Existing active tasks remain untouched.

The workspace uses explicit translation keys in all eleven supported locales. Native names, paths, and output bypass translation. Saved language, light/dark/system appearance and text size apply to the shell; cross-window settings events update already loaded conversation viewers without replacing their frames. Design palette selection remains owned by the established conversation renderer.

Release checks: syntax, client generation, protocol generation, native composer syntax, shell syntax and 1,251 independent protocol conformance cases passed. The final Node test run covers 1,545 tests (1,541 pass, four existing skips). Browser verification uses isolated synthetic fixtures, including settings changes with two panes and restored layout. Live-account quota and live-provider multi-window smoke remain unverified; no model call was made for this candidate.
