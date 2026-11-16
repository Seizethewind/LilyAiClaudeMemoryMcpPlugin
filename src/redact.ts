/** Secret redaction: memory text can contain tokens from prompts; they are never stored. */

const SECRET_PATTERNS: [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED:private-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}=*/gi, '$1[REDACTED]'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|AUTH)[A-Z0-9_]*\s*[=:]\s*)(?!\[REDACTED)\S{6,}/gi, '$1[REDACTED]'],
];

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => {
      count++;
      return repl.replace(/\$(\d)/g, (_x, i) => m[Number(i)] ?? '');
    });
  }
  return { text: out, count };
}
