# Projects, source and handoffs

A project belongs to an accountable employee and starts under a work goal. Its record holds its ID, repository, application path, originating goal and most recent committed handoff. An owner, CEO or accountable employee can attach a later goal, so a change request can continue the original application. An employee with an active, assigned task on an attached goal can publish the work. The project retains its identity when the employee process restarts.

## Publish a change

1. Create the project using `project.create`, or recover its metadata with `project.list` and `project.get`. For a new change goal, use `project.attach`.
2. Read `project.snapshot` with the prior handoff’s project ID, producing task ID and commit SHA. The snapshot is a durable copy of the exact UTF-8 files submitted in the acknowledged Git commit.
3. Submit the full project tree with `project.commit` from the current assigned task. For an update, supply the prior SHA as `baseSha`. The tree accepts at most 64 regular text files and 64 KiB of paths and content. Omitting an old file removes it from the new tree. A stale base returns a conflict. Concurrent submissions that both reach Git retain their separate PRs, and the handoff that loses the project update is marked `diverged`.
4. Inspect the returned branch, SHA and PR along with the accountable goal, authoring employee and task. Use `delivery.build` and `delivery.preview` against that SHA. The delivery service records its test result and preview URL. `project.history` retains prior handoffs and `delivery.status` retrieves the corresponding deployment record.

## Hosted Git worker

The deployed Git worker reads the raw fine-grained PAT from the Secrets Manager ARN in `PEROTTINO_PROJECTS_GIT_SECRET_ARN`. Grant only reference to that secret on the Git worker role. The broker may invoke the Git worker and receives its commit/PR receipt. The employee and code-test runtimes have no Git secret permission.

Set `PEROTTINO_PROJECTS_REPOSITORY` on the worker and broker to a GitHub `owner/name`. The default is `The-CarL/perottino-co-projects`. The owner selects the repository visibility. Source and PRs are publicly readable when the chosen repository is public. Initialize its default branch with a commit and grant the PAT access to that repository with Contents and Pull requests read/write and Metadata read. Reserve the `jobs/` branch namespace for the worker. Keep production deployment credentials out of workflows that the projects repository runs on these branches. [GitHub fine-grained PAT permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)

The hosted worker uses GitHub’s Git Data and Pull Requests APIs. Each job builds an isolated Git tree, replaces only `apps/<project-id>`, writes a child commit with its original date, and creates `jobs/<project-id>/<job-id>`. The worker verifies the branch tip and reconciles an existing PR on retry. It never runs the submitted files, merges a PR, or pushes to the default branch. A first PR targets the default branch. A follow-up uses the prior handoff’s commit as its parent even when an earlier PR is still open. Infrastructure proposal files may be included for review under the project path. Policy and deployment changes to the platform remain in its separately permissioned repository. [Git trees](https://docs.github.com/en/rest/git/trees) · [Pull requests](https://docs.github.com/en/rest/pulls/pulls)

## Local verification

The local backend creates a real bare Git repository under the data directory. Each job uses a private temporary Git index and records its commit, task branch and local review ref. A local review has `local: true` and no external URL. A fresh broker can open the same SQLite state and Git directory to continue the project.

Run `node --test test/company-projects.test.mjs test/project-git.test.mjs` to verify the local commits, authorizations, base checks, response-loss recovery, cross-goal handoff and the hosted HTTP contract with an offline GitHub fixture. These tests make no external GitHub requests.
