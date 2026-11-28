# Hosted browser profile acceptance

This disposable HTTPS sign-in site proves that an AgentCore browser can save and resume an authenticated session. It uses a synthetic principal and makes no AWS data calls. The server verifies the cookie on each protected request and enforces the assessment end time. A clean browser receives HTTP 401.

Generate a private one-use assessment passphrase with `secrets.token_urlsafe(28)` in Python. To calculate the public CloudFormation parameter `SessionVerifier`, compute the hexadecimal HMAC-SHA256 of the ASCII text `hosted-profile-session/v1` keyed by that passphrase, then SHA-256 hash the ASCII hexadecimal result and take its hexadecimal digest. Keep the passphrase and session cookie in private memory or an owner-only temporary file. The template accepts only the public verifier.

Deploy `browser-profile-fixture.yaml` with the project's `Scope`, an existing minimal Lambda `ExecutionRoleArn`, the verifier and a UTC `ExpiresAt` within the next three hours. The site returns HTTP 410 after the cutoff. CloudFormation owns its API and Lambda until the temporary stack is removed.

1. Allow the stack's HTTPS `Origin` on a disposable AgentCore profile and grant the profile to a test employee.
2. Open `/protected` and verify the sign-in requirement. Go to `/` and submit `profile-tester` and the temporary passphrase. Open the protected page and record the synthetic account's marker. Stop the session and save the profile.
3. Start a fresh session with the saved profile and visit `/protected` directly. Verify the identical marker without entering credentials. Compare with a clean session. Stop the sessions and revoke the test grant.

Keep session IDs in private test evidence and cookie values out of test output.
