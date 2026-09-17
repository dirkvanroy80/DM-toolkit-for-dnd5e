/**
 * DM Toolkit D&D 5e
 *
 * Uses Foundry V13+ CombatTracker._prepareTurnContext so player clients never
 * receive the real monster name in tracker render context. A render hook is a
 * fallback for systems that rebuild tracker HTML without that context field.
 *
 * API: https://foundryvtt.com/api/classes/foundry.applications.sidebar.tabs.CombatTracker.html
 */

import { registerAttackLimit } from "./roll-limit.js";
import {
  registerEnhancedStatusEffects,
  registerEnhancedStatusEffectsSettings
} from "./enhanced-status-effects.js";
import {
  registerExtendedExpiration,
  registerExtendedExpirationSettings
} from "./extended-expiration.js";
import {
  registerGmTransparentFog,
  registerGmTransparentFogSettings
} from "./gm-transparent-fog.js";
import {
  registerHideBloodied,
  registerHideBloodiedSettings
} from "./hide-bloodied.js";
import { registerPortals, registerPortalsSettings } from "./portals.js";
import {
  registerSilentDmRolls,
  registerSilentDmRollsSettings
} from "./silent-dm-rolls.js";
import {
  registerTokenAuras,
  registerTokenAurasSettings
} from "./token-auras.js";
import {
  registerTokenTorch,
  registerTokenTorchSettings
} from "./token-torch.js";
import { registerTraps, registerTrapsSettings } from "./traps.js";

const MODULE_ID = "DM-toolkit-for-dnd5e";

registerExtendedExpiration();
registerAttackLimit();
registerGmTransparentFog();
registerHideBloodied();
registerTokenAuras();
registerPortals();
registerTraps();
registerSilentDmRolls();
registerEnhancedStatusEffects();
registerTokenTorch();

Hooks.once("init", () => {
  // registerMenu entries render at the top of the module section; register the
  // Custom conditions toggle next so it sits directly under that button.
  registerEnhancedStatusEffectsSettings();
  registerHideCombatantNamesSettings();
  registerTokenAurasSettings();
  registerSilentDmRollsSettings();
  registerTokenTorchSettings();
  registerGmTransparentFogSettings();
  registerHideBloodiedSettings();
  registerExtendedExpirationSettings();
  registerPortalsSettings();
  registerTrapsSettings();
});

Hooks.once("setup", () => {
  const CombatTracker = foundry.applications?.sidebar?.tabs?.CombatTracker;
  if (CombatTracker) wrapPrepareTurnContext(CombatTracker);
  if (CONFIG.ui?.combat && CONFIG.ui.combat !== CombatTracker) {
    wrapPrepareTurnContext(CONFIG.ui.combat);
  }
});

Hooks.on("renderCombatTracker", (app, element) => {
  maskTrackerElement(app, element);
});

function registerHideCombatantNamesSettings() {
  game.settings.register(MODULE_ID, "hideCombatantNames", {
    name: "DM-TOOLKIT-DND5E.Settings.HideCombatantNames.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.HideCombatantNames.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => ui.combat?.render?.({ force: true })
  });

  game.settings.register(MODULE_ID, "replacementName", {
    name: "DM-TOOLKIT-DND5E.Settings.ReplacementName.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.ReplacementName.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "Unknown Creature"
  });

  game.settings.register(MODULE_ID, "onlyHostile", {
    name: "DM-TOOLKIT-DND5E.Settings.OnlyHostile.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.OnlyHostile.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

/**
 * Wrap CombatTracker._prepareTurnContext so the Handlebars context name is
 * replaced before the tracker HTML is built.
 * @param {typeof foundry.applications.sidebar.tabs.CombatTracker} cls
 */
function wrapPrepareTurnContext(cls) {
  const original = cls.prototype._prepareTurnContext;
  if (typeof original !== "function" || original.__dmToolkitDnd5e) return;

  async function wrapped(combat, combatant, index) {
    const context = await original.call(this, combat, combatant, index);
    if (shouldHideName(combatant) && context && typeof context === "object") {
      context.name = getReplacementName();
    }
    return context;
  }

  wrapped.__dmToolkitDnd5e = true;
  cls.prototype._prepareTurnContext = wrapped;
}

/**
 * Fallback: rewrite visible names and alt text after render.
 * @param {foundry.applications.sidebar.tabs.CombatTracker} app
 * @param {HTMLElement|JQuery} element
 */
function maskTrackerElement(app, element) {
  if (!isHideCombatantNamesEnabled()) return;
  if (game.user?.isGM) return;

  const root = getHtmlRoot(element) ?? app.element;
  const combat = app.viewed;
  if (!root || !combat) return;

  const replacement = getReplacementName();
  for (const row of root.querySelectorAll("[data-combatant-id]")) {
    const combatant = combat.combatants.get(row.dataset.combatantId);
    if (!shouldHideName(combatant)) continue;

    const nameNode = row.querySelector(".token-name .name, .token-name strong, .token-name h4");
    if (nameNode) nameNode.textContent = replacement;

    for (const img of row.querySelectorAll("img")) {
      if (img.alt) img.alt = replacement;
    }

    for (const titled of row.querySelectorAll("[title]")) {
      if (combatant.name && titled.title.includes(combatant.name)) {
        titled.title = titled.title.replaceAll(combatant.name, replacement);
      }
    }
  }
}

/**
 * @param {HTMLElement|JQuery} element
 * @returns {HTMLElement|null}
 */
function getHtmlRoot(element) {
  if (!element) return null;
  if (element instanceof HTMLElement) return element;
  if (typeof element[0] !== "undefined") return element[0];
  return null;
}

/**
 * Monsters are combatants that are not player-owned. Optionally limited to hostile tokens.
 * @param {Combatant} combatant
 * @returns {boolean}
 */
function shouldHideName(combatant) {
  if (!isHideCombatantNamesEnabled()) return false;
  if (!combatant || game.user?.isGM) return false;

  const isNpc = combatant.isNPC ?? !combatant.actor?.hasPlayerOwner;
  if (!isNpc) return false;

  if (!game.settings.get(MODULE_ID, "onlyHostile")) return true;

  const disposition = combatant.token?.disposition
    ?? combatant.actor?.prototypeToken?.disposition
    ?? CONST.TOKEN_DISPOSITIONS.HOSTILE;
  return disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE;
}

/** @returns {boolean} */
function isHideCombatantNamesEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, "hideCombatantNames"));
  } catch (_err) {
    return false;
  }
}

/** @returns {string} */
function getReplacementName() {
  const configured = game.settings.get(MODULE_ID, "replacementName")?.trim();
  return configured || game.i18n.localize("DM-TOOLKIT-DND5E.UnknownCreature");
}
