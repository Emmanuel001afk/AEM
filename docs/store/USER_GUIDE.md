# Using AEM Store

## Platforms

- **Android:** Browse apps, install ready Android packages, and check updates. Android may ask you to allow installation from AEM Store and confirm the installation. Install and update behavior still needs verification on physical devices for each release.
- **Windows:** The desktop app can offer native Windows installers, supported phone delivery, and an Android emulator. See [desktop setup](../desktop/README.md). Emulator setup may require a large download and a capable Windows PC; see [limitations](../limitations.md).
- **Web:** Browse the catalog and download supported artifacts. Browser access does not provide Android's native installation or Windows desktop features.

An internet connection is needed to refresh the catalog and download apps. An unavailable catalog, download history, or notification service should be treated as a temporary error, not proof that an app is absent.

## Releases and updates

For Android, AEM prefers a ready release APK over a debug APK, then selects the newest suitable version. A debug APK is used when no suitable release APK is available. A newer APK may be displayed under **Updates** as not ready while it is being prepared. On Windows, published GitHub releases are preferred and workflow builds are used as a fallback.

## Installation and troubleshooting

1. Open an app, choose Install or Update, and follow Android's confirmation screen. If Android requests permission to install unknown apps, allow AEM Store and retry.
2. If the status has not been confirmed, check the Android installer and use **Reopen Install** where available. Refresh the catalog to recheck installed versions.
3. If the installed app and the store release have different signing keys, Android cannot update one with the other. Back up data first: uninstalling can erase app data. Only uninstall the existing app and reinstall if you accept that risk. AEM's replacement signing key cannot update apps signed with the previous key.
4. If history is temporarily unavailable, the store attempts to keep a local record and continues installation. Local records may not survive clearing app data and are not synchronized later. If device storage is unavailable, the record may not persist at all.

## Privacy

AEM intentionally includes builds from connected public and private repositories. Store catalog entries and published files may be public. Download history is associated with a device identifier, not a signed-in account, so it should not be treated as confidential. Avoid placing sensitive information in app metadata or download filenames.
