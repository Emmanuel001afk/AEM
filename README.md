# AEM

AEM is a personal software distribution store. It uses GitHub as its source provider, receives published APK artifacts, stores them in its own Supabase artifact storage, and distributes releases through the shared web + Android clients.

Core pipeline: GitHub source -> published artifact -> AEM ingestion -> validation -> publication -> install/update.

The foundation is domain-first, provider-neutral, event-driven, storage-neutral, installer-aware, partner-aware, and designed for shared web + Android clients. GitHub is the first source provider. Android package identity, signing identity, and version code remain deterministic security boundaries; AI does not decide installation safety.

GitHub is the first source provider. Public repositories can be discovered without private credentials. Private repositories are accessed by the server-side `AEM_GITHUB_TOKEN` GitHub Actions secret; the token is never shipped to the Store client.


## GitHub source and release pipeline

AEM uses GitHub as the source-of-record provider for applications. The Store does not expose a manual source-build control: it consumes published release metadata and APK artifacts, validates package identity, signing identity, and version code, and then installs or updates from the single latest eligible release for the selected channel.

The Android Store APK itself is built by the repository's GitHub Actions release workflow. Its signed APK is published into AEM's Supabase artifact storage, where the catalog stores the durable release and artifact metadata used by the web and Android clients.


### Source-driven catalog
The Store catalog is provider-backed. GitHub is the current provider, with private/public repository discovery, APK-family artifact publication, durable AEM Storage copies, and server-side source credentials.

### Android client hardening
The Android wrapper uses the AEM launcher mark, Android package visibility limited to catalog package checks, a secure FileProvider for system installer handoff, and an AEM PackageInstaller session for APK-family packages.

Installer progress and cancellation are emitted by the native Android layer so the Store can show live file state instead of raw byte counters.

### AEM Transfer
AEM Transfer is the Store's direct phone-to-phone channel. Two Android phones build a Wi-Fi Direct link, the receiver explicitly accepts the request, and every file is SHA-256 verified before it is saved to `Downloads/AEM Transfer`. Nothing is uploaded and no catalog row is written.

The screen uses the same visual language as the Store (red `#F04444` accent, radial dark backdrop, 20–22 dp cards, eyebrow labels) and is organised as **Transfer**, **Downloads** and **History**. A foreground service keeps receive sessions alive in the background.

Protocol version 6 adds receiver consent, a declared sender token, replay protection (a retried transfer id cannot create duplicates), path sanitisation, size/count bounds, resume from receiver offsets, and an honest decline path. See [`docs/transfer.md`](docs/transfer.md) for the wire format, permissions, storage layout, troubleshooting and the security model.

Final verification trigger: Android client and installer changes are built from the same main source tree.
