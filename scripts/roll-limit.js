/**
 * Limit Active Effects to a number of distinct attack, damage, concentration, save,
 * ability-check, or skill-check rolls. Rolls from the same activity use share one id
 * (re-rolls do not consume another use). A new activity use starts a new id. The effect
 * is disabled before a new roll that would exceed the limit.
 *
 * Duration UI / end-condition storage lives in extended-expiration.js.
 */

import {
  ABILITY_KEYS,
  coerceRollIdArray,
  getAppliedCheckIds,
  getAppliedSaveIds,
  getAppliedSkillIds,
  hasAnyCheckLimit,
  hasAnySaveLimit,
  hasAnySkillLimit,
  isAttackLimitedEffect,
  isCheckLimitedEffect,
  isConcentrationLimitedEffect,
  isDamageLimitedEffect,
  isSaveLimitedEffect,
  isSkillLimitedEffect,
  setAppliedCheckIds,
  setAppliedSaveIds,
  setAppliedSkillIds,
  SKILL_KEYS,
  wouldExceedAttackBudget,
  wouldExceedCheckBudget,
  wouldExceedConcentrationBudget,
  wouldExceedDamageBudget,
  wouldExceedSaveBudget,
  wouldExceedSkillBudget
} from "./extended-expiration.js";

const MODULE_ID = "DM-toolkit-for-dnd5e";
const ATTACK_ID_KEY = "attackId";
const DAMAGE_ID_KEY = "damageId";
const SAVE_ID_KEY = "saveId";
const CHECK_ID_KEY = "checkId";
const SKILL_ID_KEY = "skillId";

/** @type {Map<string, string>} activityKey -> attack id for the current use */
const currentAttackIdByActivity = new Map();
/** @type {Map<string, string>} activityKey -> damage id for the current use */
const currentDamageIdByActivity = new Map();

export function registerAttackLimit() {
  Hooks.on("preUpdateActiveEffect", preserveRollLimitFlags);

  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") return;

    Hooks.on("dnd5e.preUseActivity", onPreUseActivity);
    Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
    wrapAttackChatAction();
    wrapAttackActivity();
    wrapDamageActivities();
    wrapActorSavingThrow();
    wrapActorAbilityCheck();
    wrapActorSkillCheck();
    Hooks.on("dnd5e.preRollAttackV2", onPreRollAttack);
    Hooks.on("dnd5e.preRollDamageV2", onPreRollDamage);
    Hooks.on("dnd5e.preRollSavingThrowV2", onPreRollSavingThrow);
    Hooks.on("dnd5e.preRollAbilityCheckV2", onPreRollAbilityCheck);
    Hooks.on("dnd5e.preRollSkillV2", onPreRollSkill);
  });
}

/**
 * @param {ActiveEffect} effect
 * @param {object} update
 */
