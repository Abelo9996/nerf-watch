# Security policy

nerf-watch reads local agent session logs, which contain prompts, file paths and project names. Anything that leaks that data is a security issue.

## Reporting

Report privately through GitHub: open the [Security tab](https://github.com/Abelo9996/nerf-watch/security) and choose "Report a vulnerability". Please do not open a public issue, and never attach raw session logs.

Include the nerf-watch version or commit, the command you ran, and which field leaked (describe it; do not paste the real value).

You can expect an acknowledgement within 7 days.

## In scope

- A report (`report --out`, `--json` output) that contains prompts, paths, project names, session ids or other identifying data
- Any network request made by nerf-watch (it is designed to make none)
- Reading files outside the agent log directories it documents

## Supported versions

Only the latest release and `main` receive fixes while the project is at 0.x.
