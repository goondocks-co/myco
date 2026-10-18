# Shared POSIX PATH setup; embedded in docs/install.sh by gen-release-selector.mjs.
myco_setup_path() (
  set -eu
  binary=$1
  bin_dir=${binary%/*}
  link="$HOME/.local/bin/myco"
  if [ -L "$link" ]; then
    target=$(readlink "$link")
    case "$target" in
      "$binary"|"$HOME/.myco/bin/myco"|../../.myco/bin/myco)
        if [ "$target" != "$binary" ]; then
          ln -s "$binary" "$link.myco-new"
          mv -f "$link.myco-new" "$link"
        fi ;;
      *) printf 'Myco: left foreign link untouched: %s -> %s\n' "$link" "$target" >&2 ;;
    esac
  elif [ -e "$link" ]; then
    printf 'Myco: left foreign path untouched: %s\n' "$link" >&2
  fi

  # Login startup files run after macOS path_helper; bash uses its first existing profile.
  bash_profile="$HOME/.profile"
  for rc in "$HOME/.bash_profile" "$HOME/.bash_login"; do
    if [ -f "$rc" ]; then bash_profile=$rc; break; fi
  done
  quoted_bin=$(printf '%s' "$bin_dir" | sed "s/'/'\\\\''/g")
  path_line="  *) export PATH='$quoted_bin':\$PATH ;;"
  for rc in "$HOME/.zshenv" "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bashrc" "$bash_profile"; do
    case "$rc" in
      "$HOME/.zshrc"|"$HOME/.bashrc") [ -f "$rc" ] || continue ;;
    esac
    destination=$rc
    hops=0
    max_rc_links=40
    while [ -L "$destination" ]; do
      hops=$((hops + 1))
      if [ "$hops" -gt "$max_rc_links" ]; then printf 'Myco: shell rc symlink cycle: %s\n' "$rc" >&2; exit 1; fi
      target=$(readlink "$destination")
      case "$target" in /*) destination=$target ;; *) destination="${destination%/*}/$target" ;; esac
    done
    if [ -e "$destination" ] && [ ! -f "$destination" ]; then printf 'Myco: shell rc is not a file: %s\n' "$rc" >&2; exit 1; fi
    edited=$(mktemp "${destination%/*}/.myco-path-XXXXXX")
    original=
    trap 'rm -f "$edited" "$original"' EXIT
    original=$(mktemp "${destination%/*}/.myco-original-XXXXXX")
    existed=0
    if [ -f "$destination" ]; then
      existed=1
      cp -p "$destination" "$original"
      cp -p "$original" "$edited"
      awk '
        $0 == "# myco:path:start" { if (owned) exit 1; owned=1; next }
        $0 == "# myco:path:end" { if (!owned) exit 1; owned=0; next }
        owned { next }
        $0 == "# Added by Myco." || $0 == "# Added by the Myco installer." {
          count=0
          for (i=1; i<=4 && (getline line)>0; i++) saved[++count]=line
          if (count == 4 && saved[1] == "case \":$PATH:\" in" && saved[2] ~ /^  \*/ && saved[3] ~ /^  \*\) export PATH=/ && saved[4] == "esac") next
          print
          for (i=1; i<=count; i++) print saved[i]
          next
        }
        { print }
        END { if (owned) exit 1 }
      ' "$original" > "$edited"
    fi
    {
      printf '# myco:path:start\n# Added by Myco.\n'
      # $PATH is evaluated when the shell reads its startup file.
      # shellcheck disable=SC2016
      printf 'case ":$PATH:" in\n'
      printf "  *:'%s':*) ;;\n" "$quoted_bin"
      printf '%s\n' "$path_line"
      printf 'esac\n# myco:path:end\n'
    } >> "$edited"
    if { [ "$existed" = 1 ] && ! cmp -s "$original" "$destination"; } \
      || { [ "$existed" = 0 ] && { [ -e "$destination" ] || [ -L "$destination" ]; }; }; then
      printf 'Myco: shell rc changed during PATH setup; retry: %s\n' "$rc" >&2
      exit 1
    fi
    if [ "$existed" = 0 ] || ! cmp -s "$edited" "$destination"; then mv -f "$edited" "$destination"; fi
    rm -f "$edited" "$original"
    trap - EXIT
  done
  printf 'Myco command: %s\nOpen a new shell to use myco on PATH.\n' "$binary"
)
