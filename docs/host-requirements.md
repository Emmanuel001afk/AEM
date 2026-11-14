# Host resources and the Latitude 3190 target

## Store versus emulator

AEM Store's Windows desktop, native application delivery and phone display are independent of the emulator. Do not require an emulator download merely to transfer a file or display a phone. Native Windows applications have their own requirements.

The current integrated image route targets Windows x64 and Android 34 x86_64. Host diagnostics:

- measure total and currently available RAM;
- reserve at least 2,560 MB (or 25% of RAM) for Windows/AEM, another 768 MB for emulator graphics/process/startup overhead, and 768 MB of currently free memory as load headroom;
- retain at least half the logical cores in the default profile (at most four guest cores);
- require 20 GB free storage for SDK, image, userdata and temporary downloads;
- sample CPU utilization; report GPU/driver information without claiming a rendered acceleration benchmark;
- use the installed emulator's `-accel-check` result rather than localized Windows text or the presence of the phrase “Hyper-V”. Missing/unverified acceleration cannot pass readiness.

Engineering profiles: 1536 MB lightweight (experimental), 2048 MB balanced, 3072 MB standard. These are budget policies, **not physically tested performance tiers**. Manual allocations are supported within the current safe memory/core envelope. Recheck after closing applications. Quick boot may save snapshots on normal shutdown; cold boot skips them.

## Dell Latitude 3190, 4 GB RAM

No Latitude 3190 or equivalent physical Windows machine is connected to this environment. No startup time, frame rate, CPU/RAM usage or app execution result has been measured on it.

A 4096 MB host leaves only 768 MB after the static OS/AEM/overhead reserves, below the 1536 MB guest minimum used here. Therefore the current Android 34 profile is **not recommended** on this target. This is an engineering budget result, not a claim that no emulator can ever boot. Windows paging, low-power CPU throughput, shared GPU memory, storage I/O and virtualization/hypervisor configuration all matter. Reducing guest RAM alone cannot solve them.

Prefer phone-powered execution or an available genuine native Windows implementation. Future evaluation of an older/smaller supported system image needs real tests and will have different minimum API/app compatibility.

## Physical test procedure still required

Record exact CPU, Windows build, RAM available after login, disk type/free space, GPU driver and acceleration probe. Measure cold/quick boot to Android boot completion, peak working set/commit, host responsiveness and idle/active CPU; repeat with a real signed APK and a native-library app. Test shutdown, failed-start recovery, snapshots, hardware sleep and low-storage conditions. Do not disable Windows security or antivirus to obtain favorable numbers.

SDK installation requires Java, acceptance of Google's terms and HTTPS access to Google repositories. This sandbox cannot access those repositories. HAXM is not the recommended modern Windows route; use a currently supported hypervisor compatible with the installed emulator. Graphics auto mode does not guarantee hardware acceleration or automatic recovery from driver failure.


## Executed CI runtime check

Combined run 43587692645 exercised AEM's actual Electron emulator manager on Linux KVM: measured diagnostics, managed API34 Google APIs x86_64 AVD creation/boot with 2048 MB and two cores, signer rejection/acceptance, signed APK installation and accessible UI launch, uninstall/stop/delete. SDK tools/image were provisioned by CI, not the AEM SDK downloader. This is not Windows hypervisor coverage, a performance tier certification or a Latitude 3190 benchmark.
