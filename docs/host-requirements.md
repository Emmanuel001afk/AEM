# Host Requirements — AEM Store Desktop + Emulator

See `docs/desktop/README.md` (install) and `docs/emulator/README.md` (runtime). This page is the single checklist for IT/support.

## Windows Desktop (required)

- Windows 10 2004+ (build 19041) x64 or Windows 11. No 32-bit, no Windows 8/7.
- 4 GB RAM min, 8 GB rec. Free RAM ≥ 3 GB at launch.
- 10 GB free disk min, 20 GB rec. UserData: `%APPDATA%/AEM Store`.
- No antivirus exclusion required, but add `AEM-Store.exe` and `userData/android-sdk/emulator` to allowlist if emulator start is slow (AV may scan QCOW2 I/O).
- Network: HTTPS egress to `*.supabase.co`, `api.github.com`, `dl.google.com` (for SDK). Offline catalog works from cache but emulator SDK download needs internet.

## Emulator (when using Android environment)

- BIOS VT-x/AMD-V **enabled** (Diagnostics will fail otherwise).
- **One of:** Windows Hypervisor Platform (Settings → Apps → Optional Features → Windows Features → Windows Hypervisor Platform + Hyper-V), or Hyper-V, or Intel HAXM. WHPX is preferred.
- If `bcdedit` shows `hypervisorlaunchtype off`, run as admin: `bcdedit /set hypervisorlaunchtype auto` + reboot.
- GPU: host acceleration auto-detected; SwiftShader fallback if no GPU (slower but functional).

## macOS (future)

- macOS 12+ on Intel or Apple Silicon (arm64 system image).
- Hypervisor.Framework available by default; no extra driver.
- Same RAM/disk.

## Linux (future)

- Kernel with KVM (`/dev/kvm` exists, user in `kvm` group).
- Same RAM/disk; GPU accel via host.

## Unsupported

- Windows 10 S mode, ARM Windows (no x86_64 emulator yet), WSL1 (no nested virt), containers without `--privileged`.
