/**
 * Optionally block the dnd5e "Bloodied" effect from being applied to actors.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const SETTING_KEY = "hideBloodiedEffect";
const BLOODIED_NAME = "bloodied";

export function registerHideBloodied() {
  Hooks.once("ready", () => {
    Hooks.on("preCreateActiveEffect", onPreCreateActiveEffect);
  });
}

export function registerHideBloodiedSettings() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "DM-TOOLKIT-DND5E.Settings.HideBloodiedEffect.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.HideBloodiedEffect.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

/**
 * @returns {boolean}
 */
function isEnabled() {
  return Boolean(game.settings.get(MODULE_ID, SETTING_KEY));
}

/**
 * @param {ActiveEffect} effect
 * @param {object} data
 * @returns {boolean|void}
 */
function onPreCreateActiveEffect(effect, data) {
  if (!isEnabled()) return;
  if (effect.parent?.documentName !== "Actor") return;
  if (!isBloodiedEffect(effect, data)) return;
  return false;
}

/**
 * @param {ActiveEffect} effect
 * @param {object} data
 * @returns {boolean}
 */
function isBloodiedEffect(effect, data) {
  const name = String(data?.name ?? effect?.name ?? "").trim().toLowerCase();
  if (name === BLOODIED_NAME) return true;

  const statuses = data?.statuses ?? effect?.statuses;
  if (!statuses) return false;
  if (statuses instanceof Set) return statuses.has(BLOODIED_NAME);
  if (Array.isArray(statuses)) return statuses.map(String).map(s => s.toLowerCase()).includes(BLOODIED_NAME);
  return false;
}
