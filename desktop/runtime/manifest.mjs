/** Pinned bootstrap inputs. SDK package revisions are recorded again after installation. */
export const RUNTIME = Object.freeze({
  apiLevel: 35,
  avdName: "AEM_Phone",
  image: "system-images;android-35;google_apis;x86_64",
  packages: Object.freeze([
    "platform-tools;35.0.2",
    "platforms;android-35",
    "build-tools;35.0.2",
    "emulator;36.1.9",
    "system-images;android-35;google_apis;x86_64",
  ]),
  commandLineTools: Object.freeze({
    version: "13114758",
    url: "https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip",
    sha256: "98b565cb657b012dae6794cefc0f66ae1efb4690c699b78a614b4a6a3505b003",
  }),
  java: Object.freeze({
    version: "21.0.13+9",
    url: "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip",
    sha256: "2332c0b4cff6bed722da3567c91d5e47568bcba863fa4945d0a8d6fc76158628",
  }),
  sdkLicense: "https://developer.android.com/studio/terms",
  javaLicense: "https://openjdk.org/legal/gplv2+ce.html",
});
