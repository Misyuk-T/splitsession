# Open questions (observations without a decision)

## A tab dragged out of its container's group (2026-10-11)
**Observation (manual test):** a container tab was dragged out of its group. It stays in the container and keeps living as that container's account. There is no reverse effect (it does not return to the main profile). A tab dragged *into* a container's group, on the other hand, is moved by SplitSession into that container (`64494a3`). The behaviour is asymmetric, and a tab outside the group looks ordinary although its account is the container's (only the badge on the active tab shows it).

**Options:**
1. Leave as is: dragging out does not change the account (protection against accidentally switching to the main account).
2. Symmetric: the dragged-out tab is reopened in the ordinary profile.
3. "The group always tells the truth": a container tab that was dragged out returns to its group (without a reload); it goes to the ordinary profile only through an explicit action, "Reopen in... > No container".

**Decision:** not taken; recorded as an observation only (2026-10-11).
