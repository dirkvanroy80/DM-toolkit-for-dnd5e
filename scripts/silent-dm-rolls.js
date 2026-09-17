/**
 * When enabled, suppress the core dice sound for rolls made by a GM.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const SETTING_KEY = "silentDmRolls";

export function registerSilentDmRolls() {
  Hooks.on("preCreateChatMessage", onPreCreateChatMessage);
}

export function registerSilentDmRollsSettings() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "DM-TOOLKIT-DND5E.Settings.SilentDmRolls.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.SilentDmRolls.Hint",
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
  try {
    return Boolean(game.settings.get(MODULE_ID, SETTING_KEY));
  } catch (_err) {
    return false;
  }
}

/**
 * Foundry v14 sends the ChatMessage document (not createData) to the server after
 * preCreate hooks, so the sound must be cleared on the document via updateSource.
 *
 * @param {ChatMessage} message
 * @param {object} data
 * @param {object} _options
 * @param {string} userId
 */
function onPreCreateChatMessage(message, data, _options, userId) {
  if (!isEnabled()) return;
  const user = game.users.get(userId);
  if (!user?.isGM) return;
  if (!isDiceRollMessage(message, data)) return;

  data.sound = null;
  try {
    message.updateSource({ sound: null });
  } catch (_err) {
    // Document may already be locked in some edge paths; data.sound still helps older flows.
  }
}

/**
 * @param {ChatMessage} message
 * @param {object} data
 * @returns {boolean}
 */
function isDiceRollMessage(message, data) {
  if (message?.isRoll) return true;

  const rolls = data?.rolls ?? message?.rolls;
  if (Array.isArray(rolls) && rolls.length > 0) return true;

  const diceSound = CONFIG.sounds?.dice;
  const sound = data?.sound ?? message?.sound;
  if (diceSound && sound && sound === diceSound) return true;

  if (data?.flags?.core?.initiativeRoll) return true;

  return false;
}
