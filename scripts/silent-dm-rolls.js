/**
 * When enabled, suppress the core dice sound for rolls made by a GM.
 * Chat visibility follows the selected message/roll mode: only when that mode is
 * "Private GM" (private to gamemasters) are messages kept GM-only / hidden from players.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const SETTING_KEY = "silentDmRolls";
const FLAG_KEY = "silentDmRoll";

export function registerSilentDmRolls() {
  const install = () => {
    installChatMessagePreCreateWrap();
    installRollToMessageWrap();
  };
  if (globalThis.CONFIG?.ChatMessage || globalThis.ChatMessage) install();
  Hooks.once("init", install);
  Hooks.once("setup", install);
  Hooks.once("ready", install);

  Hooks.on("preCreateChatMessage", onPreCreateChatMessage);
  Hooks.on("renderChatMessageHTML", onRenderChatMessageHTML);
  Hooks.on("renderChatMessage", onRenderChatMessageLegacy);
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

/** @returns {boolean} */
function isEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, SETTING_KEY));
  } catch (_err) {
    return false;
  }
}

/** @returns {string[]} */
function getGmUserIds() {
  if (typeof ChatMessage.getWhisperRecipients === "function") {
    try {
      const recipients = ChatMessage.getWhisperRecipients("GM");
      if (recipients?.length) return recipients.map(u => u.id);
    } catch (_err) { /* fall through */ }
  }
  return game.users.filter(u => u.isGM).map(u => u.id);
}

/**
 * @returns {string}
 */
function getGmMessageMode() {
  const modes = CONFIG.ChatMessage?.modes;
  if (modes?.gm) return "gm";
  if (modes?.private) return "private";
  return CONST.DICE_ROLL_MODES?.PRIVATE ?? "gmroll";
}

/**
 * Current / requested mode is "Private GM Roll" (private to gamemasters).
 * Explicit options from this roll win over the sidebar dropdown setting.
 * @param {object} [options]
 * @param {ChatMessage|object} [message]
 * @param {object} [data]
 * @returns {boolean}
 */
function isPrivateToGamemastersMode(options, message, data) {
  const explicit = options?.messageMode ?? options?.rollMode;
  if (explicit != null && String(explicit).length) {
    return isGmPrivateModeValue(explicit);
  }

  const whisper = data?.whisper ?? message?.whisper ?? [];
  if (Array.isArray(whisper) && whisper.length) {
    const mode = inferModeFromMessage({
      whisper,
      blind: data?.blind ?? message?.blind,
      author: message?.author,
      user: message?.user
    });
    return mode === "gm" || mode === "blind";
  }

  return isGmPrivateModeValue(
    safeSetting("core", "messageMode") ?? safeSetting("core", "rollMode")
  );
}

/**
 * @param {unknown} mode
 * @returns {boolean}
 */
function isGmPrivateModeValue(mode) {
  if (mode == null) return false;
  const privateMode = CONST.DICE_ROLL_MODES?.PRIVATE ?? "gmroll";
  const m = String(mode).toLowerCase();
  return m === "gm"
    || m === "private"
    || m === "gmroll"
    || m === String(privateMode).toLowerCase()
    || m.includes("gmroll")
    || m === "privategm"
    || m === "private-gm";
}

/**
 * @param {ChatMessage} message
 * @returns {string|null}
 */
function inferModeFromMessage(message) {
  const whisper = message.whisper ?? [];
  if (!whisper.length) return "public";
  const allGm = whisper.every(id => game.users.get(id)?.isGM);
  if (allGm) return message.blind ? "blind" : "gm";
  if (whisper.length === 1 && whisper[0] === (message.author?.id ?? message.user)) return "self";
  return "whisper";
}

/**
 * @param {string} namespace
 * @param {string} key
 * @returns {unknown}
 */
function safeSetting(namespace, key) {
  try {
    return game.settings.get(namespace, key);
  } catch (_err) {
    return null;
  }
}

/**
 * @param {ChatMessage|object} message
 * @returns {string|null}
 */
