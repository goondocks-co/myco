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
    if [ -f "$rc" ] && grep -qFx "$path_line" "$rc"; then continue; fi
    {
      printf '\n# Added by Myco.\n'
      # $PATH is evaluated when the shell reads its startup file.
      # shellcheck disable=SC2016
      printf 'case ":$PATH:" in\n'
      printf "  *:'%s':*) ;;\n" "$quoted_bin"
      printf '%s\n' "$path_line"
      printf 'esac\n'
    } >> "$rc"
  done
  printf 'Myco command: %s\nOpen a new shell to use myco on PATH.\n' "$binary"
)
