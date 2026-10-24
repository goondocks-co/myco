#!/usr/bin/env bash
set -euo pipefail
fixture=$1
trap 'chmod -R a+rwX "$fixture"' EXIT
mkdir -p "$fixture/archives" "$fixture/baseline" "$fixture/bin"
make_package() {
  local name=$1 version=$2 dependency=$3 destination=$4
  local staging="$fixture/packages/$name-$version"
  mkdir -p "$staging/DEBIAN" "$staging/usr/share/$name"
  printf 'Package: %s\nVersion: %s\nArchitecture: all\nMaintainer: CI <ci@example.com>\nDescription: offline apt cache contract\n' "$name" "$version" > "$staging/DEBIAN/control"
  if test -n "$dependency"; then printf 'Depends: %s\n' "$dependency" >> "$staging/DEBIAN/control"; fi
  printf '%s\n' "$version" > "$staging/usr/share/$name/version"
  dpkg-deb --build "$staging" "$destination/${name}_${version}_all.deb" >/dev/null
}
make_package myco-cache-dependency 1.0 '' "$fixture/baseline"
make_package myco-cache-probe 1.0 'myco-cache-dependency (>= 1.0)' "$fixture/baseline"
make_package myco-cache-dependency 2.0 '' "$fixture/archives"
make_package myco-cache-probe 2.0 'myco-cache-dependency (>= 2.0)' "$fixture/archives"
dpkg --install "$fixture/baseline/"*.deb
printf '#!/bin/sh\nexec "$@"\n' > "$fixture/bin/sudo"
chmod +x "$fixture/bin/sudo"
export PATH="$fixture/bin:$PATH" ARCHIVES="$fixture/archives"
touch "$ARCHIVES/complete"
. /etc/os-release
printf 'Ubuntu %s, architecture %s\n' "$VERSION_ID" "$(dpkg --print-architecture)"
apt-get --version | sed -n '1p'
bash -e -o pipefail "$fixture/hit.sh" | tee "$fixture/install.log"
printf 'Installed versions: '
dpkg-query -W -f='${Version} ' myco-cache-dependency myco-cache-probe
printf '\n'
if grep -q '^Get:' "$fixture/install.log"; then
  echo 'Cached installation acquired an archive' >&2
  exit 1
fi
