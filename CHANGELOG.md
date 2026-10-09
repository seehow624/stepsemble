# Changelog

## 3.8.35

- A completed Chinese, Japanese or Korean composition no longer swallows the next Enter. The composer previously blocked Enter for 180 milliseconds after composition ended, including when a candidate was accepted with Space, a number key or a click. It now checks the input method's active state and the key event itself, including WebKit's legacy IME indicator. Confirming a candidate still belongs to the input method; a separate Enter sends immediately. Shift+Enter and touch-keyboard newlines remain unchanged.
- Regression tests exercise both composition event orders and the actual composer listener, checking that the first independent Enter sends the complete text exactly once.

## 3.8.34

- OMP sign-in and model settings now offer **Use OpenCodex**. The selected Host runs OpenCodex’s managed integration command, checks gateway/model-list availability and confirms the resulting configuration. Phone users can reuse providers already configured in that Host’s OpenCodex without opening a localhost sign-in callback. Direct provider sign-in remains available. Configuration conflicts, different OMP profiles, unavailable gateways and uncertain results are reported without forcing an overwrite; existing conversations continue unchanged.

- Goals and Schedules are available from the Workspace sidebar. A Goal shows its objective, elapsed work time, current activity, output count and latest result, with pause, resume, stop and a link to its conversation. A conversation also has a Goal button and a compact progress banner.
- The Host continues a Goal in the same native conversation until the agent reports completion or a blocker, or a time, turn or output budget is reached. Pi, Claude Code, Codex, OpenCode, OMP, Cline, Kilo, Hermes and Grok Build use their normal native execution and approval paths. Closing the browser does not cancel the work. A Host restart marks uncertain work interrupted and requires a deliberate resume.
- Schedules can run once, daily, weekly or at an interval, with a time zone for daily and weekly jobs. Each occurrence opens its own conversation. The UI supports editing, pausing, running now and reading previous results. Missed occurrences coalesce into one run; an already-running occurrence is not duplicated.
- Codex now accepts ordinary newline and tab characters in a prompt, including multiline Goal instructions, while still rejecting terminal control characters.
- Verification covers persisted state, restart, cancellation, limits, DST, authenticated Host routes and background execution through synthetic native peers. An optional smoke check uses the installed official Claude Code and Codex binaries against local model fixtures.

## 3.8.33

- The Host now measures Pi, Claude Code, Codex, OpenCode and ACP runs in the background. Closing every page or opening a conversation halfway through no longer loses its final speed. Reopened pages use the same counts and run clock; old cached pages cannot overwrite Host measurements, and rapid consecutive turns keep separate records.
- Codex, Claude Code and OpenCode use the output tokens reported by the agent when showing a finished run's speed. Codex shows its average so far when a count is available; agents with streamed text continue to show an estimated live pace. Tool execution and approval waits are excluded from tok/s, while tok/min covers the whole run.
- Grok's speed uses its whole-turn usage rather than its last call's context. Kilo reports only the last call, so its turn speed remains marked as an estimate. ACP reasoning tokens are included when the agent counts them separately.
- Each speed stays with the message that started its run, including when another message follows immediately. The work line stays visible while the final count arrives, and its duration agrees with the speed summary. Codex uses its own completed turn times so polling delay does not lower its rate.
- A Workspace conversation that cannot open now explains the error and offers a retry. When sign-in is required, it offers the agent's sign-in instead of remaining on the loading screen.
- Checked on an isolated Host with the real Claude Code and Codex executables against local model fixtures, including tool execution and consecutive turns; covered by output-rate, adapter and conversation tests, protocol checks and rolling browser compatibility.

## 3.8.32

- A model OpenCodex starts serving now reaches Pi's model menu on its own. OpenCodex keeps a block in Pi's `models.json` that lists its models, and rewrites it when it starts, when its settings change and on `ocx sync`, but not on its hourly catalog refresh, so a model it picked up in between stayed out of Pi's menu. When OpenCodex has connected Pi, the Host now compares the models OpenCodex serves on loopback with that block every five minutes and when a model menu opens. If they differ, it runs OpenCodex's own `opencodex integration client enable --client pi`, which rewrites only that block, keeps a snapshot first and refuses a block edited by hand, and the menu is read afresh. A refresh that leaves the lists different is not repeated for the same OpenCodex list; one that fails is tried again after an hour. Stepsemble does not edit the block and does not read OpenCodex's credentials.
- A failed run on an English page was titled "workFailed", and a stopped Pi process "Pi workInterrupted". Reading the Chinese title back to English, the short 失敗 of the activity receipt ("Failed") was replaced before the whole phrase 工作失敗 ("Work failed") could be. Chinese phrases are now read longest first, whether they came from a translation already on the page or from the original wording, so the title stays one phrase. The titles of a failed or stopped run, and why it stopped, now have their own wording in all eleven languages; Simplified Chinese, Japanese and the other languages showed the same broken words before.
- The line that says how long a run has been working now shows, on its right, how fast the model is writing: "≈ 65 tok/s" while text arrives, estimated from the text, and nothing while a tool runs, while the run waits for you, or when nothing new has appeared for a moment. When the run ends the line shows tok/s over the time the model worked (time spent running tools or waiting for you is left out) and tok/min over the whole run, such as "76 tok/s · 2,797 tok/min". Pi and ACP agents that report their output tokens are counted exactly; for the others the count is estimated from the text they showed, about one token per Chinese, Japanese or Korean character and per four other characters, and the numbers start with "≈". Hovering over them gives the token count, the model's time and the run's time. A finished reply with nothing to fold gets the line for its speed. The page that watched a run from its start measures it, and the Host keeps the numbers (`GET` and `POST /api/turn-rates`, no conversation text), so other devices and later visits show them; a run no open page watched has none.
- Checked on the Mac mini: on a test Host with the real Pi, a stand-in OpenCodex serving one model more than Pi's block and a stand-in `opencodex` command, the first model list showed one model, the Host ran the command once, and the next list showed both; later reads ran nothing. Against the real OpenCodex 2.80.0 and Pi's real `models.json`, the lists matched and no command ran, and the command itself answered "already applied" without changing the file. The title test reads 工作失敗 as Work failed in English and as its own words in Simplified Chinese, Japanese, Korean and German, and moves a title already shown in Japanese or German to another language intact. A Pi run on a test Host, against a stand-in model that wrote at a fixed pace, asked for a three-second command and reported 360 output tokens, showed about 65 tok/s while the second answer streamed and nothing while the command ran, then 76 tok/s · 2,797 tok/min: 360 tokens over the model's 4.7 seconds and the run's 7.7 seconds. A second browser, in English, read the same numbers from the Host. The conversation check now waits for the fake ACP agent's finished reply to show an estimated speed on a plain line.

## 3.8.31

- Codex 0.161.0 is supported. Its only change that touches Stepsemble's release check is how the schema lists Codex's error kinds: with `anyOf` instead of `oneOf`, and with a member for error kinds still to come. Stepsemble does not read the error kind. The check had refused the release, because it only lined up two unions written with the same keyword. It now takes them as the same union and compares their members as before; written the other way round, a union Stepsemble sends to Codex is still refused, since it may then accept fewer values. Codex 0.161.0 also gives the goal methods an optional origin, which Stepsemble does not use. A Mac with Codex's automatic upgrade on installs 0.161.0 once it runs this Stepsemble; a release refused by an earlier version of the check is checked again.
- Checked against the official 0.161.0: the four live checks (sending, several conversations at once, approval, branching) passed with a local model. Run on the published contracts of every stable Codex from 0.151.0 to 0.161.0, each against the one before, the check still refuses only 0.156.0, for the same reason as before, and accepts the other 21. A test covers the rewritten union in both directions and a member lost on the way.

## 3.8.30

- Oh My Pi (omp) is a new agent in the Workspace. When `omp` is installed on a Host (`bun install -g @oh-my-pi/pi-coding-agent` puts it in `~/.bun/bin`), New session lists Oh My Pi and talks to it through its own ACP server, `omp acp`, as it does with Cline, Kilo Code and Hermes: streamed replies, stopping a reply, its approval questions, its Default and Plan modes, its thinking setting, and the models it offers once it is signed in. Its conversations open again after the Host restarts, and branching a conversation uses omp's own fork. It has a mark of its own, a π with a spark, in the list and on tabs.
- omp opens a conversation even before it is signed in to a model provider, then refuses every message with only "Internal error". Stepsemble now treats a new omp conversation without any model to choose as not signed in: it closes that empty conversation and New session offers Sign in, which runs `omp login` in the same dialog, where the provider is chosen from omp's own list. An ACP reply of "Internal error" now shows the reason the agent put in its details, such as "No model selected. Use /login …", in place of the bare words. `STEPSEMBLE_OMP_ACP=0` turns the ACP bridge off, as for the other ACP agents.
- Settings → Harness updates checks and updates Oh My Pi with `omp update --check` and `omp update`, and reads its version from `omp/18.6.1`, a form the version reader did not accept before. Models & providers lists Oh My Pi with the models its last conversation offered.
- An agent installed as a script that names its runtime on the first line, as omp names Bun, starts even when the Host's PATH does not include that runtime: the agent's own folder, where Bun and npm keep the runtime beside it, is added at the end of PATH for its ACP server, its sign-in terminal and its update commands. Programs the PATH already finds are found as before.
- Checked on the Mac mini with omp 18.6.1 against a test Host whose PATH held only /usr/bin and /bin and whose home had omp in .bun/bin: Oh My Pi was listed as installed and its ACP server started; New session for it said Oh My Pi is not signed in on OneStep-MacMini and offered Sign in, which opened `omp login` with its list of 80 providers; no empty conversation was left behind. A real conversation was not tried, because omp on the Mac mini is not signed in yet. Tests cover the new conversation without a model, the reason taken from an Internal error, omp's update check and version, its sign-in command, and the PATH addition.

## 3.8.29

- The list's top row in Stepsemble.app holds the window's red, yellow and green buttons, then the Stepsemble logo and name, sized to sit beside them, and Refresh and Settings as small toolbar buttons on the right. The Host is now one card, in the app and in the browser: the computer's name, a dot and a line that say whether it answers (Connecting…, Connected or Host is unavailable, in the eleven languages), and the up-down arrows of a menu. Clicking it, or reaching it with the keyboard, opens the system's list of Hosts. In the browser the name and logo stay at the top beside Refresh and Settings, lined up with the card's icon and edge. The window, its buttons and its dialogs follow the light or dark theme chosen in Stepsemble, and Follow system follows macOS.
- When the Host soak test fails, it now names the step it was in (copying the source, starting the Host, signing in, opening tasks, the cycles or restarting the Host) and the kind of error: an HTTP status, or a file or connection error code. On the Windows CI machine it failed once for this release with only fixture_operation_failed and passed when run again; the next such failure will say where.
- The browser check that holds a streaming Pi reply's frames, to scroll up while one waits, could wait forever: a piece of the reply that arrived just after the hold asked for a frame that was then held, and the check waited for no frame at all. It failed that way twice on the macOS CI machine for this release. That held frame is the waiting one the check needs, so it now goes on with it; the check still fails if the list is pulled back to the end.
- Checked on the Mac mini with the app built as a release builds it, against a test Host: the Host card opened the system menu of Hosts and described the Host to VoiceOver as a Host menu with its connection; Refresh and Settings worked from the top row, and double-clicking the name zoomed the window; choosing Light in Settings turned the window light. In Chromium at desktop and phone sizes, the Host card, the search and its buttons share one left and right edge, and the card said Connected in Traditional Chinese. The browser check for the app's window still finds every control clear of the window's buttons and of the strip that moves the window.

## 3.8.28

- Stepsemble.app's window has no title bar, as Chrome's and Brave's have none. The bar that said "Stepsemble · Workspace" is gone: the Workspace reaches the top of the window, the window's red, yellow and green buttons sit beside the Stepsemble name at the top of the list, and each pane's tab strip lines up with them. With the list hidden, the buttons sit at the start of the top-left pane's strip, before the list toggle. The empty parts of that top edge (beside the name, after the tabs, above the panes) move the window, and double-clicking them zooms or minimizes it, as chosen in System Settings. The panes keep an even 8-pixel margin, and Settings start just below the buttons. In full screen the Workspace uses its own top, as in a browser. macOS no longer gathers these windows into its own window tabs, which would cover the Workspace's; ⌘N still opens a new window. A page other than the Workspace, such as the sign-in page, keeps the title bar, and the browser is unchanged.
- The app opens the Workspace page itself rather than the start page that forwarded to it, so the window does not switch from a title bar to none as it opens. Started with STEPSEMBLE_PORT and STEPSEMBLE_TOKEN_FILE, as a test Host gives them, the app opens that Host.
- Checked on the Mac mini with the app built as a release builds it, under a separate bundle identifier, against a test Host: the buttons sat in line with the name and the tab strips; Refresh, Settings, the list toggle, New window and the tabs where the title bar was answered clicks; double-clicking the empty strip, or the name, zoomed the window and double-clicking again restored it; the list hidden, Settings, a window opened from New window, full screen and back, 175% zoom (the narrow layout, where a conversation starts below the buttons) and the sign-in page with its title bar all showed correctly, and going between the sign-in page and the Workspace kept the window's size. Dragging the window could not be tried there: the automation tool cannot drag a standard title bar either, and the app moves the window with the same AppKit call a title bar uses. The browser check that runs on every release now gives the Workspace the app's button positions at phone and desktop sizes, and fails if a button, tab or conversation sits under the window's buttons or in the strip that moves the window; with the list toggle left under the buttons, it fails.

## 3.8.27

- Stepsemble.app is the Workspace on a Mac. Opening it shows the Workspace of the Host on that Mac, signed in with that Mac's Web token without typing it, in its own window with the usual Mac menus: copy and paste, undo, reload, zoom, New Window (⌘N) and Close Window (⌘W). A new window a page opens, such as the Workspace's own New window, opens as another app window with the same sign-in; links to other sites open in the default browser; downloads go to Downloads; confirmations and file pickers are Mac dialogs. Closing the last window keeps the app in the Dock, and the Host keeps running either way. When the Host is not running, the window says so and connects as soon as it answers. The folder permission window moved to Stepsemble → Folder Access…; it opens by itself the first time, and Open Stepsemble from a refused folder in Add project now shows it even when the app is already open. Phones and other computers keep using the browser.
- A Mac whose Host starts over SSH, like the Mac mini, gets the app as its window: the installer and the updater sign it and keep it current, and the launcher stays as it is, without a restart for the app.
- Two Host tests that start real servers failed on the Windows CI machine when they ran next to other Host tests. Their single requests now wait up to 15 seconds and the soak waits up to 30 seconds for a Host to start; the soak also says which step failed (request_timeout, host_start_timeout, host_exited_before_start) instead of fixture_operation_failed.
- Checked on the Mac mini with the app built and signed as a release installs it: it opened signed in to the Mac mini; ⌘A, ⌘X and ⌘V cut and pasted in the session search; the Workspace's New window and ⌘N opened signed-in windows; a conversation opened in a pane; its link to the Codex documentation opened in the default browser while the pane stayed; Restore interface defaults showed a Mac confirmation and Cancel changed nothing; closing every window kept the app open, and opening it again brought the Workspace back with its pane. Showing Folder Access from Add project on a Host the app starts was not tried before publishing; it is checked on the MacBook Pro after the update.

## 3.8.26

- On a Mac, Stepsemble now starts through its own app, so macOS asks whether Stepsemble may use Documents, Desktop, Downloads, iCloud Drive and other drives, and keeps the answer through updates. macOS recorded that permission for the Node.js that ran the Host: on the MacBook Pro, Add project showed "EPERM: operation not permitted" for Documents, and each new Node.js needed the permission again. The installer now signs Stepsemble.app on each Mac with a certificate it makes there and keeps, installs it in `~/Applications`, and the Host's LaunchAgent starts the Host through it; agents the Host starts are covered too. The app opens when the installer finishes and lists the places macOS protects (Time Machine backup disks are left out); Allow access asks macOS about each, and Full Disk Access… opens that setting with the app selected in Finder, for a place turned down before. On a Host the app started, Add project offers Open Stepsemble on that Mac rather than Full Disk Access for Node.js. The window, and the questions macOS asks, are in the eleven languages of the Workspace.
- A Mac updated from an earlier version moves to the app by itself. After the update, the next update check that finds no agent working signs the app, points the LaunchAgent at it and restarts the Host. If the Host does not come back healthy, the LaunchAgent and the app are put back, and that release does not try again. Later updates sign each new app with the same certificate, so the permissions stay. A Host started over SSH, like the Mac mini's, keeps its launcher. The uninstaller moves the app and its certificate to the Trash and clears the permissions macOS kept for it.
- Checked on the Mac mini with the app built and signed the way a release builds and installs it, in a separate folder: launchd started the app, the app started Node.js, and reading Documents, Desktop, Downloads, iCloud Drive and an external drive brought up five questions titled Stepsemble. After Allow, macOS recorded all five for com.stepsemble.app, and a program Node.js started, as an agent would, read Documents without a question. After the app was rebuilt with another version and signed again, the same reads took milliseconds and asked nothing. Stopping the Host sends Node.js one SIGTERM, so running Pi work still finishes, and processes it leaves behind end with the launchd job. Tests run the updater's own steps for a move, a move that fails, waiting for agent work, the SSH launcher and a missing app; CI builds the app for Apple silicon and Intel and signs it. The browser check opens a folder refused on an app-started Host and opens the app. This release was not installed on the MacBook Pro before it was published.

## 3.8.25

