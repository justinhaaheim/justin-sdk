# Known Mac build problems

Problems found while building Expo apps for the Mac as "Designed for iPad" apps with `justin-sdk mac-build`, each with what you see, its cause, and its fix. `bun run justin-sdk mac-build --problems` prints this file. When an app hits a new one, add it here rather than only to that app's notes (home-base-0jeya.13).

Messages in quotes are as the tools print them. `<Scheme>` and `<path>` stand for your app's values.

## 1. Xcode times out opening the workspace after a fresh prebuild

**What you see:** the terminal build succeeds, then `Xcode build/launch failed after 496s, though the terminal build succeeded … Xcode reported: 683:757: execution error: Xcode got an error: AppleEvent timed out. (-1712)`.

**Cause:** Xcode did not answer the `open` Apple Event within 300 s while it loaded the freshly regenerated workspace. Why it needed that long is not known.

**Fix:** fixed in mac-build (home-base-0jeya.13). It now sends `open` once without waiting for a reply and checks every 2 s whether the workspace has loaded, for up to 15 minutes. It logs `Xcode opened and loaded the workspace in <N>s (<B> of <P> checks found Xcode too busy to answer within 20s).` If the 15 minutes run out, it says how long Xcode had been loading. With a mac-build older than this list, `bun run mac` (no prebuild) right after the failure launches and installs the app.

**Seen:** screenshot-app, 2026-11-19 (the terminal build took 170 s).

## 2. A signing build that starts while the screen is locked drops the Xcode account

**What you see:** the Apple account is gone from Xcode › Settings › Accounts, and later builds fail with "No Accounts" (problem 3).

**Cause:** a build that updates signing (`xcodebuild … -allowProvisioningUpdates`) and starts while the screen is locked cannot read Xcode's credentials from the data-protection keychain, and Xcode then deletes its Apple account. Locking the screen with no build running does not do this. Whether a lock that comes after a build has started does it is not known; the account is read about 1 to 10 s into a build.

