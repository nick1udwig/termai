/** English letter names, shared by every executable in the command catalog. */
const alphabet = [
  ['a', 'ay'], ['bee', 'be'], ['see', 'sea'], ['dee'], ['ee'], ['ef', 'eff'],
  ['jee', 'gee'], ['aitch', 'haitch'], ['eye'], ['jay'], ['kay'], ['el', 'ell'],
  ['em'], ['en'], ['oh'], ['pee', 'pea'], ['cue', 'queue'], ['ar', 'are'], ['ess', 'es'],
  ['tee', 'tea'], ['you'], ['vee'], ['double you', 'double u'], ['ex'], ['why'], ['zee', 'zed'],
];
const letters = new Map(alphabet.flatMap((names, index) => {
  const letter = String.fromCharCode(97 + index);
  return [letter, ...names].map(name => [name, letter] as const);
}));

// A deliberately narrow pronunciation approximation for fused letter names.
// Soft C matters here: "Alice" and "ell ess" have the same consonant sounds.
// This is only used against generated spellings of known executable names.
function soundKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/qu/g, 'k')
    .replace(/c(?=[eiy])/g, 's').replace(/g(?=[eiy])/g, 'j').replace(/c/g, 'k')
    .replace(/z/g, 's').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}

export function commandSpeechIndex(commands: string[]) {
  const names = new Map<string, string[]>();
  const sounds = new Map<string, { command: string; length: number }[]>();
  const add = (map: Map<string, string[]>, key: string, command: string) => {
    const bucket = map.get(key);
    if (bucket) { if (!bucket.includes(command)) bucket.push(command); }
    else map.set(key, [command]);
  };
  for (const command of commands) {
    // Explicit spelling can cover long names; approximate sounds stay bounded
    // to short alphabetic commands, where dictation commonly fuses initials.
    if (!/^[a-z]{2,12}$/i.test(command)) continue;
    add(names, command.toLowerCase(), command);
    if (command.length > 6) continue;
    let spellings = [''];
    for (const letter of command.toLowerCase()) {
      const variants = alphabet[letter.charCodeAt(0) - 97];
      spellings = spellings.flatMap(prefix => variants.map(suffix => prefix + suffix.replaceAll(' ', '')));
    }
    for (const spelling of spellings) {
      const key = soundKey(spelling);
      if (key.length < 2) continue;
      const bucket = sounds.get(key) || [];
      if (!bucket.some(entry => entry.command === command && entry.length === spelling.length))
        bucket.push({ command, length: spelling.length });
      sounds.set(key, bucket);
    }
  }
  return (words: { value: string; quoted: boolean }[]) => {
    const found: { value: string; consumed: number; score: number }[] = [];
    const input: string[] = [];
    for (const word of words.slice(0, 12)) {
      if (word.quoted || !/^[a-z]+\.?$/i.test(word.value)) break;
      input.push(word.value.toLowerCase().replace(/\.$/, ''));
      let spelling = '', valid = true;
      for (let at = 0; at < input.length; at++) {
        const pair = letters.get(input.slice(at, at + 2).join(' '));
        const letter = at + 1 < input.length && pair ? (at++, pair) : letters.get(input[at]);
        if (!letter) { valid = false; break; }
        spelling += letter;
      }
      if (valid) for (const value of names.get(spelling) || [])
        found.push({ value, consumed: input.length, score: 94 + (input.length - 1) * 8 });
      // Letter-by-letter input has an unambiguous spelling. Do not reinterpret
      // it phonetically as another command, or swallow a following argument.
      if (!valid && !found.length && input.length <= 6 && /[aeiouy]/.test(input.join(''))) for (const entry of sounds.get(soundKey(input.join(' '))) || []) {
        // Similar consonants alone are insufficient: spelling a longer name
        // aloud must not compete with a much shorter utterance.
        const difference = Math.abs(input.join('').length - entry.length);
        if (difference <= Math.max(2, Math.floor(entry.length / 5))) {
          const score = 80 - difference * 4;
          const previous = found.find(match => match.value === entry.command);
          if (previous) previous.score = Math.max(previous.score, score);
          else found.push({ value: entry.command, consumed: input.length, score });
        }
      }
    }
    return found;
  };
}
