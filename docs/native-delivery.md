# Native Windows application delivery

AEM has two connected operations under native delivery:

1. **Deliver a published Windows variant:** application details → assess methods → native Windows. Only HTTPS EXE artifacts with a platform package identity and SHA-256 are offered. AEM downloads, verifies integrity and asks again before handing the installer to Windows. A launch request is not recorded as a successful installation. The details screen queries the exact publisher-provided Windows uninstall identity in the 32/64-bit current-user and machine registry views, compares its platform version, and blocks downgrades. Refresh after finishing the installer. Missing/mismatched publisher registration cannot be inferred from a display name. Registry presence does not prove successful launch; a catalog checksum is not a publisher signature.
2. **Build licensed adapted source:** Devices → Build adapted Windows source. Choose a recipe beside a source tree, explicitly trust its build scripts, and choose local `makensis.exe`. AEM runs local .NET publish for `win-x64`, then NSIS. It produces a real application payload, Setup EXE and `aem-native-release.json` with family/platform identities, version, revision, licensing declaration and SHA-256. No external APK converter is involved.

The first source strategy supports already-adapted .NET WinForms/WPF projects. Projects must target `netX.Y-windows`, enable WinForms or WPF and specify their own `ApplicationIcon`. The source author must implement Windows UI, business logic and replacements for Android APIs. AEM does **not** automatically port Kotlin/Java/DEX, wrap APKs, or claim that arbitrary Android apps can be built for Windows. No existing third-party app has been ported or tested in this change.

Example **recipe format**, not a bundled or verified application:

```json
{
  "schema": 1,
  "familyId": "org.publisher.application",
  "androidPackage": "org.publisher.application.android",
  "windowsAppId": "org.publisher.application.windows",
  "displayName": "Publisher Application",
  "version": "1.2.3",
  "project": "windows/Application.csproj",
  "executable": "Application.exe",
  "sourceRevision": "exact reviewed source revision",
  "license": "licence permitting this source build and distribution"
}
```

The project path must remain inside the selected source directory; output is in Downloads/AEM Native Builds. Building MSBuild projects executes code with your user privileges. Source trust must be established **before** approving. Revision/license fields are declarations, not legal verification or cryptographic provenance.

Generated NSIS installers are per-user with Start Menu entry, executable icon reference, version registration and uninstaller. Application data is retained. Successful compilation is not a passing installation, shortcut, icon, launch, update or uninstall test. Those tests remain required for each adapted application. Run 43584297929 passed a repository-owned WinForms fixture through build, NSIS, install, real window launch, shortcut/registration and uninstall. This fixture is not a third-party Android port. MSIX, automatic source adaptation, remote build recipes, signed native catalog provenance and unattended native update orchestration are not implemented.
