#!/usr/bin/env bash

check_native_build_tools() {
  local target="${1:-}"
  local compiler_remedy remedy tool
  case "${target}" in
    darwin-*) COMPILER=clang; compiler_remedy='Install Xcode command line tools: xcode-select --install.' ;;
    linux-x64) COMPILER=gcc; compiler_remedy='Install build-essential with your package manager.' ;;
    linux-arm64)
      if [[ "$(uname -s)-$(uname -m)" == Linux-aarch64 ]]; then
        COMPILER="${CC:-gcc}"
      else
        COMPILER="${CC:-aarch64-linux-gnu-gcc}"
      fi
      compiler_remedy='Install gcc (native) or gcc-aarch64-linux-gnu (cross-build), or set CC.'
      ;;
    windows-x64) COMPILER="${CC:-x86_64-w64-mingw32-gcc}"; compiler_remedy='Install MinGW: brew install mingw-w64 or apt install gcc-mingw-w64-x86-64.' ;;
    *) echo "Unknown target: ${target}" >&2; return 2 ;;
  esac
  for tool in curl unzip "${COMPILER}"; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      case "${tool}" in
        curl|unzip) remedy="Install ${tool} with your package manager." ;;
        *) remedy="${compiler_remedy}" ;;
      esac
      echo "${tool} is required. ${remedy}" >&2
      return 1
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  check_native_build_tools "${1:-}"
fi
