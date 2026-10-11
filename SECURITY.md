# Security Policy

## Supported Versions

The project currently supports the latest published version on the `master` branch.

## Reporting a Vulnerability

Please report suspected security issues privately by opening a GitHub Security Advisory or contacting the maintainer directly through the repository owner and private channels.

Do not open public issues for security concerns.

## Best Practices

- Keep dependencies updated.
- Use environment variables for runtime configuration.
- Never commit tokens, keys, secrets, or `.env` files.
- Validate inputs and keep the server-side allowlists in place.
- Prefer least privilege and secure deployment boundaries.
