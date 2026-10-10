import type { Environment } from '../src/engine/host.ts';
import { shellQuote } from '../src/engine/repair.ts';
import { probe } from './probes.ts';
import { localBash } from './shell.ts';

/** Export trusted shell completion definitions, never the active Readline line. */
export const COMPLETION_SNAPSHOT = `
  {
    builtin declare -f
    builtin complete -p
    local termai_completion_var
    while IFS= read -r termai_completion_var; do
      case "$termai_completion_var" in
        _*|*COMPLETION*|COMP_WORDBREAKS)
          builtin declare -p "$termai_completion_var" 2>/dev/null ;;
      esac
    done < <(builtin compgen -A variable)
  } > "$TERMAI_COMPLETIONS_FILE.tmp"
  command mv -f -- "$TERMAI_COMPLETIONS_FILE.tmp" "$TERMAI_COMPLETIONS_FILE"
`;

/** Invoke registered completion functions with a synthetic completion context.
 * Only trusted complete -p output is parsed as shell code; words stay arguments.
 * Completion chatter is discarded, and only COMPREPLY leaves the subprocess. */
export const COMPLETION_SCRIPT = `
exec 3>&1
{
  shopt -s extglob progcomp
  if [[ -n "$TERMAI_COMPLETIONS_FILE" && -r "$TERMAI_COMPLETIONS_FILE" ]]; then
    source "$TERMAI_COMPLETIONS_FILE"
  elif [[ -r /usr/share/bash-completion/bash_completion ]]; then
    source /usr/share/bash-completion/bash_completion
  elif [[ -r /etc/bash_completion ]]; then
    source /etc/bash_completion
  fi
  COMP_LINE=$1; shift
  COMP_POINT=\${#COMP_LINE} COMP_TYPE=9 COMP_KEY=9
  COMP_WORDS=("$@") COMP_CWORD=$(($# - 1)) COMPREPLY=()
  termai_completion_command=$1
  termai_completion_current=\${COMP_WORDS[COMP_CWORD]}
  termai_completion_previous=\${COMP_WORDS[COMP_CWORD-1]}
  for termai_completion_attempt in 1 2; do
    termai_completion_spec=$(builtin complete -p -- "$termai_completion_command")
    if [[ -z "$termai_completion_spec" ]]; then
      if builtin declare -F _comp_load >/dev/null; then _comp_load -- "$termai_completion_command"
      elif builtin declare -F _completion_loader >/dev/null; then _completion_loader "$termai_completion_command"
      fi
      termai_completion_spec=$(builtin complete -p -- "$termai_completion_command")
    fi
    [[ -n "$termai_completion_spec" ]] || break
    eval "termai_completion_args=(\${termai_completion_spec#complete })"
    termai_completion_function= termai_completion_external= termai_completion_options=()
    for ((termai_completion_index=0; termai_completion_index<\${#termai_completion_args[@]}-1; termai_completion_index++)); do
      termai_completion_option=\${termai_completion_args[termai_completion_index]}
      case "$termai_completion_option" in
        -F) termai_completion_function=\${termai_completion_args[++termai_completion_index]} ;;
        -C) termai_completion_external=1; ((termai_completion_index++)) ;;
        -o) ((termai_completion_index++)) ;;
        *) termai_completion_options+=("$termai_completion_option") ;;
      esac
    done
    if [[ -n "$termai_completion_function" ]]; then
      "$termai_completion_function" "$termai_completion_command" "$termai_completion_current" "$termai_completion_previous"
      [[ $? == 124 ]] && continue
    elif [[ -z "$termai_completion_external" && \${#termai_completion_options[@]} -gt 0 ]]; then
      mapfile -t COMPREPLY < <(builtin compgen "\${termai_completion_options[@]}" -- "$termai_completion_current")
    fi
    break
  done
} >/dev/null 2>&1
if ((\${#COMPREPLY[@]})); then builtin printf '%s\\0' "\${COMPREPLY[@]:0:1000}" >&3; fi
`;

export function validCompletionWords(words: unknown): words is string[] {
  return Array.isArray(words) && words.length >= 2 && words.length <= 64 &&
    words.every(word => typeof word === 'string' && word.length <= 2000 && !/[\x00-\x1f\x7f]/.test(word)) &&
    words.join(' ').length <= 4000 && /^[\w./+-]+$/.test(words[0]);
}
export function completionArgs(words: string[]) {
  return [words.map((word, index) => index === words.length - 1 && !word ? '' : shellQuote(word)).join(' '), ...words];
}
export function completionValues(raw: string): string[] {
  return [...new Set(raw.split('\0').map(value => value.trimEnd()).filter(value => value && value.length <= 2000 && !/[\x00-\x1f\x7f]/.test(value)))].slice(0, 1000);
}
export async function shellComplete(words: string[], cwd: string, env: Environment, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  if (!validCompletionWords(words)) return [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1200)]);
  try {
    const result = await probe(localBash(), ['--noprofile', '--norc', '-c', COMPLETION_SCRIPT, 'termai-completion', ...completionArgs(words)], {
      cwd, env: { ...env, BASH_ENV: '/dev/null', ENV: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
      timeout: 1200, maxBuffer: 128 * 1024,
    }, deadline);
    return completionValues(result.stdout);
  } catch { signal.throwIfAborted(); return []; }
}
