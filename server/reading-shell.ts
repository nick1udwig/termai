/** Loaded into each managed Bash session, including SSH sessions. Keep bytes out
 * of the PTY: only a small, nonce-tagged notification goes to the terminal. */
export const READING_SHELL = String.raw`
__termai_read() (
  local termai_mode=auto termai_target termai_file termai_code=0 termai_size
  case "$\{1-}" in
    --file) termai_mode=file; shift ;;
    --command) termai_mode=command; shift ;;
    --) shift ;;
  esac
  termai_target="$(IFS=' '; printf '%s' "$*")"
  if (( $# )) && [[ "$termai_mode" != command ]] && {
    [[ -e "$termai_target" || "$termai_mode" == file ]] || ! builtin type -t -- "$1" >/dev/null;
  }; then
    [[ "$termai_target" == /* ]] || termai_target="$PWD/$termai_target"
    printf '\033]777;termai;%s;reading-file;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$termai_target" | command base64)" > /dev/tty
    return
  fi
  if (( $# == 0 )) && [[ -t 0 ]]; then
    printf '%s\n' 'Usage: command | look at  OR  look at FILE  OR  look at COMMAND [ARGS…]' >&2
    return 2
  fi
  termai_file="$(command mktemp "$TERMAI_READING_DIR/read.XXXXXXXX")" || return
  trap 'command rm -f -- "$termai_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if (( $# )); then
    if "$@" | command head -c 20971521 > "$termai_file"; then
      termai_code=$\{PIPESTATUS[0]}
    else
      termai_code=$\{PIPESTATUS[0]}
    fi
  else
    command head -c 20971521 > "$termai_file" || return
    termai_target='Command output'
  fi
  termai_size="$(command wc -c < "$termai_file")" || return
  if (( termai_size > 20971520 )); then
    printf '%s\n' 'Reading Mode output exceeds the 20 MB limit.' >&2
    return 1
  fi
  printf '\033]777;termai;%s;reading-capture;%s;%s;%s\007' "$TERMAI_NONCE" "$\{termai_file##*/}" "$(printf '%s' "$termai_target" | command base64)" "$termai_code" > /dev/tty || return
  trap - EXIT
  return "$termai_code"
)
# The utility is session-local; other uses of the system look command still work.
builtin unalias look 2>/dev/null || :
function look {
  if [[ "$\{1-}" == at ]]; then shift; __termai_read "$@"; else command look "$@"; fi
}
`.replaceAll('$\\{', '${');