function preserveRollLimitFlags(effect, update) {
  const becomingDisabled = "disabled" in update && update.disabled === true && !effect.disabled;
  if (becomingDisabled) {
    if (isAttackLimitedEffect(effect) || effect.getFlag(MODULE_ID, "limitAttacks")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedAttackIds`, []);
    }
    if (isDamageLimitedEffect(effect) || effect.getFlag(MODULE_ID, "limitDamage")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedDamageIds`, []);
    }
    if (isConcentrationLimitedEffect(effect) || effect.getFlag(MODULE_ID, "limitConcentration")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedConcentrationIds`, []);
    }
    if (hasAnySaveLimit(effect) || effect.getFlag(MODULE_ID, "appliedSaveIds")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedSaveIds`, {});
    }
    if (hasAnyCheckLimit(effect) || effect.getFlag(MODULE_ID, "appliedCheckIds")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedCheckIds`, {});
    }
    if (hasAnySkillLimit(effect) || effect.getFlag(MODULE_ID, "appliedSkillIds")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedSkillIds`, {});
    }
  }

  const becomingEnabled = "disabled" in update && update.disabled === false && effect.disabled;
  if (becomingEnabled) {
    if (effect.getFlag(MODULE_ID, "limitAttacks") || effect.getFlag(MODULE_ID, "units") === "attacks") {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedAttackIds`, []);
    }
    if (effect.getFlag(MODULE_ID, "limitDamage") || effect.getFlag(MODULE_ID, "units") === "damage") {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedDamageIds`, []);
    }
    if (effect.getFlag(MODULE_ID, "limitConcentration")
      || effect.getFlag(MODULE_ID, "units") === "concentration") {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedConcentrationIds`, []);
    }
    if (hasAnySaveLimit(effect) || effect.getFlag(MODULE_ID, "appliedSaveIds")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedSaveIds`, {});
    }
    if (hasAnyCheckLimit(effect) || effect.getFlag(MODULE_ID, "appliedCheckIds")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedCheckIds`, {});
    }
    if (hasAnySkillLimit(effect) || effect.getFlag(MODULE_ID, "appliedSkillIds")) {
      foundry.utils.setProperty(update, `flags.${MODULE_ID}.appliedSkillIds`, {});
    }
  }

  const ns = foundry.utils.getProperty(update, `flags.${MODULE_ID}`);
  if (!ns) return;

  if ("limitAttacks" in ns) {
    ns.limitAttacks = ns.limitAttacks === true || ns.limitAttacks === "true";
  }
  if ("maxAttacks" in ns) {
    ns.maxAttacks = Math.max(1, Math.floor(Number(ns.maxAttacks)) || 1);
  }
  if ("limitDamage" in ns) {
    ns.limitDamage = ns.limitDamage === true || ns.limitDamage === "true";
  }
  if ("maxDamage" in ns) {
    ns.maxDamage = Math.max(1, Math.floor(Number(ns.maxDamage)) || 1);
  }
  if ("limitConcentration" in ns) {
    ns.limitConcentration = ns.limitConcentration === true || ns.limitConcentration === "true";
  }
  if ("maxConcentration" in ns) {
    ns.maxConcentration = Math.max(1, Math.floor(Number(ns.maxConcentration)) || 1);
  }
  if (!becomingDisabled && !Array.isArray(ns.appliedAttackIds)) {
    const existing = effect.getFlag(MODULE_ID, "appliedAttackIds");
    if (existing) ns.appliedAttackIds = existing;
  }
  if (!becomingDisabled && !Array.isArray(ns.appliedDamageIds)) {
    const existing = effect.getFlag(MODULE_ID, "appliedDamageIds");
    if (existing) ns.appliedDamageIds = existing;
  }
  if (!becomingDisabled && !Array.isArray(ns.appliedConcentrationIds)) {
    const existing = effect.getFlag(MODULE_ID, "appliedConcentrationIds");
    if (existing) ns.appliedConcentrationIds = existing;
  }
  if (!becomingDisabled && ns.appliedSaveIds === undefined) {
    const existing = effect.getFlag(MODULE_ID, "appliedSaveIds");
    if (existing) ns.appliedSaveIds = existing;
  }
  if (!becomingDisabled && ns.appliedCheckIds === undefined) {
    const existing = effect.getFlag(MODULE_ID, "appliedCheckIds");
    if (existing) ns.appliedCheckIds = existing;
  }
  if (!becomingDisabled && ns.appliedSkillIds === undefined) {
    const existing = effect.getFlag(MODULE_ID, "appliedSkillIds");
    if (existing) ns.appliedSkillIds = existing;
  }
}

function wrapAttackChatAction() {
  const Cls = CONFIG.DND5E?.activityTypes?.attack?.documentClass;
  const actions = Cls?.metadata?.usage?.actionsitions;
  if (!actions || actions.rollAttack?.__dmToolkitAttackLimit) return;

  function rollAttackFromChat(event, _target, message) {
    const attackId = message?.id;
    return this.rollAttack(
      { event, [MODULE_ID]: { [ATTACK_ID_KEY]: attackId } },
      {},
      {
        data: {
          [`flags.dnd5e.originatingMessage`]: attackId,
          [`flags.${MODULE_ID}.${ATTACK_ID_KEY}`]: attackId
        }
      }
    );
  }

  rollAttackFromChat.__dmToolkitAttackLimit = true;
  actions.rollAttack = rollAttackFromChat;
}

function wrapAttackActivity() {
  const cls = CONFIG.DND5E?.activityTypes?.attack?.documentClass;
  if (!cls?.prototype?.rollAttack) return;
  const original = cls.prototype.rollAttack;
  if (original.__dmToolkitDnd5eAttackLimit) return;

  async function wrapped(config = {}, dialog = {}, message = {}) {
    const attackId = ensureRollId(config, message, this, ATTACK_ID_KEY);
    foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${ATTACK_ID_KEY}`, attackId);
    await pruneEffectsBeforeRoll(this.actor, attackId, "attacks");
    const rolls = await original.call(this, config, dialog, message);
    if (rolls?.length) await recordRollOnEffects(this.actor, attackId, "attacks");
    return rolls;
  }

  wrapped.__dmToolkitDnd5eAttackLimit = true;
  cls.prototype.rollAttack = wrapped;
}

