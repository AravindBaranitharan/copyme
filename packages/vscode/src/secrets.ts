/**
 * Heuristics for text that should not leave a machine without being looked at.
 *
 * This is a speed bump, not a filter. It catches the shapes people paste by
 * accident — a private key, a cloud access key, a bearer token, an `.env` line
 * — and asks. It will miss things, so nothing downstream may treat a clean
 * result as proof the text is safe.
 */

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: "a private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "a Stripe key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "an OpenAI-style key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "a JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "an Authorization header", pattern: /authorization\s*[:=]\s*["']?(?:bearer|basic)\s+\S+/i },
  { name: "a connection string with a password", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i },
  { name: "a secret assignment", pattern: /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*\s*[:=]\s*\S/im },
];

/** Names every rule that matched, most specific first. Empty when nothing did. */
export function findSecrets(text: string): string[] {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
}
