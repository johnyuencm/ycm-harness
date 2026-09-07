# Review agent prompts

Canonical reviewer and explorer prompts live in `plugin/agents/`.

Independent review is a two-phase panel (not five parallel seats):

- `tech_lead.md` — debates with `project_manager` (max 3 rounds)
- `project_manager.md` — includes spec completeness (acceptance vs evidence)
- `user_advocate.md` — last; includes Shneiderman / usability

Do not dispatch `spec_reviewer.md` or `uiux.md` (retired).

Explore fan-out:

- `explore-architecture.md`
- `explore-risks.md`

Do not dispatch `combined_reviewer` (retired). Do not run `ycm-harness review *`.