function wrapDamageActivities() {
  const types = CONFIG.DND5E?.activityTypes ?? {};
  for (const entry of Object.values(types)) {
    const cls = entry?.documentClass;
    if (!cls?.prototype?.rollDamage) continue;
    // Healing uses rollDamage too — do not consume the Damage budget.
    if (cls.metadata?.type === "heal") continue;
    const original = cls.prototype.rollDamage;
    if (original.__dmToolkitDnd5eDamageLimit) continue;

    async function wrapped(config = {}, dialog = {}, message = {}) {
      if (isHealingDamageMessage(message) || this?.type === "heal") {
        return original.call(this, config, dialog, message);
      }
      const damageId = ensureRollId(config, message, this, DAMAGE_ID_KEY);
      foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${DAMAGE_ID_KEY}`, damageId);
      await pruneEffectsBeforeRoll(this.actor, damageId, "damage");
      const rolls = await original.call(this, config, dialog, message);
      if (rolls?.length) await recordRollOnEffects(this.actor, damageId, "damage");
      return rolls;
    }

    wrapped.__dmToolkitDnd5eDamageLimit = true;
    cls.prototype.rollDamage = wrapped;
  }

  wrapDamageChatActions();
}

/**
 * @param {object} message
 * @returns {boolean}
 */
function isHealingDamageMessage(message = {}) {
  const type = foundry.utils.getProperty(message, "data.type")
    ?? message?.data?.["data.type"]
    ?? foundry.utils.getProperty(foundry.utils.expandObject(foundry.utils.deepClone(message?.data ?? {})), "type");
  return type === "healing";
}

function wrapDamageChatActions() {
  const types = CONFIG.DND5E?.activityTypes ?? {};
  for (const entry of Object.values(types)) {
    const actions = entry?.documentClass?.metadata?.usage?.actionsitions;
    if (!actions?.rollDamage || actions.rollDamage.__dmToolkitDamageLimit) continue;

    function rollDamageFromChat(event, _target, message) {
      const damageId = message?.id;
      return this.rollDamage(
        { event, [MODULE_ID]: { [DAMAGE_ID_KEY]: damageId } },
        {},
        {
          data: {
            [`flags.dnd5e.originatingMessage`]: damageId,
            [`flags.${MODULE_ID}.${DAMAGE_ID_KEY}`]: damageId
          }
        }
      );
    }

    rollDamageFromChat.__dmToolkitDamageLimit = true;
    actions.rollDamage = rollDamageFromChat;
  }
}

/**
 * @param {object} config
 * @param {object} _dialog
 * @param {object} message
 */
function onPreRollAttack(config, _dialog, message) {
  stampPreRollId(config, message, ATTACK_ID_KEY);
}

/**
 * @param {object} config
 * @param {object} _dialog
 * @param {object} message
 */
function onPreRollDamage(config, _dialog, message) {
  stampPreRollId(config, message, DAMAGE_ID_KEY);
}

/**
 * @param {object} config
 * @param {object} _dialog
 * @param {object} message
 */
function onPreRollSavingThrow(config, _dialog, message) {
  stampPreRollId(config, message, SAVE_ID_KEY);
}

function wrapActorSavingThrow() {
  const Cls = CONFIG.Actor?.documentClass;
  if (!Cls?.prototype?.rollSavingThrow) return;
  const original = Cls.prototype.rollSavingThrow;
  if (original.__dmToolkitDnd5eSaveLimit) return;

  async function wrapped(config = {}, dialog = {}, message = {}) {
    let ability = config.ability;
    if (ability === "spellcasting") ability = this.spellcastingAbility;
    const isConc = Boolean(config.isConcentration);
    const trackSave = ABILITY_KEYS.includes(ability);
    if (!trackSave && !isConc) {
      return original.call(this, config, dialog, message);
    }

    const saveId = ensureSaveRollId(config, message);
    foundry.utils.setProperty(config, `${MODULE_ID}.${SAVE_ID_KEY}`, saveId);
    foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${SAVE_ID_KEY}`, saveId);
    if (trackSave) await pruneEffectsBeforeSave(this, saveId, ability);
    if (isConc) await pruneEffectsBeforeRoll(this, saveId, "concentration");
    const rolls = await original.call(this, config, dialog, message);
    if (rolls?.length) {
      if (trackSave) await recordSaveOnEffects(this, saveId, ability);
      if (isConc) await recordRollOnEffects(this, saveId, "concentration");
    }
    return rolls;
  }

  wrapped.__dmToolkitDnd5eSaveLimit = true;
  Cls.prototype.rollSavingThrow = wrapped;
}

