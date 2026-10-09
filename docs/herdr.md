# Herdr connection

Type `herdr` in a Termai terminal on a local or SSH machine to save and open its
Herdr host automatically. Named sessions support `herdr --session NAME` and
`herdr session attach NAME`. Command capture reads the final Readline buffer, so
history, completion and pasted commands work too. Help, API commands, shell
operators, aliases and functions retain their normal shell behavior.

A plain launch starts an absent headless server, matching normal Herdr startup.
Manual **Connection → Herdr** profiles select a backend and optional session and
connect to an existing server. Closing a view keeps Herdr and its agents running.

SSH discovery reuses the source terminal's authenticated transport to forward
Herdr's Unix socket. OpenSSH must allow Unix socket forwarding. Keep that source
terminal open while using its Herdr view. After a backend restart, reconnect the
source host and run `herdr` again; the saved host is reused.

## Terminal interface and independent layout

Every selected agent opens the same terminal.html / terminal.ts pane as a normal
terminal. Input, dictation, configurable shortcuts, IME focus, touch scrolling,
selection handles, automatic copy, terminal links and the history scrollbar all
use the existing implementations. There is no separate message composer.

The gateway reads `pane.read` with source `recent_unwrapped` and ANSI formatting,
then each viewer wraps that history in its own Ghostty buffer. It reads while
visible, at most once every 150 ms after the preceding response, and sends changed
screens only. Herdr currently limits a read to 1,000 logical lines. Styles remain
intact; fixed terminal grids are represented as text in the local viewport. A
read-only `herdr terminal session observe` stream supplies the application’s live
cursor. Ghostty maps its position through the native and local widths. While
snapshots and live frames disagree during a repaint, the cursor stays hidden
until they agree, avoiding a false cursor at the bottom.

Viewing, fitting, keyboard appearance and scrolling never attach a controller or
resize/scroll the server's PTY. Mobile and desktop therefore have independent
layout, scroll and selection. Typing uses `pane.send_text`; dictation uses
`pane.send_input` to respect the application's paste mode without submitting it.
Input is serialized and validates the current agent before writing. Uncertain
input is never replayed after a disconnect. There is no exclusive writer takeover.

## Tabs, names and notifications

Agent names use the session's actual pane label, with presentation title, agent
name and terminal-title fallbacks. Rename uses the same `pane.rename` action as
Herdr's desktop Rename pane menu. Printable labels can contain spaces and capital
letters (up to 100 characters). Desktop changes propagate through snapshots;
mobile changes update that shared label. Agent API addresses remain independent.
Top-level Termai tab names are local workspace labels.

Hold opens Rename and Close tab. Moving after the hold reorders agent tabs;
moving before the hold scrolls the strip. Keyboard users can use Shift+F10 for
the menu, arrows to select, and Alt+arrows to reorder agents. The strip’s + offers
**Create agent** and a list of existing agents. Creation lets you choose a name,
agent type, space and working directory, opens a fresh Herdr tab and starts the
agent there. Existing terminals remain running. The agent type must be installed
on that host. If startup is rejected, the new terminal remains available in spaces.

Settings → **Herdr strip shows** switches between **Agents** (default) and
**Spaces**. Spaces include ordinary terminals without an agent. Tap a selected
space again to choose one of its terminals. Each mode keeps its own order. Spaces aggregate the attention and work status of their agents;
renaming a space updates Herdr’s shared workspace label.

Order, selected agent and viewed-completion acknowledgements are
saved in browser local storage per backend, source machine and Herdr session.
Closing an agent tab closes its Herdr pane on the server and ends its process.
Closing a space closes that server workspace and its terminals. Rejected closes
keep the tab visible and show Herdr’s error. Closing the top-level Herdr tab disconnects
its notifications. Ordinary shell tabs retain their stop-process confirmation.

Hollow green is idle, orange is working, red is blocked/requesting attention, and
blue is completed but not yet viewed here. Viewed acknowledgements are local;
desktop focus does not clear this browser's unread completions. Servers with
completion_seq report completion directly. Older versions use done status or an
observed working-to-idle transition, so completions entirely during a disconnect
cannot always be detected.

Metadata stays connected while another top-level tab is selected. After a browser
gesture enables audio, the official done/request sounds play while the webapp is
visible and focused, regardless of the selected tab. Initial/repeated snapshots
are quiet, and unfocused notifications are not queued for later playback.

## Backend and API

Default socket: XDG_CONFIG_HOME/herdr/herdr.sock, otherwise
HOME/.config/herdr/herdr.sock. HERDR_SOCKET_PATH overrides the default session's
socket. Named sessions use sessions/NAME/herdr.sock below the same config
directory. Discovery resolves these paths from the source shell's environment.
HERDR_CONFIG_PATH affects configuration, not socket location.

The integration requires session.snapshot, events.subscribe, pane.rename,
pane.read with recent_unwrapped, pane.send_text and pane.send_input. The read-only
history API was verified against the installed Herdr 0.9.3 server. The Herdr CLI
is also required on the target host for the read-only cursor stream. Agent
creation uses `server.agent_manifests`, `tab.create`, `pane.rename` and
`agent.start`; space renaming uses `workspace.rename`. Closing uses `pane.close` or
`workspace.close`, with worktree-group closing disabled.

