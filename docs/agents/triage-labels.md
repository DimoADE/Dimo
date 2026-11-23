# Triage Labels

Repository automation skills reference five canonical triage roles. Because local issues are tracked as Markdown files under `.scratch/` (see [`issue-tracker.md`](issue-tracker.md)), each triage label is recorded on the `Status:` line near the top of the issue file.

| Canonical role    | `Status:` value   | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

When a skill applies a triage role (for example, marking an issue AFK-ready), write the corresponding `Status:` value near the top of the issue file.
