// Ported from utils.lua `string.GetArguments`.
// Splits a command's argument string into up to `limit` tokens, honouring
// double-quoted spans and ``` code blocks (which keep their delimiters).

export function getArguments(text: string, limit?: number): string[] {
  const args: string[] = [];
  let e = 0;

  while (true) {
    let b = e; // 0-based index into text
    // skip whitespace
    while (b < text.length && /\s/.test(text[b])) b++;
    if (b >= text.length) break;

    if (limit && args.length >= limit - 1) {
      args.push(text.slice(b));
      break;
    }

    const c = text[b];
    if (text.startsWith("```", b)) {
      const close = text.indexOf("```", b + 3);
      if (close !== -1) {
        e = close + 3;
        args.push(text.slice(b, e));
        continue;
      }
      // no closing fence, fall through to plain token
    }

    if (c === '"') {
      const close = text.indexOf('"', b + 1);
      if (close !== -1) {
        args.push(text.slice(b + 1, close));
        e = close + 1;
        continue;
      }
    }

    // plain token: read until next whitespace
    let end = b;
    while (end < text.length && !/\s/.test(text[end])) end++;
    args.push(text.slice(b, end));
    e = end;
  }

  return args;
}

export function upperizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
