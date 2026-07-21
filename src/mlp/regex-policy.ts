export function assertSafeClaimRegex(pattern: string): void {
  if (pattern.length > 256) throw new Error('claim regex exceeds 256 characters');
  try {
    new RegExp(pattern, 'u');
  } catch {
    throw new Error('claim regex must be a valid regular expression');
  }

  let inClass = false;
  let escaped = false;
  let unboundedQuantifiers = 0;
  for (const character of pattern) {
    if (escaped) {
      if (/[1-9]/.test(character)) throw new Error('claim regex backreferences are not allowed');
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inClass = true;
      continue;
    }
    if (character === ']' && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (character === '|') throw new Error('claim regex alternation is outside the bounded safe subset');
    if (character === '{' || character === '}') throw new Error('claim regex counted quantifiers are outside the bounded safe subset');
    if (character === '*' || character === '+' || character === '?') unboundedQuantifiers += 1;
  }
  if (/\(\?/.test(pattern)) throw new Error('claim regex lookaround and special groups are not allowed');
  if (unboundedQuantifiers > 1) throw new Error('claim regex may contain at most one unbounded quantifier');
}
