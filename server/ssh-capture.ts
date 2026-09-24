/** Recognize wrappers whose first external action forwards the original SSH
 * arguments. Read the definition only: never invoke a function to inspect it.
 * Locals and timing/status bookkeeping are safe before that call; argument,
 * environment, directory changes, extra options and other commands are not. */
export const SSH_WRAPPER_CHECK = String.raw`
__termai_ssh_passthrough() {
  local termai_definition termai_line termai_names=' ' termai_name termai_row=0
  termai_definition="$(builtin declare -f ssh)" || return 1
  while IFS=$' \t' read -r termai_line; do
    ((termai_row+=1))
    if ((termai_row == 1)); then [[ "$termai_line" == 'ssh ()' ]] || return 1; continue; fi
    if ((termai_row == 2)); then [[ "$termai_line" == '{' ]] || return 1; continue; fi
    termai_line="\${termai_line%;}"
    if [[ "$termai_line" == 'command ssh "$@"' || "$termai_line" == '/usr/bin/ssh "$@"' || "$termai_line" == '/bin/ssh "$@"' ]]; then
      return 0
    elif [[ "$termai_line" =~ ^local[[:space:]]+([a-z_][a-z_0-9[:space:]]*)$ ]]; then
      for termai_name in \${BASH_REMATCH[1]}; do
        [[ "$termai_name" =~ ^[a-z_][a-z_0-9]*$ && "$termai_name" != termai_* ]] || return 1
        termai_names+="$termai_name "
      done
    elif [[ "$termai_line" =~ ^([a-z_][a-z_0-9]*)=\$(SECONDS|\?)$ ]]; then
      [[ "$termai_names" == *" \${BASH_REMATCH[1]} "* ]] || return 1
    else
      return 1
    fi
  done <<< "$termai_definition"
  return 1
}
`.replaceAll('\\${', '${');