**Fix:** every signing step in mac-build (each xcodebuild run, Xcode opening the workspace, and Xcode's own build) first waits for an unlocked screen. While it waits it prints `[signing-guard] The screen is locked (…), so <step> is waiting to start.` and it starts by itself once the screen is unlocked. `bun run justin-sdk signing-guard -- <command>` does the same for any other script. `JUSTIN_SDK_SIGNING_GUARD=off` turns the wait off for one run. If the account is already gone, sign in again in Xcode › Settings › Accounts.

**Seen:** shown on 2026-11-20 (home-base-di8c7). The account loss it explains was first seen on 2026-10-21 (problem 3).

## 3. "No Accounts", or a provisioning profile that lacks a capability

**What you see:** xcodebuild's errors say "No Accounts", or that a provisioning profile lacks a capability such as App Groups or Push Notifications. mac-build then prints `xcodebuild failed; its errors are above.` and the same advice as below.

**Cause:** xcodebuild could not use an Xcode account to create this app's profile, so it fell back to the wildcard "iOS Team Provisioning Profile: \*", which has no App Groups and no push. An app whose cached profile already covers its capabilities still builds, so this can hit one app and not another. The account was most likely dropped by a build started while the screen was locked (problem 2).

**Fix:** sign in again in Xcode › Settings › Accounts (or add your Apple ID), then run the build again. While no account is signed in, an app can build without the target that needs the capability: the screenshot app leaves out its broadcast extension, which needs an App Group, with `PREVIEW_BROADCAST_OVERRIDE=off bun run build:mac` (screenshot-app-m7jy).

**Seen:** health-logger-rn and screenshot-app, 2026-10-21, from a Claude Code session and from a terminal, although Xcode listed an Apple ID. screenshot-app's Mac preview, 2026-11-19, while it carried the broadcast extension.

## 4. The generated project has no signing team

**What you see:** `The generated project has no DEVELOPMENT_TEAM (<path>/project.pbxproj), so xcodebuild cannot sign it.` Without that check, xcodebuild compiles for minutes and then stops on "Signing for <target> requires a development team".

**Cause:** xcodebuild never picks a team itself (`expo run:ios` does, which is why an app can build for a device for months without one). Expo writes the team from `ios.appleTeamId` at prebuild.

**Fix:** set `ios.appleTeamId` in the app config (app.config.ts or app.json) to your Apple Developer team id, then run `bun run build:mac` so the prebuild writes it.

**Seen:** health-logger-rn, 2026-10-21.

## 5. The app crashes at launch: React Native's prebuilt framework has no Mac slice

**What you see:** the app crashes at launch with dyld "Library not loaded" for `@rpath/ReactNativeDependencies.framework`, and no window ever appears.

**Cause:** React Native 0.81 and later ships a prebuilt `ReactNativeDependencies.xcframework` with no "Designed for iPad" (Mac) slice. The Mac build links it but never embeds it.

**Fix:** mac-build's prebuild runs pod install with `RCT_USE_PREBUILT_RNCORE=0`, which builds React Native from source. `--skip-prebuild` (`bun run mac`) runs no pod install and keeps whatever the last one chose, so after ios/ was prebuilt some other way (a simulator or Detox prebuild), run the full `bun run build:mac`. Device and EAS builds do not run this command and keep the faster prebuilt framework.

**Seen:** not recorded.

## 6. Xcode launches the app under the debugger and it never runs (Xcode 27.1)

**What you see:** Xcode launches the app suspended ("the debugger is responsible for resuming"), spends 151 s in "Configuring Debugger Actions", and the app never runs: no window, no console output, and no new process for mac-build's launch check.

**Cause:** with LLDB attached, Xcode 27.1 never resumed the app. On Xcode 27.0 the same launch worked.

**Fix:** mac-build sets the scheme's Run action, on every run, to the configured build configuration with no debugger and the plain process launcher. The scheme is generated, and `expo prebuild --clean` rewrites it, so mac-build patches it again each time.

**Seen:** health-logger-rn and screenshot-app, 2026-10-22, Xcode 27.1. It worked on Xcode 27.0 (nature-sounds, 2026-10-12).

## 7. "could not find any valid run destinations" (-10008) after a regenerate

**What you see:** Xcode reports no schemes and no run destinations, or `Xcode still had no "My Mac" run destination for this scheme after 600s.`

**Cause:** two different things. A workspace document that was open in Xcode before `expo prebuild --clean` keeps pointing at the project that used to be there. And right after Xcode takes in a regenerated project, it answers -10008 for minutes while it works through the pod targets.

**Fix:** mac-build closes the workspace in Xcode, stopping the app first, before anything rewrites ios/: before the prebuild, and on the incremental path (`bun run mac`) before it changes the scheme's Run action. So Xcode never holds a project that is regenerated under it, and the next open reads the project on disk (home-base-0jeya.13). It then asks for the run destination every 2 s for up to 600 s. If the 600 s run out, Xcode is almost always blocked on a dialog (problem 8): more waiting will not clear it. `bun run build:mac:no-launch` does not touch Xcode, so close the workspace in Xcode yourself before you run it.

**Seen:** not recorded.

## 8. A dialog in Xcode stops the build

**What you see:** mac-build stops with one of these:

- `Xcode is showing a dialog (<its title, or "a window with no readable title">, <width>x<height>, window number <n>), seen twice 3s apart, and while Xcode shows a dialog it may not answer mac-build, and a workspace it is opening may not load (problem 8 …)`, before it uses Xcode or right after it rewrites ios/.
- `Xcode has shown a dialog (…) for 30s while <path> had not loaded (problem 8 …)`, while it waits for the workspace to load.
- `Xcode did not answer within 60s when asked to close <path>, and Xcode is showing a dialog (…)`, or the same for "stop the app running from". When no dialog can be seen: `Xcode did not answer within 60s when asked to close <path>, so it is probably showing a dialog (problem 8 …)`.

With an older mac-build: an Apple Event times out (`AppleEvent timed out. (-1712)`, after 300 s on `close` alone), or the wait for the workspace runs its whole 15 minutes, or Xcode reports no run destinations however long mac-build waits.

The dialog seen on 2026-11-21 said: The workspace file that was at "`<path>`/ios/`<Scheme>`.xcworkspace" has disappeared. Do you want to re-save the container, or close it? Its buttons are Close and Re-save.

**Cause:** Xcode is waiting on a modal dialog. Which Apple Events a dialog blocks is not known. While the "has disappeared" dialog was up, Xcode's read-only polls for the workspace kept answering, and said it was still loading; the `close` before it got no answer for 300 s. So only the window list shows a dialog. The "has disappeared" dialog came from a prebuild: `expo prebuild --clean` deleted and regenerated ios/ while Xcode had the workspace open. Xcode's log puts it at 2:11am on 2026-11-21, when the second build's close reached Xcode after its prebuild (inferred from the log; nobody saw it appear). Other dialogs are a signing prompt, "stop the running app?", and a trust prompt; closing a workspace whose app is still running under the debugger raises one.

**Fix:** look at Xcode, answer the dialog, and run the build again. For "has disappeared", click **Close**, not Re-save: Re-save would write Xcode's copy of the workspace from memory over the regenerated file (inferred from the button's words, not tried). Xcode 27.2 may crash while it handles this dialog (see Seen below); if it does, open Xcode again and run the build: mac-build opens the workspace itself. If you are not sure what your answer did to the project, `bun run build:mac` regenerates ios/ either way. If mac-build reported no run destinations, also pick the My Mac (Designed for iPad) destination in Xcode and Run once.

What mac-build does about it (home-base-0jeya.13):

