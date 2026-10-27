const SLASH_CHAR_CODE = 47;

export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) end--;
  return value.slice(0, end);
}