The gateway accepts fixed actions and checks agent IDs against the selected
server. Backend pairing and origin checks apply. WebSocket tickets are short-lived,
single-use and scoped to the Herdr session, source transport and selected terminal.
SSH sources belong to the paired browser that opened them. Clients cannot provide
arbitrary socket paths or shell commands to this gateway.

## Sounds and validation

Settings → Background notifications offers an Enable button for each backend
when termai is open as an installed PWA over HTTPS. Permission is requested only
on that tap. Focused workspaces play the official Herdr sounds even when another
top-level tab is selected; unfocused devices receive a visible Web Push alert.
The notification requests vibration, while the OS controls sound, vibration,
Focus/Do Not Disturb and notification permission. iOS/iPadOS requires a home-screen
web app and version 16.4 or later. See
https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/.

The backend watches agent transitions independently of browser WebSockets, so
alerts can arrive when the PWA is suspended or closed. Each backend owns a separate
notification worker scope and persistent VAPID key. Pairing digests,
push subscriptions, watch descriptors and status checkpoints live in private
files under TERMAI_DATA_DIR; terminal output and SSH secrets are not stored there.
Rotating the pairing token revokes notification ownership. Local watches resume
after backend restart. SSH watches survive browser closure, but after backend
restart their source host must reconnect. Closing a top-level Herdr connection
stops its alerts; closing just the browser keeps watches active. Enable/disable
applies to this browser/device. Tapping an alert opens the corresponding connection
and agent, including when the app has to start first.

Delivery needs outbound HTTPS to the browser's push service. The server accepts
Apple, Google, Mozilla and Windows push endpoints, with bounded watches, bounded
pending delivery, expired-device cleanup and transient-error retries. An optional
TERMAI_PUSH_CONTACT sets the VAPID contact URI; by default it uses the configured
public backend host. First snapshots and reconnects do not replay old alerts.

Settings → Herdr terminal layout defaults to Reflow text. Full width preserves
the server's native column count for apps with borders, tables or column-dependent
layouts. It adds sideways panning through the shared TerminalGestures code and
keeps the ordinary vertical scrolling, hold-to-copy, selection handles and history
scrollbar. Each viewer still owns its font size, viewport and scroll position;
neither mode attaches a controlling Herdr client or resizes the server PTY.
For Codex, the gateway identifies the agent kind and requests a larger read-only
observer window (512 columns by 256 rows), avoiding the CLI's default 40-row crop
which can hide the real caret. Observer size never changes the PTY's dimensions.
The shaded composer supplies the actual source column count, rather than using
the observer's padded frame width as the app width.

An isolated Codex layout adapter uses Ghostty's decoded glyphs, widths, styles and
hyperlinks to remove desktop paint padding, wrap prose at word boundaries and
join italic Recap continuations with a small hanging indent. The composer stays
shaded at the local width, including multiline drafts and typed trailing spaces.
The status shortens paths and uses ellipsis to stay on one row; independently
right-aligned alerts get their own compact row without desktop spacer gaps.
Every retained glyph maps back to its native cell for cursor placement. Input,
dictation, gestures, selection, copy and shortcut buttons still use the shared
terminal code. Native source rows and code indentation remain available in
Full width, which bypasses the adapter completely.

The adapter requires a recognized shaded Codex composer and a narrower viewer.
Unknown layouts, menus without that composer and other apps keep the ordinary
terminal projection. This is a presentation adapter, not semantic Markdown or a
second app instance: rebuilding arbitrary tables/widgets at each width would
require application-specific structured state or an independently rendered client.
Extremely wide apps require panning, and the read-only history still follows
Herdr's exported recent-unwrapped representation.

src/assets/herdr/done.mp3 and request.mp3 are unchanged copies from
https://github.com/herdrdev/herdr/tree/2563803dca97c040beaf3dc3acdcb5a3221b4238/assets/sounds.
The upstream AGPL-3.0 license is distributed as public/HERDR-SOUNDS-LICENSE.txt;
public/THIRD-PARTY-NOTICES.txt identifies these assets separately from Termai.

Run npm run build, npm test, npm run test:herdr, npm run test:codex-layout, npm run test:workspace and
npm run test:gestures. Herdr tests use a disposable socket server, dictation daemon
and real isolated SSH server, never the user's agents. They cover automatic local
and SSH discovery, raw input, dictation, shared custom shortcuts, independent
mobile/desktop wrapping, touch scrolling/copy, shared labels, menus, ordering,
persistence, server pane/space closing and errors, agent creation, spaces without
agents, desktop-created agents, live
cursor placement, status transitions, foreground sounds, PWA permission and click routing,
full-width panning/copy and borders, server-owned push delivery/restart/expiry/revocation,
asset identity, mounted paths,
authentication and ticket scope. Browser screenshots are written to
.test-artifacts/herdr-mobile.png and .test-artifacts/herdr-desktop.png.
Codex layout checks cover painted padding, prose word wrapping, Recap continuation
rows, Unicode and multiline draft cursors, trailing spaces, styles/links, shared
touch copying/input, desktop independence and the original-width fallback. Their
screenshots are written to output/codex-layout/.