- Add project explains a folder the system will not open, and the Host no longer stops while a Mac asks about one. On a Mac, Documents, Desktop, Downloads, iCloud Drive and external drives need macOS permission for the Node.js that runs Stepsemble; without it the dialog showed only "EPERM: operation not permitted, scandir". It now says that macOS refused the folder, shows that Node.js, and offers to open Privacy & Security → Full Disk Access on that Mac, with the Node.js selected in Finder, ready to drag into the list. A folder the account may simply not read says so. The Host used to read a folder in a way that held every conversation until the macOS dialog was answered on the Mac; it now waits up to eight seconds, says the Mac may be asking, and Try again receives the answer of the same read.
- On Linux and Windows, Add project reaches other drives. It offered only the home folder there. An installed Linux Host also browses `/media`, `/mnt` and `/run/media/<user>`. An installed Windows Host browses every drive (`*:\` in `STEPSEMBLE_BROWSE_ROOTS`), including one connected later, and going up from a drive lists the drives. A `STEPSEMBLE_BROWSE_ROOTS` already set still decides, and a Host started by hand still browses only the home folder. Two Windows faults are fixed with it: a whole drive allowed as a root showed the list of allowed folders instead of its own folders, and the folders on it were refused.
- On Linux, Stepsemble keeps running after you log out, so a phone can still reach it. The installer turns on systemd linger for the user once. `--no-linger` leaves it off and is remembered, and a linger turned off later by hand stays off. If linger cannot be turned on, the installer prints the command to run and still finishes.
- On Windows, when Controlled folder access is on, the installer says how to allow Node.js; until then agents cannot change files in Documents, Desktop and other protected folders. Making a new folder in such a place from Add project now says the same.
- Scrolling up while a reply streams stays where you scrolled. Each piece of a reply asked for the list to follow it on the next frame, and a scroll that came while such a frame was waiting was taken for the reply growing, so the list was pulled back to the end; with a fast reply this could keep happening. Moving up right after your own wheel, touch, key or scroll-bar drag now ends the following and drops the waiting frame. At the end of the list a reply is still followed, and opening a conversation still starts at its end.
- Checked on the Mac mini. Host tests cover a folder refused by permission, a folder that cannot be written, an allowed filesystem root, a drive that does not answer, and a read that waits: shared by a second request, timed out for the browser, answered later. Full Disk Access opened on the Mac mini from a signed-in request, and a cross-site request was refused. The browser check that runs on every release now opens a folder macOS refuses at three sizes, opens Full Disk Access, tries again, and opens a folder that does not answer. The Linux linger step was run with a stand-in loginctl in ten situations. The browser check now also holds the frame that follows a streaming Pi reply, scrolls up (with the wheel, or touch on a phone) and checks that the list stays; it fails with the previous app.js. The Windows drive test passed on Windows Server 2025 in CI; this release was not tried on a real Linux or Windows computer.

## 3.8.24

- New Pi conversations open. Pi writes a conversation's file with its first message, and Stepsemble kept the file Pi said it would write. Opening the conversation in a tab before that, on a phone or after coming back to it, asked for a file that was not there yet and failed with "Could not open the conversation: invalid session path". A tab now joins the Pi that is running, and opening the file once it is written joins the same Pi rather than starting a second one on it. A conversation whose Pi ended before its first message, as an update ends them, starts Pi again in the same folder and the same tab; one archived since is left to be brought back.
- Claude Code starts in every folder a project can be chosen from. Its helper on the Mac gets the folders it may work in when it is installed; the MacBook Pro's had only the home folder, so a project on /Volumes, such as StepFlow, was refused with "desktop_workspace_denied" while every other agent ran there. After an update, when no Claude conversation is running, the helper is given the folders this Host lets a project be chosen from. It restarts in a few seconds; its sign-in and key stay as they are. A conversation refused for such a folder now says so in words and brings that update forward instead of waiting for the next start.
- Checked with the synthetic Pi on a test Host: a new conversation opened in a tab before and after its file exists joins the running Pi, one whose Pi ended starts again in the same tab and Workspace entry, and an archived one is not replaced. With the change removed, the ended conversation fails again. The helper installer, run on test folders, adds a folder the helper does not hold, skips one it holds or one that is gone, keeps the key, and brings back the old folders when the new helper fails its check.

## 3.8.23

- Typing in the message box no longer moves the conversation above it. To find how tall the box should be, Stepsemble collapsed it for an instant with each change; at the end of a conversation the list followed, so every new line in the box pushed the conversation up by a line, most visibly on a phone. The conversation now stays where it is while the box grows or shrinks.
- On an iPhone, the latest message is brought back into view when the keyboard comes up or goes down, and no longer each time iOS nudges the page while text is typed.
- Checked in Chromium and WebKit at phone and desktop sizes, at the end of a long reply just received, typing five lines (60 keystrokes): the latest reply did not move. With the previous version, at phone size in Chromium, it moved up by one line with each new line, 72 pixels in all. The browser check that runs on every release now types four lines in that position and fails on the previous version; it also sends the viewport events iOS sends while typing and checks that the conversation stays put.

## 3.8.22

- Workspace tabs are all one width, however long their titles, and each starts with its agent's logo. When many are open they narrow together before the strip scrolls. A tab opened before this version gets its logo once the session list names its agent.
- On a desktop a conversation no longer has a title row. The tab already names it and shows its agent, and the path is in the session list, so the name, path and timer are gone from the top of the conversation, which now starts at the top of its pane. Changes and More float over the pane's top-right corner. A phone shows no tabs and keeps the title row, with Back.
- Subscription limits are current. The Host kept a reading for five minutes, the Workspace asked for one every five minutes, and Refresh got the same kept reading, so a number could be close to ten minutes old. Refresh, in the sidebar or next to the time in the limits panel, now has the Host read the providers again; a reading taken in the last 15 seconds still answers, so repeated clicks or several devices do not reach the providers again. The Workspace asks every two minutes, the Host keeps a reading two minutes, and coming back to the Workspace after a minute away reads them again. Refresh in Settings → Quota sources reads them again too.
- Checked on a synthetic Host at 1440 and 390 pixels: two tabs 188 pixels wide with the Codex and Claude Code logos; on a desktop the conversation shows no name, path or timer and starts at the top, with Changes and More at the top right; on a phone the title row and Back remain. The browser check that runs on every release now opens Pi, Claude Code and an ACP agent as tabs, checks their one width and logos, the missing title row on a desktop and the kept one on a phone, and that Refresh asks for a new reading. Tests cover a reading kept two minutes, Refresh within and after 15 seconds, and a tab keeping its agent.

## 3.8.21

- The first-run pages of Google Antigravity show in full in the sign-in terminal, with their buttons. Stepsemble told sign-in programs the terminal had 24 rows, and a full-screen program draws only that many: Antigravity's Terms of Service page stopped at its consent checkbox, and the Previous and Done buttons below it, with the hint for moving to them, were cut off. Enter on the checkbox only switches it, so the sign-in could not go on. The terminal now has 40 rows. The screen scrolls, and blank rows below a page are not shown, now also when a program parks its hidden cursor on the last row.
- Checked with the real Antigravity CLI 1.2.14 on the Mac mini at phone width (49 columns), without accepting anything: at 24 rows its Terms page shows 23 lines with no Done button and no hint; at 40 rows it shows all 33 lines, down to Previous, Done and "↑/↓ Navigate · enter Toggle". A sign-in already on that page can finish with ↓, then →, then Enter.

## 3.8.20

- Signing in to Google Antigravity from a conversation opens the whole Google sign-in page again. The sign-in sheet put a shortened copy of the link first, cut where Antigravity's own screen breaks the line, and Google refused it with "Required parameter is missing: response_type". Links are now read from the screen as Antigravity draws it, and a shortened copy of a link Antigravity also sent in full is left out. After signing in on a phone, paste the code the page shows into the sheet and press Enter; Antigravity finishes the sign-in on the Host.
- Codex upgrades itself again on a Mac where OpenCodex wraps Codex. OpenCodex replaces the `codex` command with a small script and keeps the launcher it replaced beside it as `codex.opencodex-real`. Stepsemble could not tell where that script came from, so on the Mac mini it stopped upgrading Codex after 0.159.0 and showed no newer version. It now follows such a script to the launcher it keeps and upgrades Codex when that launcher is the official install. OpenCodex wraps the new Codex again, as it does after any Codex update. A wrapped Codex that belongs to the ChatGPT app, as on the MacBook Pro, is still left alone.
- The documentation, the change log and the German translation use the name Stepsemble throughout; the German text still said Pi Harbor in a few places.
- Checked by replaying the real sign-in screen of the Antigravity CLI 1.2.14 from the Mac mini: the sheet offers only the full Google address, with its response type, redirect and state, where the old sheet also offered the shortened one. A read-only check against the Mac mini's real OpenCodex wrapper now reports the official install, with 0.159.0 installed and 0.159.2 available; before, it reported an unknown source. Tests cover a wrapped Codex being upgraded through the launcher OpenCodex keeps, and a wrapper that points elsewhere or to an app's Codex being refused.

## 3.8.19

- Every provider in Settings → Agents & models → Pi Agent now has a switch that takes it out of the model menu, including those Pi lists because you signed in to them there, such as minimax or openai-codex. Before, only providers you added yourself could be removed, and the others could only be hidden one model at a time. A provider switched off stays out with any model it adds later, and switching it on again brings back your choices for its models. Its sign-in is untouched.
- What is hidden from the model menu is now kept on the Host, so every device that uses it shows the same menu. It was kept in each browser, so a model hidden on the computer still showed on the phone. The first time each browser opens this version, what it had hidden moves to the Host. A Host older than this version still keeps the list in each browser.
- A provider Pi lists because of a sign-in says so when you open it, with how to remove it: type /logout followed by its name in a conversation with Pi. One whose key comes from an environment variable names that variable instead, since /logout cannot remove it.
- The button that checks the model catalogs for updates used the same download icon as Import; it now uses the Updates icon. On a phone a provider's name is no longer cut short.
- Checked with the real Pi 0.87.1 and test sign-ins, with no model calls. minimax (API key), openai-codex (account) and deepseek (environment variable) each showed the right note. Switching off minimax on one device hid it on a second device with separate browser storage, and switching it back on there showed it again on the Host. A list saved in the browser moved to the Host and was cleared from the browser. The browser check that runs on every release switches a provider off and on at phone and desktop sizes.

## 3.8.18

- Settings now open in the same window. They used to open a second window, and closing them loaded a second Workspace there. The gear, and "Quota sources" in the limits panel, now open Settings over the Workspace. Back at the top level, Escape or the edge swipe closes them, and the open conversations are as they were, without reloading. Signing out, an update or a restart from Settings reloads the whole window.
- When the Host cannot be reached, a conversation pane or Settings gets the saved copy of the page. The saved copy's headers had forbidden showing it inside the Workspace, so the pane showed a browser error instead.
- Checked in Chromium and WebKit at phone and desktop sizes. The gear opened no second window, Settings filled the Workspace, Back and Escape closed them, and the conversation pane behind was not reloaded. This now runs on every release.

## 3.8.17

- In a Claude Code conversation, "Working for" and the timer at the top now count from the message you just sent. Before, they counted from when the conversation was opened in Stepsemble. A message sent an hour after opening the conversation showed "Working for 1h 2m" the moment it was sent. Stepsemble had taken the time Claude's process started as the start of the reply. Claude now reports when each reply starts and ends. A message sent while the agent is already working still joins the reply in progress, as in Codex. The same rule protects every agent: after a message sent while the agent is idle, any start time from before the send is ignored.
- Checked in Chromium at phone and desktop sizes. A Claude conversation left open for 6 seconds before the message showed "Working for 2s" and 2s at the top, and afterwards a total no longer than the time actually taken. With the old page, the same check failed with 8s at the top against "Working for 2s". This check now runs on every release.
- Codex 0.159.0 is supported. Its only change that touches Stepsemble is the cursor for reading a conversation's items in pages: it now also takes a position within a turn. The string cursor Stepsemble sends is still accepted. Stepsemble's release check had refused it, because the same values are written another way in the schema. The check now compares such a rewrite shape by shape. Run on every stable Codex from 0.151.0 to 0.159.0, it still refuses 0.156.0, for the same reason as before, and accepts the rest. The four live checks (sending, several conversations at once, approval, branching) passed against the official 0.159.0. A Mac with Codex's automatic upgrade on installs 0.159.0 once it runs this Stepsemble. A release refused by an earlier version of the check is checked again.
- The Updates page now shows Grok Build, Kilo and Cline. They were listed as managed by an editor, but they are command-line programs. Grok Build is checked with its own `grok update --check --json` and updated with `grok update`. Kilo and Cline are checked against npm and updated where they are installed: with Homebrew, globally with npm, or in an npm folder of their own, as on the Mac mini. Their own updaters could install a second copy elsewhere and leave the one in use as it was. On the Mac mini this shows Grok Build 1.0.41 → 1.0.44 and Kilo 7.7.9 → 7.8.1 available, and Cline 3.0.65 up to date.
- Hermes shows its version again (0.21.5): Stepsemble read only one-word names before the version, and Hermes prints "Hermes Agent v0.21.5". Its update check fetches from git and sometimes took more than the 20 seconds allowed, so it showed a timeout; it now has 55 seconds.

## 3.8.16

- The Updates page now shows OpenCode's newest version on the MacBook Pro as well. OpenCode there is 1.18.31, newer than Homebrew's own formula (1.18.30), so it most likely came from OpenCode's Homebrew tap (`anomalyco/tap`). After 3.8.15 it still showed "unknown". Homebrew reports the newest version as `current_version`, exits with code 1 when a package has a newer version, and gives a tap formula's full name. Stepsemble read `latest_version`, treated exit code 1 as a failure, and looked only for the short name. It now reads Homebrew's answer in that form for OpenCode. The same fix covers Codex installed through Homebrew, whose Update row never showed the version it would update to. When a check really fails, the reason is kept instead of being dropped.
- Checked against Homebrew on the Mac mini. OpenCode from Homebrew's own formulas reads up to date at 1.18.30. The same package named through `anomalyco/tap` reads 1.18.33 available: Homebrew exits with code 1 and lists the full name, as it does for a copy installed from the tap.

## 3.8.15

- A message sent before a conversation has finished opening is sent as soon as it has. Send did nothing at that moment, with no word, and the message just stayed in the box. Now Stepsemble says it is connecting and sends the message once the conversation is ready; after 30 seconds without a connection it says so, and the message is still in the box. The same applies while Claude Code or Codex are still loading a conversation.
- The run timer at the top counts from the moment a message is sent, like the "Working for" line under the message. It showed 0s until the agent reported its run, which for Claude Code and Codex can take a few seconds. A message that is not sent puts back the time shown before.
- Claude Code releases are now checked as Codex releases are. `npm run -s check:claude-release` downloads the newest Claude Code and runs the real program against what Stepsemble relies on: the model and effort it sends, the usage it reports, a picture, a command running past 30 seconds, Stop and going on, resuming a closed conversation, branching one, and reading its transcript back. It uses a local model and no account, and keeps the result so each release is checked once. Claude Code 2.1.284, published today, passed all eight checks, as did 2.1.283.
- Grok Build and Pi releases are checked the same way. `npm run -s check:grok-release` downloads the newest Grok Build from xAI and checks the model and thinking level it sends, its usage, a picture, Stop and going on, the permission it asks before a command that writes a file, and reopening a conversation. `npm run -s check:pi-release` installs the newest Pi from npm, starts it as Stepsemble does, and checks Stepsemble's own Pi extension, the model and thinking level, usage, a picture, Stop and going on, a command, resuming a conversation from its file and branching one. Both use a local model and no account. Grok Build 1.0.44 passed all six checks and Pi 0.87.1 all eight; both are the newest releases today. The daily check now runs them too, and reports a release that fails without changing Stepsemble for it.
- Grok's usage showed cache writes as input with a model that is not xAI's own, such as a Claude model through OpenCodex. A reply with 2 new input tokens and 100 written to the cache read Input 102 and Cache write 0. Grok reports cache writes only in the total for the whole turn. When the turn made one model call, that total is the call's own, and Stepsemble now reads the figure from there. When a turn makes several calls, Grok does not report the last call's cache writes, so they are still counted in Input.
- The Updates page shows OpenCode's newest version again. A copy installed by Homebrew that was already up to date showed no newest version. A copy installed another way, as on the MacBook Pro, showed "unknown"; it is now compared with the newest `opencode-ai` on npm.
- A newer Codex that has waited two days for a Stepsemble that supports it is reported once, to the devices that turned on notifications: the daily review that adapts Stepsemble may not be running.
- Where a branch of a Claude Code conversation ends is now worked out by one module, shared by the Host and the release check.
- Checked in Chromium at 390 and 1280 pixels: the run timer and "Working for" read the same seconds for Pi, Claude Code and an ACP agent while the send was held back. With a conversation not connected for 2.5 seconds, Send said it was connecting and the message went once when it connected; not connected for 36 seconds, it said so after 30 and the message stayed in the box.
- The rolling browser check that runs on every release now covers these at phone and desktop sizes, in Chromium and WebKit. It checks that a message sent before connecting goes once the conversation connects, that the jump-to-latest button sits in the middle and shows "•••" while the agent works, and that "Working for" and "Thinking" appear at once for Pi, Claude Code and an ACP agent, on the same second as the header timer. It also checks that a picture shows as a thumbnail above the text and that a wide table scrolls sideways.

## 3.8.14

- A message shows at once that the agent is working on it: "Working for 3s" and "Thinking" appear right below it, as in Codex, and the time counts up until the reply begins. Before, nothing showed until the agent's first output, which for Claude Code or a Codex that has to start first could take several seconds. The time runs from the moment the message was sent. A message sent while the agent is still busy waits its turn and gets no second "Working" line.
- The control that jumps to the latest message sits in the middle above the message box, as in Codex: a round button with a down arrow that shows "•••" while the agent is working. It was a "Latest" pill at the right. A tap while the agent is still writing now follows the reply to its end; before, the reply grew during the scroll and the view could stop short of it. Checked in Chromium and WebKit at 390 and 1280 pixels with a long Pi reply: 40 pixels and centred, "•••" while writing and the arrow after, and a tap reached the bottom in both states.
- Codex can keep itself up to date on each device: turn on "Upgrade automatically" on the Codex row of the Updates page. About once an hour, and two minutes after Stepsemble starts, the device checks for a newer Codex and installs it only when this Stepsemble supports that release and no agent is working; a busy device tries again ten minutes later. A release Stepsemble does not support yet waits, and is installed by the first check after a Stepsemble update that supports it. The row says when Codex was last upgraded this way. The switch is off until it is turned on, on each device separately.
- Reviewing a new Codex release is now one command, so support for a Codex that changes something Stepsemble uses can follow quickly. `npm run -s watch:codex` says whether the newest Codex needs anything. `scripts/review-codex-release.mjs` downloads the official release, compares its app-server contract with the latest reviewed one, runs the composer, parallel, approval and a new branch check against it with a local model, and records the release. `scripts/prepare-release.mjs` sets the version, the rolling-compatibility pins and the CHANGELOG section of a release.
- Checked in Chromium at 390 and 1280 pixels with the send held back for several seconds: for Pi, Claude Code, an ACP agent and the real Codex 0.158.0 with a local model, "Working for 1s" and "Thinking" appeared 0.05 to 0.07 seconds after Send, counted up, and gave way to the reply below the message; a second Codex message started again from 1s. On a Host with a stand-in Codex 0.157.0, turning the switch on upgraded it to 0.157.1 within five seconds, and a release that could not be checked was left alone. Run from a copy of this tree without 0.158.0, the review script reproduced the recorded 0.158.0 schema file and profile byte for byte, and the four checks passed against the official release.

## 3.8.13

- Pictures sent with a message are shown as in Codex: small square thumbnails above the text, on the same side, with the text in its own bubble below. A tap opens the picture. They were inside the bubble at full width, and a message of pictures alone had an empty bubble; it now has none.
- Reopened conversations keep the pictures: Claude Code's history now reads them from its record (a message of pictures alone was left out altogether), and Codex and OpenCode show the pictures their records hold. After a Codex reply, Codex's own copy of the message used to replace the pictures with "[image]". A picture an agent keeps only as a file, or past 16 MB of pictures in one history, keeps its place as an image tile.
- Grok Build, Kilo, Hermes and Cline show the pictures in their own replay of a conversation.
- Checked on a Host with a local Claude and a local model for Codex, at 1280 and 390 pixels: two pictures with text and a picture alone, sent and reopened, each thumbnail 140 pixels (112 on a phone) above its text and none inside the bubble; a Pi history with pictures the same; a thumbnail opens the picture full size.

## 3.8.12

- Use a new Codex release without waiting for a Stepsemble release when it only adds to the Codex that Stepsemble supports. Codex publishes a release every few days; until now each one had to be added to Stepsemble by hand, and in the meantime Codex conversations could not send after Codex was updated. Stepsemble now compares the new release's app-server contract with the latest one it has reviewed. New methods, optional fields and values are accepted; a release that removes or changes something Stepsemble sends or reads is kept out until it is reviewed. A release with the same contract as a reviewed one is used in full too, where it was read-only.
- The Updates page updates Codex only to a release Stepsemble supports. It reads the release's contract from the official Codex repository (about 1 MB, not the 70 to 100 MB release) and compares it before offering the update. A release Stepsemble does not support shows "Waiting for Stepsemble" with the reason and no Upgrade button; one that could not be checked asks to check again later; a supported one says so. An npm installation is updated to exactly the checked release.
- After Codex is updated, Stepsemble starts its idle Codex app-servers again from the executable now installed and checks it. Before, it kept using the release it had started with until Stepsemble itself restarted.
- Checked against the published contracts of every stable Codex release from 0.151.0 to 0.158.0: 14 of 15 updates only add; 0.156.0 is kept out because it removed the image field Stepsemble sends. Removing a field Stepsemble reads, requiring a new field Stepsemble sends, removing `turn/completed`, `turn/start` or an approval decision, and changing a type are each kept out. On a Host with a stand-in Codex 0.157.0, the Updates page checked 0.157.1 against GitHub in about 5 seconds, found it supported and installed it, and refused a release with no published contract without installing anything.

## 3.8.11

- Tables in replies scroll sideways and show every column in full. A table was squeezed into the width of the reply, so on a phone a column of Chinese text broke one character per line ("需要幾把 key" took seven lines). Each column now takes the width its content needs, up to a reading width (14em on a phone, 18em wider), headers and short cells stay on one line, and a table wider than the reply scrolls. A fade at an edge shows there is more on that side.
- While a reply is still being written, a table keeps the place it was scrolled to.
- On a phone, a swipe from the left edge over a table that is scrolled sideways scrolls the table back; at its first column the swipe goes back to the list as before.
- The time under a reply reads the same in Safari as elsewhere: "Sep 28, 1:42 PM", where Safari wrote "Sep 28 at 1:42 PM".
- Checked with the table from the StepSay reply, on a 390-pixel phone in Chromium and WebKit, dark and light: every header and first-column cell on one line, long columns 214 pixels wide and at most three lines, the table 653 pixels wide in a 364-pixel view.
- Support Codex 0.158.0. Stepsemble works only with Codex releases whose app-server contract it has reviewed; after updating Codex to 0.158.0 a Host would have refused Codex conversations the next time it started. Against 0.157.0 the contract adds an error kind and a plan type and changes nothing Stepsemble sends. Sending with a model, level and image, two conversations at once, approvals and branching were run against the real 0.158.0 with a local model.
- Claude Code 2.1.283 needs no change: new conversations, branching, a command of 40 seconds, going on after Claude is stopped, the model and level sent, and the usage details were run against it with a local model.
- Branching a Claude Code conversation begun in the last few seconds opened an empty branch that did not take a message. The branch reads the conversation it comes from, which Stepsemble's history had not found yet; a conversation that is asked for and not found now makes Stepsemble look again, at most once a second.

## 3.8.10

- Bring Stepsemble's Claude Code helper on the Mac up to date so it can branch a conversation. 3.8.9 checked whether the helper could branch before updating it, but the update itself looked only at the older features, found nothing to do, and reported the helper as updated. Branching a Claude Code reply then kept saying the helper was updating. The update now installs the current helper when it cannot branch and confirms afterwards that it can.
- Settings offers the helper update when the helper cannot branch.
- Checked on the Mac Mini: its helper reported no branching before and branching after one update, with no Claude conversation running.

## 3.8.9

- Show what Claude Code wrote in the usage details. Output showed the few tokens Claude had written when it began a reply (8 on the StepSay answer) and never the count it reports when the reply ends (1,043, as Claude's own record says). The Host now reads that end count, and the turn's result where there is none.
- Show Codex's input and cache hit rate the way they are for Claude. Codex counts the tokens the cache supplied inside its input, so Input showed them twice and the hit rate came out far too low: 48% for a call whose cache supplied 93% of the input. Input now counts only what the cache did not supply.
- Show Grok Build's usage at all. Grok reports it where the protocol has no usage; the details stayed empty. They now show Grok's last model call.
- Show the real context for Hermes and Kilo, which report it themselves, and count Hermes's usage for what it is: the sum of every model call in the turn. The details used that sum as the context size, 39,639 tokens where Hermes reported 23,128. Where an agent counts its cached tokens or its thinking apart, Input and Output now read the same as for the others, and cache writes are shown when reported.
- Count thinking in OpenCode's and Kilo's Output, as Claude Code, Codex and Grok count it: an OpenCode reply of 401 tokens and 254 of thinking showed 401.
- Say which span the counts cover, under Context: the last model call, all model calls of the last turn, or the whole conversation (Pi).
- Checked each against the agent's own records on this Mac: Claude Code (Output 777 where the reply began at 1), Codex (Input 11,654 of 18,566, 37% cached), Grok Build (129 new, 24,064 cached, 99%), Hermes (context 27,250 of 272,000) and Kilo (18,461 new, 2,176 cached, Output 12).
- Under each reply, as in Codex: a Copy icon, a Branch in new chat icon, and the reply's date and time. Retry is gone; it only worked for Pi. Copy shows a check for a moment once the reply is on the clipboard.
- Branch in new chat starts a new conversation that holds everything up to that reply and nothing after it, named "… · branch", and opens it as a tab beside the original. The original is never changed.
- Claude Code, Codex, Pi and OpenCode branch at any finished reply. Kilo and Hermes copy the whole conversation, so the icon is under their latest reply only, once they are idle. Grok Build and Cline cannot branch a conversation, so their replies show Copy and the time.
- Stepsemble's Claude Code helper on the Mac updates itself to branch conversations. Until it has, branching a Claude Code reply says the helper is updating.
- Checked on this Mac: a branch at the first of two replies held the first and not the second, and answered a new message, for Claude Code, Codex and Pi; Hermes and Kilo copied the whole conversation and answered; OpenCode branched before the next message through its API.

## 3.8.8

- Keep Claude Code going while a long command runs. Claude Code 2.1.281 reports that a command is still running once it has run for 30 seconds, and Stepsemble stopped Claude at that report because it did not know the kind: the StepSay task was stopped 30 seconds into waiting for Xcode to install (the command ended with exit code 137). Stepsemble now passes on every kind of event Claude sends and draws the ones it knows. An event it cannot read, a line that is not an event, or one larger than 8 MB is left out and the conversation goes on; only a permission or control request Claude waits an answer to still ends it. Google Antigravity gets the same treatment. Checked with Claude Code 2.1.281 running a 40-second command.
- Go on with a Claude Code conversation that stopped. The message box used to turn read-only ("native resume is not connected yet") until the Host restarted. Write your next message and send it: Claude starts again on the same conversation, and the message goes to it. A stopped conversation opened from the list opens ready to go on in the same way.
- Show a Claude Code conversation that stopped as stopped. When Claude's process ended in the middle of a later turn, the conversation kept showing it as working.
- Show Claude Code's tool calls as tool rows when a conversation is opened again. Each command appeared as "[Bash]" and each result as a message of yours ("[tool result] Exit code 137"); they now fold into "Worked for …" like a live conversation. Background task notices, notes Claude adds for itself and its "No response requested." are no longer shown, and a slash command appears as you typed it, such as "/model sonnet", with its output below.
- Keep less for each Claude Code conversation and send the page less. An image a tool reads, such as a screenshot, and Claude's own copy of a tool's result are no longer kept with the conversation's events (a 2.4 MB image read took 700 KB before), and the page asks only for the events it has not drawn yet instead of all of them every two seconds.
- Name Claude Code as "Claude Code" on a stopped conversation's notice, where a phone that had not loaded the agent list showed "claude-code".

## 3.8.7

- Keep a long Claude Code task going. Stepsemble ended a Claude Code conversation once Claude had sent 2,048 streamed pieces since it started, and stopped Claude with it: the StepSay task failed after 7 minutes, while Claude wrote a long CLAUDE.md whose text alone arrived in 1,866 pieces. There is no such limit now. The pieces of a message go once Claude sends the complete message, so a page loads less on each check; when a single message is longer than the window, the pieces the page never draws go first, such as a file's text as a tool writes it.
- Draw a long answer once after a reload or a slow connection. The conversation page now reads on from the last event it drew by number, and a page that holds only the later pieces of an answer shows the complete answer in their place, where it used to show both. Checked with answers of 600 pieces at a typing pace and of 5,000 and 12,000 pieces at once: every word shown once, live and after a reload, and the conversation carried on. Google Antigravity conversations get the same fix.

## 3.8.6

- Make a folder for a new project from Add project. New folder, beside the filter, asks for a name, makes the folder inside the one shown and opens it, ready to add; it works on every Host. It makes one folder at a time, only where the dialog may browse, never over an existing folder or file, and not with a name that holds / \\ or :, or starts with a dot.
- Choose Grok Build's thinking level with a Grok that lists no reasoning option, as the one on the MacBook Pro does. That Grok lists only its models, so the model list showed no thinking level. Each model states the levels it takes; Stepsemble now offers them and sets the one you choose the way Grok's own /effort command does, with a model switch that names the level, and shows the level Grok reports when a conversation is opened again. Checked on Grok's own records: turns sent at Low and Extra High were answered at low and xhigh.

## 3.8.5

- Name each model by the model and put the provider that serves it on the line below, for every agent. The line under a model repeated the agent ("claude-code" under every Claude Code model, "codex", "grok-build"); it now reads Anthropic, OpenAI, ChatGPT, xAI, OpenCodex · MiniMax, OpenRouter · Anthropic or Kilo Gateway · Anthropic, as the case may be.
- Show Claude Code's models with their version: "Opus 5.5 · 1M", "Sonnet 5", "Haiku 4.5", where the list said "Opus (1M context)", "Sonnet" and "Haiku".
- Leave brackets and prefixes out of model names: "claude-fable-5-1 (anthropic)", "OCX anthropic/claude-opus-5-5", "OpenRouter · anthropic/claude-sonnet-5" and "Kilo Gateway/Anthropic: Claude Opus 5.5 (new)" read claude-fable-5-1, claude-opus-5-5, claude-sonnet-5 and Claude Opus 5.5, with the provider and notes such as "new" or "$$" on the line below. The model button beside Send uses the same names.

## 3.8.4

- Start a new Pi conversation with the model and thinking level you chose last, on any device, as the other agents do. Pi run by Stepsemble records a choice only in the conversation it was made in, so a new conversation went back to the model in Pi's own settings; the level came from whichever browser opened it, and choosing a Claude Code level changed it too. The Host now keeps Pi's choice with the others.
- Keep a Pi conversation's thinking level when you switch its model. Pi reset the level to the default in its settings, Max on this Mac, so choosing another model at Low quietly answered at Max. A model that offers less still lowers it, and switching back restores the level you chose.
- Open the limits from the strip at the foot of the session list in place: the box grows upward over the list and shows every allowance on one line, with a thin bar of what is left, the percentage and how long until it resets, and when the limits were checked. Tap the strip again, tap elsewhere or press Escape to close it. It replaces the Subscription limits dialog.
- Checked on each agent's own records that the model and level chosen in Stepsemble are the ones used, when a conversation starts, after a change and in the next new conversation: Claude Code (the request it sends), Codex, Grok Build, Hermes, OpenCode and Pi.

## 3.8.3

- Show each of your messages once in Grok Build conversations. A Grok newer than 1.0.41 sends your message back while it answers, and Stepsemble also keeps the copy it records as the message is sent, so every message appeared twice. The copy the agent sends back is now dropped as it arrives; this covers Kilo, Cline and Hermes too, should they start doing the same.
- Send with Enter and start a new line with Shift+Enter on a computer, in every Workspace pane. Stepsemble told a computer from a phone by the page's width, and a pane is often narrower than that breakpoint, so Enter only started a new line there. It now asks whether there is a mouse or trackpad; on a phone, Enter still starts a new line and the button sends.

## 3.8.2

- Make the Subscription limits page, opened from the limits strip, short and plain: one card per provider and one line per allowance, with what is left, a thin bar of it and when it resets. It showed each allowance in its own large card with a ring, the same percentage written out, and a bar of what was used, so the ring and the bar ran opposite ways; a phone needed about half as much scrolling for the same four providers.
- Colour an allowance only when it runs low, amber at a quarter or less and red at a tenth or less, and list a provider close to a limit first.
- Show reset times without seconds, as the time alone today, the weekday this week and the date after that, and show when the limits were checked once at the foot of the page. A bucket that repeats the provider's name ("codex" under Codex) is left out.

## 3.8.1

- Keep the limits strip at the foot of the session list quiet: while every allowance is comfortable it shows "Limits are fine" and each provider's own logo, where it showed four large rings that were full most of the time. A provider down to a quarter or less gets a chip with what is left, amber, or red at a tenth or less; tapping the strip still opens the details, and hovering a logo or chip still shows each window and when it resets.
- Judge each provider by the window with the least left, where the strip showed its shortest window: OpenCode Go read 100% for its 5 hours while its month was at 40%.

## 3.8.0

- Start each new conversation with the model and thinking level you chose last for that agent, and keep each conversation's own choice when it is opened again, for example after an update. The Host keeps the choice, so the phone and the computer start new conversations the same way. This covers Claude Code, Codex, OpenCode, Grok Build, Kilo, Cline and Hermes; Pi already keeps its own. A Claude Code conversation from an earlier version reopens with the model it last answered with, as its transcript records it.
- Show the model and thinking level an agent really uses, and offer no "Default" in either list. Claude Code's "Default (recommended)" is left out because it is the same model as Opus (1M context); Claude and Codex now show the level they run with, where they used to show "Default"; the model button says "Choose model" until the agent names its model.
- Run Claude Code at the thinking level you choose, and until you choose one, at the level Claude's own settings name. Claude started by Stepsemble ignored that setting and answered at its built-in level, Medium for Opus, even when the settings said xhigh. Checked on the requests Claude Code 2.1.281 sends: the level shown beside the model is the level sent.
- Choose Hermes's model in Stepsemble. Hermes lists its models apart from its other settings; the model button now shows the one it uses and switches it, where it used to say "Server default" and offer no choice.
- Switch the model of an OpenCode conversation again. OpenCode 1.18 refused the request because Stepsemble named the model with a field it no longer accepts.
- Hide the thinking level for OpenCode, which takes none from Stepsemble; choosing one there only showed an error.

## 3.7.2

- Stop a Claude Code conversation that failed from keeping its Claude process running. The process stayed open with nothing to do, so the conversation kept counting as work in progress, and Update now said an agent was working until Stepsemble restarted. A failed conversation now ends its process, and a Claude process that does not exit when asked, on a failure or on Close, is ended after 3 seconds.

## 3.7.1

- Continue a Codex conversation after Stepsemble restarts, for example after an update. Codex 0.156 reports a conversation's status before it answers the request that reopens it, and the last turn's usage right after; Stepsemble took both for another conversation's and dropped the connection, so every message to a conversation opened before the restart was not sent. Checked with Codex 0.156.1 on the conversation that failed.
- Remove the blur that iOS 26 and later draw over the top of Stepsemble opened from the Home Screen, which made the title row look out of focus. iOS draws it when the page offers no color for the status bar; Stepsemble now offers its background color, which iOS paints there in place of the blur.
- Send the first message in a conversation that is still opening. The message box looked ready while Claude Code, Codex, OpenCode, Grok Build, Kilo, Cline, Hermes or Antigravity was still loading, and a message sent then was refused with "Waiting for the task to confirm input is available". The box now stays read-only until the conversation has loaded.
- Keep a Claude Code conversation going after Stop. Claude ends a stopped answer with an error, which Stepsemble took for the whole conversation failing: it showed "Failed" and could not be continued, even after a reload. A turn that ends in an error now shows that error, and the conversation goes on.
- Continue OpenCode conversations in the Workspace, including new ones. Every OpenCode session that was not answering at that moment opened read-only, as history.
- Show your own messages in Grok Build, Kilo, Cline and Hermes conversations after a reload, each above its answer. They were missing, and the answers to several messages could run together in one bubble.
- Continue a Kilo, Cline or Hermes conversation after Stepsemble restarts, for example after an update. Loading it again failed on the agent's answer, which by the protocol names no conversation, and a new terminal session was started in its place. The conversation now opens again with its earlier messages.
- Show why an agent did not answer, for example "You need to sign in to use this model" from Kilo or OpenCode, instead of only "The message was not sent" or no reply at all.
- Offer Google Antigravity's sign-in in New session when it is signed out. The conversation used to start and then wait without a word, while Antigravity waited at its own sign-in screen.

## 3.7.0

- Name a session that was started without a name after the first message sent in it, for every agent; Pi already names its sessions this way. The name is the message's first line, up to about 48 letters or 24 Chinese characters. A command such as /login names nothing, a name typed in New session is kept, and a session is named this way only once.
- Rename any session: Rename is in a session's ⋯ in the Workspace list, in a pane's ⋯ and in the conversation's own ⋯ at the top. The Host keeps the name, so every device shows it, and the agent's own name for the session no longer replaces it. For Pi and Codex it also becomes the session's own name, which their own apps show.
- Rename a saved Pi session from its actions again; the dialog closed without renaming it.
- Keep the Claude Code model you choose when you change its reasoning level. Stepsemble sent the level as a model change without a model, which Claude Code takes as "switch to the default model", so choosing Sonnet and then a level quietly went back to Opus while the button still showed Sonnet. Claude Code also ignored the level itself. The level now goes through Claude Code's own setting for it, and the model stays as chosen; this was checked against Claude Code 2.1.281.
- Show each reply below the message it answers. Claude Code, Grok Build, Kilo, Cline, Hermes and Antigravity added a new answer to the reply above your latest message, so a conversation showed one long reply followed by your later questions.
- Show a Claude Code conversation once when it is opened again while it is still running, for example after a reload or on another device. Its replies appeared twice, once merged into one block at the top and again in the conversation below; the conversation now shows Claude's history with only the newer replies after it.

## 3.6.3

- Show when Grok Build, Kilo, Cline or Hermes is answering. Send turns into Stop and the run timer and "Working" appear until the answer ends, also after the page is reloaded meanwhile; before, nothing showed that the agent was still working.
- Stop a Grok Build answer with Stop. Stepsemble sent the cancel as a request, which Grok answers with "Method not found" while it keeps working; it is now the notification ACP defines, and Grok stops at once.
- Let an answer from Grok Build, Kilo, Cline or Hermes take longer than 30 seconds. A longer turn was reported as not sent and its text put back in the message box while the agent kept working.
- Attach images in Grok Build conversations. Grok 1.0.41 reports that it takes no images, but it passes them to the model; this was checked with real images and Grok's own models.
- Keep the usage details on screen on a phone. They opened from the context ring toward the left, and with the ring in the middle of the message box they were cut off at the left edge; they now move to stay on screen and are never wider than it.
- Keep a conversation's title row clear of the status bar on a phone. The Workspace now starts a conversation below the status bar and fills that strip itself, so no pane content sits under iOS's blur at the top, and the title row sits a little lower.
- Show the capacity of Claude's 1M context models, such as Opus (1M context). Claude reports the capacity under the model's full name, "claude-opus-5-5[1m]", while its replies name "claude-opus-5-5", so the two were not matched and the usage details showed no capacity; the capacity is now kept from one turn to the next as well.

## 3.6.2

- Choose a Grok Build conversation's model and reasoning level. The model button was hidden for Grok, although Grok lists its own models and every model set up in `~/.grok/config.toml`, such as the OpenCodex ones. The sheet now offers them, and its reasoning menu shows the levels the chosen model supports.
- Show every ACP conversation's model and reasoning level beside Send as soon as it opens, for Kilo, Cline and Hermes as well as Grok. The reasoning menu lists the agent's own levels and is hidden for an agent that has none, instead of offering levels that did nothing.
- Keep the name typed in New session for a Grok conversation; it used to become Grok followed by part of its id.
- Open a Grok conversation again after Stepsemble restarts, for example after an update. It is loaded from Grok with its history, model and mode; before, it opened empty and could not be continued.

## 3.6.1

- Sign an agent in on another computer from the Workspace. With another computer chosen as the host, starting a sign-in did nothing on computers added before device pairing: the relay left out the page's origin, so the other computer refused it. The relay now vouches for a page this computer has already checked, which also lets quota sources be saved and the Claude helper be updated on such a computer. A request without an origin is still refused.
- Keep a sign-in that fails in New session on screen with its reason until you close its terminal. It used to disappear at once and leave the Sign in button, as if nothing had happened.
- Fit New session's sign-in terminal on the screen. The dialog takes the screen's height and the terminal fills what is left, so its code, links and keys are no longer cut off at the bottom on a phone.
- Start each folder in Add project at its top, even when the previous folder was still scrolling after End or a flick.

## 3.6.0

- Lay out the message box like Codex's: attachments and Approval on the left; the context ring, the model with its reasoning level and a smaller round Send button on the right. Tap the ring for the context numbers. On a phone the arrows are dropped to save room, and the model label uses the chosen language until the conversation reports its model.
- Add Approval to the message box. It offers the modes of the conversation's own agent: Read only, Default and Full access for Codex; Manual, Accept edits, Plan, Auto, Don't ask and Bypass permissions for Claude Code; Build and Plan for OpenCode; the modes Hermes, Kilo Code and Cline report; and Default and Plan for Grok Build, the two it applies. Pi and Antigravity have none, so it stays hidden there. Each conversation remembers its choice and gets it back when reopened. Codex applies a change from the next message and the others at once. Full access and Bypass permissions are shown in orange.
- Let a Claude Code conversation switch to Bypass permissions. A session still starts in the mode Claude's own settings choose, and the option is passed only to a Claude Code CLI that lists it, so an older CLI keeps starting normally. On a Mac that starts Claude Code through the desktop helper, Claude Code's page in Settings shows whether the helper is current and can update it; an earlier helper cannot offer Bypass permissions, and choosing it says so.
- Support Codex CLI 0.156.1 and 0.157.0 natively. Codex conversations had fallen back to a reduced mode since the CLI updated to 0.156.1. Both releases were reviewed against the one before and passed the composer, parallel and approval checks, so updating Codex to 0.157.0 keeps them working.
- Open a new Codex conversation on the first try. Reading its goal was not routed, so opening failed, and before the first message it showed a history error; a Codex conversation without messages now opens empty.
- Show a sent Codex message once. It appeared twice, with a date line between the copies, after Codex returned it.
- Keep the Workspace on screen when its computer can't be reached for a moment, such as while the computer wakes up, Wi-Fi or a VPN reconnects, or Stepsemble restarts after an update. The offline page used to be the old single-conversation screen and stayed until you reloaded; the Workspace now reconnects by itself. A pane that can't reach its computer says so and opens once it answers, also when the conversation is on another computer that is asleep or offline. A pane whose conversation or computer is gone says so in your language instead of showing an error code. Signing in from the Workspace returns there even when the device list is slow.
- Go back to the Workspace list when you swipe from the left edge of a conversation on a phone. The swipe used to close the conversation and leave an empty pane, and an empty pane no longer offers the old New project button.
- Keep the name you type for a new Codex conversation. It becomes the Codex thread's own name, so Codex's apps show it too; the conversation used to appear as Codex followed by part of its id.
- Keep the model's full name and reasoning level beside the Send button. A usage update replaced them with the bare model id, so a Claude Code conversation could lose its level.
- Show the OpenCodex cards on the Codex and Claude Code pages in Settings only when the computer has OpenCodex, and in the chosen language. Without OpenCodex those pages and the agent list no longer mention it. When its status can't be read, the page says why instead of showing "Checking gateway status…" forever, and a switch that fails explains the reason.
- Remove the single-conversation page with its own session list. Opening `/index.html` by itself (typed, from an old bookmark or home-screen icon, or a pane opened outside the Workspace) now goes to the Workspace, and nothing inside Stepsemble shows that list any more. The Workspace keeps what only that page offered: New session can start in an isolated Git worktree, History links to the read-only history reader, and the setup guide opens after the first sign-in on a device.
- When New session picks an agent that is not signed in yet, the dialog offers that agent's own sign-in and starts the session once it succeeds. Cline no longer falls back to a garbled terminal view in that case, and Grok Build no longer shows only an error code.
- Use Grok Build's structured connection whenever `grok` is installed, as for the other ACP agents (`STEPSEMBLE_GROK_ACP=0` turns it off), and offer Default and Plan under Approval.
- Update the Claude desktop helper by itself after Stepsemble updates, once no Claude conversation is open. The button on Claude Code's page in Settings stays for a helper that could not be updated; `STEPSEMBLE_CLAUDE_HELPER_AUTO_UPDATE=0` leaves the update to it.
- Lay out New session with the agent and the name side by side at the same height and a compact Create button, and create the session with Enter in the name. A long folder path no longer widens the dialog on a phone.
- Show conversation titles without Markdown in the Workspace sidebar, as the conversation does; let Add project's folder list take keyboard focus so Home and End scroll it; and read Added aloud once a History row is added.
- Keep the Settings window open when you choose another device in it; it used to close and show the old session list.

## 3.5.0

- Split Settings into six sections: Appearance, Notifications, Agents & models, Devices & access, Updates and About. Advanced is gone, and each option now sits with the options it belongs to.
- Give push notifications their own Notifications section. It says when an alert is sent: an agent finishes, fails or is stopped while that conversation is not open on any screen. The section list shows whether this device receives alerts, and a browser that cannot receive them explains how to add Stepsemble to the Home Screen on iPhone or iPad.
- Move the Sub Agent sessions switch from Settings into History from other apps, next to the list it filters. The switch shows how many Sub Agent sessions there are and keeps its choice. On a phone, each history row now gives the session title its own line.
- Show Pi's token use for the last 7 days on Pi's page in Models & providers, since it only counts Pi sessions. About no longer repeats the Pi version; Updates lists every agent's version, Pi included.
- Move Restore interface defaults to the bottom of Appearance. It now resets only the options on that page and keeps the language, projects, model visibility and the Sub Agent switch.
- Rename Resource sync to Pi resource sync, since it compares Pi's extensions, skills and packages, and describe Agents & models as models, providers and quota sources.

## 3.4.0

- Leave Settings one level at a time. Settings, a section, Models & providers and an agent's page are now steps in the browser history, so Safari's edge swipe, Android's back gesture, the back button and the in-app swipe return to the level above instead of jumping to the main page. Models & providers gets the same edge swipe as the rest of Settings, and a swipe can start on a row.
- List every installed agent under Models & providers. Each agent's page says how to sign in, can check its sign-in status, and shows the models it offers: Codex and OpenCode list theirs live, while Claude Code, Kilo Code, Hermes and Cline show the models from their last conversation. Pi keeps model visibility and the Custom provider editor, OpenCode its providers, and Codex and Claude Code their OpenCodex routing.
- Move the local OpenCode server setting to OpenCode's page, with a note on what it does, and drop the Agent sign-in group from Settings.
- Choose where limits come from. Quota sources lists each agent's own sign-in, Pi's sign-ins and keys, OpenCodex and CodexBar, each with a switch; a service that several sources can read can use a chosen one, and the list marks which source is in use. CodexBar's CLI runs only after it is turned on, at most every five minutes. OpenCodex's OpenAI and Anthropic readings now fill the Codex and Claude rings when no sign-in answers.
- Teach sign-in with /login in the setup guide and help.

## 3.3.0

- Sign in with each agent's own commands. Type `/login`, `/logout` or `/status` in a conversation with Pi, Codex, Claude Code, OpenCode, Kilo Code, Hermes, Grok Build, Cline or Antigravity, and Stepsemble runs that agent's command on the conversation's host in a terminal sheet. Sign-in links open as buttons, one-time codes can be copied, and what you type goes back to the command. Entries for keys, tokens and passwords are hidden and masked in the output. The command palette lists `/login` and `/status` for each installed agent.
- Keep a sign-in running when you switch hosts. Typing `/login` on that host again, from the same or another device, shows the same run with its link and code.
- Warn before a Codex sign-in that it replaces the current account: `codex login` signs out first, even if the new sign-in is never finished.
- In a Pi conversation, `/login` lists every provider Pi supports, with account sign-in before an API key, and `/logout` lists the providers that are signed in.
- On a Mac where Stepsemble runs over SSH, Claude Code's commands run through the desktop helper. A helper from an earlier release offers Update the helper, or the previous sign-in in the host's browser.
- Remove the sign-in forms from Settings, together with the free-provider list, local model scanning (Ollama, LM Studio, vLLM), the Nous integration and the preset services Stepsemble added on top of Pi. Models & providers keeps model visibility and the Custom provider editor. Entries already in `models.json` stay as custom providers, and Stepsemble no longer refreshes a Nous token.
- Add Settings → Agents & models → Quota sources. It reads subscription and API limits from OpenCodex on the selected host with OpenCodex's local admin token, which never leaves the host, and links to its dashboard. The limits dialog points there.
- Use a new sign-in right away. After Codex signs in or out, idle Codex app-servers restart while a running turn is left alone; OpenCode reloads its providers when idle; a Grok Build process that reported a missing sign-in is replaced on the next attempt.
- Hold automatic updates while a sign-in is running.

## 3.2.4

- Keep the Codex allowance visible when the installed Codex CLI is newer than this release has reviewed. The limits strip showed a dash because the allowance was only read through Codex's app-server, which stops at an unreviewed schema; Stepsemble now reads the same allowance from ChatGPT with the account the Codex CLI is signed in to, or with the ChatGPT account signed in under Settings. The Codex CLI's token is only read, never renewed, and an expired token is never sent.
- Read allowances with the accounts and keys saved in Settings. A Claude account signed in under Models & providers now shows its limits when Claude Code is not signed in, and OpenCode Go and MiniMax API keys saved there are probed without another app's configuration. A MiniMax China key is checked on the China host.
- The limits dialog says where to sign in or add a key and opens Settings from a button.

## 3.2.3

- Add Update now for a device whose update is waiting on running agent work. The confirmation lists that work first: turns in Codex, Claude Code, Pi and the other native sessions stop (the conversation is kept, so ask the agent to continue after the update), while supervised CLI tasks keep running through the restart. Cancelling leaves the install to run automatically once the work finishes.
- Installing an available update on a busy device asks the same question before restarting. Scheduled and deferred updates never interrupt running work; only an explicit confirmation from the app does.

## 3.2.2

- Stop an open Pi conversation that is only waiting for input from holding back automatic updates. The updater skipped idle Pi streams but still counted the same session's task row as pending work, so a tab left open could defer every release for hours. Such a session now reports itself idle, reopens from its saved session file after the update, no longer offers a Stop button that has nothing to stop, and no longer counts as active work. Streaming, compaction, queued messages, tool work and pending dialogs still block installation.

## 3.2.1

- Give the Workspace stage the full window height. The header row with the title and drag hint is gone; the list toggle now sits at the start of the top-left pane's tab strip and New window, as an icon, at the end of the top-right one, so both stay in the corners in any split or maximized layout.
- Tidy the Workspace sidebar. Refresh sits beside Settings and now reloads the session list and subscription allowances together; History from other apps sits between the search field and Add project; the footer holds only the allowances.
- Show each provider allowance as its logo, shortest window and remaining ring, so four providers fit side by side. Hovering a provider still shows its name, every window and the reset times.
- Remove the "Connected" line from the sidebar footer. The HOST dot shows the connection state, hovering it names the host or the error, screen readers still hear it, and a new connection failure appears once as a notice.

## 3.2.0

- Group each agent turn into a timed work log. While it runs, the current step subtly sweeps to show activity; after completion, the steps fold under the elapsed time while the final answer stays visible. Open a step to read its tools, reasoning, and intermediate commentary in order. This works for Pi and the supported native agent transcripts on desktop and phone.
- Show edited files with added and removed line counts below completed work. Expand the file list or open the project changes inspector to review current diffs.
- Let unsent image thumbnails open in the existing full-size viewer, with Escape, backdrop click, and close-button dismissal. Raise the four-image composer limit to a bounded per-agent allowance: up to 100 for Claude and 20 for other supported agents, subject to each prompt's size budget.
- Remove the stale "Still working" warning from active conversations, and keep waiting-for-approval states distinct from the thinking animation.

## 3.1.4

- Serve the web client compressed. Opening the Workspace shell and one conversation used to transfer about 2.1 MB of JavaScript and CSS on every cold load; brotli brings that to roughly 450 KB, and long session payloads are gzipped above 1 KB. This is what made Stepsemble feel slow on a phone, especially over Tailscale.
- Keep a versioned asset in the browser cache for a year instead of revalidating it daily. Each release already changes the `?v=` on every asset, so the URL identifies its own content.
- Negotiate encodings correctly: brotli and gzip fall back to identity, each representation carries its own ETag, and unversioned preview pages keep the short cache.

## 3.1.3

- Update Workspace session rows and pane tabs when a conversation gains or changes its title. Pi sessions use their explicit name or first user message, including older entries previously shown only as "Pi"; the first-message text stays out of the workspace membership file.
- Replace the Workspace Settings emoji with the same centered SVG icon used by the main app.

## 3.1.2

- Split Settings into five sections (Appearance, Agents & models, Devices & access, Updates, Advanced). Phones open on a short section list with the selected host at the top; wide windows keep the list beside the open section.
- Make "Check for updates" read the published release only. Installing is a separate, confirmed action per device, each device has its own automatic-update switch, and a check can no longer be picked up by the pending-install scheduler.
- Show coding-agent versions honestly: a newer published version stays visible after an upgrade that did not change the installed version, missing agents collapse into one line, host-managed agents have no upgrade button, "Upgrade all" only runs the outdated ones, and a stale check refreshes when the Updates section opens.
- Collapse the nine design themes behind the current one, stack device pickers on phones, apply the Sub Agent setting to History from other apps, and keep language and project organisation when restoring interface defaults.
- Fix the Codex & Claude tab in Models & providers, which fell back to the Pi Agent list.

## 3.1.1

- Let an update proceed when an external, read-only history observation still carries a stale running label. Stepsemble-owned agent work and live RPC streams continue to block installation.

## 3.1.0

- Add a managed Workspace that lists projects and sessions added to Stepsemble, keeps external history separate, and supports tabs, split panes, and independent windows. Phones retain a single-column session view.
- Show subscription allowances in the Workspace sidebar, with per-window detail and reset times. Read available Claude, Codex, OpenCode Go, and configured provider limits without presenting unknown usage as zero.
- Refine project browsing and Workspace navigation, including collapsible project groups, removal from Workspace, compact pane actions, and clearer agent identities.
- Keep the Workspace appearance aligned with Stepsemble's existing design system and correct mobile navigation and quota progress presentation.

## 3.1.0-rc.11

- Carry the approved artwork into the empty workspace pane as well, matching the conversation view's empty state instead of a silhouette of the glyph.

## 3.1.0-rc.10

- Draw the workspace brand mark with the approved artwork again: the shell had replaced it with a monochrome silhouette, which dropped the connectors' colour and merged the four modules into one shape.

## 3.1.0-rc.9

- Show a provider's allowance as soon as it is configured, by selecting the usage probe from the provider's canonical destination rather than requiring a built-in entry.

- Add MiniMax, which reports a rolling and a weekly allowance per model; the row keeps whichever model is closest to running out.

## 3.1.0-rc.8

- Read the OpenCode Go allowance from its own usage endpoint with the key already configured for that provider, so the number no longer depends on another application's management API.

- Keep opencodex as the fallback for allowances Stepsemble cannot read itself, and label those rows as coming through it instead of leaving the dependency invisible.

## 3.1.0-rc.7

- Give every allowance the same shape, so a provider reporting a single weekly limit still shows its 7d label and number beside the meter.
- Explain a provider on hover: each allowance, how long until it resets, and the exact local reset time.
- Read allowances that have no local CLI of their own from the opencodex management API, which adds OpenCode Go with its rolling, weekly and monthly windows without duplicating provider credentials.

## 3.1.0-rc.6

- Split a provider's meter across its allowances instead of reporting only the tightest one, so a 5-hour and a weekly limit are labelled and measured side by side.
- Drop an allowance whose reset time has already passed, so a stale snapshot can no longer report a number for a window that has started over.
- Read the console user's keychain when the configured home resolves to that user's own `.claude`, which restores live Claude limits for isolated preview hosts.

## 3.1.0-rc.5

- Collapse the pane layout actions into one overflow control on the tab strip, so each pane gives its height to the conversation instead of a permanent row of buttons.

## 3.1.0-rc.4

- Show provider subscription limits at the bottom of the workspace sidebar: one row per provider carrying the window closest to running out, a meter that fills as the allowance is consumed, and every window on click.
- Read Claude's own cached utilization snapshot when a live account reading is unavailable, and report it with the time it was observed rather than as a current number.

## 3.1.0-rc.3

- Refine the workspace shell around the Stepsemble conversation layout: paper background, branded identity, project card, flat session rows, quieter pane borders, and a branded empty state.
- Keep host connectivity visible in the workspace header and leave the managed session, split pane, and multi-window behavior unchanged.
- Open phones in the original single-column conversation view instead of the split-pane shell, and remove split, extra-window and maximize controls from narrow layouts.
- Give an empty workspace pane no tab strip and no toolbar, so the invitation to drag a session stands alone until a conversation is open.
- Rename the pane control that carries its own conversation to Move to new window, which no longer repeats the header's New window label.
- Separate Close pane from the layout actions, and report subscription limits as unavailable instead of showing a row of bare dashes.
- Widen the gap between the project row's touch actions so two 32px targets no longer sit 2px apart on a phone.

## 3.1.0-rc.2

- Open the managed workspace by default: only sessions created here or explicitly added appear in its sidebar; adding a project does not import history or launch an agent.
- Keep external history behind an on-demand entry with separate preview and add actions. Adding membership does not take control of external tasks.
- Arrange sessions as tabs and resizable split panes, move them to independent windows, and restore layouts. Closing a viewer leaves its task running.
- Display available Codex and Claude subscription limits separately from conversation context usage; unknown limits remain unavailable instead of zero.
- Apply saved language, light/dark appearance and text size to the workspace and synchronize open panes without reconnecting. Translate workspace chrome in all eleven locales while preserving original session titles and terminal output.
- Draw the workspace shell with the product design system: the same design palette, resolved appearance, 0.5px hairlines, 12–14px radii, type scale, density and saved sidebar width as the conversation views, and the same button and input controls.
- Version and pre-cache workspace assets with the release to prevent mixed client resources after updates.

## 3.0.79

- Collapse Pi history and runtime wrappers that refer to the same conversation, including mixed absolute and relative session paths.
- Open duplicate-prone Pi task entries through the canonical history identity so stale runtime records no longer lead to an unavailable conversation.
- Preserve a newly created Pi task in Sessions until history indexing catches up, while merging repeated wrappers by the session UUID.

## 3.0.77

- Observe Codex Desktop-owned work from Codex's own read-only persisted turn state, so Sessions and the conversation view show Working and the real elapsed start time even though Stepsemble uses an independent app-server process.
- Recover current Codex context usage from the selected rollout's latest bounded token-count record. The context ring now shows current tokens, capacity, percentage, input/output, and cache usage instead of Unknown when the native process has no shared in-memory state.
- Admit only known Codex history responses up to their existing 8 MiB budget. Large legitimate turn pages no longer terminate the transport as `native_frame_invalid`, and a persisted fallback keeps a conversation open while native metadata reconnects.
- Distinguish an externally running read-only Codex task from an ended task, extend transient reconnect retries, and keep the Sessions list synchronized with persisted in-progress turns.
- Make the composer safe for Chinese and other IMEs: Enter used to commit composition never sends the message, including Safari/macOS ordering and legacy key-code 229; the next Enter behaves normally.

## 3.0.76

- Keep native Codex work visibly active beside the composer, with the current turn timer and official Goal objective/status instead of relying on a generic task row.
- Present Codex thinking as its own disclosure and viewed images as visible thumbnails with a lightbox; keep shell commands, file changes, and long output in the compact tool disclosure.
- Read Goal state through Codex's official `thread/goal/get` method and expose only observed image files through short-lived, authenticated, path-free preview handles.
- Add desktop and mobile browser coverage for working state, Goal mode, thinking, image previews, progressive tool disclosure, overflow, and page errors without making a provider or model call.

## 3.0.75

- Present structured activity from Codex, Claude Code, OpenCode, Grok Build, Hermes, Kilo Code, and Cline as compact disclosure cards instead of placing commands, reasoning, and long tool output in the main conversation.
- Group each Codex turn's thinking, shell commands, and file changes into one collapsed work row while keeping the final answer as normal Markdown. Tool details remain available on demand, including failures and full bounded output.
- Keep Claude Code tool requests and results correlated in one card, render structured Claude/ACP answers with normal typography, and preserve raw terminal styling only for unstructured CLI fallbacks.
- Add a shared, bounded transcript-presentation layer, synthetic browser fixtures, and regression coverage for Codex, Claude Code, OpenCode, and ACP event shapes.

## 3.0.74

- Add a versioned runtime capability contract for every Agent Hub connector. Session continuation, model/reasoning control, images, approvals, recovery, history, context, files, interrupt, and subagents are now reported from the active adapter or bounded fallback instead of inferred from the harness brand.
- Show the primary capability states in New Project as compact Ready, Limited, Unavailable, or Unknown chips. A missing, disabled, degraded, or read-only adapter no longer inherits controls from another runtime path.
- Add a release conformance gate covering Pi RPC, Claude structured/fallback, Codex mutation/read-only, OpenCode native, ACP, Antigravity, and missing executables. Approval is advertised only after explicit adapter proof; catalog discovery remains distinct from live-inference health.
- Keep Stepsemble self-contained: no HarnessRouter runtime, gateway, Docker service, credential sharing, or approval bypass was added.

## 3.0.73

- Prefer fixed official provider model APIs for supported Pi providers. Use Pi's public catalog for exact-model metadata and fallback, not as a gate on discovering new models. Retain the last verified official roster during outages.
- Support bounded, credential-safe discovery with pagination for Anthropic and Gemini API keys, public OpenCode Go/Zen and OpenRouter catalogs, and common OpenAI-compatible provider APIs. Subscription OAuth and manual model lists stay with their existing owners.
- Show each Pi provider's catalog source, last successful check, and stale-cache status. Unknown new-model capabilities do not inherit another model's reasoning, images, or context claims.
- Use OpenCodex's live catalog when Codex is explicitly routed through the configured local gateway. Refresh Claude gateway aliases in existing conversations, including removals and capability changes, without restarting or changing the current model.
- Preserve native direct-mode behavior, credentials, and running conversations. Add real-Pi registry/selection and official-source/gateway regression coverage.

## 3.0.72

- Refresh Pi model catalogs when opening the picker and every five minutes; follow added, renamed, and retired models without re-entering API keys.
- Reload the model registry inside existing Stepsemble Pi sessions through a verified extension command, with no inference or conversation restart. Keep session catalogs out of the global settings cache.
- Refresh automatically discovered provider presets against their configured endpoints; preserve manual/imported model lists, credentials, and concurrent edits. Show failed or unsupported checks instead of claiming every catalog is current.
- Use Pi's own storage lock for per-provider catalog commits, coalesce requests, bound network work, and retain last-good data during outages.
- Hide retired baseline entries when a newer remote catalog omits them, and preserve official model names from UI translation.

## 3.0.71

Report thinking support per Claude Code model instead of one fixed level.
- The badge over a Claude or gateway row now shows the levels that model actually accepts (for example `low-max`) and stays empty when the model exposes none, so Haiku no longer reads exactly like Opus.
- Selecting a model without thinking levels disables the reasoning select, explains why, and clears the composer chip so it cannot keep advertising the level chosen for the previous model.
- Gateway aliases keep the effort levels OpenCodex declares for the upstream provider instead of inheriting the base Claude model's full range, so the select lists only levels the provider offers.

## 3.0.70

Keep Claude Code's OpenCodex model metadata after selection.
- When a native Claude control ACK returns only a model id, the client now reattaches the loaded catalog row. Gateway aliases keep their context-window capacity, supported thinking levels, and provider label immediately after switching.
- The current model is resolved through the same catalog path on session open and in the model sheet, so the context dashboard can show known capacity before the first assistant usage report.

## 3.0.69

Keep gateway metadata when Claude Code supplies its own alias rows.
- Claude Code's initialize response now contains the OpenCodex aliases after the settings overlay is applied. Stepsemble merges those rows with its companion catalog instead of dropping the richer context-window and reasoning metadata, so the model sheet and thinking selector stay accurate.
- Live validation covers the macOS desktop helper path, alias selection, and a clean session close.

## 3.0.68

Expose the OpenCodex model catalog inside Stepsemble-launched Claude Code sessions.
- Refresh now writes a Stepsemble-owned `modelPicker` settings overlay with `behavesAs` mappings, so aliases such as `claude-ocx-opencode-go--glm-5.3-flash` are accepted by Claude Code without unknown-model warnings while the subscription OAuth credentials remain untouched.
- The structured Claude bridge merges the refreshed gateway catalog into its model sheet, including gateway labels, context-window capacity, and supported reasoning levels; both direct and macOS desktop-helper launches receive the same settings overlay.
- Added an isolated adapter regression test covering the catalog merge, settings argument, and gateway model selection contract.

## 3.0.67

Refresh Claude Code's gateway model list before Stepsemble-launched sessions.
- Claude Code reads the model picker's gateway section from ~/.claude/cache/gateway-models.json and, with a subscription-preserving launch, never refreshes that cache itself (the ocx claude launcher rewrites it before every launch). Stepsemble now performs the same pre-write for the sessions it starts: it pulls the anthropic-flavor catalog from the gateway and rewrites the cache in the exact on-disk schema, so every routed model is selectable and the list is never stale.
  - The pre-write only runs when Stepsemble's Claude session routing is enabled; failures keep the previous cache untouched.

## 3.0.66

Route Stepsemble's Claude Code sessions through the opencodex gateway on request.
- The Claude Code card now mirrors the real integration: terminal sessions are wired by "ocx claude" (model discovery on), and a new switch routes the sessions Stepsemble itself launches.
  - The routed launch injects only ANTHROPIC_BASE_URL plus CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, matching opencodex's subscription-preserving mode: the Claude subscription login is never modified, and gateway models become selectable in the session.
  - Applies to both spawn paths: the direct session factory and the macOS desktop helper, which re-reads the routing file on every launch.
  - The earlier panel action that toggled the gateway's inbound debug logging was removed; the correct switch is now this per-session routing setting.

## 3.0.65

Add an OpenCodex gateway panel for Codex and Claude Code.
- New "Codex & Claude" tab on the models page: shows whether opencodex is reachable, which providers it exposes, and whether Codex/Claude Code are currently routed through the gateway or running natively.
  - Routing switches invoke the opencodex CLI itself (ocx restore / restore back / debug claude on|off), so Stepsemble and the gateway never fight over config.toml, and running sessions are untouched.
  - Codex status is read from config.toml (model, injected openai_base_url) and the gateway's /v1/models list; Claude Code status comes from settings.json env overrides.

## 3.0.64

Bring OpenCode provider management into the Models & providers page.
- Add an agent switch (Pi Agent / OpenCode) to the models page: the OpenCode tab shows the live signed-in provider catalog from the managed server, the auth-backed sources, and the user's custom providers.
  - Custom OpenCode providers are saved to the native ~/.config/opencode/opencode.json provider block (npm package, base URL, optional API key, model list with reasoning flags and context limits) so the composer and the CLI share the same truth.
  - The managed OpenCode server restarts in place after each save/delete, then the UI re-reads the refreshed /config/providers catalog.
  - Warn when opencode.jsonc also defines a provider block that could shadow the edits.

## 3.0.63

Read the OpenCode model catalog from the endpoint OpenCode 1.18 actually serves.
- Prefer OpenCode's /config/providers route when listing models: 1.18 moved the signed-in provider catalog there, while its /api/model route ignores the directory query and the legacy /provider route can wedge the server, which froze the composer model list on stale or empty data.
  - Keep /api/model and /provider as 404 fallbacks for older OpenCode servers.

## 3.0.62

Keep Pi model catalogs fresh even when a provider has no stored credential.
- Refresh the persisted pi.dev model catalog overlays (models-store.json) directly from Stepsemble, using the same entry shape, etag and Last-Modified semantics as Pi, so providers without a usable Pi credential no longer freeze on their last cached catalog.
- Add a "Check model catalog updates" action on the Models & providers page that revalidates every persisted provider catalog and reloads the global model list; unchanged catalogs keep their cached body and validator.
  - Revalidate provider catalogs on a four-hour window whenever the provider catalog is read, and respect PI_OFFLINE for background refreshes.

## 3.0.61

Restore the Pi provider catalog and clarify which agent provider settings affect.
- Resolve the Pi provider package root by walking up from the real Pi binary path, so Pi 0.85.1's nested `dist/bundle` layout still loads the built-in provider list and auth runtime when adding a provider.
- Prefer the first existing pi-ai module path across nested and hoisted `node_modules` locations instead of assuming a fixed depth.
- Label Models & providers as applying to Pi Agent sessions only — a badge on the settings row, a scope note on the models page, and an updated setup-guide step, translated for all eleven locales.

## 3.0.60

Keep source-based installs fast on development volumes.
- Exclude the local Rust `crates` build tree from the web release staging copy so updates do not scan multi-gigabyte derived files.

## 3.0.59

Stabilize Codex cold-start sessions and composer controls.
- Retry the short native app-server handshake when opening a Codex session, so the transcript and response do not appear blank during startup.
- Retry Codex model discovery during the same window, keeping model and thinking-level controls available without a manual refresh.
- Add regression coverage for the startup race and bump frontend assets for the service worker.

## 3.0.58
Stabilize fast history re-opening after a list refresh.
- Wait for the session and Agent Hub snapshots that Back started before
  opening a cross-agent row, so rapid taps cannot land on the empty chat view.
- Retry one transient OpenCode native reconcile failure without losing the
  read-only conversation state.
- Bump frontend asset URLs to invalidate the previous service-worker cache.

## 3.0.57
Keep imported OpenCode history read-only across repeated opens.
- Preserve the idle/history marker while reconciling a native OpenCode session so it cannot be reclassified as live work.
- Re-open historical sessions without reusing a stale working directory, while keeping active OpenCode mutation controls unchanged.
- Route OpenCode history through its own native adapter before the shared Claude/Codex transcript reader, so repeated opens never fall back to the empty chat state.
- Bump frontend asset URLs for the service worker.

## 3.0.56
Make imported OpenCode conversations open reliably.
- Reconcile read-only native history by session ID when its original working directory is no longer an allowed project folder.
- Keep mutation routes and active OpenCode sessions behind the existing directory safety guard.
- Bump frontend asset URLs so the service worker cannot serve the previous chat-opening code.

## 3.0.55

Make Claude history hydration reliable after a frontend update.

- Try native transcript hydration independently of the live adapter lifecycle,
  so a saved Claude session is not treated as empty just because its status is
  `waiting` or `available`.
- Record a bounded client-side load state and message count for diagnostics,
  while keeping transcript contents and credentials out of logs.
- Bump asset URLs so service-worker caches cannot keep an older conversation
  renderer after an install.

## 3.0.54

Make native Claude and Codex conversations visible and responsive again.

- Normalize Codex seconds, milliseconds, microseconds, and nanoseconds before
  sorting or displaying sessions, so future-dated Codex rows no longer hide
  Claude, OpenCode, or Pi conversations behind the first page.
- Complete Claude Code's native initialization handshake before the first
  prompt, preventing a live child with no events or response.
- Expose Claude's supported effort levels in the composer and apply changes
  through the native control channel, with a safe default for models that do
  not advertise effort support.

## 3.0.53

Show one Claude conversation once, and stop launching duplicate processes.

- Return the attached session when a Claude conversation is resumed. Opening
  an already-attached conversation started another process, so several live
  sessions shared one conversation and each received the same prompt, which
  looked like a hang.
- De-duplicate the task snapshot on the native conversation id rather than the
  task id, across live sessions, the resume registry and local history, and
  match either `nativeSessionId` or `nativeHistorySessionId`.

## 3.0.52

Resolve the executable the user's own shell would pick.

- Search user-owned locations such as `~/.local/bin` before system package
  manager directories when `PATH` does not resolve a command. A service started
  by launchd has a bare `PATH`, and the previous order selected a third-party
  shim wrapping an old Codex instead of the user's official install.
- Apply the same order in the harness update service, which kept its own copy
  of the directory list.
- Explicit `PATH` entries and `*_BIN` overrides keep precedence, and provenance
  rules are unchanged.

## 3.0.51

Show which executable an unproven install source selected.

- Report the resolved `executablePath` in harness update status, and show it
  on rows whose source is unknown. A refused update previously gave no
  indication of which file was selected, leaving nothing to investigate.
- Provenance is unchanged: showing the path does not prove a source, and an
  unproven source still fails closed.

## 3.0.50

Check Claude Code and Codex updates from the app.

- Compare the installed version with the version published to the official npm
  package, using a registry read that does not modify the installation.
  Claude Code's `update --check` flag no longer exists, and the Codex
  standalone package has no dry-run probe, so neither could report an
  available update before.
- Reading the registry is not a provenance claim. Codex still updates only
  through its proven install source, and an unproven source still fails closed.
- A failed lookup reports "unknown" rather than implying the harness is
  current.

## 3.0.49

Stop reporting an unchecked harness as absent.

- Report `installed` and `executable` as `null` until a real observation
  exists, instead of deriving `false` from a missing check. Claude Code,
  OpenCode and Pi appeared as "not installed" on a host that had never run a
  check, while all three were running.
- Keep the upgrade control usable while the state is unknown, so the first
  check can be started. Only a confirmed absence disables it.
- Show "Not checked" rather than "Version unavailable" for that state.
- Source-aware provenance is unchanged: Codex still refuses to update an
  executable whose installed source cannot be proven.

## 3.0.48

Run native Claude conversations in the same macOS desktop context as sign-in.

- Route Claude stream-json through the owner-only desktop helper when the
  web host runs over SSH. Never silently retry through the SSH process after
  an unavailable or uncertain desktop launch.
- Preserve the native model, image, approval, interrupt and context channels
  with bounded local transport and owned-child cleanup.
- Add an explicit, idle-only upgrade path for an already-installed helper,
  preserving its configuration and credentials with rollback on failure.
- Reconcile Claude streamed text and final results per turn, so a repeated
  final error or answer is not appended twice.

See `docs/release-3.0.48.md` for validation and remaining sign-in boundaries.

## 3.0.47

Make context usage visible and keep missing or historical data honest.

- Show a percentage beside the context ring, or localized Unknown when the
  agent has not supplied enough data. Keep read-only usage separate from
  permission to send messages or choose models.
- Fix OpenCode identity-only polls clearing known model capacity. Load the
  project-scoped catalog on open, preserve same-model metadata, account for
  cache writes, and prevent model/session/host mismatches from painting stale
  percentages.
- Preserve validated Codex last usage observations across reconnects and
  restarts, with an explicit last-reported timestamp and non-live indicator.
  Unobserved history remains unknown; no automatic resume or probe prompt.
- Add render, source-identity, request-race and persistence regressions;
  verify narrow mobile layouts and translated status explanations.

See `docs/release-3.0.47.md` for validation and explicit data boundaries.

## 3.0.46

Improve native task concurrency, reconnects, and safe local setup.

- Codex uses a bounded pool of independent native app-server connections.
  Resume, send, interrupt, approvals, and context usage are thread-scoped;
  busy children and in-flight resumes cannot be evicted or mistaken for idle.
- Add mobile Codex approval cards with full bounded permission details,
  one-shot decisions, and explicit uncertain-delivery state. Never infer an
  approval acknowledgement from a successful response write.
- Reconcile native conversations on foreground/network recovery with
  single-flight polling, without replaying prompts or approval decisions.
- Add opt-in, password-protected loopback OpenCode setup in Settings.
  Existing explicit servers remain untouched; only opt-in is persisted,
  never the generated service password. Await owned-service shutdown.
- Update Codex through its proven original installation source (official
  standalone, npm, or Homebrew), then verify the resulting version. Unknown
  wrappers are not overwritten. Native work/approval reservations block updates.
- Add isolated real Codex composer/parallel checks to three-OS CI. These
  checks use synthetic local providers, not subscription inference.

See `docs/release-3.0.46.md` for validation and remaining device/login limits.

## 3.0.45

Fix two deployment issues exposed by the 3.0.44 two-Mac rollout.

- Installed services with a sparse PATH append their own Node runtime
  directory only if `node` cannot already be resolved. This lets env-node CLI
  wrappers start under launchd while preserving operator PATH precedence.
- Persisted, unloaded Claude conversations and confirmed idle Claude
  processes are history, not pending work. Real prompts, pending permissions
  and unknown states remain protected from updates.
- Rolling installers recognize the exact unloaded Claude history shape from
  older hosts, so stale history cannot indefinitely defer a safe update.

Validation: 1,358 tests passed, 4 skipped, 0 failed.

## 3.0.44

Complete the native Claude Code and Codex composer, including existing installs.

- Claude Code loads its official model list and only confirms a model switch
  after the native control acknowledgement. Codex loads its paginated model list,
  supports model-specific reasoning levels, and sends image attachments through
  the official app-server input format.
- Show native per-turn context usage when reported; leave unknown capacity
  unknown. Clear stale Claude usage on model changes and never substitute
  cumulative session totals for current context occupancy.
- Scope Codex sends and interrupts to the requested thread. A stale browser
  cannot accidentally send to or stop another active thread.
- Apply native defaults to existing installed runtimes as well as new launchers,
  preserving explicit opt-outs and reviewed-version safety checks. Reuse an
  existing owned local OpenCode service configuration on macOS without copying
  credentials into files or logs.
- Add isolated HTTP/composer tests, a mobile UI fixture, and a real Codex
  app-server composer check using only a local mock provider. Model discovery
  and Claude model-switch checks require no paid inference request.

Validation: 1,355 tests passed, 4 skipped, 0 failed. See
`docs/release-3.0.44.md` for native and mobile verification boundaries.

## 3.0.43

Turn on the native paths for Claude Code and Codex.

- Enable Claude Code's documented stream-json mode and Codex's official
  app-server by default in the launcher. Both were already implemented but
  gated behind environment variables that no install ever set, which is why
  Codex ran as a plain terminal connector and Claude Code asked for desktop
  sign-in. Either can still be turned off by setting its variable to 0.
- Promote Codex `0.154.0` from read-only to reviewed. Comparing its generated
  schema set against the `0.153.4` baseline shows 14 of 26 files
  byte-identical, and every difference is additive or irrelevant to what
  Stepsemble writes: the three approval responses it sends are unchanged,
  `ThreadStartParams` is unchanged, `ThreadResumeParams` only gained optional
  properties, and the approval correlation fields it depends on are still
  required. All eight request methods it uses are present.
- Record the `0.154.0` schema baseline and the review evidence, so a later
  release cannot inherit this decision silently. A future version carrying the
  same fingerprint still gets read-only access until it is reviewed on its own.

Validation: 1,328 tests passed, 4 skipped, 0 failed.

## 3.0.42

Verify each composer control against what the connector can actually do, and
stop idle ACP sessions from blocking updates.

- ACP agents now feed the context gauge. Their prompt reply carries the turn's
  token usage, which was being discarded; a live Hermes turn reports 18,450
  tokens.
- Fix a read-only transcript still offering model choice and a context gauge.
  The attachment button already refused, but the other two controls did not
  check the read-only markers.
- Pin the capability matrix in a test, so a connector cannot silently gain a
  control its wire format cannot honour.
- Report an idle ACP session (Cline, Kilo Code, Hermes, Grok Build) as history
  rather than "waiting". The same mislabelling was fixed for OpenCode in
  3.0.34; it survived here and silently blocked an install on this host,
  because the update guard treats a waiting task as active work.

Verified live on this host: Hermes accepts an image prompt and replies, its
ACP session advertises no model option and says so rather than showing an
empty sheet, Codex opens as a terminal connector and therefore exposes none of
the three controls, and Claude Code requires desktop sign-in before a session
can start.

Validation: 1,328 tests passed, 4 skipped, 0 failed.

## 3.0.41

Bring model choice and the context gauge to the connectors that can support
them.

- Cline, Kilo Code, and Hermes gain model selection. ACP exposes this as a
  session config option rather than a dedicated model API, so the adapter now
  reads the options an agent advertises and applies a change through
  `session/set_config_option`. An agent that offers no model choice says so
  instead of showing an empty sheet.
- OpenCode sessions show the context gauge. The native server already reports
  per-turn token totals and the model that produced them, so that feeds the
  existing dashboard rather than a second, parallel one.
- Prefer OpenCode's own reported total over a locally computed sum, so the
  figure always matches what the agent accounts for.

Validation: 1,326 tests passed, 4 skipped, 0 failed; verified against live
OpenCode sessions that real token totals are reported and that the computed
share matches the agent's own total.

## 3.0.40

Stage files and commit them from the project changes view.

- Each changed file gets a stage toggle, and the header gains a Commit action
  that stays inert until something is staged. Reviewing a change on a phone no
  longer has to end with walking back to the computer to run `git add`.
- Staging and committing reuse the same repository validation as the read
  path. Every file is resolved through the existing containment check, and
  arguments reach git as an argv array, so a path or message never touches a
  shell.
- The service still holds no destructive command: there is no checkout, reset,
  clean, stash, or push. An empty commit is refused rather than silently
  created.

Validation: 1,324 tests passed, 4 skipped, 0 failed. Verified against a live
repository that staging, committing, and the containment and empty-commit
refusals all behave as intended.

## 3.0.39

Send image attachments to every connector whose wire format carries them.

- Claude Code, OpenCode, Grok Build, Cline, Kilo Code, and Hermes now accept
  images. Previously the attach button was hidden for everything except Pi, so
  the most common mobile action — screenshot a problem and ask about it — only
  worked with one agent.
- Each vendor receives its own documented shape: Anthropic content blocks for
  Claude Code, ACP image blocks for the ACP agents, and file parts for
  OpenCode. One shared module applies the same count, size, and MIME limits to
  all of them.
- Terminal-only CLI connectors keep the attach button hidden, because their
  stdin takes text and an attachment there would be silently dropped.
- A malformed attachment is dropped on its own instead of discarding the valid
  images behind it or failing the whole prompt.

Validation: 1,321 tests passed, 4 skipped, 0 failed; verified against a live
OpenCode session that the delivered message carries both a text and a file
part.

## 3.0.38

Correct the privacy documentation and remove two dead code paths.

- The README still described native Claude Code and Codex history as an
  opt-in development candidate that "does not scan private history". Reading
  those transcripts is now default behavior on macOS and Linux, so the section
  states which paths are read, how to change them, that Windows is
  unsupported, and that the access is read-only and grants no resume,
  approval, or model authority. The Traditional Chinese README carries the
  same text.
- Remove `loadUpdateStatus()`, a wrapper that only forwarded to
  `refreshUpdateCenter()`, and `readOnboardingState()`, which had no
  callers.

Validation: 1,317 tests passed, 4 skipped, 0 failed; verified on this host
that the default roots are in use and that only a read-only route is exposed.

## 3.0.37

Correct the last stale count in the conversation catalog browser fixture. A
title search over the 132-record fixture matches seven rows — six task
records plus the one Pi history that shares the title — but the check still
expected six from when the fixture held 131 records. Every count in that
suite is now reconciled against the catalog's actual output.

Validation: 1,317 tests passed, 4 skipped, 0 failed.

## 3.0.36

Repair the cross-platform test matrix.

- Skip the native history catalog tests on Windows and assert the boundary
  there instead. Reading provider transcripts requires POSIX ownership and
  mode checks, so the catalog reports itself unsupported on Windows rather
  than reading those files; the tests asserted the POSIX result everywhere.
- Correct the conversation catalog browser fixture, which still expected 31
  rows on its final page after the fixture grew from 131 to 132 records.

Validation: 1,317 tests passed, 4 skipped, 0 failed.

## 3.0.35

Keep the session list stable while agent tasks are polled.

- Redraw the Sessions list only when the task rows it shows actually change.
  Every five-second poll previously rebuilt the whole list, which discarded
  the row under the user's pointer and paid for a full sort and re-layout on
  each tick. Elapsed time and last activity keep updating through their own
  ticker.
- Skip the POSIX permission-bit assertions in the two harness update tests on
  Windows, where file access is governed by the inherited ACL instead. This
  restores the Windows CI job.

Validation: 1,317 tests passed, 3 skipped, 0 failed.

## 3.0.34

Stop presenting stored OpenCode conversations as pending work.

- An idle native OpenCode session is now published as history instead of
  "waiting". On this Mac mini that changed 26 rows that each claimed to be a
  queued task, some showing elapsed times over 100 hours.
- Remove the Stop button from those rows. The native server refuses an abort
  for an idle session, so the button could only ever fail.
- Keep them out of the Agent Hub preview and the Active filter, while All
  conversations still lists them and reopening one still allows new messages.
- Teach the macOS, Linux, and Windows updaters that a stored conversation is
  not active work, so old rows cannot block an update.

Validation: 1,316 tests passed, 3 skipped, 0 failed, including a new
regression that pins this behavior.

## 3.0.33

Make Agent Hub launches recoverable and actionable across the three most-used
CLI harnesses.

- Fall back to the supervised OpenCode CLI when its native server rejects a
  project directory, while keeping native sessions for directories it accepts.
- Preserve structured launch error codes through the Host and browser so
  Claude Code sign-in and unavailable cross-device folders open the right
  recovery path instead of showing an opaque failure.
- Keep Claude Code's official desktop sign-in boundary intact; Stepsemble never
  substitutes another account or silently bypasses the vendor client.

Validation: 1,315 tests passed, 3 skipped, 0 failed; live Mac mini launch
checks for OpenCode, Claude Code, and Codex completed with the expected
capability boundaries.

## 3.0.32

Expose OpenCode's native model catalog and session model switching in the
Stepsemble composer. The selected `providerID/modelID` is sent on subsequent
prompts, and unsupported vendor check flags remain neutral instead of looking
like failed updates.

Validation: full Node test suite, client/syntax checks, protocol checks, and
live OpenCode model-catalog verification passed.

## 3.0.31

Promote the stable multi-agent bridge surfaces for Claude Code and ACP-based
connectors.

- Claude Code structured sessions now use the documented host-control channel
  for native `can_use_tool` allow/deny responses, keep approval state bounded,
  and send a native interrupt without confusing it with closing a session.
- Cline, Kilo Code, and Hermes use a standard ACP v1 stdio adapter for session
  creation/loading, streaming updates, permission options, cancellation, and
  bounded reconnect state. Each connector keeps an explicit CLI fallback flag
  when its local ACP executable is unavailable or rejects the request.
- Keep credentials, private session databases, and vendor-owned account state
  outside Stepsemble; upstream ACP/CLI load semantics remain the authority for
  cross-restart history.
- Keep Codex native mutation behind the exact reviewed app-server version gate;
  newer alpha builds fail closed to the bounded CLI path until separately
  reviewed.

Validation: 1,296 tests passed, 3 skipped, 0 failed; syntax/session checks,
client artifact, protocol conformance, version synchronization, diff checks,
and a restart soak passed with cleanup confirmation.

## 3.0.30

Harden the multi-agent hub and add conservative connector coverage.

- Reconcile Claude Code structured session status, native session IDs,
  timestamps, terminal state, and confirmed child cleanup; task inventory keeps
  active Claude and Antigravity sessions visible after a browser reload.
- Keep Codex native resume bound to the exact requested thread when mutation
  mode is explicitly enabled; read-only native history never shows a misleading
  Stop or Send action, and reject unreviewed CLI versions before app-server IO.
- Add allow-listed Cline, Kilo Code, and Hermes connectors with coding/personal
  grouping, maturity metadata, local offline source marks, and safe bounded
  fallbacks. Their private credentials and session stores remain untouched.
- Bound the home Agent Hub connector/task preview while retaining a complete
  searchable task center, and document the promotion gate for future native
  adapters.

Validation: 1,291 tests passed, 3 skipped, 0 failed; client artifact, syntax,
session, protocol, version, and diff checks passed.

## 3.0.29

Keep mobile launches on the Sessions home instead of reopening the last chat.

- Desktop reloads still restore the last conversation for continuity.
- Touch devices with a narrow viewport skip automatic chat/task restoration on
  startup, while explicit deep links and user taps continue to open sessions.
- Returning from a mobile back-forward cache page also resets to Sessions.

Validation: full client, syntax/session, protocol, and Node test suites passed.

## 3.0.28

Fix the Agent Hub Task center Stop action on iPhone-sized layouts.

- Reset native button appearance so Safari does not apply a platform-specific
  shape or baseline to the task action.
- Give Stop a stable, centered 60–64px trailing control with a 44px touch
  target; long task names, timestamps, and narrow rows can no longer squeeze
  or distort it.

Validation: client build check, full syntax/session checks, protocol checks, and
the release workflow.

## 3.0.27

Add opt-in structured adapters for Claude Code and Grok Build, plus a second
opt-in Codex native mutation surface with explicit approval confirmation.

- Claude Code uses the public stream-json / JSONL input / resume contract and
  keeps bounded session events plus subagent correlation without inventing a
  permission ACK.
- Grok Build uses the public ACP stdio contract, renders bounded permission
  options, and only answers an optionId offered by the upstream request.
- Codex native writes require `STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1` and an
  owner-only intent journal; approval pipe writes remain awaiting confirmation.
- Add allow-listed native project directories, process cleanup, pending routes,
  Agent Hub task opening, and cross-harness capability documentation.

Validation: 1,286 Node tests passed, 3 skipped, 0 failed; syntax/session checks,
protocol conformance, and short synthetic restart soak passed.

## 3.0.26

Make Codex native history genuinely pageable in the conversation view.

- Add an accessible “載入更早的訊息” control whenever the bounded turns/items
  pages expose a native cursor.
- Keep independent turns/items cursors, retain already loaded older pages across
  live polling, merge overlapping turn/item pages by stable IDs, and preserve the
  user's scroll anchor while older content is inserted.
- Retry a failed bounded page without discarding its cursor; the Codex surface
  remains explicitly read-only with no send, resume, abort, or approval controls.
- Keep missing middle pages reachable after a burst of new messages; show a
  localized gap notice until they are loaded. Abort stale reads when changing
  host or conversation, and reuse unchanged message nodes during polling.
- Fix a native CI timing assertion: an interrupt already confirmed in the same
  stdout chunk is valid; the test still requires the matching interrupted turn,
  zero executed commands, and no fabricated approval acknowledgement.
- Do not indefinitely defer updates for explicitly idle Codex/OpenCode native
  history rows. The macOS updater and all three installers still block genuine
  pending work, missing idle evidence, and contradictory running status.

Validation: 1,277 Node tests passed, 3 skipped, 0 failed on macOS; eight executable frontend
controller regressions, Codex transport cursor coverage, protocol conformance,
JavaScript checks, and version synchronization.

## 3.0.25

Add an explicit, read-only Codex app-server history adapter.

- Show native Codex threads in Agent Hub and All conversations only when
  `STEPSEMBLE_CODEX_NATIVE=1` is explicitly enabled.
- Hydrate the conversation view through bounded metadata, turn, and item pages;
  large rollout history no longer blocks the page with one oversized read.
- Keep private rollout paths out of browser DTOs and keep Codex send/resume/abort
  and approval actions unavailable until a separately verified native contract
  exists.

Validation: real Codex 0.153.4 probe, full Node suite (1,265 passed, 2 skipped),
JavaScript checks, and version synchronization.

## 3.0.24

Keep Task center activity timestamps readable in narrow action columns.

- Show the compact local date/time in each task row while retaining the full
  translated “updated” phrase as a tooltip and accessible label.

Validation: full Node suite, JavaScript checks, and version synchronization.

## 3.0.23

Make the Agent Hub Task center easier to scan on phones and small windows.

- Turn the task center into a bounded, mobile-first sheet with a clear handle,
  compact header, searchable toolbar, and an independently scrolling task list.
- Keep task cards to the useful hierarchy: task name, agent/status/elapsed time,
  workspace path, and an output preview only when output exists.
- Preserve visible Stop actions with accessible task-specific labels and touch
  targets, while adding a compact path tooltip for truncated workspaces.
- Add smoke coverage for the task center's dialog semantics, mobile geometry,
  independent scrolling, and compact rendering contract.

Validation: full Node suite (1,259 passed, 2 skipped), JavaScript checks, and
version synchronization.

## 3.0.22

Keep the conversation catalog browser coverage aligned with a collapsed Agent Hub.

- Expand the live Agent Hub preview in the conversation catalog case before
  asserting task rows, preserving the clean default on the Sessions page.

Validation: full Node suite, JavaScript checks, and rolling browser coverage.

## 3.0.21

Keep the synthetic Pi session browser coverage aligned with a collapsed Agent Hub.

- Expand the live Agent Hub preview in the browser case before asserting the
  stopped Pi task row, preserving the product's clean collapsed default.

Validation: full Node suite, JavaScript checks, and rolling browser coverage.

## 3.0.20

Keep browser compatibility coverage aligned with the Settings-based Claude sign-in panel.

- Update the synthetic Claude auth browser cases to open Settings before
  interacting with the moved sign-in disclosure, including after reload.

Validation: full Node suite, JavaScript checks, and rolling browser coverage
against the released Settings layout.

## 3.0.19

Keep the Sessions page focused while preserving access to agent controls.

- Move the Claude Code sign-in disclosure from Agent Hub into Settings → Agent
  sign-in, and pause its status polling whenever Settings is hidden.
- Make the Agent Hub live task preview collapsible, collapsed by default, with
  an accessible disclosure button and a device-local remembered preference.
- Move the Sub Agent sessions preference from the Sessions page into Settings
  → Behavior, while keeping the opt-in session query and count behavior intact.

Validation: Agent Hub, auth placement, settings preference, JavaScript checks,
and the full Node suite.

## 3.0.18

Keep active Agent Hub tasks inside a bounded live preview.

- Mark the Agent Hub card while a task is starting, running, or reconnecting so
  asynchronous task rows cannot expand the sidebar through flex min-content
  sizing.
- Reserve a compact card height for active work and keep the task list's
  vertical scroll surface inside that card, leaving the Sessions heading and
  list reachable.

Validation: Agent Hub layout smoke coverage, JavaScript checks, and the full
Node suite.

## 3.0.17

Keep Sessions visible when Agent Hub has dense content.

- Bound Agent Hub to a compact flex panel instead of allowing its contents to
  stretch the main sidebar.
- Give connector chips their own horizontal scroll surface and task rows their
  own vertical scroll surface.
- Reserve the Sessions heading and list viewport so the main conversation list
  remains reachable on small screens and dense workspaces.

Validation: layout smoke coverage, JavaScript checks, and the full Node suite.

## 3.0.16

Show every agent conversation in the main Sessions list.

- Merge Pi history with native and generic Agent Hub task records in the main
  list, including OpenCode sessions and their agent logos.
- Keep stable cross-agent keys for selection and pins, while retaining Pi-only
  archive/rename actions for Pi files.
- Open agent rows through their native or generic session route and keep the
  list refreshed when task discovery completes.

Validation: cross-agent session-list tests, full smoke suite, and live Mac mini
OpenCode session verification.

## 3.0.15

Conversation catalog and Agent Hub layout fix.

- Refresh the Agent Hub task snapshot when the All conversations sheet opens
  and when a background task refresh completes, so native OpenCode sessions
  cannot be hidden behind an early Pi-only snapshot.
- Keep native OpenCode rows in the shared conversation catalog with their
  source identity and logo.
- Turn Agent Hub into a bounded live preview: show active work first and only
  the latest idle row, while preserving the complete list in View all.
- Bound the Agent Hub card to its own scroll surface so Sessions remains
  reachable on small screens and dense workspaces.

Validation: Agent Hub race tests, conversation catalog tests, full smoke suite,
and live Mac mini OpenCode verification.

## 3.0.14

Release-gate fix for native OpenCode history rows.

- Keep completed OpenCode sessions visible in the task center without treating
  their projected `waiting` status as active work.
- Allow the verified updater to proceed when native OpenCode reports
  `isRunning: false`, while continuing to defer for real active sessions.

Validation: full Node suite, cross-platform CI, native history boundary, and
rolling browser compatibility.

## 3.0.13

OpenCode visibility fix for the macOS SSH launcher.

- Carry an existing owner-only `com.jerome.opencode-web` launchd service into
  the Stepsemble child process so the Agent Hub can discover the configured
  OpenCode native server after a restart.
- Keep other launch modes explicit; no random-port scan, `~/.opencode` scan,
  provider-state migration, or HTTP credential exposure is added.

Validation: launcher syntax plus the live Mac mini native probe; the full
3.0.12 runtime contract remains unchanged.

## 3.0.12

OpenCode native server adapter and cross-harness capability audit.

- Add an explicit, opt-in OpenCode adapter for the official local server. It
  verifies health/session/permission routes, passes the selected project
  directory through the upstream API, supports native session/history,
  children, status, async messages, approval responses, abort, and bounded
  restart reconciliation, and falls back to the canonical connector when the
  upstream is not configured or healthy.
- Wire the Agent Hub and conversation UI to native OpenCode sessions,
  approval cards, bounded polling, and restart-safe reconcile checkpoints.
- Keep remote access fail-closed: loopback is the default, remote URLs require
  explicit opt-in and HTTPS, credentials are never copied into checkpoints,
  and response sizes/IDs/cursors remain bounded.
- Publish the capability matrix and official-source audit for Pi Agent,
  OpenCode, Claude Code, Codex, and Grok Build. Sources without a completed
  native contract suite remain explicitly `native_readonly`,
  `structured_ack_required`, or `canonical_bounded`.
- Add adapter fixtures, directory-scoping coverage, single-flight probing,
  startup retry, protocol/client checks, and the live OpenCode 1.18.5 route
  verification used for this release.

Validation: full Node suite, syntax/protocol/client checks, and the live
OpenCode server integration probe must pass before the v3.0.12 tag is pushed.

## 3.0.11

Cross-platform CI stability hotfix for 3.0.10.

- Make the isolated soak tolerate only the bounded supervisor reconnect window
  after a Host restart; terminal and unknown 409 responses still fail loudly.
- Make the access-token integration test reserve a kernel-selected loopback
  port so Windows system-reserved ports cannot cause false failures.

Validation and platform-specific evidence are recorded in
[`docs/release-3.0.11.md`](docs/release-3.0.11.md).

## 3.0.10

Windows durability and startup-fallback hotfix for 3.0.9.

- Use explicit Windows `whoami.exe`/PowerShell paths and typed ACL
  constructors, including directory inheritance for SQLite WAL/SHM files.
- Treat a journal worker that cannot pass its owner/ACL gate as unavailable;
  generic tasks keep the bounded snapshot path and the catalog removes durable
  capabilities instead of failing every task launch.
- Keep the exact 3.0.9 capability and ACK contract unchanged while adding the
  startup regression coverage needed for this fallback.

Validation and platform-specific evidence are recorded in
[`docs/release-3.0.10.md`](docs/release-3.0.10.md).

## 3.0.9

Durable Agent Hub and cross-platform capability-boundary release.

- Enable the generic canonical session journal on Windows behind an explicit
  owner-only PowerShell DACL gate. The journal directory is protected before
  SQLite opens so WAL/SHM siblings cannot inherit a broader ACL; failures stay
  bounded and fail closed instead of pretending to be durable.
- Add capability-aware catalog/task metadata for native Pi history, prepared
  Claude/Codex read-only sources, bounded CLI history, host-local journals and
  the authenticated dedicated peer relay.
- Replace the misleading generic `approval_protocol` capability with explicit
  observation and `approval_ack_required` markers. Decisions remain durable,
  while acknowledgement and resume require exact `STEPSEMBLE_ACK` evidence.
- Keep official CLIs without that adapter contract in `awaiting_confirmation`;
  no native transcript, subagent store or cross-host replication is fabricated.

Validation and platform-specific evidence are recorded in
[`docs/release-3.0.9.md`](docs/release-3.0.9.md).

## 3.0.8

Small fix release, no feature or roadmap changes.

- Fix the stable-release updater leaving its recorded status at an
  intermediate "health check" phase after a successful update. The updater
  now writes the final "updated" phase once the new release passes its
  health check, matching what the service is actually running.

## 3.0.7

Stable incremental release of the verified work below, not completion of the
entire cross-agent roadmap. Native history remains explicit opt-in; upgrading
does not grant access to private conversations or alter provider accounts.

- Ship the approved B+ brand assets and agent-specific conversation marks.
- Improve the conversation browser, mobile inner scrolling, localized history
  controls, preserved focus/scroll and stale/busy/recovery feedback.
- Fix Pi worktree launches incorrectly appearing failed, retain native session
  names and SSE, prevent duplicate starts, and enforce project-folder boundaries.
- Add local source-group setup/management and bounded read-only Claude/Codex
  history, including original names, WAL/cold metadata, raw/structured pages,
  compressed large rollouts and cross-page tool links. These require separately
  configured trusted readers/SDK and owner-selected sources; the installer does
  not automatically build helpers or scan private agent directories.
- Fix history mode-switch/cancel races; share a two-reader resource limit and
  require actual process cleanup before admitting replacement work.
- Validate Codex paginated native item reads with owned fixtures and fix
  turn-scoped item identity. Paginated private-source/Web integration is still
  unavailable, as are full cross-agent native resume/durable approvals.
- Harden update/release validation and retain compatibility aliases and
  automatic code rollback on failed post-update health checks.

Validation: full/minimum-Node regression and platform/browser/native gates are
recorded in [the release manifest](docs/release-3.0.7.md). The completed 72-hour
test covers its frozen rc.1 workload only, not this later release runtime.

## 3.0.7-rc.7

Development candidate, not a stable release or a production deployment. This
section summarizes the rc.7 history and launch-safety increments; earlier
intermediate limitations are retained in the linked engineering documents.
The separately frozen rc.1 soak does not certify this later runtime.

- Connect opt-in Codex legacy history to the actual Host, source catalog,
  HTTP/peer transport and read-only Web view. Preserve original session IDs and
  native names with SQLite/name-index precedence and version-fenced pagination.
- Read active-WAL and cold SQLite metadata without repairing or writing the
  source. POSIX descriptor, owner, ACL and local-filesystem checks remain strict;
  Windows private native-history sources are explicitly unsupported.
- Support bounded small plain/Zstandard rollouts and separate large-page
  profiles for both encodings. Stream large concatenated Zstandard sources in
  Rust; keep physical-file and decoded-content proofs distinct, preserve plain
  sibling priority and retain the shared reader permit/deadline during negotiation.
  Verify whole-source revisions and reject stale, malformed or
  unsupported sources without replacing a valid displayed page with empty data.
- Show source-linked turns, native IDs, rollback state and bidirectional tool
  navigation across large-history pages. Preserve unknown and original records
  in raw mode; never execute historical tools or present this as native resume.
- Verify a real owned 17.2 MB / 16,384-record Host fixture, including direct jumps,
  off-page changes, original IDs and cross-page links. This is not a maximum-size
  capacity, mixed-load or physical-mobile performance certification.
- Share the Host's two-reader admission limit across inventory, Claude and Codex
  pipelines. Retain permits until actual worker close; reject late/stale results
  and quarantine unconfirmed cleanup rather than silently starting more work.
- Fix mode-switch and cancel/refresh races where browser fetch cancellation can
  precede Host cleanup. Preserve the displayed history, disable unsafe navigation
  during cleanup and provide explicit manual recovery without automatic retries.
- Add a local English/Traditional Chinese setup wizard for new Claude/Codex
  source groups. Review exact roots and reader scope before CREATE; never select
  private sources, overwrite an existing configuration or activate a service.
- Manage multiple source groups locally with inspect/add/replace/edit/remove,
  exact before/after review and a new inactive candidate. Preserve manual grants
  and original files; require explicit SDK adoption, reject changed reviews and
  never imply that candidate removal revokes access on the running Host.
- Localize read-only history controls, errors and accessibility text in all
  eleven existing languages. Preserve native content, DOM, focus and scroll
  through locale changes; bound history cards and retain independent inner scroll.
- Use optimized, pinned Rust readers in owned browser CI on macOS and Linux.
  Retain all 24 existing and six Codex cases and the finite suite deadlines;
  preserve the original macOS debug-build timeout as a diagnosed failure.
- Attach new Pi worktrees to their native session/SSE connection, preserving the
  name and canonical project path. Coalesce repeated starts and fence cancelled
  or old-Host responses; close only newly opened, confirmed-idle native sessions.
- Start the project picker at an allowed home or its first valid configured
  root. Keep the root chooser navigation-only, disable Start while folders load,
  and apply the existing project-directory policy to new Pi sessions.
- Reject managed worktrees outside the configured directory policy before
  creating a directory or Git branch. Do not silently add browse roots; retain
  existing session-resume policy and potentially useful partial worktree data.
- Validate release tags against the package version and explicitly mark RC
  assets as prereleases, never latest stable. Keep legacy asset aliases and
  provenance; invalid tags or unknown classification fail before publication.

Unsupported Codex paginated/native projections,
other agents' native-history adapters, durable approval/resume, full source-group
management and physical-device/platform acceptance remain open. No additional
provider login, model call, private-source grant or production change is included.
See [the release review](docs/release-review-2026-09-09.md),
[current Web checkpoints](docs/web-completion-loop.md) and
[large structured history evidence](docs/codex-structured-source.md) and
[large compressed history acceptance](docs/codex-large-compressed-history.md).

## 3.0.7-rc.6

Development candidate; production Hosts remain on 3.0.6. The independent,
fixed-source 72-hour soak is unchanged and does not cover this candidate.

- Add a fixture-only Codex 0.153.4 history RPC boundary and native owned-home
  regression runner. Verify legacy history and original names without executing
  turns; record unsupported item pagination and paginated-store gaps explicitly.
  This does not enable private Codex history or add a new Web source.
- Add a source-group browser to the read-only Claude history page: explicit
  inventory refresh, 50-row snapshot-fenced pages and an independently scrolling
  mobile list with the existing local Claude mark.
- Read only visible row names, one at a time; preserve native titles separately
  from summaries, with full-text expansion for long names and no model calls.
- Keep row focus and opened content stable as names arrive. Abort obsolete
  requests, serialize content cleanup and open only the latest selection.
- Show stale, busy, missing-name and revoked-source states explicitly; pause
  name loading in the background and retain the manual catalog as a lazy fallback.
- Do not add private source grants, automatic home-directory scanning, new native
  resume/approval support or production deployment.
- Revalidate HTML entry documents so an updated history page does not keep
  loading yesterday's versioned scripts from a day-long document cache.

## 3.0.7-rc.5

Development candidate; production Hosts remain on 3.0.6. The fixed-source
72-hour soak is unchanged and does not cover these newer changes.

- Add a unified, per-Host conversation browser for visible Pi histories and
  Stepsemble task records, with local agent logos, source/type filters, search,
  fixed 50-row pages and an independently scrolling mobile list.
- Preserve native Pi titles and exact file identity when a live Pi task refers
  to the same conversation; task process exit never overwrites the saved title
  or turns the conversation into a failed task. Same titles across agents stay separate.
- Clearly distinguish terminal task output from native history; this does not
  add automatic discovery or native resume/approval for other agents.
- Keep list snapshots stable until explicit refresh, retain records on transient
  source failures, and resolve selected rows against the current Host at click time.
- Fence running-state polling by Host/view and coalesce slow requests; a late
  response or malformed snapshot no longer clears another Host’s running badges.
- Make completed/interrupted CLI task output explicitly read-only. Preserve
  drafts while reconnecting, wait for a validated task snapshot before enabling
  input, fence obsolete SSE callbacks by exact connection/Host/view, and stop
  terminal EOF retries. Replayed lifecycle events cannot revive an ended task.

## 3.0.7-rc.4

Development candidate; production Hosts remain on 3.0.6. The fixed-source
72-hour soak is unchanged and does not cover these newer changes.

- Add leading local agent marks to sessions, Agent Hub, the task center and
  conversation headers, keeping status indicators and accessible agent names.
- Replace the Pi-only composer placeholder with a neutral prompt in all 11
  interface languages so other agents are not mislabeled as Pi.
- Distinguish harness identity from selected models: Codex and GPT use different
  marks; Pi stays Pi regardless of its model. Unknown sources use a neutral mark.
- Precache pinned, attributed SVG assets for offline display; no per-row external
  image requests or new runtime dependencies. Keep Stepsemble's B+ logo unchanged.
- Reserve explicit GPT/ChatGPT presentation mappings without claiming a new
  connector or automatic discovery of all native histories.

## 3.0.7-rc.3

Development candidate; stable Hosts remain on 3.0.6. The fixed-source 72-hour
soak continues unchanged and does not cover these newer changes.

- Connect the bounded Claude read-only history pipeline to the application Host
  behind explicit operator configuration and per-credential source grants.
- Add a separate history tab with local/paired-host routing, inert message
  rendering, pagination, stale-page recovery and accessible mobile controls.
- Retire history scopes on logout, successful login, token/grant revocation and
  peer replacement; wait for owned reader cleanup during Host shutdown.
- Keep history routes out of the legacy proxy and history documents out of the
  offline SPA fallback. Version new assets with the current client cache.
- Keep native accounts, approval/resume authority and production deployment
  unchanged. Native source reading is opt-in POSIX only; Windows remains gated.

## 3.0.7-rc.2

Development candidate; stable Hosts remain on 3.0.6 pending verification.

- Replace the former hand-balanced Step Mosaic with the user-approved B+
  vector master: one module and one coordination ribbon repeated at exact
  90-degree rotations around the true centre.
- Give the standard mark equal 16% optical margins and retain a more generous
  safe area in a separate maskable PWA icon.
- Add dedicated 16 px and 32 px favicon artwork, a transparent monochrome
  glyph source and integrity checks for every promoted raster derivative.
- Keep the fixed-source 72-hour runtime soak on its original rc.1 source; this
  brand-only candidate does not restart or retroactively alter that evidence.

## 3.0.7-rc.1

Development candidate; stable Hosts remain on 3.0.6 pending verification.

- Discover session files asynchronously with four metadata workers and shared
  in-flight scans; bound cache size, scan entries and request waiting time.
- Preserve native title/filter semantics and refresh same-size replacements;
  failed whole-store reads return an error instead of an empty history list.
- Actually enforce the 400-file search and 8 MiB usage-file limits, including
  files growing during reads; yield during summary/search/usage parsing.
- Add isolated eight-task/two-client-per-task recovery stress tests with both
  graceful and forced HTTP Host restarts, exact synthetic ACK checks and cleanup.
- Provide a fixed-source, clean-commit 72-hour soak runner with bounded reports,
  observation-gap detection and self-expiring synthetic peers. A short CI test
  is not a completed 72-hour or native session/approval certification.

## 3.0.6

- Wait for verified generic Agent reattachment and actual CLI exit when
  stopping; concurrent stop requests share one bounded operation. Unconfirmed
  stops remain active and retryable instead of falsely reporting completion.
- Do not kill a persisted supervisor PID when its control connection is down;
  retain Windows owned-tree cleanup and reject input while stopping.
- Preserve session-list DOM, keyboard focus and scroll when opening a chat;
  update only selection and its accessible current-state marker.
- Surface chat stop failures so a lost connection is not silently ignored.
- Restore archives across Host restart without overwriting conflicting newer
  files; clean up only empty directories and preserve unknown recovery files.

## 3.0.5

- Bound the New project folder list to its own scroll area while preserving
  the outer form scrollbar and access to Agent settings and Start here.
- Add a labelled, keyboard-focusable folder region, native touch scrolling,
  a stable scrollbar gutter and scroll-position reset when opening a folder.
- Exercise 200 folders, nested wheel/keyboard scrolling, empty folders and
  reachable bottom controls at desktop, mobile and short-screen sizes in CI.
- Do not reload and discard an open form when the offline cache activates for
  the same version already displayed by the browser.

## 3.0.4

- Display the approved full-colour Step Mosaic on the workspace, sign-in,
  onboarding and empty conversation, without redrawing the source artwork.
- Separate the workspace identity from the host selector, label New project,
  wrap all Agent chips on narrow screens, and enlarge key touch targets.
- Fix Pi idle shutdown being reported as Failed, unify native session titles,
  and protect work starting concurrently with session closure.
- Fence Agent Hub responses by host and request identity; do not turn failed
  discovery into a fabricated installed-agent status.
- Precache the colour logo and limit service-worker cleanup to known app shells.
- Clear closed-chat content at every viewport size, so widening a mobile list
  cannot reveal a stale conversation in the desktop pane.
- Include the previously tested protocol, dialog recovery, bounded streaming,
  recoverable archive and opt-in Claude desktop-helper work from the rc series.
- Publish under Apache-2.0 with preserved legacy and third-party notices.
- Other CLI agents remain terminal integrations, not full native history or
  structured approval parity. Rust, native Apps, physical-device and long-soak
  gates remain on the roadmap.

## 3.0.4-rc.4

Development candidate; not activated or published as a stable release.

- Prevented intentional idle Pi SIGTERM/143 shutdowns from appearing as Failed;
  genuine crashes, active interruption and observed model failures stay visible.
- Protected prompt preflight, pending dialogs/commands, streaming and compaction
  from stale close requests; fenced sends/reuse after close intent and concurrent
  metadata opens before spawning another writer.
- Unified Pi titles across lists, Agent Hub, chat, search and export: latest
  native name (including resets), then first user text; never the JSONL filename
  or latest assistant answer on the new Host. Native history is not migrated.
- Added isolated lifecycle/race and desktop/mobile browser regressions, plus a
  separate PWA cache identity. Not deployed or published as a stable release.

## 3.0.4-rc.3

- Added an opt-in macOS Aqua desktop Claude broker for both official sign-in
  and task supervisor launch. The SSH Web Host is preserved; no credential
  copying, shell/env injection or fallback to SSH when the helper is absent.
- Added owner-only IPC, single-use launch tickets, bounded admission and
  persistent uncertain-operation guards. Existing terminal tasks can reconnect
  after Web/helper restarts without repeating their launch.
- Added a real macOS GUI-context offline fixture and explicit helper installer.
  Native metadata was detected through SSH-to-desktop IPC on the trial host;
  this is not a successful model/login or complete native history/approval test.

## 3.0.4-rc.2

- Prevented known macOS SSH hosts from treating desktop Claude authentication
  as signed out or launching another login. These hosts require a desktop
  execution helper; the main SSH service remains unchanged.
- The local rc.1 trial was rolled back to 3.0.3 after the real authentication
  context check failed. This candidate is not deployed or a stable release.

## 3.0.4-rc.1

- Added the guarded Claude Code sign-in entry in Agent Hub. The installed
  official CLI opens the Host browser; Stepsemble does not relay OAuth material.
- Includes the unreleased reliability, protocol, native Pi dialog and browser
  recovery work documented in `docs/platform-plan.md` 1.24. Reference protocol
  planners are not a completed durable store or full native-agent parity.
- Assigned separate asset queries and a service-worker cache for the trial.
  No stable GitHub release or automatic rollout to other devices is implied.

## 3.0.3

- Made the exact user-approved 1254 px Step Mosaic artwork the canonical brand
  source instead of continuing with an approximate hand-redrawn SVG.
- Regenerated the Apple touch and PWA icons directly from that source, and
  derived the monochrome interface mask from the same silhouette.
- Removed the inaccurate coloured SVG redraws from active use and locked the
  canonical source checksum in the brand regression test.

## 3.0.2

- Corrected the Step Mosaic vector construction so every violet coordination
  inset overlaps and remains visibly attached to its ivory agent module,
  including at small icon sizes.

## 3.0.1

- Replaced the literal cat-paw-and-terminal mark with a vendor-neutral Step
  Mosaic: four equal agent modules move in one rhythm, and each reveals the
  same violet Stepsemble coordination layer.
- Added matched full-colour app, rounded logo, monochrome mask, Apple touch,
  and maskable PWA artwork without assigning any provider a privileged brand
  colour.

## 3.0.0

- Adopted the Stepsemble name, with a new cat-paw-and-terminal identity
  for a workspace that coordinates multiple coding agents.
- Preserved existing legacy state through an additive migration:
  private configuration, tokens, device trust, task journals, browser
  preferences, cookies, environment variables, and pairing codes remain
  readable while all new writes use Stepsemble names.
- Added upgrade-aware macOS, Linux, and Windows installation paths so the
  public rename does not move Pi sessions, provider credentials, approvals,
  or project files.
- Bumped the pairing protocol emitted by new hosts to `STEPSEMBLE3` while
  accepting `PIHARBOR3` and the token-authenticated `PIHARBOR2` transition
  format.

## 2.13.2

- Fixed empty usage dates inheriting the global empty-state padding, which
  stretched the About card into large gaps on mobile.

## 2.13.1

- Fixed the Settings → About usage card leaking the `usage.title` key and
  stretching empty days into large gaps on narrow screens.
- Usage rows now use intrinsic compact tracks, and the renderer repairs the
  heading/list semantics when an older PWA shell reconnects.
- Service-worker shell installs and navigations now bypass HTTP-cached HTML so
  releases cannot reopen with stale layout or localization resources.

## 2.13.0

- Generic Agent Hub tasks now run under an independent per-task supervisor,
  reconnect after a Stepsemble service restart, preserve elapsed time/output,
  and are marked interrupted when the supervisor is truly gone.
- Added a searchable Agent Hub task center with status filters, replay, native
  Pi stop controls, automatic reopen of the last generic task, and push
  notifications for unattended Agent completions.
- Added a versioned connector manifest/event contract, Linux systemd and
  Windows Scheduled Task installers, cross-platform CI, and updater health
  checks with automatic macOS rollback when a release fails to start.
- Settings wheel gestures now forward from the fixed toolbar/overlay edges,
  while language choices keep their local names (English, 简体中文, 繁體中文,
  and more).

## 2.12.1

- Agent discovery now checks the common Homebrew, user-bin, npm, Volta,
  asdf, Bun, and Hermes paths in addition to launchd's PATH. Installed Codex,
  Claude Code, and OpenCode CLIs therefore remain selectable when Stepsemble is
  started as a background service.

## 2.12.0

- Added Agent Hub connectors for the native Pi Agent plus installed Claude
  Code, Codex CLI, Grok Build, and OpenCode executables. Connector ids are
  allow-listed, project paths are validated server-side, and arbitrary shell
  commands are never accepted from the browser.
- Added a streamed task inbox with per-task elapsed time, reconnectable SSE,
  bounded private output journals, isolated Git worktrees, and background
  execution after leaving or closing the browser.
- Added a dependency-free Unix PTY bridge for interactive CLIs (with a safe
  pipe fallback on Windows or hosts without Python), plus truthful detached /
  orphaned states after a supervised restart.
- Added localized Agent Hub labels and a one-second local clock that updates
  without rebuilding the task list, preserving scroll position and focus.

## 2.11.2

- Automatic updates and fresh installs now fall back to the public GitHub
  release page when the unauthenticated GitHub API rate limit is exhausted.
  The archive and SHA-256 checksum are still downloaded and verified before
  activation.

## 2.11.1

- macOS devices now use the system ComputerName as the default Stepsemble
  label, while retaining the network hostname for connectivity. A hostname
  such as `Mac.lan` no longer replaces a friendly device name in the UI.

## 2.11.0

- Archiving is now reversible. Session archive, project archive, and project
  removal skip the blocking confirm and show a toast with a 7-second Undo
  button; the server gained a validated unarchive action that moves the
  snapshot back to its original location. Flows touching credentials or
  irreversible steps keep their confirms.
- Fixed during development of this release (never shipped): the unarchive
  path initially required the destination file to exist and then deleted the
  snapshot regardless, which would have destroyed the archived session. It now
  validates destinations without requiring existence and only removes the
  snapshot when every captured file returned home.
- Keyboard shortcuts on the list: / focuses search, n opens the new-project
  dialog, arrow keys walk the rows. All are suppressed while typing, while the
  palette, setup guide, or any dialog is open.
- The command palette gains "Settings → Devices / Access tokens / Connection /
  Appearance / About" jump targets and live filtering while typing (it only
  re-rendered on open and Enter before), and session/device names no longer
  run through the phrase translator, which was mangling them.

## 2.10.0

- Reloading Stepsemble now returns to the conversation the user had open
  instead of the session list, including a run that is still in flight: the
  chat reattaches to the live process and the elapsed timer continues. The
  last chat is remembered per device.
- Sidebar rows lead with a compact recency stamp (Just now / 5m / 2h / 3d), so
  scanning for recent work no longer relies on sort order.
- The running-state poll no longer rebuilds the whole sidebar every five
  seconds. It now polls the cheap /api/rpcs endpoint and redraws only when the
  visible running set actually changes (a run started, settled, or flipped its
  stuck flag); elapsed-time text keeps ticking via the existing 1s updater.

## 2.9.0

- Closing and reopening Stepsemble mid-run now shows what is still working. The
  session list marks a running conversation with a pulsing dot and its elapsed
  time ("Running for 27s"), so the first screen after reopening answers whether
  the host is still busy instead of looking idle.
- The elapsed time comes from the run on the server, so it is the real duration
  after a reload or from another device, and it keeps ticking while the list is
  open. The badge clears itself when the run settles.
- The list refreshes every five seconds only while it is visible and something
  is actually running; an idle app makes no extra requests.

## 2.8.1

- Fixed broken English (and every other non-Chinese locale) in runtime
  messages. Around 65 user-facing strings were authored as Chinese sentences
  and translated by phrase substitution, which produced output such as
  "Connection，workStill …" for a restored connection and "Enabled：" when a
  conversation failed to open. They are stable translation keys now, so
  connection, retry, compaction, provider setup, and device management all
  read as real sentences in all 11 locales. A test fails the build if a new
  hardcoded sentence appears.

## 2.8.0

- The chat header now shows how long the current turn has been working, next
  to the Thinking/Working status. It ticks every second while the run is live
  and keeps the final duration once the answer arrives, so a long run is
  visibly progressing instead of looking frozen. Format is seconds, then m:ss,
  then h:mm:ss, in tabular digits so the header does not shift on each tick.
- The elapsed time belongs to the run, not the browser tab: the server records
  when the turn started and hands it back on reconnect, so reloading the page
  or opening the session on another device continues the same clock instead of
  restarting at zero.

## 2.7.1

- A supervised server no longer outlives the process that started it. A script
  that spawned Stepsemble and then failed before its own cleanup left the server
  holding a port and an open stdio pipe, which kept the caller's event loop
  alive: both sides waited for each other and the calling Agent run appeared
  frozen with no output for hours. The server now notices that it has been
  re-parented and stops through the normal drain path, so the caller fails fast
  instead of hanging. Set `PI_HARBOR_ORPHAN_EXIT=0` to opt out; launchd and the
  SSH launcher are unaffected.

## 2.7.0

- Provider config portability: export the whole models.json provider list to
  a JSON file (secrets strictly opt-in with a plain warning) and import it on
  another device; every imported provider passes the same validation as the
  editor, and same-id providers are replaced explicitly.
- Full-text session search: sidebar queries of two or more characters now
  also search inside recent session transcripts (bounded scan, snippets),
  with results that jump straight into the matching conversation.
- Local usage summary: Settings → About shows the last seven days of tokens
  and cost aggregated from local session files only — no third-party APIs.
- PWA push notifications: opt in from Settings → About; the host sends a
  signed Web Push (VAPID + aes128gcm, implemented with node:crypto only)
  when a run settles with no browser attached, and tapping it opens the app.
- Session action sheet gained "Export as Markdown": user/assistant turns,
  collapsed thinking blocks, tool-call summaries, and provider errors.

## 2.6.0

- Wedged pi runs no longer block auto-updates forever. A run streaming with
  no browser attached and no events for 15 minutes is treated as stuck: the
  updater may apply pending releases while it exists, and the sidebar shows
  a quiet amber banner with a one-tap Force stop.
- The model picker gained a search field and a per-row thinking badge
  (max / xhigh / high) computed from the model's own capability map, so it
  is obvious which models keep `max` before switching.
- Added a command palette (Cmd/Ctrl+K on desktop): jump to recent sessions,
  switch model or device, start a new session, toggle Sub Agent sessions, or
  open Settings without leaving the keyboard. Arrow keys and Enter navigate,
  and Escape closes it like any other dialog.

## 2.5.5

- The mobile model chip is wider still (200px, 140px on very narrow screens)
  and may shrink gracefully when space runs out, so long model names stay
  readable without pushing the send button off the toolbar.

## 2.5.4

- The composer's model chip is wider on every screen size (240px desktop,
  150px mobile, 124px on very narrow screens), so long entries such as
  "GLM-5.3-Flash (2x usage) · max" stay readable instead of truncating early.

## 2.5.3

- Desktop project rows now reveal the same compact segmented capsule as
  mobile: 32px buttons with 15px icons in a solid hairline capsule with a
  matching collapse chevron, replacing the oversized ghost icons that
  appeared on hover.
- Collapsed project and pinned groups keep a small gap (6px, 4px in compact
  mode) between cards so fully collapsed lists no longer read as overlapping
  borders.

## 2.5.2

- Sidebar geometry: project cards inside the session list now keep the exact
  width of the search box and the Sub Agent filter above them. The list
  reserved a scrollbar gutter (and classic scrollbars narrowed it further),
  which made every project card visibly shorter than the fixed rows on
  desktop while mobile was unaffected. The sidebar scrollbar is now hidden;
  touch and wheel scrolling are unchanged.
- The mobile project row's "+" and "…" actions were redesigned into a
  compact segmented capsule with a matching 32px collapse chevron, replacing
  the oversized floating ghost icons.

## 2.5.1

- Fixed Ollama model thinking metadata. Ollama's `/api/tags` list does not
  include thinking capability; provider setup now checks `/api/show` and
  records the model's `reasoning` flag and supported thinking levels. Ollama
  models that support it now expose `max`, while GPT-OSS correctly exposes
  only `low`, `medium`, and `high` because Ollama cannot fully disable or
  raise its thinking level beyond those values.

## 2.5.0

- The session sidebar now keeps itself up to date. A brand-new session
  appears as soon as its first message is persisted, and settled runs refresh
  the list, so sub agent sessions and previews no longer wait for a manual
  reload.
- The Sub Agent filter row in the sidebar was reworked: a short constant
  label with a state note ("Hidden by default" / "Showing") and a bare count
  replace the long bilingual strings, and the card now shares the session
  rows' inset, radius, and height so it lines up with the project cards.
- Fixed thinking levels silently resetting to off. Pi clamps the thinking
  level to what the selected model supports, and models added through the
  provider editor were saved without the reasoning flag — so every level was
  clamped to off. The provider form now carries a thinking marker per model
  and preserves model fields across edits, the composer re-reads the clamped
  level instead of trusting the request, remembers your last choice, and
  restores it when a session or model switch drops it. Existing ollama-cloud
  GLM/Kimi/MiniMax entries on hosts upgraded from earlier releases keep the
  reasoning flag the editor used to drop.
- Added read-only resource sync in Settings. Pick any two devices to compare
  the global Pi extensions, skills, and installed packages on each host, with
  identical entries collapsed and differences highlighted. The inventory is
  scan-only (no secrets, no symlink escapes) and installs nothing.

## 2.4.5

- The model picker now matches the selected model on provider + id instead of
  id alone. The same model id can be offered by several providers (e.g.
  glm-5.3-flash on both Ollama Cloud and OpenCode Go, or GPT 5.6 Luna on both
  OpenAI Codex and OpenCode Go); picking it used to tick every provider's row
  at once. The checkmark and highlight now land only on the provider that was
  actually selected, with a safe id-only fallback when provider info is
  missing.

## 2.4.4

- Added a live task-progress panel above the composer. Pi plan/todo widgets and
  plan text now appear as a compact Running indicator with an expandable,
  clickable checklist; completed steps remain visible in session history.

## 2.4.3

- The sign-in screen now explains how to read the Web token on macOS, Linux,
  and Windows. The host's own platform is preselected, PowerShell and Command
  Prompt each get their correct syntax, and the commands are never rewritten by
  the locale layer. The README carries the same per-OS commands.

## 2.4.2

- Settings now scrolls from anywhere on the page. The desktop scroller spans
  the full window and centres its cards with padding, so the wheel no longer
  stops working when the pointer sits beside the content column.
- The language picker lists every language in its own language (English,
  简体中文, 繁體中文, 日本語, …) instead of English names, and takes its labels
  from the same locale registry the setup guide already used.
- Escape now closes overlays everywhere: the setup guide, device and pairing
  dialogs, provider setup, new-project and rename dialogs, action sheets, the
  model picker, the image viewer, and inline access-token forms. It closes
  only the topmost layer, then leaves Model settings and Settings in turn.

## 2.4.1

- Fixed a localization feedback loop introduced by the new access-token
  controls. Keyed `title`, `aria-label`, and `placeholder` attributes are now
  rewritten only when their translated value changes, so opening Stepsemble no
  longer pins the browser renderer at 100% CPU.

## 2.4.0

- Vendored Mermaid 11.12.1 and load it lazily from the Stepsemble host, so
  diagram sources stay private and Mermaid rendering works offline. The CSP
  no longer permits jsdelivr; upstream license notices are included beside
  the bundle.
- Added optional independent browser access tokens in Settings → Access
  tokens. The installer/master token can issue labelled tokens, each is shown
  only once and can be revoked independently, and the server stores only
  SHA-256 hashes in a 0600 token store. Issued tokens retain the existing
  single-user host access model; they are not separate Pi accounts.
- Release workflows now publish GitHub OIDC artifact attestations for the
  archive and checksum in addition to the existing SHA-256 verification;
  no long-lived signing private key is stored in the repository.

## 2.3.4

- Removed the provider-account quota feature entirely (per feedback): the
  popover again focuses on the conversation's own usage — context, input,
  output, cache hit percentage, and cache write — with the ring trigger and
  all 2.3.x layout refinements kept. Third-party balance APIs varied too
  much in reliability and semantics to be worth the maintenance.

## 2.3.3

- OpenCode Go quota headers are scoped to the calling model's bucket, so the
  probe previously reported an unused model's empty bucket (0% used) instead
  of the subscriber's real usage. The probe now walks the GLM family first
  (glm-5.3, glm-5.2, glm-5.1) followed by configured and documented models,
  preferring the first bucket with non-zero usage and logging every raw
  bucket for diagnosis.

## 2.3.2

- MiniMax coding-plan quota requires web-session authentication: the endpoint
  answers "cookie is missing" to API-key auth. The popover now reports this
  state honestly, and a session cookie can be provided per provider in
  `~/.config/pi-harbor/provider-cookies.json` (mode 0600); cookies are sent
  only back to their own provider and never logged.
- The OpenCode Go probe now tries the models actually configured for that
  provider before the documented defaults, because quota headers are scoped
  to the calling model's bucket.

## 2.3.1

- Simplified provider-account rows: usage windows are labelled just
  "5-hour quota", "Weekly quota", "Monthly quota" under the provider name
  instead of repeating the provider prefix.
- Fixed credential-store region mapping for MiniMax: preset id `minimax` is
  the international endpoint (api.minimax.io) and `minimax-cn` the Chinese
  one, so auth-stored MiniMax keys no longer query the wrong region.
- Added bounded parse-failure diagnostics for provider quota lookups and raw
  OpenCode Go quota header values in the server log to make remote
  troubleshooting possible without exposing credentials.

## 2.3.0

- MiniMax quota lookups now distinguish an invalid or non-coding-plan key
  ("sign in again") from a missing API, and automatically retry the
  provider's other region (China/global) before giving up; Zhipu GLM quota
  lookups gained the same region fallback.
- The OpenCode Go quota probe walks the cost-ranked documented model list
  until quota response headers appear instead of relying on a single model
  name, and logs one bounded diagnostic line when every probe fails.

## 2.2.9

- Provider quotas now cover subscription account logins, not just API keys:
  the snapshot merges models.json with Pi's credential store, so every
  configured provider appears in the popover.
- OpenAI Codex (ChatGPT) shows the 5-hour and weekly usage windows from the
  same backend endpoint the Codex CLI and pi-usage extension consume, using
  the stored OAuth token and its embedded account id.
- OpenCode Go quotas are read from the quota response headers of a minimal
  probe request against the cheapest documented Go model (one probe per
  cache window), mirroring the community approach.
- Subscription providers without any queryable endpoint are labelled
  honestly instead of being omitted.

## 2.2.8

- Extended provider quotas to subscription coding plans, following the same
  community endpoints used by cc-switch and GLM Monitor: Zhipu GLM Coding
  Plan (open.bigmodel.cn / api.z.ai `usage/quota/limit`) shows the 5-hour and
  weekly token windows with reset times plus MCP monthly calls, and MiniMax
  (`coding_plan/remains`) shows remaining call counts. Plan auth follows each
  provider's convention (raw key for Zhipu, Bearer for MiniMax).
- Quota responses now distinguish an invalid key ("sign in again") from a
  provider without any quota API.

## 2.2.7

- The context gauge is now the only composer indicator: the ring (still
  state-colored) opens the usage popover on tap, and all token figures live
  inside it, replacing the separate exclamation button.
- Added a provider-accounts section to that popover: for configured paid
  providers with a known quota API (DeepSeek, OpenRouter, SiliconFlow) it
  shows the remaining balance; providers without one are marked honestly.
  Queries run host-side against allowlisted endpoints, cache for ten minutes,
  and never return credentials or raw provider payloads.

## 2.2.6

- Added a read-only project Changes inspector with a changed-file badge,
  staged and working-tree diffs, Git-safe path scoping, desktop split view,
  mobile file-to-detail navigation, and complete copy in all 11 locales.
- Prevented the generic locale pass from re-translating Traditional Chinese
  chrome, eliminating mixed strings such as `work階段`, `五min`, and
  `MorePROJECT操作`; the fully localized setup guide is now isolated from the
  generic DOM translator.
- Added bounded, automatically saved composer drafts scoped by device and
  session, so switching conversations restores each draft independently instead
  of carrying one prompt into another chat.
- Split the mobile setup guide into an independently scrolling content area and
  a fixed action area, keeping every instruction visible above Continue.
- Kept the 320px composer inside the viewport by collapsing its inline context
  numbers to the existing progress ring while retaining full details in the
  accessible usage popover.

## 2.2.5

- Fixed chat image enlarging: tapping or clicking a chat image never opened
  the viewer because the gallery handler re-normalized an already-normalized
  attachment and silently rejected it. Normalization is now idempotent, so
  sent and received images open full-screen again, with a regression test.
- The context ring and its numbers now sit directly beside the usage-details
  button on the right, leaving the free toolbar space between the model chip
  and the indicator.

## 2.2.4

- The context progress bar became a compact circular progress ring beside the
  usage numbers, keeping the toolbar to a single slim row; warning (>70%)
  and critical (>90%) colors are unchanged.
- Cache write now shows an em dash with an explanatory tooltip when a provider
  reports no cache writes (most OpenAI-compatible providers only report cache
  hits) instead of a bare 0.

## 2.2.3

- Rebuilt the composer toolbar into one row: attachment button on the left, a
  fixed-width model chip next to it, the context progress bar beside Send, and
  an exclamation button that opens a usage-details popover.
- The model chip keeps a constant size and truncates overlong model names with
  an ellipsis while always keeping the trailing thinking level (for example
  "DeepSeek V3 Fla… · max") fully visible.
- Detailed token figures (input, output, cache hit, hit percentage, cache
  write) moved into the popover; the bar keeps context used, capacity, and
  percentage always visible.

## 2.2.2

- Added an always-visible conversation context dashboard in the composer: current
  context used versus model capacity, percentage, cumulative input/output tokens,
  cache-hit tokens, cache-hit percentage, and cache writes, sourced from Pi's
  authoritative `get_session_stats` (never from cumulative totals).
- Unknown context estimates after compaction are shown honestly while retaining
  known capacity and totals; no polling — stats refresh on open, assistant
  message completion, compaction, model changes, and run boundaries.
- The model & reasoning control is now compact and sits beside Send/Stop;
  the freed toolbar space carries the dashboard (three-column metrics on
  mobile, single row on desktop) with 320px-safe, reduced-motion, and
  screen-reader support in all 11 languages.
- Session/history wire formats now preserve Pi's full usage components
  (input/output/cacheRead/cacheWrite and nested cost) alongside legacy totals.

## 2.2.1

- Corrected all 11 setup-guide locales to recommend independent `PIHARBOR3`
  credentials and reserve the shared Web token only for legacy manual URL entry.

## 2.2.0

- Added one-time `PIHARBOR3` pairing with independent, revocable per-peer
  credentials, dedicated bearer relay authentication, and legacy shared-token
  fallback for manual and previously saved devices.
- Added local pairing review, sanitized incoming-grant management, atomic trust
  storage, installer/updater archive preflight, pinned CI action revisions,
  keyed device/pairing localization, and synchronized release version tooling.
- Mermaid remains a runtime CDN dependency; release signing is still future work.

## 2.1.2

- Hardened the one-time access-key reveal against DNS rebinding and unexpected
  reverse proxies by requiring both the TCP source and HTTP Host to be loopback.
- Fixed duplicate onboarding element IDs and CSS collisions so both the access
  key flow and the reusable setup guide keep their own labels and Skip actions.
- Replaced unsigned pairing codes with short-lived HMAC-authenticated v2 codes;
  candidate URLs no longer receive a reusable login cookie before trust is proven.
- Corrected the Traditional Chinese access-key wording and added live server
  integration tests for token reveal and credential-safe device pairing.
- Bumped the application and PWA resources to 2.1.2.

## 2.1.1

- Added a hardware-wallet-style first-run onboarding that reveals the private
  access key once on the host computer before sign-in, gated behind two
  confirmations and never shown again after they are saved.
- Restricted the key reveal to loopback requests without forwarding or
  Tailscale headers, and stored the one-time confirmation beside the token
  file with owner-only permissions.
- Bumped the application and PWA resources to 2.1.1.

## 2.1.0

- Added a touch-safe left-edge swipe back from Settings with shared cleanup and
  reduced-motion-safe transitions.
- Fixed the first New project folder load to use the selected host's safe home
  request and ignore stale or non-absolute paths.
- Added localized first-login token guidance, expanded the setup guide for
  devices and LLM providers, and documented token retrieval in every locale.
- Fixed localization collisions that could corrupt words such as “Project” and
  kept user-provided folder names and paths unchanged.
- Bumped the application and PWA resources to 2.1.0.

## 2.0.9

- Added a localized multi-device update center with per-device versions, phases,
  last/next check times, and an Update all devices action.
- Made deferred updates explicit while Agent work is active and applied them
  immediately after the final active RPC settles, with a final updater safety gate.
- Bumped the application and PWA resources to 2.0.9.

## 2.0.8

- Prevented browsers from caching the service worker for 24 hours, which could
  leave an installed mobile PWA displaying the previous Stepsemble release.
- Rechecked the service worker when the app is opened or returns to the
  foreground, bypassing the HTTP cache for update checks.
- Compared the loaded client with the origin server after a manual update and
  reloaded automatically when a newer application bundle is ready.
- Displayed the selected device's live Stepsemble version in About instead of
  relying only on the version baked into the original HTML.

## 2.0.7

- Reorganized Settings into clearer Connection, Appearance, Behavior, About,
  and Advanced groups, with updates and version details together under About.
- Reduced session-list clutter by showing the large New project card only when
  empty and using one compact top-bar action once sessions exist.
- Combined model and reasoning selection into one composer control, unified
  live Agent status, and improved long-response typography and touch targets.
- Added a compact device health indicator and lighter, more consistent visual
  treatment across settings cards and controls.
- Requested portrait orientation for the installed mobile PWA, with a
  best-effort Screen Orientation API lock on supported touch devices.

## 2.0.6

- Added one quiet, collapsed task receipt after a tool-using run settles,
  showing only its reliable outcome, edited-file count, and tool count.
- Kept receipts out of ordinary text replies and preserved the existing
  thinking, tool output, usage, and error details behind disclosure.
- Distinguished completed, failed, interrupted, and missing-final-response
  runs without treating intermediate retries or queued continuations as final.
- Localized task receipts across all 11 supported languages.

## 2.0.5

- Replaced the inactive desktop composer with one clear New project action
  until a conversation is opened or created.
- Changed the send control from a paper plane to a minimal upward arrow while
  keeping the separate stop state unchanged.
- Preserved mobile background conversation content when returning to the
  session list, and prevented the inactive composer from flashing on load.

## 2.0.4

- Made first sign-in wait for the authoritative device catalog before loading
  sessions or opening the setup guide, so devices appear immediately without
  closing and reopening Stepsemble.
- Added bounded retries and a visible retry action for temporary device-list
  failures without retrying expired authentication.
- Kept the selected local or remote device stable while refreshing the catalog,
  with an additional safety refresh when the first-run guide is dismissed.

## 2.0.3

- Gave Pine Milk its own pine-and-cream palette. It previously had no colours
  of its own and fell back to the default theme, so it looked identical to
  Ink & Ivory.
- Kept a saved Pine Milk selection instead of resetting it to the default.
- Drew the in-app brand mark from the theme's text colour with no plate behind
  it, so it reads light on dark themes and dark on light themes.

## 2.0.2

- Kept an automatically updated v1 service on its configured token file, port,
  host, and browse roots by reading the previous environment variable names as
  a fallback. Without this, an updated v1 install started with a throwaway
  token and rejected every sign-in.

## 2.0.1

- Fixed the final legacy-folder migration step in the macOS installer.
- Preserved the local SSH launcher across repeated installations and verified
  that health checks belong to the newly installed release.

## 2.0.0

- Renamed the complete product, runtime paths, service labels, storage keys,
  pairing format, and deployment assets under the v2 product identity.
- Introduced the original Terminal Dock logo and application icon.
- Added a macOS one-click installer and recoverable uninstaller, with optional
  official Pi Agent installation.
- Moved automatic updates to checksum-verified stable GitHub Releases and
  deferred activation while Pi work is running.
- Added a multilingual first-run guide that can be reopened from Settings.
- Preserved existing sessions, providers, projects, and Web token during the
  local v1 migration.
