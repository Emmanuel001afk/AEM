# AEM

AEM is a personal software distribution store. It can discover GitHub repositories, queue Android source builds, store produced APKs in its own Supabase artifact storage, and distribute releases through the shared web + Android clients.

Core pipeline: source -> existing build -> release artifact -> release event -> AEM ingestion -> validation -> publication -> install/update.

The foundation is domain-first, provider-neutral, event-driven, storage-neutral, installer-aware, partner-aware, and designed for shared web + Android clients. GitHub is the first source provider. Android package identity, signing identity, and version code remain deterministic security boundaries; AI does not decide installation safety.

GitHub is the first source provider. Public repositories can be discovered without private credentials. Private repositories are accessed by the server-side `AEM_GITHUB_TOKEN` GitHub Actions secret; the token is never shipped to the Store client.


## Automatic GitHub Android builds

AEM can queue an Android build from a GitHub repository. The automatic builder runs on GitHub Actions, checks out the requested ref, detects the requested Gradle variant/module, builds an APK, extracts package/version metadata, uploads the APK to the AEM Supabase artifact bucket, and creates the corresponding application, release, and artifact records. The Store reads published artifacts and uses the stored APK URL for installation. GitHub Actions supports scheduled workflows at intervals as short as five minutes, and its workflow artifacts/API can persist and retrieve build outputs. citeturn1search0turn0search0

For arbitrary public repositories, AEM attempts the build automatically. A repository still has to be a buildable Android project and may require project-specific dependencies, secrets, signing configuration, or a different Java/Gradle setup. Private repositories require appropriate GitHub credentials/permissions; AEM does not bypass GitHub access controls.


### Source-driven catalog
The Store catalog is provider-backed. GitHub is the current provider, with private/public repository discovery, APK-family artifact publication, durable AEM Storage copies, and server-side source credentials.
