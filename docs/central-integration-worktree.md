# Dispatch — Central Integration Worktree

**Status:** proposal · 2026-07-21
**Problem owner:** ticket branching (`engine/branching.mjs`) + a future publish coordinator

## 1. Decision

Use one dedicated **integration worktree per Git repository** as the only place that integrates
completed ticket branches and pushes the result to `origin/main`.

Ticket work continues in isolated ticket worktrees. Those worktrees may create commits, but they
do not update `main` and do not push directly to `origin/main`. A repository-level lock serializes
publication through the integration worktree.

The central idea is sound, with three Git-specific corrections:

1. A branch is created from a **commit/ref**, not from a worktree. New ticket branches should use
   the latest fetched `refs/remotes/origin/main` as their base.
2. Branches merge into the integration **branch** checked out in the central worktree; they do not
   merge into the worktree itself.
3. “One central worktree” means one per repository. Unrelated repositories do not share Git refs,
   remotes, or a useful integration checkout.

## 2. Why centralize publishing

Today, ticket worktrees isolate agents while they edit and commit, but publication is still a
distributed write to one remote branch. Two agents can both finish from the same base, race to
push, or make different assumptions about a stale local `main`.

A dedicated publisher gives the repository one serialization point:

```text
refs/remotes/origin/main (published source of truth)
          │
          ├── DSP-101/...  ticket worktree ──┐
          ├── DSP-102/...  ticket worktree ──┼── merge one at a time
          └── DSP-103/...  ticket worktree ──┘
                                              ▼
                                  integration worktree
                                  branch: dispatch/integration
                                              │
                                              └── push HEAD:main ──► origin/main
```

This separates three responsibilities:

- `origin/main` is the published source of truth.
- Ticket worktrees own feature development and commits.
- The integration worktree owns merge, verification, and push.

## 3. Invariants

The implementation should enforce these rules:

- There is at most one integration worktree for a repository's shared Git directory.
- The integration worktree is generated infrastructure, not a user's normal checkout.
- It always checks out a dedicated local branch such as `dispatch/integration`; it does not need
  to check out or advance the user's local `main`.
- New ticket branches start from the latest **published** `origin/main` commit after a fetch.
- An unpublished integration tip is never used as a ticket branch base.
- Only the integration worktree may push to the configured target branch.
- Integration is serialized with a per-repository lock.
- The integration worktree must be clean before and after every publish attempt.
- Publication never force-pushes. A changed remote tip causes a retry against the new tip.
- A ticket is marked published only after the pushed commit is confirmed on the remote-tracking
  branch.

The dedicated branch matters because Git allows a local branch to be checked out in only one
worktree at a time. Keeping `dispatch/integration` in the publisher avoids taking over `main` from
a user's checkout or from Dispatch's self-update flow.

## 4. Branch creation

Branch creation can still be initiated from the repository's shared Git directory; it does not
have to run with the integration worktree as its current directory. The required sequence is:

1. Fetch `origin main` through the repository coordinator.
2. Resolve `refs/remotes/origin/main` to an immutable commit SHA.
3. Create the ticket branch and private worktree from that SHA.
4. Persist the SHA as the ticket's `branchBase`.

Conceptually:

```sh
git fetch origin main
git worktree add -b DSP-101/example <ticket-worktree> refs/remotes/origin/main
```

Using local `main` first is unsafe because it may intentionally lag behind the remote. Using the
current `dispatch/integration` tip is also unsafe: while one ticket is being verified, that tip may
contain unpublished changes. A second ticket based on it would silently depend on the first.

Branch creation does not need to hold the publish lock through verification. Once the remote ref is
resolved to a SHA, that commit is a valid base even if another publish lands a moment later. The
new ticket is simply based on the previous published state and may need conflict resolution later.

Existing ticket branches keep their original base when their worktree is reused. They are brought
up to date only at integration time, where conflicts can be handled explicitly.

## 5. Publish protocol

Version one should publish one ticket at a time:

