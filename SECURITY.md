# Security policy

Sedes is a powerful local management surface for coding agents. It can expose
prompts, transcripts, provider controls, tasks, automation, and every file root
admitted by the operator. Its current identity provider exposes one local
principal. Production API access requires, by default, a passwordless paired browser session
or device credential; there is no multi-user account administration.

The operator can set `SEDES_AUTH_REQUIRED=false` at startup to disable paired
client checks. In that mode every client admitted by the network and existing
Host/Origin checks can access management APIs as the local principal. Existing
CSRF checks, host approvals, and dedicated Tool-client credentials still apply.
Stored credentials remain intact; re-enabling authentication accepts only
credentials that are still valid, never expired or revoked ones.

## Supported security boundary

The supported default is a Linux server bound to loopback. Non-loopback access
is limited to the explicitly documented private deployment shapes:

- Tailscale Serve in front of the loopback listener;
- an explicitly opted-in Android client using `adb reverse` to the host's
  loopback listener;
- an Electron client on the same computer;
- a same-host private HTTPS reverse proxy in front of the loopback listener,
  with the exact external DNS Host admitted by Sedes and the original Host and
  protocol forwarded correctly; or
- the explicit trusted-home-LAN mode, limited to one exact private Host and a
  network whose clients are all trusted.

Sedes must not be exposed through Tailscale Funnel, a public listener, a guest
network, or another network with untrusted clients. Host and Origin validation,
CORS, Fetch Metadata, CSRF, and security headers protect browser flows but are
not substitutes for pairing authentication. Frontend assets and the downloadable
connector remain public. Pairing adds client authentication, not a completed
public-internet hardening or multi-tenant security boundary. Plain HTTP still
exposes credentials and application traffic to network observers.

Electron's managed Local connection runs the packaged Sedes server with the
desktop operating-system account's filesystem and provider authority. It binds
only an ephemeral loopback port and gives the sandboxed renderer no control
over the server executable, environment, configuration path, state path, or
workspace root. Loopback limits network reachability; it is not a sandbox or a
login boundary. Local configuration and application state remain sensitive and
live under Electron's private user-data directory. Provider credentials and
native conversation stores remain separately installed and provider-owned.

Read [Operations and security](docs/operator/operations.md) for the complete
deployment matrix, state protections, backup rules, and incident recovery.

## Supported versions

Security fixes target the current `main` branch and the most recent tagged
release. Older tags and checkouts are not supported; do not infer support for
an older checkout from a provider's compatibility range.

## Reporting a vulnerability

Report potential vulnerabilities privately through GitHub's
[private vulnerability report form](https://github.com/kcosr/sedes/security/advisories/new).
Reports are read on a best-effort basis; there is no guaranteed response time.

Do not open a public issue, discussion, or pull request containing an
exploit, credential, transcript, private hostname, filesystem path,
provider-native identifier, or other sensitive evidence. Include the affected
commit or version, deployment shape, reproduction conditions, impact, and any
known mitigation in the private report. Redact secrets and conversation
content unless they are indispensable to reproduction.

## Operational response

If a Sedes listener may have been reachable by an untrusted client:

1. Stop the server or restore the loopback/private network boundary.
2. Preserve and review relevant process and proxy logs without publishing
   transcripts or secrets.
3. Revoke exposed paired-client credentials with `sedes auth list` and
   `sedes auth revoke CLIENT_ID`; rotate provider and principal Tool-client
   credentials as appropriate.
4. Treat configured workspace contents, application state, attachments, and
   provider conversation data as potentially disclosed.
5. Restore only from a quiescent, verified backup when state integrity is in
   doubt.

Replacing the Sedes installation key invalidates application-authenticated
references and Tool-client credentials; paired clients have separate revocation
records in `authentication/authentication.sqlite` beneath the state directory. Key replacement is not a substitute for rotating
provider credentials or reviewing provider-owned conversation state.
