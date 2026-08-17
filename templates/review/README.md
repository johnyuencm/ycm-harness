# Review agent prompts

Canonical reviewer and explorer prompts live in `plugin/agents/`.

Independent review is a four-agent panel dispatched in parallel:

- `tech_lead.md`
- `spec_reviewer.md`
- `user_advocate.md`
- `project_manager.md`

Explore fan-out:

- `explore-architecture.md`
- `explore-risks.md`

Do not dispatch `combined_reviewer` (retired). Do not run `ycm-harness review *`.