1. Confirm the ticket branch has no uncommitted changes and has at least one commit to publish.
2. Acquire the per-repository publish lock.
3. Write a small recovery record containing the ticket id, branch, expected base, and phase.
4. Fetch `origin main` and verify the integration worktree is clean with no merge in progress.
5. Align `dispatch/integration` with `refs/remotes/origin/main`.
6. Merge the ticket branch with `--no-ff` so parallel branches can be integrated without rewriting
   their commits and the ticket boundary remains visible in history.
7. Run the repository's required verification in the integration worktree.
8. Push with `git push origin HEAD:main`.
9. Fetch or inspect the pushed ref and confirm the integration commit is reachable from
   `refs/remotes/origin/main`.
10. Mark the ticket published, clear the recovery record, and release the lock.

If the push is rejected because `origin/main` moved, do not force-push. Fetch the new tip, restore
the generated integration branch to that published tip, merge the unchanged ticket branch again,
rerun verification, and retry the push.

If the merge conflicts, abort it and leave the ticket branch untouched. The ticket should move to
an intervention state with the conflicting paths and current remote tip recorded. Conflict
resolution can then happen in the ticket worktree or in a separate, explicitly owned resolution
branch.

## 6. Crash recovery

The integration worktree needs durable state because a server can stop between merge and push.
On startup, inspect both Git state and the recovery record:

| State | Recovery action |
|---|---|
| Remote contains the recorded integration commit | Mark publish successful and clean up. |
| Clean integration tip is ahead of the same remote base | Rerun verification, then retry push. |
| Remote moved since the recorded base | Restore to the new remote tip and re-merge the ticket. |
| Merge/rebase is in progress | Abort it, restore the published tip, and requeue the ticket. |
| Dirty tree with no matching recovery record | Stop and require intervention; never discard it silently. |

Resetting is acceptable only inside this generated worktree and only when the recovery record says
which ticket branch can reconstruct the candidate. The publisher must never hard-reset an ordinary
user or ticket worktree.

## 7. Critique and tradeoffs

The model is a good fit when Dispatch is allowed to integrate directly to one remote branch. It
eliminates push races, gives verification a stable location, and makes publish recovery observable.
It does not eliminate every Git problem:

- **It is a serialization bottleneck.** This is intentional for correctness, but long verification
  blocks every later publish. A future implementation can prepare candidates in parallel while
  keeping the final merge-and-push section serialized.
- **Branches still become stale.** Parallel ticket branches start independently from the published
  tip. Later branches may conflict after earlier ones land; the central worktree detects that
  conflict but cannot make it disappear.
- **Direct pushes may bypass review policy.** If `main` is protected or pull requests are required,
  the same worktree should push a candidate branch and open/update a PR instead. The remote platform,
  not the local publisher, should perform the final merge.
- **The integration tip must not become a development base while ahead of the remote.** Doing so
  creates hidden dependencies between tickets and is the main flaw in a literal interpretation of
  “all branches are made from the central worktree.”
- **The lock must be repository-scoped and crash-safe.** A process-local boolean is insufficient;
  publication needs an atomic filesystem lock plus owner/time metadata and stale-lock recovery.

## 8. Required Dispatch changes

This document describes a target design, not current behavior. Implementing it requires:

1. Change branch-base resolution in `engine/branching.mjs`: fetch first and prefer
   `refs/remotes/origin/main`, rather than preferring local `main`.
2. Add a repository identity, integration-worktree path, publish lock, and recovery record.
3. Add a publisher that performs merge, verification, remote-race retry, and confirmation.
4. Replace the current agent instruction to push completed branches directly to `origin/main` with
   a handoff to the publisher.
5. Keep `engine/update-status.mjs` focused on updating the Dispatch installation's local `main`;
   that self-update checkout is not the publication authority for ticket repositories.
6. Test concurrent completed tickets, a moving remote tip, merge conflicts, verifier failures,
   interrupted pushes, stale locks, and restart recovery.

Until those changes ship, the central integration worktree is a proposal and should not be assumed
by agents or operators.
