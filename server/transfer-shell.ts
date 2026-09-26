/** Installed only in managed shells. Payload bytes stay in a private file, never the PTY. */
export const TRANSFER_SHELL = String.raw`
builtin unalias upload download 2>/dev/null || :
function upload {
  if (( $# > 1 )); then printf '%s\n' 'Usage: upload [DIRECTORY]' >&2; return 2; fi
  local termai_destination="$\{1:-$PWD}"
  [[ "$termai_destination" == /* ]] || termai_destination="$PWD/$termai_destination"
  if [[ ! -d "$termai_destination" ]]; then printf '%s\n' 'Upload destination is not a directory.' >&2; return 1; fi
  printf '\033]777;termai;%s;transfer-upload;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$termai_destination" | command base64)" > /dev/tty
}
function download { (
  local termai_file termai_name termai_size termai_mode=auto
  if [[ "$\{1-}" == --file ]]; then termai_mode=file; shift; fi
  if [[ "$\{1-}" == -- ]]; then shift; fi
  if (( $# > 1 )); then printf '%s\n' 'Usage: download FILE  OR  command | download [NAME]' >&2; return 2; fi
  if [[ -t 0 || "$termai_mode" == file ]]; then
    if (( $# != 1 )) || [[ ! -f "$1" ]]; then printf '%s\n' 'Usage: download FILE  OR  command | download [NAME]' >&2; return 2; fi
    termai_file="$1"; [[ "$termai_file" == /* ]] || termai_file="$PWD/$termai_file"
    printf '\033]777;termai;%s;transfer-download;%s\007' "$TERMAI_NONCE" "$(printf '%s' "$termai_file" | command base64)" > /dev/tty
    return
  fi
  termai_name="$\{1:-command-output.txt}"
  if [[ "$termai_name" == */* || "$termai_name" == *\\* || "$termai_name" =~ [[:cntrl:]] || "$termai_name" == '.' || "$termai_name" == '..' || $\{#termai_name} -gt 255 ]]; then printf '%s\n' 'Use a filename for the downloaded output.' >&2; return 2; fi
  termai_file="$(command mktemp "$TERMAI_TRANSFER_DIR/download.XXXXXXXX")" || return
  trap 'command rm -f -- "$termai_file"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  command head -c 1073741825 > "$termai_file" || return
  termai_size="$(command wc -c < "$termai_file")" || return
  if (( termai_size > 1073741824 )); then printf '%s\n' 'Piped downloads are limited to 1 GB.' >&2; return 1; fi
  printf '\033]777;termai;%s;transfer-capture;%s;%s\007' "$TERMAI_NONCE" "$\{termai_file##*/}" "$(printf '%s' "$termai_name" | command base64)" > /dev/tty || return
  trap - EXIT
); }
`.replaceAll('$\\{', '${');
