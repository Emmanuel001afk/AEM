# AEM

AEM is a personal software distribution store. It does not build applications. Existing projects build and publish their own release artifacts; AEM discovers, validates, registers, stores metadata for, and distributes those releases.

Core pipeline: source -> existing build -> release artifact -> release event -> AEM ingestion -> validation -> publication -> install/update.

The foundation is domain-first, provider-neutral, event-driven, storage-neutral, installer-aware, partner-aware, and designed for shared web + Android clients. GitHub is the first source provider. Android package identity, signing identity, and version code remain deterministic security boundaries; AI does not decide installation safety.

This first implementation establishes the release/distribution core without running a build and without requiring an AEM Supabase project yet.