/**
 * @param {object} config
 * @param {object} [message]
 * @returns {string}
 */
function ensureSaveRollId(config, message = {}) {
  const existing = foundry.utils.getProperty(config, `${MODULE_ID}.${SAVE_ID_KEY}`);
  if (existing) return existing;

  const fromMessage = readMessageRollId(message, SAVE_ID_KEY);
  if (fromMessage) {
    foundry.utils.setProperty(config, `${MODULE_ID}.${SAVE_ID_KEY}`, fromMessage);
    return fromMessage;
  }

  const chatMessage = findRelatedChatMessage(config);
  if (chatMessage) {
    const id = chatMessage.getFlag(MODULE_ID, SAVE_ID_KEY)
      ?? chatMessage.getFlag("dnd5e", "originatingMessage")
      ?? chatMessage.id;
    foundry.utils.setProperty(config, `${MODULE_ID}.${SAVE_ID_KEY}`, id);
    return id;
  }

  const saveId = foundry.utils.randomID();
  foundry.utils.setProperty(config, `${MODULE_ID}.${SAVE_ID_KEY}`, saveId);
  return saveId;
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {string} ability
 */
async function pruneEffectsBeforeSave(actor, rollId, ability) {
  if (!actor || !rollId || !ability) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    if (!isSaveLimitedEffect(effect, ability)) continue;
    if (!wouldExceedSaveBudget(effect, rollId, ability)) continue;

    if (!effect.canUserModify(game.user, "update")) {
      console.warn(`${MODULE_ID} | Cannot disable effect "${effect.name}" (no permission).`);
      continue;
    }
    await effect.update({ disabled: true });
  }
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {string} ability
 */
async function recordSaveOnEffects(actor, rollId, ability) {
  if (!actor || !rollId || !ability) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    if (!isSaveLimitedEffect(effect, ability)) continue;

    const appliedIds = getAppliedSaveIds(effect, ability);
    if (appliedIds.includes(rollId)) continue;
    if (!effect.canUserModify(game.user, "update")) continue;

    await setAppliedSaveIds(effect, ability, [...appliedIds, rollId]);
  }
}

