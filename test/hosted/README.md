# Hosted browser profile acceptance

The browser profile fixture is an isolated HTTPS site for testing a saved login. It creates a private session table, a Lambda function and an HTTP API. The test account can only read a random marker assigned at sign-in. The site uses no company data.

Deploy `browser-profile-fixture.yaml` in the assessment account with the project's `Scope`, `PermissionsBoundaryArn` and a UTC `ExpiresAt` within the next three hours. After the cutoff, the site returns HTTP 410 and its synthetic session records expire by TTL. CloudFormation still owns the resources until the fixture stack is removed.

1. Allow the stack's HTTPS `Origin` on a disposable AgentCore profile and grant that profile to a test employee.
2. In the first browser session, open `/protected` and verify that the server asks for sign-in. Go to `/` and submit the public fixture username `profile-tester` and password `profile-demo-only`. Open the protected page and record its marker. Stop the session and save the profile.
3. Start a fresh session with the saved profile and visit `/protected` directly. Verify that the server returns the identical marker. Compare with a clean session, which must be asked to sign in. Stop all test sessions and revoke the test grant.

Store the checks and provider session IDs in private test evidence. Keep cookie values out of test output.
