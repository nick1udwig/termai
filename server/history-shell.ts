/** Keep managed utilities out of Bash history using HISTCONTROL=ignorespace.
 * Inspect command boundaries without interpreting quoted text or expansions. */
export const HISTORY_SHELL = String.raw`
__termai_history_segment() {
  [[ "$1" =~ ^[[:space:]]*(upload|download|__termai_read)([[:space:]]|$) ||
     "$1" =~ ^[[:space:]]*look[[:space:]]+at([[:space:]]|$) ]]
}
__termai_history_special() {
  local termai_line="$1" termai_segment= termai_quote= termai_char
  local termai_at termai_depth=0 termai_escape=0
  for ((termai_at=0; termai_at<$\{#termai_line}; termai_at++)); do
    termai_char="$\{termai_line:termai_at:1}"
    if ((termai_escape)); then
      termai_segment+="$termai_char"; termai_escape=0; continue
    fi
    if [[ "$termai_char" == '\' && "$termai_quote" != "'" ]]; then
      termai_segment+="$termai_char"; termai_escape=1; continue
    fi
    if [[ -n "$termai_quote" ]]; then
      [[ "$termai_char" != "$termai_quote" ]] || termai_quote=
      termai_segment+="$termai_char"; continue
    fi
    case "$termai_char" in
      "'"|'"'|'\x60') termai_quote="$termai_char"; termai_segment+="$termai_char" ;;
      '('|'{') termai_depth=$((termai_depth + 1)); termai_segment+="$termai_char" ;;
      ')'|'}') termai_depth=$((termai_depth - 1)); termai_segment+="$termai_char" ;;
      '|'|';'|'&')
        if ((termai_depth == 0)); then
          if __termai_history_segment "$termai_segment"; then return 0; fi
          termai_segment=
        else termai_segment+="$termai_char"; fi ;;
      '#')
        if ((termai_depth == 0)) && [[ -z "$termai_segment" || "$termai_segment" == *[[:space:]] ]]; then break; fi
        termai_segment+="$termai_char" ;;
      *) termai_segment+="$termai_char" ;;
    esac
  done
  __termai_history_segment "$termai_segment"
}
`.replaceAll('$\\{', '${').replaceAll('\\x60', '`');