/**
 * @param {object} config
 * @param {object} _dialog
 * @param {object} message
 */
function onPreRollAbilityCheck(config, _dialog, message) {
  stampPreRollId(config, message, CHECK_ID_KEY);
}

function wrapActorAbilityCheck() {
  const Cls = CONFIG.Actor?.documentClass;
  if (!Cls?.prototype?.rollAbilityCheck) return;
  const original = Cls.prototype.rollAbilityCheck;
  if (original.__dmToolkitDnd5eCheckLimit) return;

  async function wrapped(config = {}, dialog = {}, message = {}) {
    let ability = config.ability;
    if (ability === "spellcasting") ability = this.spellcastingAbility;
    if (!ABILITY_KEYS.includes(ability)) {
      return original.call(this, config, dialog, message);
    }

    const checkId = ensureCheckRollId(config, message);
    foundry.utils.setProperty(config, `${MODULE_ID}.${CHECK_ID_KEY}`, checkId);
    foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${CHECK_ID_KEY}`, checkId);
    await pruneEffectsBeforeCheck(this, checkId, ability);
    const rolls = await original.call(this, config, dialog, message);
    if (rolls?.length) await recordCheckOnEffects(this, checkId, ability);
    return rolls;
  }

  wrapped.__dmToolkitDnd5eCheckLimit = true;
  Cls.prototype.rollAbilityCheck = wrapped;
}

/**
 * @param {object} config
 * @param {object} [message]
 * @returns {string}
 */
function ensureCheckRollId(config, message = {}) {
  const existing = foundry.utils.getProperty(config, `${MODULE_ID}.${CHECK_ID_KEY}`);
  if (existing) return existing;

  const fromMessage = readMessageRollId(message, CHECK_ID_KEY);
  if (fromMessage) {
    foundry.utils.setProperty(config, `${MODULE_ID}.${CHECK_ID_KEY}`, fromMessage);
    return fromMessage;
  }

  const chatMessage = findRelatedChatMessage(config);
  if (chatMessage) {
    const id = chatMessage.getFlag(MODULE_ID, CHECK_ID_KEY)
      ?? chatMessage.getFlag("dnd5e", "originatingMessage")
      ?? chatMessage.id;
    foundry.utils.setProperty(config, `${MODULE_ID}.${CHECK_ID_KEY}`, id);
    return id;
  }

  const checkId = foundry.utils.randomID();
  foundry.utils.setProperty(config, `${MODULE_ID}.${CHECK_ID_KEY}`, checkId);
  return checkId;
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {string} ability
 */
async function pruneEffectsBeforeCheck(actor, rollId, ability) {
  if (!actor || !rollId || !ability) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    if (!isCheckLimitedEffect(effect, ability)) continue;
    if (!wouldExceedCheckBudget(effect, rollId, ability)) continue;

    if (!effect.canUserModify(game.user, "update")) {
      console.warn(`${MODULE_ID} | Cannot disable effect "${effect.name}" (no permission).`);
      continue;
    }
    await effect.update({ disabled: true });
  }
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {string} ability
 */
async function recordCheckOnEffects(actor, rollId, ability) {
  if (!actor || !rollId || !ability) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    if (!isCheckLimitedEffect(effect, ability)) continue;

    const appliedIds = getAppliedCheckIds(effect, ability);
    if (appliedIds.includes(rollId)) continue;
    if (!effect.canUserModify(game.user, "update")) continue;

    await setAppliedCheckIds(effect, ability, [...appliedIds, rollId]);
  }
}

/**
 * @param {object} config
 * @param {object} _dialog
 * @param {object} message
 */
function onPreRollSkill(config, _dialog, message) {
  stampPreRollId(config, message, SKILL_ID_KEY);
}

function wrapActorSkillCheck() {
  const Cls = CONFIG.Actor?.documentClass;
  if (!Cls?.prototype?.rollSkill) return;
  const original = Cls.prototype.rollSkill;
  if (original.__dmToolkitDnd5eSkillLimit) return;

  async function wrapped(config = {}, dialog = {}, message = {}) {
    const skill = config.skill;
    if (!SKILL_KEYS.includes(skill)) {
      return original.call(this, config, dialog, message);
    }

    const skillId = ensureSkillRollId(config, message);
    foundry.utils.setProperty(config, `${MODULE_ID}.${SKILL_ID_KEY}`, skillId);
    foundry.utils.setProperty(message, `data.flags.${MODULE_ID}.${SKILL_ID_KEY}`, skillId);
    await pruneEffectsBeforeSkill(this, skillId, skill);
    const rolls = await original.call(this, config, dialog, message);
    if (rolls?.length) await recordSkillOnEffects(this, skillId, skill);
    return rolls;
  }

  wrapped.__dmToolkitDnd5eSkillLimit = true;
  Cls.prototype.rollSkill = wrapped;
}

/**
 * @param {object} config
 * @param {object} [message]
 * @returns {string}
 */
function ensureSkillRollId(config, message = {}) {
  const existing = foundry.utils.getProperty(config, `${MODULE_ID}.${SKILL_ID_KEY}`);
  if (existing) return existing;

  const fromMessage = readMessageRollId(message, SKILL_ID_KEY);
  if (fromMessage) {
    foundry.utils.setProperty(config, `${MODULE_ID}.${SKILL_ID_KEY}`, fromMessage);
    return fromMessage;
  }

  const chatMessage = findRelatedChatMessage(config);
  if (chatMessage) {
    const id = chatMessage.getFlag(MODULE_ID, SKILL_ID_KEY)
      ?? chatMessage.getFlag("dnd5e", "originatingMessage")
      ?? chatMessage.id;
    foundry.utils.setProperty(config, `${MODULE_ID}.${SKILL_ID_KEY}`, id);
    return id;
  }

  const skillId = foundry.utils.randomID();
  foundry.utils.setProperty(config, `${MODULE_ID}.${SKILL_ID_KEY}`, skillId);
  return skillId;
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {string} skill
 */
async function pruneEffectsBeforeSkill(actor, rollId, skill) {
  if (!actor || !rollId || !skill) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    if (!isSkillLimitedEffect(effect, skill)) continue;
    if (!wouldExceedSkillBudget(effect, rollId, skill)) continue;

    if (!effect.canUserModify(game.user, "update")) {
      console.warn(`${MODULE_ID} | Cannot disable effect "${effect.name}" (no permission).`);
      continue;
    }
    await effect.update({ disabled: true });
  }
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {string} skill
 */
async function recordSkillOnEffects(actor, rollId, skill) {
  if (!actor || !rollId || !skill) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    if (!isSkillLimitedEffect(effect, skill)) continue;

    const appliedIds = getAppliedSkillIds(effect, skill);
    if (appliedIds.includes(rollId)) continue;
    if (!effect.canUserModify(game.user, "update")) continue;

    await setAppliedSkillIds(effect, skill, [...appliedIds, rollId]);
  }
}

/**
 * @param {object} config
 * @param {object} message
 * @param {string} idKey
 */
function stampPreRollId(config, message, idKey) {
  const rollId = foundry.utils.getProperty(config, `${MODULE_ID}.${idKey}`)
    ?? resolveRollId(config, message, null, idKey);
  if (!rollId) return;

  foundry.utils.setProperty(config, `${MODULE_ID}.${idKey}`, rollId);
  for (const roll of config.rolls ?? []) {
    foundry.utils.setProperty(roll, `options.${MODULE_ID}.${idKey}`, rollId);
  }
}

/**
 * @param {object} activity
 */
function onPreUseActivity(activity) {
  const key = getActivityKey(activity);
  if (!key) return;
  currentAttackIdByActivity.delete(key);
  currentDamageIdByActivity.delete(key);
}

/**
 * @param {object} activity
 * @param {object} _usageConfig
 * @param {object} results
 */
function onPostUseActivity(activity, _usageConfig, results) {
  const key = getActivityKey(activity);
  const messageId = results?.message?.id;
  if (!key || !messageId) return;
  // Same activity-use message identity for attack + damage re-rolls from that card.
  currentAttackIdByActivity.set(key, messageId);
  currentDamageIdByActivity.set(key, messageId);
}

/**
 * @param {object} config
 * @param {object} [message]
 * @param {object} [activity]
 * @param {string} idKey
 * @returns {string}
 */
function ensureRollId(config, message = {}, activity = null, idKey = ATTACK_ID_KEY) {
  const key = getActivityKey(activity);
  const stickyMap = idKey === DAMAGE_ID_KEY ? currentDamageIdByActivity : currentAttackIdByActivity;
  const existing = foundry.utils.getProperty(config, `${MODULE_ID}.${idKey}`);
  if (existing) {
    rememberRollId(activity, existing, idKey);
    return existing;
  }

  const resolved = resolveRollId(config, message, activity, idKey);
  if (resolved) {
    rememberRollId(activity, resolved, idKey);
    foundry.utils.setProperty(config, `${MODULE_ID}.${idKey}`, resolved);
    return resolved;
  }

  const sticky = key ? stickyMap.get(key) : null;
  if (sticky) {
    foundry.utils.setProperty(config, `${MODULE_ID}.${idKey}`, sticky);
    return sticky;
  }

  const rollId = foundry.utils.randomID();
  rememberRollId(activity, rollId, idKey);
  foundry.utils.setProperty(config, `${MODULE_ID}.${idKey}`, rollId);
  return rollId;
}

/**
 * @param {object} config
 * @param {object} [message]
 * @param {object} [activity]
 * @param {string} idKey
 * @returns {string|null}
 */
function resolveRollId(config, message = {}, activity = null, idKey = ATTACK_ID_KEY) {
  const fromMessage = readMessageRollId(message, idKey);
  if (fromMessage) return fromMessage;

  const chatMessage = findRelatedChatMessage(config);
  if (chatMessage) {
    return chatMessage.getFlag(MODULE_ID, idKey)
      ?? chatMessage.getFlag("dnd5e", "originatingMessage")
      ?? chatMessage.id;
  }

  return findLatestActivityUseMessage(activity)?.id ?? null;
}

/**
 * @param {object} [activity]
 * @returns {string|null}
 */
function getActivityKey(activity) {
  if (!activity) return null;
  const actorId = activity.actor?.id ?? activity.item?.actor?.id ?? "";
  const itemId = activity.item?.id ?? "";
  const activityId = activity.id ?? "";
  if (!itemId || !activityId) return null;
  return `${actorId}.${itemId}.${activityId}`;
}

/**
 * @param {object} [activity]
 * @param {string} rollId
 * @param {string} idKey
 */
function rememberRollId(activity, rollId, idKey = ATTACK_ID_KEY) {
  const key = getActivityKey(activity);
  if (!key || !rollId) return;
  const stickyMap = idKey === DAMAGE_ID_KEY ? currentDamageIdByActivity : currentAttackIdByActivity;
  stickyMap.set(key, rollId);
}

/**
 * @param {object} [activity]
 * @returns {ChatMessage|null}
 */
function findLatestActivityUseMessage(activity) {
  if (!activity?.id) return null;
  const itemUuid = activity.item?.uuid;
  const messages = game.messages.contents;
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 40); i--) {
    const msg = messages[i];
    try {
      if (msg.getAssociatedActivity?.()?.id === activity.id
        && (!itemUuid || msg.getAssociatedActivity?.()?.item?.uuid === itemUuid
          || msg.getFlag("dnd5e", "itemUuid") === itemUuid)) {
        return msg;
      }
    } catch (_err) { /* ignore */ }

    const flagItemUuid = msg.getFlag?.("dnd5e", "itemUuid");
    const flagActivityId = msg.getFlag?.("dnd5e", "activity")?.id
      ?? foundry.utils.getProperty(msg, "flags.dnd5e.activity.id");
    if (flagActivityId === activity.id && (!itemUuid || flagItemUuid === itemUuid)) return msg;
  }
  return null;
}

/**
 * @param {object} [message]
 * @param {string} idKey
 * @returns {string|null}
 */
function readMessageRollId(message = {}, idKey = ATTACK_ID_KEY) {
  const data = message?.data;
  if (!data || typeof data !== "object") return null;

  const expanded = foundry.utils.expandObject(foundry.utils.deepClone(data));
  return foundry.utils.getProperty(expanded, `flags.${MODULE_ID}.${idKey}`)
    ?? foundry.utils.getProperty(expanded, "flags.dnd5e.originatingMessage")
    ?? data[`flags.${MODULE_ID}.${idKey}`]
    ?? data["flags.dnd5e.originatingMessage"]
    ?? null;
}

/**
 * @param {object} config
 * @returns {ChatMessage|null}
 */
function findRelatedChatMessage(config) {
  const event = config?.event;
  if (!event) return null;

  const messageId = event.target?.closest?.("[data-message-id]")?.dataset?.messageId
    ?? event.currentTarget?.closest?.("[data-message-id]")?.dataset?.messageId
    ?? event.currentTarget?.dataset?.messageId
    ?? event.target?.dataset?.messageId;
  return messageId ? (game.messages.get(messageId) ?? null) : null;
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {"attacks"|"damage"|"concentration"} unit
 */
async function pruneEffectsBeforeRoll(actor, rollId, unit) {
  if (!actor || !rollId) return;

  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    const limited = unit === "damage" ? isDamageLimitedEffect(effect)
      : unit === "concentration" ? isConcentrationLimitedEffect(effect)
        : isAttackLimitedEffect(effect);
    if (!limited) continue;

    const exceeds = unit === "damage" ? wouldExceedDamageBudget(effect, rollId)
      : unit === "concentration" ? wouldExceedConcentrationBudget(effect, rollId)
        : wouldExceedAttackBudget(effect, rollId);
    if (!exceeds) continue;

    if (!effect.canUserModify(game.user, "update")) {
      console.warn(`${MODULE_ID} | Cannot disable effect "${effect.name}" (no permission).`);
      continue;
    }
    await effect.update({ disabled: true });
  }
}

/**
 * @param {Actor} actor
 * @param {string} rollId
 * @param {"attacks"|"damage"|"concentration"} unit
 */
async function recordRollOnEffects(actor, rollId, unit) {
  if (!actor || !rollId) return;

  const appliedFlag = unit === "damage" ? "appliedDamageIds"
    : unit === "concentration" ? "appliedConcentrationIds"
      : "appliedAttackIds";
  const effects = [...(actor.appliedEffects ?? actor.effects ?? [])];
  for (const effect of effects) {
    const limited = unit === "damage" ? isDamageLimitedEffect(effect)
      : unit === "concentration" ? isConcentrationLimitedEffect(effect)
        : isAttackLimitedEffect(effect);
    if (!limited) continue;

    const appliedIds = coerceRollIdArray(effect.getFlag(MODULE_ID, appliedFlag));
    if (appliedIds.includes(rollId)) continue;
    if (!effect.canUserModify(game.user, "update")) continue;

    // Only record here. Disable on the next roll that would exceed the budget.
    await effect.setFlag(MODULE_ID, appliedFlag, [...appliedIds, rollId]);
  }
}
