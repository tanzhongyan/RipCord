# Security policy

## Report a vulnerability

Use GitHub private vulnerability reporting: <https://github.com/tanzhongyan/RipCord/security/advisories/new>.

Do not open a public issue for a vulnerability.

> [!NOTE]
> TEMPLATE-TODO(security): confirm this reporting link still points at your repository after you run the init workflow.

## Supported versions

Only the `main` branch is supported. Fixes land on `main`.

## Response targets

| Step                         | Target           |
| ---------------------------- | ---------------- |
| Acknowledge your report      | 3 business days  |
| Triage and severity decision | 10 business days |

## What the repository scans for

| Layer             | Tool                                                               | When                             |
| ----------------- | ------------------------------------------------------------------ | -------------------------------- |
| Static analysis   | Biome recommended rules, CodeQL with `security-extended` queries   | Every pull request, weekly       |
| Workflow analysis | CodeQL `actions` language, zizmor                                  | Every pull request               |
| Secrets           | gitleaks on full history; staged-file check in the pre-commit hook | Every pull request, every commit |
| Dependencies      | `bun audit`, GitHub dependency review (fails on high severity)     | Every pull request               |
| Dynamic analysis  | OWASP ZAP baseline against `next start`                            | Weekly and on demand             |
