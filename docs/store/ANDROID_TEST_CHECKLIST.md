# Android store release checklist

Run on a physical Android device using a test app and test data. Record device model, Android version, AEM version, package version, date and results. Do not uninstall an app with valuable data without a verified backup. This checklist is a test plan, not a claim that the tests have passed.

- [ ] Fresh install: allow permission when prompted, confirm Android's installer, and verify the app opens and history says completed.
- [ ] Permission denied: verify the store explains the permission and retry succeeds after permission is granted.
- [ ] Update with matching signing key: install an older version, update, verify data remains and installed version changes.
- [ ] Different signing key: install a test app signed with a different key. Verify the store blocks update, explains the mismatch and warns that uninstalling may erase data.
- [ ] Interrupt network during download: verify a useful failure or pause and that retry/resume works. Check Wi-Fi-only behavior on cellular.
- [ ] Pause, resume and cancel: confirm the controls and displayed statuses match the actual download.
- [ ] Leave the installer open beyond two minutes: verify the store does not report a confirmed failure, and check that Reopen Install or the Android installer can continue.
- [ ] Deny access to download-history service while keeping the artifact reachable: installation should proceed with a local-history warning; verify it finishes and the local record updates.
- [ ] Deny catalog, installed-app detection, and notifications separately: verify useful error feedback and recovery on refresh.
- [ ] Check a release APK against a newer debug APK, debug-only fallback, and a pending APK: confirm the displayed selection and Updates page are understandable. Verify OEA offers only the launcher, not a game APK.
- [ ] Restart AEM during download or installation and check the resulting state against Android. Record any platform-specific limitations.