function getMessageAuthorId(message) {
  return message?.author?.id
    ?? message?.author
    ?? message?.user?.id
    ?? message?.user
    ?? null;
}

/**
 * @param {ChatMessage|object} message
 * @param {object} [data]
 * @returns {boolean}
 */
function isDiceRollMessage(message, data) {
  if (message?.isRoll) return true;

  const flag = message?.flags?.[MODULE_ID]?.[FLAG_KEY]
    ?? data?.flags?.[MODULE_ID]?.[FLAG_KEY];
  if (flag) return true;

  const rolls = data?.rolls ?? message?.rolls;
  if (Array.isArray(rolls) && rolls.length > 0) return true;
  if (rolls && typeof rolls === "object" && typeof rolls.size === "number" && rolls.size > 0) {
    return true;
  }

  const diceSound = CONFIG.sounds?.dice;
  const sound = data?.sound ?? message?.sound;
  if (diceSound && sound && sound === diceSound) return true;

  if (data?.flags?.core?.initiativeRoll || message?.flags?.core?.initiativeRoll) return true;

  const content = String(data?.content ?? message?.content ?? "");
  if (content.includes("dice-roll") || content.includes("dice-result") || content.includes("dice-total")) {
    return true;
  }

  return false;
}

/**
 * Mute dice sound; if Private GM mode is active, also force GM-only whisper.
 * @param {ChatMessage} message
 * @param {object} [data]
 * @param {object} [options]
 * @param {string|User} [userOrId]
 * @returns {boolean}
 */
