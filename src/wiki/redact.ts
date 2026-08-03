export interface RedactionRule {
  id: string;
  description: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionFinding {
  rule_id: string;
  match: string;
  // Offset in the partially-redacted intermediate string at the time this rule ran.
  // Use 'rule_id' + 'match' for stable identity; do not rely on 'index' for arithmetic
  // that maps back to the original input.
  index: number;
}

export interface RedactionResult {
  redacted: string;
  findings: RedactionFinding[];
}

export const BUILTIN_RULES: readonly RedactionRule[] = [
  {
    id: "private-key-block",
    description: "PEM private key block",
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    replacement: "<redacted:private-key>",
  },
  {
    id: "db-url-with-creds",
    description: "Database URL with embedded credentials",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps)(?:\+[a-z0-9]+)?:\/\/[^\s:@\/]+:[^\s@\/]+@[^\s\/]+/gi,
    replacement: "<redacted:db-url>",
  },
  {
    id: "jwt",
    description: "JSON Web Token (three base64url segments)",
    pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g,
    replacement: "<redacted:jwt>",
  },
  {
    id: "ssh-public-key",
    description: "SSH public key payload",
    pattern: /\bssh-(?:rsa|ed25519|dss|ecdsa-sha2-nistp(?:256|384|521))\s+[A-Za-z0-9+/=]{40,}(?:\s+\S+)?/g,
    replacement: "<redacted:ssh-public-key>",
  },
  {
    id: "bearer-token",
    description: "Authorization Bearer token",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._\-+/=]{16,}\b/g,
    replacement: "<redacted:bearer-token>",
  },
  {
    id: "openai-key",
    description: "OpenAI-style secret key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: "<redacted:openai-key>",
  },
  {
    id: "anthropic-key",
    description: "Anthropic-style secret key",
    pattern: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,
    replacement: "<redacted:anthropic-key>",
  },
  {
    id: "github-token",
    description: "GitHub PAT",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    replacement: "<redacted:github-token>",
  },
  {
    id: "stripe-key",
    description: "Stripe secret/publishable key",
    pattern: /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{20,}\b/g,
    replacement: "<redacted:stripe-key>",
  },
  {
    id: "aws-access-key",
    description: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "<redacted:aws-key>",
  },
  {
    id: "google-api-key",
    description: "Google API key (AIza...)",
    pattern: /\bAIza[0-9A-Za-z\-_]{35,}\b/g,
    replacement: "<redacted:google-api-key>",
  },
  {
    id: "slack-token",
    description: "Slack token (xoxb/xoxp/xoxa/xoxr/xoxs)",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "<redacted:slack-token>",
  },
  {
    id: "email",
    description: "RFC-5322-ish email address",
    pattern: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
    replacement: "<redacted:email>",
  },
  {
    id: "ipv4",
    description: "IPv4 address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "<redacted:ip>",
  },
  {
    id: "absolute-home-unix",
    description: "Absolute path under /home/<user> or /Users/<user>",
    pattern: /(?:\/home|\/Users)\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*/g,
    replacement: "<redacted:home-path>",
  },
  {
    id: "absolute-home-win",
    description: "Absolute path under C:\\Users\\<user> (supports spaces)",
    pattern: /[A-Za-z]:\\Users\\[^\\\/\r\n<>"|*?]+(?:\\[^\\\/\r\n<>"|*?]+)*/g,
    replacement: "<redacted:home-path>",
  },
];

export interface RedactionOptions {
  rules?: readonly RedactionRule[];
  allow?: RegExp[];
  extraPatterns?: RegExp[];
}

export function redact(input: string, opts: RedactionOptions = {}): RedactionResult {
  const rules = opts.rules ?? BUILTIN_RULES;
  const allow = opts.allow ?? [];
  const findings: RedactionFinding[] = [];
  let output = input;

  for (const rule of rules) {
    output = output.replace(rule.pattern, (match, ...args) => {
      const offset = typeof args[args.length - 2] === "number" ? (args[args.length - 2] as number) : -1;
      if (allow.some((a) => a.test(match))) {
        return match;
      }
      findings.push({ rule_id: rule.id, match, index: offset });
      return rule.replacement;
    });
  }

  if (opts.extraPatterns) {
    for (let i = 0; i < opts.extraPatterns.length; i++) {
      const p = opts.extraPatterns[i];
      if (!p) continue;
      output = output.replace(p, (match, ...args) => {
        const offset = typeof args[args.length - 2] === "number" ? (args[args.length - 2] as number) : -1;
        if (allow.some((a) => a.test(match))) {
          return match;
        }
        findings.push({ rule_id: `extra-${i}`, match, index: offset });
        return "<redacted:custom>";
      });
    }
  }

  return { redacted: output, findings };
}

export function compileAllowList(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p));
}

export function compileExtraPatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "g"));
}