- It stops the app, waits for it to exit, and closes the workspace before anything rewrites ios/ (problem 7), so it no longer raises the "has disappeared" dialog itself.
- It reads the window server's list, which needs no accessibility access, for an Xcode window at the modal panel level that is on screen. It does so before it uses Xcode and again after it rewrites ios/, where a dialog seen twice 3 s apart stops the run at once. It does so every 2 s while the workspace loads, whether or not Xcode answers, where a dialog that stays 30 s stops the wait. And it does so when its stop or close gets no answer within 60 s, to say whether a dialog is there.
- It saves a picture of the dialog to `~/.local/state/justin-sdk/mac-build/xcode-dialog-<time>.png` (under `$XDG_STATE_HOME` when that is set) and names the file. It first asks macOS, without a prompt, whether the terminal has screen recording permission. Without it no picture is taken, and the message says so.
- If a window it takes for a dialog is not one, `--no-dialog-check` turns off all three checks that can stop a run: before it uses Xcode, after it rewrites ios/, and while the workspace loads. Run `bun run build:mac -- --no-dialog-check`. The check after a stop or close gets no answer stays on, because it changes only the words of a failure that happens anyway.

**Seen:** health-logger-rn, 2026-11-21. At 2:07am, after the prebuild had regenerated the workspace that Xcode had open from the 1:56am run, the close got no answer for 300 s (`Xcode reported: 291:326: execution error: Xcode got an error: AppleEvent timed out. (-1712)`). The third build's wait for the workspace then ran its whole 15 minutes, to 2:54am, with every poll answering that the workspace was still loading. At 2:59am the "has disappeared" dialog was on screen: in the window server's list it was owned by Xcode, at layer 8, on screen, 410x432, with no title. At 10:51:30am Xcode crashed with the dialog still up: SIGABRT from Xcode's own assertion in `-[IDEContainer _canClosePreflightWithCheckedContainers:error:]`, called from `-[IDEDocumentController responseToExternalChangesToBackingFileForContainer:fileWasRemoved:]` (crash report `~/Library/Logs/DiagnosticReports/Xcode-2026-11-21-105130.ips`). Whether Close had just been clicked is not known. The Apple account was still listed in Xcode afterwards.

## 9. The terminal build and Xcode's build recompile each other's work

**What you see:** Xcode's build, right after a terminal build that succeeded, recompiles a large part of the project again (856 of about 2,600 objects, 83 s, measured).

**Cause:** xcodebuild and Xcode send different build requests (xcodebuild adds ACTION, COLOR_DIAGNOSTICS and diagnostic_message_length), so their task signatures differ and each invalidates the other's work. This cannot be fully removed.

**Fix:** mac-build picks one builder per path. The incremental path (`bun run mac`) lets Xcode build alone. After a prebuild it builds in the terminal first, because that build is minutes long either way and the terminal shows progress and real compiler errors.

**Seen:** audio-journal-1, 2026-08-17.

## 10. Xcode never reports the build's status (Xcode 27.1)

**What you see:** `Xcode never reported the build's status (it answered 11 times with a reference it could not resolve), so the launch was requested anyway; whether the app came up is judged from the process list.`

**Cause:** Xcode 27.1 can answer the build-status request with a reference it cannot resolve (-1700) instead of a value.

**Fix:** none needed. mac-build requests the launch anyway and confirms it from the process list.

**Seen:** health-logger-rn, 2026-10-22.

## 11. Opening the built app directly fails

**What you see:** opening the `.app` from DerivedData fails with "incorrect executable format", and `xcrun devicectl` does not list this Mac as a device.

**Cause:** the product is an iOS binary. Only Xcode can install and launch a Designed-for-iPad app on the Mac.

**Fix:** let mac-build launch it through Xcode. It then copies the app Xcode installed into `~/Applications/<Scheme>.app`, which opens like any other app. `bun run mac:install` copies the last Xcode install without building.

**Seen:** not recorded.

## 12. Closing the stale workspace never ran

**What you see:** after a prebuild, the workspace that was open in Xcode stays open, and mac-build prints `App did not exit within 20s of Xcode stopping it; terminating it directly.` A build can also fail with `Xcode was not running 31s after it was asked to open <path>: it quit, or crashed, while opening it.` while Xcode is running.

**Cause:** inside `tell application "Xcode"`, `it is not running` is always true, whether Xcode is running or not. The scripts that stop the app and close the stale workspace (problem 7), and the check that waits for the workspace to load (problem 1), each began with `if it is not running then return "not running"`. So the stop and the close returned at once and did nothing, and every check answered that Xcode was not running.

**Fix:** fixed in mac-build (home-base-0jeya.13). Each of those scripts now asks `application "Xcode" is not running` before its `tell` block. A test fails if any script in mac-build tests `it is not running` again. Once the close ran, it ran after the prebuild and hit a dialog (problem 8), so it now runs before anything rewrites ios/ (problem 7).

**Seen:** the stop and the close never ran from 2026-10-21, when mac-build was written; the screenshot-app log of 2026-11-19 shows the message above. The load check failed in health-logger-rn on 2026-11-21. The first close that ran, in health-logger-rn on 2026-11-21 at 2:07am, got no answer for 300 s (problem 8).
