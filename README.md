# DM Toolkit D&D 5e

A Foundry VTT module with optional DM-focused tools for the **dnd5e** system. Features are built on Foundry core and dnd5e only.
STILL IN TESTING PHASE!

**Compatibility:** 
v0.1.0 Foundry VTT 14 (verified 14.367), dnd5e 6.0.0

Most features are **off by default**. Enable what you need under **Configure Settings → Module Settings → DM Toolkit D&D 5e**.

---

## Features

### Custom conditions

Define custom conditions that appear on actor **Effects** tabs (alongside core conditions) and on the token HUD conditions popup.

1. Enable **Custom conditions**.
2. Open **Edit custom conditions**.
3. Add a condition, give it a name, and link (or create) an Active Effect.
4. On that effect, add at least one **Change** — without Changes, the condition will not stay applied.

Players and GMs can toggle conditions from the sheet or token HUD. Linked effects are applied to the actor when enabled.

---

### Hide combatant names

Hides monster/NPC names from **players** in the combat tracker (GMs still see real names).

| Setting | Purpose |
| --- | --- |
| **Hide combatant names** | Master switch |
| **Replacement name** | Text shown instead (default: “Unknown Creature”) |
| **Only hide hostile creatures** | If on, only hostile NPCs are masked; friendly/neutral keep their names |

---

### Token auras

Draws a filled circle aura around tokens.

- Enable **Token auras**.
- Configure per token on the token’s **Auras** tab (enable, radius, color, opacity).
- Or push aura settings from an Active Effect via the effect **Changes** tab.

**Hide hostile auras from players** (optional): hostile-token auras are GM-only.

---

### Silent DM rolls

When enabled, the dice sound does not play for rolls made by the GM. Player rolls are unchanged.

---

### Token torch

Adds a flame button to the **token HUD** (right-click a token).

1. Click the flame to light a torch.
2. A dialog asks for **Bright** (default 20), **Dim** (default 40), and **Light animation** (defaults to Torch).
3. The token becomes a moving light source with those settings.
4. Click the flame again to extinguish and restore the previous light config.

---

### Semi-transparent fog for DM

For the DM only: areas outside token vision stay shaded, but the map still shows through, and all tokens remain visible and selectable. Players are unaffected.

---

### Hide Bloodied effect

Prevents the dnd5e **Bloodied** condition from being applied to actors.

---

### Extended effect expiration

Adds an **END EFFECT** section on Active Effect sheets with richer duration rules. You can combine multiple end conditions with **OR**:

- **After** — expire after a count of distinct events (attacks, damage rolls, concentration checks, ability/skill checks, or saving throws of a chosen ability). Re-rolling the *same* roll does not consume another use.
- **On Event** — expire when a matching event occurs.

This uses Foundry/dnd5e effect duration only (no midi-qol).

---

### Portals

GM scene tools to create linked portal pads on the canvas.

1. Enable **Portals**.
2. Use the **Portals** scene control to create pads, connect pairs, and manage them.
3. Tokens that the user can move teleport when they step onto an enterable linked pad, or via the portal’s **Activate** button (if configured).

Appearance settings:

| Setting | Purpose |
| --- | --- |
| **Portal border color** | Border color for all portals |
| **Portal border thickness** | Border width in pixels (1–20) |

Portal options (per portal) include whether it can be entered, activation button, and player visibility.

---

## Installation

1. Install the module in Foundry (manifest or manual copy into `Data/modules/`).
2. Enable **DM Toolkit D&D 5e** in the world’s module list.
3. Open **Configure Settings → Module Settings** and enable the features you want.

---

## Languages

Bundled locales: English, Simplified Chinese (`cn`), Czech, German, French, Italian, Japanese, Korean, Dutch, Polish, Brazilian Portuguese.

---

## Author

Dirk Van Roy