function applySilentDmRollEffects(message, data, options, userOrId) {
  if (!isEnabled()) return false;

  const userId = typeof userOrId === "string"
    ? userOrId
    : (userOrId?.id ?? getMessageAuthorId(message) ?? game.user?.id);
  const user = game.users.get(userId);
  if (!user?.isGM) return false;
  if (!isDiceRollMessage(message, data)) return false;

  const hideFromPlayers = isPrivateToGamemastersMode(options, message, data);
  const patch = { sound: null };

  if (hideFromPlayers) {
    const whisper = getGmUserIds();
    if (whisper.length) {
      const mode = getGmMessageMode();
      if (options && typeof options === "object") {
        options.messageMode = mode;
        options.rollMode = CONST.DICE_ROLL_MODES?.PRIVATE ?? "gmroll";
      }
      try {
        if (typeof message.applyMode === "function") message.applyMode(mode);
      } catch (_err) { /* fall through */ }
      try {
        if (typeof ChatMessage.applyMode === "function") ChatMessage.applyMode(patch, mode);
        else if (typeof ChatMessage.applyRollMode === "function") {
          ChatMessage.applyRollMode(patch, CONST.DICE_ROLL_MODES?.PRIVATE ?? "gmroll");
        }
      } catch (_err) { /* keep explicit */ }
      patch.whisper = whisper;
      patch.blind = false;
      foundry.utils.setProperty(patch, `flags.${MODULE_ID}.${FLAG_KEY}`, true);
    }
  }

  patch.sound = null;

  if (data && typeof data === "object") {
    foundry.utils.mergeObject(data, patch);
    data.sound = null;
    if (hideFromPlayers && patch.whisper) {
      data.whisper = patch.whisper;
      data.blind = false;
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAG_KEY}`, true);
    }
  }

  try {
    message.updateSource(patch);
  } catch (_err) { /* ignore lock races */ }

  return true;
}

function installChatMessagePreCreateWrap() {
  const Cls = CONFIG.ChatMessage?.documentClass ?? globalThis.ChatMessage;
  if (!Cls?.prototype || Cls.prototype._dmToolkitSilentDmRolls) return;
  const original = Cls.prototype._preCreate;
  if (typeof original !== "function") return;

  Cls.prototype._dmToolkitSilentDmRolls = true;
  Cls.prototype._preCreate = async function(data, options, user) {
    const result = await original.call(this, data, options, user);
    if (result === false) return result;
    applySilentDmRollEffects(this, data, options, user);
    return result;
  };
}

function installRollToMessageWrap() {
  const classes = new Set();
  if (CONFIG.Dice?.Roll) classes.add(CONFIG.Dice.Roll);
  if (foundry.dice?.Roll) classes.add(foundry.dice.Roll);
  if (globalThis.Roll) classes.add(globalThis.Roll);
  for (const cls of CONFIG.Dice?.rolls ?? []) {
    if (typeof cls === "function") classes.add(cls);
  }
  for (const RollCls of classes) wrapRollToMessage(RollCls);
}

/**
 * @param {typeof Roll} RollCls
 */
function wrapRollToMessage(RollCls) {
  const proto = RollCls?.prototype;
  if (!proto || proto._dmToolkitSilentDmRolls) return;
  const original = proto.toMessage;
  if (typeof original !== "function") return;

  proto._dmToolkitSilentDmRolls = true;
  proto.toMessage = async function(messageData={}, options={}) {
    if (isEnabled() && game.user?.isGM) {
      messageData = foundry.utils.deepClone(messageData) ?? {};
      options = foundry.utils.deepClone(options) ?? {};
      messageData.sound = null;

      if (isPrivateToGamemastersMode(options, null, messageData)) {
        const mode = getGmMessageMode();
        const whisper = getGmUserIds();
        options.messageMode = mode;
        options.rollMode = CONST.DICE_ROLL_MODES?.PRIVATE ?? "gmroll";
        messageData.whisper = whisper;
        messageData.blind = false;
        foundry.utils.setProperty(messageData, `flags.${MODULE_ID}.${FLAG_KEY}`, true);
        try {
          if (typeof ChatMessage.applyMode === "function") ChatMessage.applyMode(messageData, mode);
          else if (typeof ChatMessage.applyRollMode === "function") {
            ChatMessage.applyRollMode(messageData, options.rollMode);
          }
        } catch (_err) { /* keep explicit */ }
        messageData.sound = null;
        messageData.whisper = whisper;
        messageData.blind = false;
      }
    }
    return original.call(this, messageData, options);
  };
}

/**
 * @param {ChatMessage} message
 * @param {object} data
 * @param {object} options
 * @param {string} userId
 */
function onPreCreateChatMessage(message, data, options, userId) {
  applySilentDmRollEffects(message, data, options, userId);
}

/**
 * Hide from players only for Private GM rolls (flag or whisper-to-GMs).
 * @param {ChatMessage} message
 * @param {HTMLElement} html
 */
function onRenderChatMessageHTML(message, html) {
  if (!shouldHideRollFromCurrentUser(message)) return;
  const el = html instanceof HTMLElement ? html : html?.[0];
  if (!el) return;
  el.hidden = true;
  el.style.display = "none";
  el.remove();
}

/**
 * @param {ChatMessage} message
 * @param {JQuery|HTMLElement} html
 */
function onRenderChatMessageLegacy(message, html) {
  if (!shouldHideRollFromCurrentUser(message)) return;
  if (html?.hide) html.hide();
  else if (html instanceof HTMLElement) {
    html.hidden = true;
    html.style.display = "none";
    html.remove();
  } else if (html?.[0]) {
    html[0].hidden = true;
    html[0].style.display = "none";
    html[0].remove();
  }
}

/**
 * @param {ChatMessage} message
 * @returns {boolean}
 */
function shouldHideRollFromCurrentUser(message) {
  if (!isEnabled()) return false;
  if (game.user?.isGM) return false;
  if (!isDiceRollMessage(message)) return false;

  const author = game.users.get(getMessageAuthorId(message));
  if (!author?.isGM) return false;

  // Only hide when this roll is (or was) Private GM — not public /roll.
  if (message.getFlag?.(MODULE_ID, FLAG_KEY)) return true;
  const whisper = message.whisper ?? [];
  if (!whisper.length) return false;
  return whisper.every(id => game.users.get(id)?.isGM);
}
