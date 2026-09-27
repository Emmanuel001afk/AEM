#!/usr/bin/env bash
set -euo pipefail
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y openjdk-17-jre-headless curl unzip
rm -rf android-sdk-build-tools /tmp/aem-build-tools /tmp/build-tools.zip
mkdir -p android-sdk-build-tools
curl -fsSL https://dl.google.com/android/repository/build-tools_r35.0.0-linux.zip -o /tmp/build-tools.zip
unzip -q /tmp/build-tools.zip -d /tmp/aem-build-tools
cp -a /tmp/aem-build-tools/35.0.0/. android-sdk-build-tools/
chmod +x android-sdk-build-tools/apksigner
