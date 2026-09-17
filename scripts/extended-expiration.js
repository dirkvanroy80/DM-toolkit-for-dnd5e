/**
 * Extended effect expiration: End Effect UI with OR-combined After / On Event conditions.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const EXTENDED_EXPIRATION_SETTING = "extendedEffectExpiration";
const END_CONDITIONS_FLAG = "endConditions";
const ATTACKS_UNIT = "attacks";
const DAMAGE_UNIT = "damage";
const CONCENTRATION_UNIT = "concentration";
const MODE_AFTER = "after";
const MODE_ON_EVENT = "onEvent";
const PSEUDO_EXPIRIES = new Set(["sourceStart", "sourceEnd", "targetStart", "targetEnd"]);
/** @type {readonly string[]} */
export const ABILITY_KEYS = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
/** @deprecated Prefer ABILITY_KEYS — kept for save-limit call sites. */
export const SAVE_ABILITIES = ABILITY_KEYS;
const SAVE_UNIT_PREFIX = "save:";
const CHECK_UNIT_PREFIX = "check:";
const SKILL_UNIT_PREFIX = "skill:";
const APPLIED_SAVE_IDS_FLAG = "appliedSaveIds";
const APPLIED_CHECK_IDS_FLAG = "appliedCheckIds";
const APPLIED_SKILL_IDS_FLAG = "appliedSkillIds";
/** @type {readonly string[]} */
export const SKILL_KEYS = Object.freeze([
  "acr", "ani", "arc", "ath", "dec", "his", "ins", "itm", "inv",
  "med", "nat", "prc", "prf", "per", "rel", "slt", "ste", "sur"
]);

export function registerExtendedExpiration() {
  wrapActiveEffectConfigSubmit();
  Hooks.on("renderActiveEffectConfig", onRenderActiveEffectConfig);
  Hooks.on("preCreateActiveEffect", onPreCreateActiveEffect);
  Hooks.on("preUpdateActiveEffect", onPreUpdateActiveEffectNormalize);
  Hooks.once("ready", () => {
    wrapPrepareDuration();
    wrapActiveEffectRegistryRefresh();
    registerExpirationHooks();
  });
}

export function registerExtendedExpirationSettings() {
  game.settings.register(MODULE_ID, EXTENDED_EXPIRATION_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.ExtendedEffectExpiration.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.ExtendedEffectExpiration.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
}

/**
 * @returns {boolean}
 */
export function isExtendedEffectExpirationEnabled() {
  return Boolean(game.settings.get(MODULE_ID, EXTENDED_EXPIRATION_SETTING));
}

/**
 * @param {ActiveEffect} effect
 * @returns {Array<{mode: string, value?: number, units?: string, expiry?: string}>}
 */
export function getEndConditions(effect) {
  if (!effect) return [];
  const stored = coerceConditionsArray(effect.getFlag?.(MODULE_ID, END_CONDITIONS_FLAG));
  if (stored.length) return stored.map(normalizeCondition).filter(Boolean);
  return synthesizeConditionsFromLegacy(effect);
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function hasEndConditions(effect) {
  return coerceConditionsArray(effect?.getFlag?.(MODULE_ID, END_CONDITIONS_FLAG)).length > 0;
}

/**
 * Foundry flag/form expansion often stores arrays as objects with numeric keys.
 * @param {*} stored
 * @returns {object[]}
 */
function coerceConditionsArray(stored) {
  if (Array.isArray(stored)) return stored.filter(v => v && typeof v === "object");
  if (!stored || typeof stored !== "object") return [];
  return Object.keys(stored)
    .filter(key => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map(key => stored[key])
    .filter(v => v && typeof v === "object");
}

/**
 * Attack budgets from end conditions and/or legacy flags.
 * @param {ActiveEffect} effect
 * @returns {number[]}
 */
export function getAttackBudgetMaxes(effect) {
  return getRollBudgetMaxes(effect, ATTACKS_UNIT, {
    maxKey: "maxAttacks",
    limitKey: "limitAttacks",
    unitsValue: ATTACKS_UNIT
  });
}

/**
 * Damage budgets from end conditions and/or legacy flags.
 * @param {ActiveEffect} effect
 * @returns {number[]}
 */
export function getDamageBudgetMaxes(effect) {
  return getRollBudgetMaxes(effect, DAMAGE_UNIT, {
    maxKey: "maxDamage",
    limitKey: "limitDamage",
    unitsValue: DAMAGE_UNIT
  });
}

/**
 * Concentration check budgets from end conditions and/or legacy flags.
 * @param {ActiveEffect} effect
 * @returns {number[]}
 */
export function getConcentrationBudgetMaxes(effect) {
  return getRollBudgetMaxes(effect, CONCENTRATION_UNIT, {
    maxKey: "maxConcentration",
    limitKey: "limitConcentration",
    unitsValue: CONCENTRATION_UNIT
  });
}

/**
 * @param {string} ability
 * @returns {string}
 */
export function saveUnitFromAbility(ability) {
  return `${SAVE_UNIT_PREFIX}${ability}`;
}

/**
 * @param {string} unit
 * @returns {boolean}
 */
export function isSaveUnit(unit) {
  return typeof unit === "string" && unit.startsWith(SAVE_UNIT_PREFIX);
}

/**
 * @param {string} unit
 * @returns {string|null}
 */
export function saveAbilityFromUnit(unit) {
  if (!isSaveUnit(unit)) return null;
  const ability = unit.slice(SAVE_UNIT_PREFIX.length);
  return ABILITY_KEYS.includes(ability) ? ability : null;
}

/**
 * @param {string} ability
 * @returns {string}
 */
export function checkUnitFromAbility(ability) {
  return `${CHECK_UNIT_PREFIX}${ability}`;
}

/**
 * @param {string} unit
 * @returns {boolean}
 */
export function isCheckUnit(unit) {
  return typeof unit === "string" && unit.startsWith(CHECK_UNIT_PREFIX);
}

/**
 * @param {string} unit
 * @returns {string|null}
 */
export function checkAbilityFromUnit(unit) {
  if (!isCheckUnit(unit)) return null;
  const ability = unit.slice(CHECK_UNIT_PREFIX.length);
  return ABILITY_KEYS.includes(ability) ? ability : null;
}

/**
 * @param {string} skill
 * @returns {string}
 */
export function skillUnitFromKey(skill) {
  return `${SKILL_UNIT_PREFIX}${skill}`;
}

/**
 * @param {string} unit
 * @returns {boolean}
 */
export function isSkillUnit(unit) {
  return typeof unit === "string" && unit.startsWith(SKILL_UNIT_PREFIX);
}

/**
 * @param {string} unit
 * @returns {string|null}
 */
export function skillKeyFromUnit(unit) {
  if (!isSkillUnit(unit)) return null;
  const skill = unit.slice(SKILL_UNIT_PREFIX.length);
  return SKILL_KEYS.includes(skill) ? skill : null;
}

/**
 * @param {string} unit
 * @returns {boolean}
 */
export function isRollLimitUnit(unit) {
  return unit === ATTACKS_UNIT || unit === DAMAGE_UNIT || unit === CONCENTRATION_UNIT
    || isSaveUnit(unit) || isCheckUnit(unit) || isSkillUnit(unit);
}

/**
 * Saving throw budgets for one ability from end conditions.
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @returns {number[]}
 */
export function getSaveBudgetMaxes(effect, ability) {
  if (!ABILITY_KEYS.includes(ability)) return [];
  return getRollBudgetMaxes(effect, saveUnitFromAbility(ability), {
    maxKey: "",
    limitKey: "",
    unitsValue: saveUnitFromAbility(ability)
  });
}

/**
 * Ability check budgets for one ability from end conditions.
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @returns {number[]}
 */
export function getCheckBudgetMaxes(effect, ability) {
  if (!ABILITY_KEYS.includes(ability)) return [];
  return getRollBudgetMaxes(effect, checkUnitFromAbility(ability), {
    maxKey: "",
    limitKey: "",
    unitsValue: checkUnitFromAbility(ability)
  });
}

/**
 * Skill check budgets for one skill from end conditions.
 * @param {ActiveEffect} effect
 * @param {string} skill
 * @returns {number[]}
 */
export function getSkillBudgetMaxes(effect, skill) {
  if (!SKILL_KEYS.includes(skill)) return [];
  return getRollBudgetMaxes(effect, skillUnitFromKey(skill), {
    maxKey: "",
    limitKey: "",
    unitsValue: skillUnitFromKey(skill)
  });
}

/**
 * @param {ActiveEffect} effect
 * @param {string} unit
 * @param {{maxKey: string, limitKey: string, unitsValue: string}} legacy
 * @returns {number[]}
 */
function getRollBudgetMaxes(effect, unit, legacy) {
  const fromConditions = getEndConditions(effect)
    .filter(c => c.mode === MODE_AFTER && c.units === unit)
    .map(c => Number(c.value) || 0)
    .filter(n => n > 0);

  if (fromConditions.length) return fromConditions;

  if (!legacy?.maxKey || !legacy?.limitKey) return [];

  const max = Number(effect.getFlag?.(MODULE_ID, legacy.maxKey)) || 0;
  const usesLegacy = effect.getFlag?.(MODULE_ID, "units") === legacy.unitsValue
    || Boolean(effect.getFlag?.(MODULE_ID, legacy.limitKey));
  return usesLegacy && max > 0 ? [max] : [];
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function isAttackLimitedEffect(effect) {
  if (!effect || effect.disabled) return false;
  return getAttackBudgetMaxes(effect).length > 0;
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function isDamageLimitedEffect(effect) {
  if (!effect || effect.disabled) return false;
  return getDamageBudgetMaxes(effect).length > 0;
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function isConcentrationLimitedEffect(effect) {
  if (!effect || effect.disabled) return false;
  return getConcentrationBudgetMaxes(effect).length > 0;
}

/**
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @returns {boolean}
 */
export function isSaveLimitedEffect(effect, ability) {
  if (!effect || effect.disabled) return false;
  return getSaveBudgetMaxes(effect, ability).length > 0;
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function hasAnySaveLimit(effect) {
  if (!effect) return false;
  return ABILITY_KEYS.some(ability => getSaveBudgetMaxes(effect, ability).length > 0);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @returns {boolean}
 */
export function isCheckLimitedEffect(effect, ability) {
  if (!effect || effect.disabled) return false;
  return getCheckBudgetMaxes(effect, ability).length > 0;
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function hasAnyCheckLimit(effect) {
  if (!effect) return false;
  return ABILITY_KEYS.some(ability => getCheckBudgetMaxes(effect, ability).length > 0);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} skill
 * @returns {boolean}
 */
export function isSkillLimitedEffect(effect, skill) {
  if (!effect || effect.disabled) return false;
  return getSkillBudgetMaxes(effect, skill).length > 0;
}

/**
 * @param {ActiveEffect} effect
 * @returns {boolean}
 */
export function hasAnySkillLimit(effect) {
  if (!effect) return false;
  return SKILL_KEYS.some(skill => getSkillBudgetMaxes(effect, skill).length > 0);
}

/**
 * True when adding this roll id would exceed any configured attack budget.
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @returns {boolean}
 */
export function wouldExceedAttackBudget(effect, rollId) {
  return wouldExceedRollBudget(effect, rollId, getAttackBudgetMaxes(effect), "appliedAttackIds");
}

/**
 * True when adding this roll id would exceed any configured damage budget.
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @returns {boolean}
 */
export function wouldExceedDamageBudget(effect, rollId) {
  return wouldExceedRollBudget(effect, rollId, getDamageBudgetMaxes(effect), "appliedDamageIds");
}

/**
 * True when adding this concentration check id would exceed any configured concentration budget.
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @returns {boolean}
 */
export function wouldExceedConcentrationBudget(effect, rollId) {
  return wouldExceedRollBudget(effect, rollId, getConcentrationBudgetMaxes(effect), "appliedConcentrationIds");
}

/**
 * True when adding this save roll id would exceed the ability's save budget.
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @param {string} ability
 * @returns {boolean}
 */
export function wouldExceedSaveBudget(effect, rollId, ability) {
  return wouldExceedRollBudget(
    effect,
    rollId,
    getSaveBudgetMaxes(effect, ability),
    APPLIED_SAVE_IDS_FLAG,
    ability,
    "save"
  );
}

/**
 * True when adding this ability check id would exceed the ability's check budget.
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @param {string} ability
 * @returns {boolean}
 */
export function wouldExceedCheckBudget(effect, rollId, ability) {
  return wouldExceedRollBudget(
    effect,
    rollId,
    getCheckBudgetMaxes(effect, ability),
    APPLIED_CHECK_IDS_FLAG,
    ability,
    "check"
  );
}

/**
 * True when adding this skill check id would exceed the skill's budget.
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @param {string} skill
 * @returns {boolean}
 */
export function wouldExceedSkillBudget(effect, rollId, skill) {
  return wouldExceedRollBudget(
    effect,
    rollId,
    getSkillBudgetMaxes(effect, skill),
    APPLIED_SKILL_IDS_FLAG,
    skill,
    "skill"
  );
}

/**
 * Foundry often persists arrays as objects with numeric keys.
 * @param {*} value
 * @returns {string[]}
 */
export function coerceRollIdArray(value) {
  if (Array.isArray(value)) return value.filter(id => typeof id === "string" && id);
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map(k => value[k])
    .filter(id => typeof id === "string" && id);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @returns {string[]}
 */
export function getAppliedSaveIds(effect, ability) {
  const raw = effect.getFlag?.(MODULE_ID, APPLIED_SAVE_IDS_FLAG);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return coerceRollIdArray(raw[ability]);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @param {string[]} ids
 */
export async function setAppliedSaveIds(effect, ability, ids) {
  const raw = effect.getFlag?.(MODULE_ID, APPLIED_SAVE_IDS_FLAG);
  const map = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? foundry.utils.deepClone(raw)
    : {};
  map[ability] = ids;
  await effect.setFlag(MODULE_ID, APPLIED_SAVE_IDS_FLAG, map);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @returns {string[]}
 */
export function getAppliedCheckIds(effect, ability) {
  const raw = effect.getFlag?.(MODULE_ID, APPLIED_CHECK_IDS_FLAG);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return coerceRollIdArray(raw[ability]);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} ability
 * @param {string[]} ids
 */
export async function setAppliedCheckIds(effect, ability, ids) {
  const raw = effect.getFlag?.(MODULE_ID, APPLIED_CHECK_IDS_FLAG);
  const map = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? foundry.utils.deepClone(raw)
    : {};
  map[ability] = ids;
  await effect.setFlag(MODULE_ID, APPLIED_CHECK_IDS_FLAG, map);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} skill
 * @returns {string[]}
 */
export function getAppliedSkillIds(effect, skill) {
  const raw = effect.getFlag?.(MODULE_ID, APPLIED_SKILL_IDS_FLAG);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return coerceRollIdArray(raw[skill]);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} skill
 * @param {string[]} ids
 */
export async function setAppliedSkillIds(effect, skill, ids) {
  const raw = effect.getFlag?.(MODULE_ID, APPLIED_SKILL_IDS_FLAG);
  const map = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? foundry.utils.deepClone(raw)
    : {};
  map[skill] = ids;
  await effect.setFlag(MODULE_ID, APPLIED_SKILL_IDS_FLAG, map);
}

/**
 * @param {ActiveEffect} effect
 * @param {string} rollId
 * @param {number[]} maxes
 * @param {string} appliedFlag
 * @param {string} [key]
 * @param {"save"|"check"|"skill"|null} [abilityKind]
 * @returns {boolean}
 */
function wouldExceedRollBudget(effect, rollId, maxes, appliedFlag, key = null, abilityKind = null) {
  if (!maxes.length || !rollId) return false;
  let ids;
  if (key && abilityKind === "save") ids = getAppliedSaveIds(effect, key);
  else if (key && abilityKind === "check") ids = getAppliedCheckIds(effect, key);
  else if (key && abilityKind === "skill") ids = getAppliedSkillIds(effect, key);
  else ids = coerceRollIdArray(effect.getFlag(MODULE_ID, appliedFlag));
  if (ids.includes(rollId)) return false;
  // First distinct roll must always be allowed when budgets are positive.
  if (!ids.length) return false;
  return maxes.some(max => ids.length >= max);
}

/**
 * @param {ActiveEffect} effect
 * @param {"attacks"|"damage"|string} unit Ability key when checking a save/check unit.
 * @returns {boolean}
 */
export function isRollBudgetExhausted(effect, unit) {
  if (unit === DAMAGE_UNIT) {
    const maxes = getDamageBudgetMaxes(effect);
    if (!maxes.length) return false;
    const ids = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedDamageIds"));
    return maxes.some(max => ids.length >= max);
  }
  if (unit === CONCENTRATION_UNIT) {
    const maxes = getConcentrationBudgetMaxes(effect);
    if (!maxes.length) return false;
    const ids = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedConcentrationIds"));
    return maxes.some(max => ids.length >= max);
  }
  if (unit === ATTACKS_UNIT || unit === "attacks") {
    const maxes = getAttackBudgetMaxes(effect);
    if (!maxes.length) return false;
    const ids = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedAttackIds"));
    return maxes.some(max => ids.length >= max);
  }
  if (ABILITY_KEYS.includes(unit)) {
    const saveMaxes = getSaveBudgetMaxes(effect, unit);
    if (saveMaxes.length) {
      const ids = getAppliedSaveIds(effect, unit);
      return saveMaxes.some(max => ids.length >= max);
    }
    const checkMaxes = getCheckBudgetMaxes(effect, unit);
    if (checkMaxes.length) {
      const ids = getAppliedCheckIds(effect, unit);
      return checkMaxes.some(max => ids.length >= max);
    }
  }
  if (SKILL_KEYS.includes(unit)) {
    const maxes = getSkillBudgetMaxes(effect, unit);
    if (!maxes.length) return false;
    const ids = getAppliedSkillIds(effect, unit);
    return maxes.some(max => ids.length >= max);
  }
  return false;
}

/**
 * @param {*} raw
 * @returns {object|null}
 */
function normalizeCondition(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === MODE_ON_EVENT ? MODE_ON_EVENT : MODE_AFTER;
  if (mode === MODE_ON_EVENT) {
    const expiry = typeof raw.expiry === "string" ? raw.expiry : "";
    return { mode, expiry };
  }
  const value = Math.max(0, Math.floor(Number(raw.value)) || 0);
  const units = normalizeTimeUnit(typeof raw.units === "string" ? raw.units : "") || (typeof raw.units === "string" ? raw.units : "");
  return { mode, value, units };
}

/**
 * Build a single condition row from native duration / legacy attack flags.
 * @param {ActiveEffect} effect
 * @returns {object[]}
 */
function synthesizeConditionsFromLegacy(effect) {
  const attackMax = Number(effect.getFlag?.(MODULE_ID, "maxAttacks")) || 0;
  const usesAttacks = effect.getFlag?.(MODULE_ID, "units") === ATTACKS_UNIT
    || Boolean(effect.getFlag?.(MODULE_ID, "limitAttacks"));
  if (usesAttacks && attackMax > 0) {
    return [{ mode: MODE_AFTER, value: attackMax, units: ATTACKS_UNIT }];
  }

  const damageMax = Number(effect.getFlag?.(MODULE_ID, "maxDamage")) || 0;
  const usesDamage = effect.getFlag?.(MODULE_ID, "units") === DAMAGE_UNIT
    || Boolean(effect.getFlag?.(MODULE_ID, "limitDamage"));
  if (usesDamage && damageMax > 0) {
    return [{ mode: MODE_AFTER, value: damageMax, units: DAMAGE_UNIT }];
  }

  const concentrationMax = Number(effect.getFlag?.(MODULE_ID, "maxConcentration")) || 0;
  const usesConcentration = effect.getFlag?.(MODULE_ID, "units") === CONCENTRATION_UNIT
    || Boolean(effect.getFlag?.(MODULE_ID, "limitConcentration"));
  if (usesConcentration && concentrationMax > 0) {
    return [{ mode: MODE_AFTER, value: concentrationMax, units: CONCENTRATION_UNIT }];
  }

  const value = effect.duration?.value;
  const units = effect.duration?.units;
  const expiry = effect.duration?.expiry;

  if (expiry && (value == null || value === "" || Number(value) === 0) && !units) {
    return [{ mode: MODE_ON_EVENT, expiry: String(expiry) }];
  }
  if (units || (value != null && value !== "")) {
    return [{
      mode: MODE_AFTER,
      value: Math.max(0, Math.floor(Number(value)) || 0),
      units: units || ""
    }];
  }
  if (expiry) return [{ mode: MODE_ON_EVENT, expiry: String(expiry) }];
  return [{ mode: MODE_AFTER, value: null, units: "" }];
}

/* -------------------------------------------- */
/*  Submit                                      */
/* -------------------------------------------- */

function wrapActiveEffectConfigSubmit() {
  const wrap = Cls => {
    if (!Cls?.prototype) return false;

    const prepare = Cls.prototype._prepareSubmitData;
    if (typeof prepare === "function" && !prepare.__dmToolkitExtendedExpiration) {
      function wrappedPrepare(event, form, formData, updateData) {
        const submitData = prepare.call(this, event, form, formData, updateData);
        if (isExtendedEffectExpirationEnabled()) applyEndConditionsToSubmit(submitData, form);
        return submitData;
      }
      wrappedPrepare.__dmToolkitExtendedExpiration = true;
      Cls.prototype._prepareSubmitData = wrappedPrepare;
    }

    const process = Cls.prototype._processSubmitData;
    if (typeof process === "function" && !process.__dmToolkitExtendedExpiration) {
      async function wrappedProcess(event, form, submitData, options) {
        if (isExtendedEffectExpirationEnabled()) applyEndConditionsToSubmit(submitData, form);
        return process.call(this, event, form, submitData, options);
      }
      wrappedProcess.__dmToolkitExtendedExpiration = true;
      Cls.prototype._processSubmitData = wrappedProcess;
    }
    return true;
  };

  const core = foundry.applications?.sheets?.ActiveEffectConfig;
  if (!wrap(core)) Hooks.once("setup", () => wrap(foundry.applications?.sheets?.ActiveEffectConfig));

  Hooks.once("ready", () => {
    // dnd5e or other modules may substitute a different sheet class.
    const configured = Object.values(CONFIG.ActiveEffect?.sheetClasses ?? {})
      .flatMap(group => Object.values(group ?? {}))
      .map(entry => entry?.cls ?? entry)
      .filter(Boolean);
    for (const Cls of configured) wrap(Cls);
  });
}

/**
 * @param {string} unit
 * @returns {boolean}
 */
function isTimeDurationUnit(unit) {
  const u = normalizeTimeUnit(unit);
  return u === "turns" || u === "rounds" || u === "seconds" || u === "minutes"
    || u === "hours" || u === "days" || u === "months" || u === "years";
}

/**
 * Normalize singular Foundry/stock unit ids to plural schema values.
 * @param {string} unit
 * @returns {string}
 */
function normalizeTimeUnit(unit) {
  if (unit === "turn") return "turns";
  if (unit === "round") return "rounds";
  return typeof unit === "string" ? unit : "";
}

/**
 * @param {object} submitData
 * @param {HTMLElement} form
 */
function applyEndConditionsToSubmit(submitData, form) {
  if (!submitData) return;

  // Only rewrite duration when our End Effect controls are present in the submitted form.
  if (!(form instanceof HTMLElement) || !form.querySelector(".dm-toolkit-end-condition")) return;

  const conditions = parseEndConditionsFromForm(form).map(c => {
    if (!c || c.mode !== MODE_AFTER) return c;
    return { ...c, units: normalizeTimeUnit(c.units) || c.units };
  });
  foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}`, conditions);

  // Ensure Foundry persists a real array (numeric-key objects break OR evaluation).
  const flagPath = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}`;
  foundry.utils.setProperty(submitData, flagPath, conditions.slice());

  // Never AND native expiry with our OR On-Event rows.
  foundry.utils.setProperty(submitData, "duration.expiry", null);

  // Restore native duration for time-based After rows so Foundry tracks remaining turns/rounds.
  // Custom units (attacks/damage/…) stay flag-only; mixed time units rely on custom evaluation.
  const timeAfter = conditions.filter(c =>
    c.mode === MODE_AFTER && isTimeDurationUnit(c.units) && Number(c.value) > 0
  );
  const timeUnits = new Set(timeAfter.map(c => normalizeTimeUnit(c.units)));
  if (timeAfter.length && timeUnits.size === 1) {
    const unit = [...timeUnits][0];
    const value = Math.min(...timeAfter.map(c => Number(c.value)));
    foundry.utils.setProperty(submitData, "duration.value", value);
    foundry.utils.setProperty(submitData, "duration.units", unit);
  } else {
    foundry.utils.setProperty(submitData, "duration.value", null);
    foundry.utils.setProperty(submitData, "duration.units", "");
  }

  const attackMaxes = conditions
    .filter(c => c.mode === MODE_AFTER && c.units === ATTACKS_UNIT)
    .map(c => c.value)
    .filter(n => n > 0);
  const damageMaxes = conditions
    .filter(c => c.mode === MODE_AFTER && c.units === DAMAGE_UNIT)
    .map(c => c.value)
    .filter(n => n > 0);
  const concentrationMaxes = conditions
    .filter(c => c.mode === MODE_AFTER && c.units === CONCENTRATION_UNIT)
    .map(c => c.value)
    .filter(n => n > 0);
  const saveConditions = conditions.filter(c => c.mode === MODE_AFTER && isSaveUnit(c.units));
  const checkConditions = conditions.filter(c => c.mode === MODE_AFTER && isCheckUnit(c.units));
  const skillConditions = conditions.filter(c => c.mode === MODE_AFTER && isSkillUnit(c.units));

  if (attackMaxes.length) {
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.units`, ATTACKS_UNIT);
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.limitAttacks`, true);
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.maxAttacks`, Math.min(...attackMaxes));
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.appliedAttackIds`, []);
  } else {
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.limitAttacks`, false);
  }

  if (damageMaxes.length) {
    if (!attackMaxes.length && !concentrationMaxes.length && !saveConditions.length
      && !checkConditions.length && !skillConditions.length) {
      foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.units`, DAMAGE_UNIT);
    }
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.limitDamage`, true);
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.maxDamage`, Math.min(...damageMaxes));
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.appliedDamageIds`, []);
  } else {
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.limitDamage`, false);
  }

  if (concentrationMaxes.length) {
    if (!attackMaxes.length && !damageMaxes.length && !saveConditions.length
      && !checkConditions.length && !skillConditions.length) {
      foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.units`, CONCENTRATION_UNIT);
    }
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.limitConcentration`, true);
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.maxConcentration`, Math.min(...concentrationMaxes));
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.appliedConcentrationIds`, []);
  } else {
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.limitConcentration`, false);
  }

  if (saveConditions.length) {
    if (!attackMaxes.length && !damageMaxes.length && !concentrationMaxes.length
      && !checkConditions.length && !skillConditions.length) {
      foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.units`, saveConditions[0].units);
    }
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.${APPLIED_SAVE_IDS_FLAG}`, {});
  }

  if (checkConditions.length) {
    if (!attackMaxes.length && !damageMaxes.length && !concentrationMaxes.length
      && !saveConditions.length && !skillConditions.length) {
      foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.units`, checkConditions[0].units);
    }
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.${APPLIED_CHECK_IDS_FLAG}`, {});
  }

  if (skillConditions.length) {
    if (!attackMaxes.length && !damageMaxes.length && !concentrationMaxes.length
      && !saveConditions.length && !checkConditions.length) {
      foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.units`, skillConditions[0].units);
    }
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.${APPLIED_SKILL_IDS_FLAG}`, {});
  }

  if (!attackMaxes.length && !damageMaxes.length && !concentrationMaxes.length && !saveConditions.length
    && !checkConditions.length && !skillConditions.length) {
    foundry.utils.setProperty(submitData, `flags.${MODULE_ID}.-=units`, null);
  }
}

/**
 * Keep endConditions as a real array and stamp combat/world start markers for After checks.
 * @param {ActiveEffect} _effect
 * @param {object} data
 */
function onPreCreateActiveEffect(_effect, data) {
  normalizeEndConditionsInChange(data);
  stampDurationStart(data);
}

/**
 * @param {ActiveEffect} effect
 * @param {object} change
 */
function onPreUpdateActiveEffectNormalize(effect, change) {
  normalizeEndConditionsInChange(change);

  const nextFlags = foundry.utils.getProperty(change, `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}`);
  const hasConditions = coerceConditionsArray(
    nextFlags ?? effect.getFlag(MODULE_ID, END_CONDITIONS_FLAG)
  ).length > 0;
  if (hasConditions) stampDurationStart(change, effect);
}

/**
 * @param {object} data
 */
function normalizeEndConditionsInChange(data) {
  if (!data || typeof data !== "object") return;
  const path = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}`;
  if (!foundry.utils.hasProperty(data, path)) return;
  const coerced = coerceConditionsArray(foundry.utils.getProperty(data, path))
    .map(normalizeCondition)
    .filter(Boolean);
  foundry.utils.setProperty(data, path, coerced);
}

/**
 * Stamp Foundry V13+ `start` markers (combat round/turn/time) for After checks.
 * @param {object} data
 * @param {ActiveEffect} [effect]
 */
function stampDurationStart(data, effect = null) {
  if (!data || typeof data !== "object") return;

  const start = foundry.utils.getProperty(data, "start") ?? {};
  const existing = effect?.start ?? {};
  const patch = {};

  if (start.time == null && existing.time == null) {
    patch.time = game.time?.worldTime ?? 0;
  }
  if (game.combat?.started) {
    if (start.round == null && existing.round == null) {
      patch.round = game.combat.round ?? 0;
    }
    if (start.turn == null && existing.turn == null) {
      patch.turn = game.combat.turn ?? 0;
    }
    if (start.combat == null && existing.combat == null) {
      patch.combat = game.combat.id;
    }
    if (start.combatant == null && existing.combatant == null) {
      patch.combatant = game.combat.combatant?.id ?? null;
    }
  }

  if (!Object.keys(patch).length) return;
  foundry.utils.setProperty(
    data,
    "start",
    foundry.utils.mergeObject(start, patch, { inplace: false })
  );
}

/**
 * @param {HTMLElement} form
 * @returns {object[]}
 */
function parseEndConditionsFromForm(form) {
  if (!(form instanceof HTMLElement)) return [{ mode: MODE_AFTER, value: null, units: "" }];

  const rows = [...form.querySelectorAll(".dm-toolkit-end-condition")];
  if (!rows.length) return [{ mode: MODE_AFTER, value: null, units: "" }];

  return rows.map(row => {
    const mode = row.querySelector('[data-dm-toolkit-field="mode"]')?.value === MODE_ON_EVENT
      ? MODE_ON_EVENT
      : MODE_AFTER;
    if (mode === MODE_ON_EVENT) {
      return {
        mode,
        expiry: row.querySelector('[data-dm-toolkit-field="expiry"]')?.value ?? ""
      };
    }
    const valueRaw = row.querySelector('[data-dm-toolkit-field="value"]')?.value;
    const value = valueRaw === "" || valueRaw == null ? null : Math.max(0, Math.floor(Number(valueRaw)) || 0);
    return {
      mode,
      value,
      units: row.querySelector('[data-dm-toolkit-field="units"]')?.value ?? ""
    };
  });
}

function registerExpirationHooks() {
  Hooks.on("updateWorldTime", () => {
    evaluateEndConditionsForEvent("updateWorldTime", {});
  });

  Hooks.on("combatTurnChange", (combat, prior, current) => {
    const ctx = {
      combat,
      prior,
      current,
      round: combat.round,
      turn: combat.turn
    };
    evaluateEndConditionsForEvent("turnEnd", ctx);
    evaluateEndConditionsForEvent("turnStart", ctx);
  });

  Hooks.on("combatStart", combat => {
    evaluateEndConditionsForEvent("combatStart", { combat });
  });

  Hooks.on("deleteCombat", combat => {
    evaluateEndConditionsForEvent("combatEnd", { combat });
  });

  Hooks.on("combatRound", (combat, _updateData, updateOptions) => {
    const direction = updateOptions?.direction ?? 1;
    evaluateEndConditionsForEvent(direction >= 0 ? "roundEnd" : "roundStart", { combat });
    evaluateEndConditionsForEvent(direction >= 0 ? "roundStart" : "roundEnd", { combat });
  });

  Hooks.on("updateCombat", (combat, changed) => {
    if (!("turn" in changed) && !("round" in changed)) return;
    const ctx = { combat, round: combat.round, turn: combat.turn };
    if ("turn" in changed) {
      evaluateEndConditionsForEvent("turnEnd", ctx);
      evaluateEndConditionsForEvent("turnStart", ctx);
    }
    if ("round" in changed) {
      evaluateEndConditionsForEvent("roundEnd", ctx);
      evaluateEndConditionsForEvent("roundStart", ctx);
    }
  });

  // dnd5e rest expiry events (shortRest / longRest) are not combat registry events.
  Hooks.on("dnd5e.restCompleted", (actor, _result, config) => {
    const events = CONFIG.DND5E?.restTypes?.[config?.type]?.expiryEvents
      ?? defaultRestExpiryEvents(config?.type);
    for (const event of events) {
      evaluateEndConditionsForEvent(event, { actors: new Set([actor]) });
    }
  });
}

/**
 * @param {string} [type]
 * @returns {string[]}
 */
function defaultRestExpiryEvents(type) {
  if (type === "short") return ["shortRest"];
  if (type === "long") return ["longRest", "shortRest"];
  return [];
}

/* -------------------------------------------- */
/*  UI                                          */
/* -------------------------------------------- */

/**
 * @param {ActiveEffectConfig} app
 * @param {HTMLElement} html
 */
function onRenderActiveEffectConfig(app, html) {
  if (!isExtendedEffectExpirationEnabled()) return;

  const root = html instanceof HTMLElement ? html : null;
  if (!root || root.querySelector(".dm-toolkit-end-effect")) return;

  const durationTab = findDurationTab(root);
  if (!durationTab) return;

  const stock = captureStockControls(durationTab);
  if (!stock.unitsSelect && !stock.expirySelect) return;

  hideStockDurationRows(durationTab, stock);
  renameDurationHeading(durationTab);

  const conditions = getEndConditions(app.document);
  const section = buildEndEffectSection(stock, conditions);

  const anchor = stock.durationRow ?? stock.expiryRow;
  if (anchor) anchor.before(section);
  else {
    const fieldset = durationTab.querySelector("fieldset");
    if (fieldset) fieldset.append(section);
    else durationTab.append(section);
  }
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLElement|null}
 */
function findDurationTab(root) {
  return root.querySelector('.tab[data-tab="duration"], [data-application-part="duration"]')
    ?? root.querySelector('select[name="duration.units"]')?.closest(".tab, [data-application-part], form")
    ?? null;
}

/**
 * @param {HTMLElement} durationTab
 * @returns {{durationRow: HTMLElement|null, expiryRow: HTMLElement|null, valueInput: HTMLInputElement|null, unitsSelect: HTMLSelectElement|null, expirySelect: HTMLSelectElement|null}}
 */
function captureStockControls(durationTab) {
  const valueInput = durationTab.querySelector('input[name="duration.value"]');
  const unitsSelect = durationTab.querySelector('select[name="duration.units"]');
  const expirySelect = durationTab.querySelector('select[name="duration.expiry"]');
  return {
    valueInput,
    unitsSelect,
    expirySelect,
    durationRow: valueInput?.closest(".form-group") ?? unitsSelect?.closest(".form-group") ?? null,
    expiryRow: expirySelect?.closest(".form-group") ?? null
  };
}

/**
 * @param {HTMLElement} durationTab
 * @param {ReturnType<typeof captureStockControls>} stock
 */
function hideStockDurationRows(durationTab, stock) {
  stock.durationRow?.classList.add("dm-toolkit-end-effect-hidden");
  stock.expiryRow?.classList.add("dm-toolkit-end-effect-hidden");
  if (stock.valueInput) {
    stock.valueInput.disabled = true;
    stock.valueInput.removeAttribute("name");
  }
  if (stock.unitsSelect) {
    stock.unitsSelect.disabled = true;
    stock.unitsSelect.removeAttribute("name");
  }
  if (stock.expirySelect) {
    stock.expirySelect.disabled = true;
    stock.expirySelect.removeAttribute("name");
  }
}

/**
 * @param {HTMLElement} durationTab
 */
function renameDurationHeading(durationTab) {
  const title = game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.Title");
  const candidates = durationTab.querySelectorAll("legend, h3, h4, .form-header, label.section-header");
  for (const el of candidates) {
    const text = el.textContent?.trim().toLowerCase() ?? "";
    if (text.includes("duration") || text.includes("effect duration")) {
      el.textContent = title;
      return;
    }
  }
  const header = document.createElement("h4");
  header.classList.add("dm-toolkit-end-effect-title");
  header.textContent = title;
  durationTab.prepend(header);
}

/**
 * @param {ReturnType<typeof captureStockControls>} stock
 * @param {object[]} conditions
 * @returns {HTMLElement}
 */
function buildEndEffectSection(stock, conditions) {
  const section = document.createElement("div");
  section.classList.add("dm-toolkit-end-effect");

  const list = document.createElement("div");
  list.classList.add("dm-toolkit-end-conditions");
  section.append(list);

  const rows = conditions.length ? conditions : [{ mode: MODE_AFTER, value: null, units: "" }];
  rows.forEach((condition, index) => {
    if (index > 0) list.append(createOrLabel());
    list.append(createConditionRow(stock, condition, index));
  });

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.classList.add("dm-toolkit-add-condition");
  addBtn.innerHTML = `<i class="fas fa-plus"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.AddCondition")}`;
  addBtn.addEventListener("click", event => {
    event.preventDefault();
    list.append(createOrLabel());
    list.append(createConditionRow(stock, { mode: MODE_AFTER, value: null, units: "" }, list.querySelectorAll(".dm-toolkit-end-condition").length));
    reindexConditionRows(list);
  });
  section.append(addBtn);

  return section;
}

/**
 * @returns {HTMLElement}
 */
function createOrLabel() {
  const or = document.createElement("div");
  or.classList.add("dm-toolkit-end-or");
  or.textContent = game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.Or");
  return or;
}

/**
 * @param {ReturnType<typeof captureStockControls>} stock
 * @param {object} condition
 * @param {number} index
 * @returns {HTMLElement}
 */
function createConditionRow(stock, condition, index) {
  const row = document.createElement("div");
  row.classList.add("form-group", "dm-toolkit-end-condition");
  row.dataset.index = String(index);

  const fields = document.createElement("div");
  fields.classList.add("form-fields", "dm-toolkit-end-condition-fields");

  const modeSelect = document.createElement("select");
  modeSelect.dataset.dmToolkitField = "mode";
  modeSelect.name = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}.${index}.mode`;
  modeSelect.innerHTML = `
    <option value="${MODE_AFTER}">${game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.ModeAfter")}</option>
    <option value="${MODE_ON_EVENT}">${game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.ModeOnEvent")}</option>
  `;
  modeSelect.value = condition.mode === MODE_ON_EVENT ? MODE_ON_EVENT : MODE_AFTER;

  const afterFields = document.createElement("div");
  afterFields.classList.add("dm-toolkit-end-after-fields");
  afterFields.hidden = modeSelect.value !== MODE_AFTER;

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.min = "0";
  valueInput.step = "1";
  valueInput.dataset.dmToolkitField = "value";
  valueInput.name = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}.${index}.value`;
  if (condition.value != null && condition.value !== "") valueInput.value = String(condition.value);

  const unitsSelect = document.createElement("select");
  unitsSelect.dataset.dmToolkitField = "units";
  unitsSelect.name = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}.${index}.units`;
  populateUnitsSelect(unitsSelect, stock.unitsSelect, condition.units ?? "");

  afterFields.append(valueInput, unitsSelect);

  const eventFields = document.createElement("div");
  eventFields.classList.add("dm-toolkit-end-event-fields");
  eventFields.hidden = modeSelect.value !== MODE_ON_EVENT;

  const expirySelect = document.createElement("select");
  expirySelect.dataset.dmToolkitField = "expiry";
  expirySelect.name = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}.${index}.expiry`;
  populateExpirySelect(expirySelect, stock.expirySelect, condition.expiry ?? "");
  eventFields.append(expirySelect);

  modeSelect.addEventListener("change", () => {
    const isAfter = modeSelect.value === MODE_AFTER;
    afterFields.hidden = !isAfter;
    eventFields.hidden = isAfter;
  });

  fields.append(modeSelect, afterFields, eventFields);

  if (index > 0) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.classList.add("dm-toolkit-remove-condition");
    removeBtn.dataset.tooltip = game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.RemoveCondition");
    removeBtn.innerHTML = `<i class="fas fa-trash"></i>`;
    removeBtn.addEventListener("click", event => {
      event.preventDefault();
      const list = row.parentElement;
      const prev = row.previousElementSibling;
      if (prev?.classList.contains("dm-toolkit-end-or")) prev.remove();
      row.remove();
      if (list) reindexConditionRows(list);
    });
    fields.append(removeBtn);
  }

  row.append(fields);
  return row;
}

/**
 * @param {HTMLElement} list
 */
function reindexConditionRows(list) {
  const rows = [...list.querySelectorAll(".dm-toolkit-end-condition")];
  rows.forEach((row, index) => {
    row.dataset.index = String(index);
    for (const el of row.querySelectorAll("[name]")) {
      const field = el.dataset.dmToolkitField;
      if (!field) continue;
      el.name = `flags.${MODULE_ID}.${END_CONDITIONS_FLAG}.${index}.${field}`;
    }

    let removeBtn = row.querySelector(".dm-toolkit-remove-condition");
    if (index === 0) {
      removeBtn?.remove();
      return;
    }
    if (removeBtn) return;

    removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.classList.add("dm-toolkit-remove-condition");
    removeBtn.dataset.tooltip = game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.RemoveCondition");
    removeBtn.innerHTML = `<i class="fas fa-trash"></i>`;
    removeBtn.addEventListener("click", event => {
      event.preventDefault();
      const parent = row.parentElement;
      const prev = row.previousElementSibling;
      if (prev?.classList.contains("dm-toolkit-end-or")) prev.remove();
      row.remove();
      if (parent) reindexConditionRows(parent);
    });
    row.querySelector(".form-fields")?.append(removeBtn);
  });
}

/**
 * @param {HTMLSelectElement} target
 * @param {HTMLSelectElement|null} source
 * @param {string} selected
 */
function populateUnitsSelect(target, source, selected) {
  if (source) {
    target.innerHTML = source.innerHTML;
  } else {
    target.innerHTML = `
      <option value=""></option>
      <option value="turns">Turns</option>
      <option value="rounds">Rounds</option>
      <option value="seconds">Seconds</option>
      <option value="minutes">Minutes</option>
      <option value="hours">Hours</option>
      <option value="days">Days</option>
    `;
  }
  insertCombatRollOptions(target);
  insertSavingThrowOptions(target);
  insertAbilityCheckOptions(target);
  insertSkillCheckOptions(target);
  if (selected) target.value = selected;
  else target.value = target.options[0]?.value ?? "";
}

/**
 * @param {HTMLSelectElement} target
 * @param {HTMLSelectElement|null} source
 * @param {string} selected
 */
function populateExpirySelect(target, source, selected) {
  if (source) {
    target.innerHTML = source.innerHTML;
  } else {
    const events = CONFIG.ActiveEffect?.expiryEvents ?? {};
    const core = CONST.ACTIVE_EFFECT_EXPIRY_EVENTS ?? [];
    target.innerHTML = `<option value=""></option>`;
    for (const id of core) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = events[id] ?? id;
      target.append(opt);
    }
    for (const [id, label] of Object.entries(events)) {
      if (target.querySelector(`option[value="${id}"]`)) continue;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      target.append(opt);
    }
  }
  if (selected) target.value = selected;
}

/**
 * @param {HTMLSelectElement} select
 */
function insertCombatRollOptions(select) {
  insertRollLimitOption(select, ATTACKS_UNIT, "DM-TOOLKIT-DND5E.AttackLimit.Unit", "DM-TOOLKIT-DND5E.AttackLimit.Hint");
  insertRollLimitOption(select, DAMAGE_UNIT, "DM-TOOLKIT-DND5E.DamageLimit.Unit", "DM-TOOLKIT-DND5E.DamageLimit.Hint");
  insertRollLimitOption(
    select,
    CONCENTRATION_UNIT,
    "DM-TOOLKIT-DND5E.ConcentrationLimit.Unit",
    "DM-TOOLKIT-DND5E.ConcentrationLimit.Hint"
  );
}

/**
 * @param {HTMLSelectElement} select
 */
function insertSavingThrowOptions(select) {
  if (select.querySelector(`option[value="${saveUnitFromAbility("str")}"]`)) return;

  let group = select.querySelector("optgroup[data-dm-toolkit-saves]");
  if (!group) {
    group = document.createElement("optgroup");
    group.label = game.i18n.localize("DM-TOOLKIT-DND5E.SaveLimit.Group");
    group.dataset.dmToolkitSaves = "true";

    const groups = [...select.querySelectorAll("optgroup")];
    const combatGroup = groups.find(g => g.querySelector(
      'option[value="turns"], option[value="rounds"], option[value="attacks"], option[value="damage"], option[value="concentration"]'
    ));
    if (combatGroup) combatGroup.after(group);
    else select.append(group);
  }

  const hint = game.i18n.localize("DM-TOOLKIT-DND5E.SaveLimit.Hint");
  for (const ability of ABILITY_KEYS) {
    const unit = saveUnitFromAbility(ability);
    if (group.querySelector(`option[value="${unit}"]`)) continue;
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = game.i18n.localize(`DM-TOOLKIT-DND5E.SaveLimit.Ability.${ability}`);
    option.dataset.tooltip = hint;
    group.append(option);
  }
}

/**
 * @param {HTMLSelectElement} select
 */
function insertAbilityCheckOptions(select) {
  if (select.querySelector(`option[value="${checkUnitFromAbility("str")}"]`)) return;

  let group = select.querySelector("optgroup[data-dm-toolkit-checks]");
  if (!group) {
    group = document.createElement("optgroup");
    group.label = game.i18n.localize("DM-TOOLKIT-DND5E.CheckLimit.Group");
    group.dataset.dmToolkitChecks = "true";

    const saveGroup = select.querySelector("optgroup[data-dm-toolkit-saves]");
    const groups = [...select.querySelectorAll("optgroup")];
    const combatGroup = groups.find(g => g.querySelector(
      'option[value="turns"], option[value="rounds"], option[value="attacks"], option[value="damage"], option[value="concentration"]'
    ));
    if (saveGroup) saveGroup.after(group);
    else if (combatGroup) combatGroup.after(group);
    else select.append(group);
  }

  const hint = game.i18n.localize("DM-TOOLKIT-DND5E.CheckLimit.Hint");
  for (const ability of ABILITY_KEYS) {
    const unit = checkUnitFromAbility(ability);
    if (group.querySelector(`option[value="${unit}"]`)) continue;
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = game.i18n.localize(`DM-TOOLKIT-DND5E.CheckLimit.Ability.${ability}`);
    option.dataset.tooltip = hint;
    group.append(option);
  }
}

/**
 * @param {HTMLSelectElement} select
 */
function insertSkillCheckOptions(select) {
  if (select.querySelector(`option[value="${skillUnitFromKey("acr")}"]`)) return;

  let group = select.querySelector("optgroup[data-dm-toolkit-skills]");
  if (!group) {
    group = document.createElement("optgroup");
    group.label = game.i18n.localize("DM-TOOLKIT-DND5E.SkillLimit.Group");
    group.dataset.dmToolkitSkills = "true";

    const checkGroup = select.querySelector("optgroup[data-dm-toolkit-checks]");
    const saveGroup = select.querySelector("optgroup[data-dm-toolkit-saves]");
    if (checkGroup) checkGroup.after(group);
    else if (saveGroup) saveGroup.after(group);
    else select.append(group);
  }

  const hint = game.i18n.localize("DM-TOOLKIT-DND5E.SkillLimit.Hint");
  for (const skill of SKILL_KEYS) {
    const unit = skillUnitFromKey(skill);
    if (group.querySelector(`option[value="${unit}"]`)) continue;
    const option = document.createElement("option");
    option.value = unit;
    option.textContent = game.i18n.localize(`DM-TOOLKIT-DND5E.SkillLimit.Skill.${skill}`);
    option.dataset.tooltip = hint;
    group.append(option);
  }
}

/**
 * @param {HTMLSelectElement} select
 * @param {string} unit
 * @param {string} labelKey
 * @param {string} hintKey
 */
function insertRollLimitOption(select, unit, labelKey, hintKey) {
  if (select.querySelector(`option[value="${unit}"]`)) return;

  const option = document.createElement("option");
  option.value = unit;
  option.textContent = game.i18n.localize(labelKey);
  option.dataset.tooltip = game.i18n.localize(hintKey);

  const groups = [...select.querySelectorAll("optgroup")];
  const combatGroup = groups.find(group => group.querySelector(
    'option[value="turns"], option[value="rounds"], option[value="attacks"]'
  ));
  if (combatGroup) {
    // Keep Attacks → Damage → Concentration Check order.
    if (unit === DAMAGE_UNIT) {
      const attacks = combatGroup.querySelector(`option[value="${ATTACKS_UNIT}"]`);
      if (attacks) {
        attacks.after(option);
        return;
      }
    }
    if (unit === CONCENTRATION_UNIT) {
      const damage = combatGroup.querySelector(`option[value="${DAMAGE_UNIT}"]`);
      if (damage) {
        damage.after(option);
        return;
      }
      const attacks = combatGroup.querySelector(`option[value="${ATTACKS_UNIT}"]`);
      if (attacks) {
        attacks.after(option);
        return;
      }
    }
    combatGroup.append(option);
    return;
  }
  const after = select.querySelector(
    'option[value="turns"], option[value="rounds"], option[value="attacks"]'
  );
  if (after) {
    if (unit === DAMAGE_UNIT) {
      const attacks = select.querySelector(`option[value="${ATTACKS_UNIT}"]`);
      if (attacks) {
        attacks.after(option);
        return;
      }
    }
    if (unit === CONCENTRATION_UNIT) {
      const damage = select.querySelector(`option[value="${DAMAGE_UNIT}"]`);
      if (damage) {
        damage.after(option);
        return;
      }
      const attacks = select.querySelector(`option[value="${ATTACKS_UNIT}"]`);
      if (attacks) {
        attacks.after(option);
        return;
      }
    }
    after.after(option);
  } else {
    select.append(option);
  }
}

/* -------------------------------------------- */
/*  Evaluation                                  */
/* -------------------------------------------- */

function wrapPrepareDuration() {
  const proto = CONFIG.ActiveEffect?.documentClass?.prototype;
  const original = proto?._prepareDuration;
  if (typeof original !== "function" || original.__dmToolkitExtendedExpiration) return;

  function wrapped(duration, context) {
    const prepared = original.call(this, duration, context);
    return applyEndConditionDurationLabel(this, prepared) ?? prepared;
  }

  wrapped.__dmToolkitExtendedExpiration = true;
  proto._prepareDuration = wrapped;
}

/**
 * @param {ActiveEffect} effect
 * @param {object} prepared
 * @returns {object}
 */
function applyEndConditionDurationLabel(effect, prepared) {
  if (!prepared || !hasEndConditions(effect)) return prepared;

  const conditions = getEndConditions(effect);
  const attackMaxes = getAttackBudgetMaxes(effect);
  if (attackMaxes.length && conditions.every(c => c.mode === MODE_AFTER && c.units === ATTACKS_UNIT)) {
    const max = Math.min(...attackMaxes);
    const used = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedAttackIds")).length;
    const remaining = Math.max(0, max - used);
    prepared.remaining = remaining;
    prepared.label = game.i18n.format("DM-TOOLKIT-DND5E.AttackLimit.DurationLabel", { remaining });
    return prepared;
  }

  const damageMaxes = getDamageBudgetMaxes(effect);
  if (damageMaxes.length && conditions.every(c => c.mode === MODE_AFTER && c.units === DAMAGE_UNIT)) {
    const max = Math.min(...damageMaxes);
    const used = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedDamageIds")).length;
    const remaining = Math.max(0, max - used);
    prepared.remaining = remaining;
    prepared.label = game.i18n.format("DM-TOOLKIT-DND5E.DamageLimit.DurationLabel", { remaining });
    return prepared;
  }

  const concentrationMaxes = getConcentrationBudgetMaxes(effect);
  if (concentrationMaxes.length
    && conditions.every(c => c.mode === MODE_AFTER && c.units === CONCENTRATION_UNIT)) {
    const max = Math.min(...concentrationMaxes);
    const used = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedConcentrationIds")).length;
    const remaining = Math.max(0, max - used);
    prepared.remaining = remaining;
    prepared.label = game.i18n.format("DM-TOOLKIT-DND5E.ConcentrationLimit.DurationLabel", { remaining });
    return prepared;
  }

  const saveUnit = conditions[0]?.units;
  const saveAbility = saveAbilityFromUnit(saveUnit);
  if (saveAbility
    && conditions.every(c => c.mode === MODE_AFTER && c.units === saveUnit)) {
    const maxes = getSaveBudgetMaxes(effect, saveAbility);
    if (maxes.length) {
      const max = Math.min(...maxes);
      const used = getAppliedSaveIds(effect, saveAbility).length;
      const remaining = Math.max(0, max - used);
      prepared.remaining = remaining;
      const abilityLabel = game.i18n.localize(`DM-TOOLKIT-DND5E.SaveLimit.Ability.${saveAbility}`);
      prepared.label = game.i18n.format("DM-TOOLKIT-DND5E.SaveLimit.DurationLabel", {
        remaining,
        ability: abilityLabel
      });
      return prepared;
    }
  }

  const checkUnit = conditions[0]?.units;
  const checkAbility = checkAbilityFromUnit(checkUnit);
  if (checkAbility
    && conditions.every(c => c.mode === MODE_AFTER && c.units === checkUnit)) {
    const maxes = getCheckBudgetMaxes(effect, checkAbility);
    if (maxes.length) {
      const max = Math.min(...maxes);
      const used = getAppliedCheckIds(effect, checkAbility).length;
      const remaining = Math.max(0, max - used);
      prepared.remaining = remaining;
      const abilityLabel = game.i18n.localize(`DM-TOOLKIT-DND5E.CheckLimit.Ability.${checkAbility}`);
      prepared.label = game.i18n.format("DM-TOOLKIT-DND5E.CheckLimit.DurationLabel", {
        remaining,
        ability: abilityLabel
      });
      return prepared;
    }
  }

  const skillUnit = conditions[0]?.units;
  const skillKey = skillKeyFromUnit(skillUnit);
  if (skillKey
    && conditions.every(c => c.mode === MODE_AFTER && c.units === skillUnit)) {
    const maxes = getSkillBudgetMaxes(effect, skillKey);
    if (maxes.length) {
      const max = Math.min(...maxes);
      const used = getAppliedSkillIds(effect, skillKey).length;
      const remaining = Math.max(0, max - used);
      prepared.remaining = remaining;
      const skillLabel = game.i18n.localize(`DM-TOOLKIT-DND5E.SkillLimit.Skill.${skillKey}`);
      prepared.label = game.i18n.format("DM-TOOLKIT-DND5E.SkillLimit.DurationLabel", {
        remaining,
        skill: skillLabel
      });
      return prepared;
    }
  }

  if (conditions.length > 1) {
    prepared.label = game.i18n.localize("DM-TOOLKIT-DND5E.EndEffect.MultiConditionLabel");
  }
  return prepared;
}

function wrapActiveEffectRegistryRefresh() {
  const registry = getActiveEffectRegistry();
  if (!registry?.refresh || registry.refresh.__dmToolkitExtendedExpiration) return;

  const original = registry.refresh.bind(registry);
  async function wrapped(event, context = {}) {
    try {
      await original(event, context);
    } catch (err) {
      console.warn(`${MODULE_ID} | ActiveEffect.registry.refresh failed`, err);
    }
    await evaluateEndConditionsForEvent(event, context);
  }
  wrapped.__dmToolkitExtendedExpiration = true;
  registry.refresh = wrapped;
}

/**
 * @returns {{refresh: Function}|null}
 */
function getActiveEffectRegistry() {
  return CONFIG.ActiveEffect?.documentClass?.registry
    ?? foundry.documents?.ActiveEffect?.registry
    ?? globalThis.CONFIG?.ActiveEffect?.documentClass?.registry
    ?? null;
}

/**
 * @param {string} event
 * @param {{actors?: Set<Actor>, combat?: Combat, prior?: object, current?: object}} context
 */
async function evaluateEndConditionsForEvent(event, context = {}) {
  const actors = collectActorsForEvaluation(context);

  for (const actor of actors) {
    const effects = collectActorEffects(actor);
    for (const effect of effects) {
      if (effect.disabled || !hasEndConditions(effect)) continue;
      await ensureEffectStartMarkers(effect);
      if (!isAnyEndConditionMet(effect, {
        event,
        combat: context.combat,
        prior: context.prior,
        current: context.current,
        round: context.round ?? context.combat?.round,
        turn: context.turn ?? context.combat?.turn
      })) continue;
      if (!effect.canUserModify(game.user, "update")) continue;
      try {
        await effect.update({ disabled: true });
      } catch (err) {
        console.warn(`${MODULE_ID} | Failed to disable effect "${effect.name}"`, err);
      }
    }
  }
}

/**
 * After conditions need start markers; Foundry V13+ stores these on `effect.start`.
 * @param {ActiveEffect} effect
 */
async function ensureEffectStartMarkers(effect) {
  const needsTime = getEndConditions(effect).some(c => {
    return c.mode === MODE_AFTER && c.units && !isRollLimitUnit(c.units);
  });
  if (!needsTime) return;

  const patch = {};
  if (effect.start?.time == null) patch["start.time"] = game.time?.worldTime ?? 0;
  if (game.combat?.started) {
    if (effect.start?.round == null) patch["start.round"] = game.combat.round ?? 0;
    if (effect.start?.turn == null) patch["start.turn"] = game.combat.turn ?? 0;
    if (effect.start?.combat == null) patch["start.combat"] = game.combat.id;
    if (effect.start?.combatant == null) {
      patch["start.combatant"] = game.combat.combatant?.id ?? null;
    }
  }
  if (!Object.keys(patch).length) return;
  try {
    await effect.update(patch);
  } catch (_err) { /* ignore */ }
}

/**
 * @param {Actor} actor
 * @returns {ActiveEffect[]}
 */
function collectActorEffects(actor) {
  const byId = new Map();
  for (const effect of actor.appliedEffects ?? []) byId.set(effect.id ?? effect.uuid, effect);
  for (const effect of actor.effects ?? []) byId.set(effect.id ?? effect.uuid, effect);
  return [...byId.values()];
}

/**
 * @param {{actors?: Set<Actor>|Actor[], combat?: Combat}} context
 * @returns {Actor[]}
 */
function collectActorsForEvaluation(context = {}) {
  if (context.actors) return [...context.actors];

  const actors = new Set(game.actors?.contents ?? []);
  for (const token of canvas.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }
  if (context.combat?.combatants) {
    for (const c of context.combat.combatants) {
      if (c.actor) actors.add(c.actor);
    }
  }
  return [...actors];
}

/**
 * @param {ActiveEffect} effect
 * @param {{event?: string, combat?: Combat, pendingAttackId?: string}} context
 * @returns {boolean}
 */
export function isAnyEndConditionMet(effect, context = {}) {
  const conditions = getEndConditions(effect);
  if (!conditions.length) return false;
  return conditions.some(condition => isEndConditionMet(effect, condition, context));
}

/**
 * @param {ActiveEffect} effect
 * @param {object} condition
 * @param {{event?: string, combat?: Combat, pendingAttackId?: string}} context
 * @returns {boolean}
 */
export function isEndConditionMet(effect, condition, context = {}) {
  if (!condition) return false;

  if (condition.mode === MODE_ON_EVENT) {
    if (!condition.expiry) return false;

    // dnd5e Specific expiries (source/target next turn) are evaluated against turnStart/turnEnd.
    if (PSEUDO_EXPIRIES.has(condition.expiry)) {
      return isPseudoExpiryConditionMet(effect, condition.expiry, context);
    }

    if (!context.event || context.event !== condition.expiry) return false;
    return isOnEventConditionReached(effect, condition.expiry, context);
  }

  if (condition.units === ATTACKS_UNIT || condition.units === DAMAGE_UNIT
    || condition.units === CONCENTRATION_UNIT
    || isSaveUnit(condition.units) || isCheckUnit(condition.units) || isSkillUnit(condition.units)) {
    // Enforced by roll-limit prune/record, not combat/time evaluation.
    // Only report met when a pending roll id would exceed the budget.
    const saveAbility = saveAbilityFromUnit(condition.units);
    if (saveAbility) {
      const pending = context.pendingSaveId;
      const pendingAbility = context.pendingSaveAbility;
      if (!pending || (pendingAbility && pendingAbility !== saveAbility)) return false;
      const ids = getAppliedSaveIds(effect, saveAbility);
      if (ids.includes(pending)) return false;
      const max = Number(condition.value) || 0;
      return max > 0 && ids.length >= max;
    }

    const checkAbility = checkAbilityFromUnit(condition.units);
    if (checkAbility) {
      const pending = context.pendingCheckId;
      const pendingAbility = context.pendingCheckAbility;
      if (!pending || (pendingAbility && pendingAbility !== checkAbility)) return false;
      const ids = getAppliedCheckIds(effect, checkAbility);
      if (ids.includes(pending)) return false;
      const max = Number(condition.value) || 0;
      return max > 0 && ids.length >= max;
    }

    const skillKey = skillKeyFromUnit(condition.units);
    if (skillKey) {
      const pending = context.pendingSkillId;
      const pendingSkill = context.pendingSkillKey;
      if (!pending || (pendingSkill && pendingSkill !== skillKey)) return false;
      const ids = getAppliedSkillIds(effect, skillKey);
      if (ids.includes(pending)) return false;
      const max = Number(condition.value) || 0;
      return max > 0 && ids.length >= max;
    }

    if (condition.units === CONCENTRATION_UNIT) {
      const pending = context.pendingConcentrationId;
      if (!pending) return false;
      const ids = coerceRollIdArray(effect.getFlag(MODULE_ID, "appliedConcentrationIds"));
      if (ids.includes(pending)) return false;
      const max = Number(condition.value) || 0;
      return max > 0 && ids.length >= max;
    }

    const pending = condition.units === DAMAGE_UNIT ? context.pendingDamageId : context.pendingAttackId;
    if (!pending) return false;
    const flag = condition.units === DAMAGE_UNIT ? "appliedDamageIds" : "appliedAttackIds";
    const ids = coerceRollIdArray(effect.getFlag(MODULE_ID, flag));
    if (ids.includes(pending)) return false;
    const max = Number(condition.value) || 0;
    return max > 0 && ids.length >= max;
  }

  return isTimeAfterConditionMet(effect, condition, context.combat);
}

/**
 * Mirror dnd5e ActiveEffect#isExpiryEvent for source/target next-turn pseudo expiries.
 * @param {ActiveEffect} effect
 * @param {string} expiry
 * @param {{event?: string, combat?: Combat, prior?: object, round?: number, turn?: number}} context
 * @returns {boolean}
 */
function isPseudoExpiryConditionMet(effect, expiry, context = {}) {
  const event = context.event;
  if (!event) return false;

  // Out of combat, any time advancement expires the effect.
  if (event === "updateWorldTime" && !getEffectBearerActor(effect)?.inCombat) return true;

  const isStart = expiry.endsWith("Start");
  if (event !== (isStart ? "turnStart" : "turnEnd")) return false;

  const combat = context.combat ?? game.combat;
  if (!combat?.started) return false;

  const startCombat = resolveEffectStartCombat(effect);
  if (startCombat && combat !== startCombat) return false;

  const origin = expiry.startsWith("target")
    ? getEffectBearerActor(effect)
    : getEffectSourceActor(effect);

  const combatant = findCombatantForActor(combat, origin);
  const startRound = effect.start?.round;
  const startTurn = effect.start?.turn;
  if (startRound == null) return false;
  const round = context.round ?? combat.round ?? 0;
  const turn = context.turn ?? combat.turn ?? 0;

  // If they have left combat, expire once we are past the creation round.
  if (!combatant) return startRound < round;

  const priorCombatantId = context.prior?.combatantId
    ?? combat.previous?.combatantId
    ?? combat.previous?.combatant?.id;
  const originTurn = isStart
    ? (combat.combatant === combatant || combat.combatant?.id === combatant.id)
    : (priorCombatantId === combatant.id);
  if (!originTurn) return false;

  // Skip the turn the effect was applied on.
  return (startRound !== round) || (startTurn !== turn);
}

/**
 * @param {ActiveEffect} effect
 * @returns {Actor|null}
 */
function getEffectBearerActor(effect) {
  if (!effect) return null;
  if (effect.actor) return effect.actor;
  if (effect.parent?.documentName === "Actor") return effect.parent;
  if (effect.parent?.documentName === "Item") return effect.parent.actor ?? null;
  return null;
}

/**
 * Prefer dnd5e getSourceActor when available.
 * @param {ActiveEffect} effect
 * @returns {Actor|null}
 */
function getEffectSourceActor(effect) {
  if (!effect) return null;
  if (typeof effect.getSourceActor === "function") {
    try {
      const source = effect.getSourceActor();
      if (source) return source;
    } catch (_err) { /* ignore */ }
  }

  const originUuid = effect.system?.origin?.actor
    ?? effect.system?.origin?.item
    ?? effect.origin;
  if (originUuid && typeof fromUuidSync === "function") {
    try {
      const origin = fromUuidSync(originUuid, { strict: false });
      if (origin?.documentName === "Actor") return origin;
      if (origin?.actor) return origin.actor;
    } catch (_err) { /* ignore */ }
  }

  return getEffectBearerActor(effect);
}

/**
 * @param {ActiveEffect} effect
 * @returns {Combat|null}
 */
function resolveEffectStartCombat(effect) {
  const startCombat = effect.start?.combat;
  if (!startCombat) return null;
  if (typeof startCombat === "string") return game.combats?.get(startCombat) ?? null;
  return startCombat;
}

/**
 * @param {Combat} combat
 * @param {Actor|null} actor
 * @returns {Combatant|null}
 */
function findCombatantForActor(combat, actor) {
  if (!combat || !actor) return null;
  if (typeof combat.getCombatantsByActor === "function") {
    const list = combat.getCombatantsByActor(actor);
    return list?.[0] ?? null;
  }
  return combat.combatants.find(c => c.actor?.id === actor.id || c.actorId === actor.id) ?? null;
}

/**
 * For OR end-conditions, an On Event row means "disable when this event fires".
 * @param {ActiveEffect} _effect
 * @param {string} expiry
 * @param {{combat?: Combat}} context
 * @returns {boolean}
 */
function isOnEventConditionReached(_effect, expiry, context = {}) {
  if (!expiry) return false;

  // Rest events (dnd5e): any matching shortRest / longRest is enough.
  if (expiry === "shortRest" || expiry === "longRest") return true;

  if (expiry === "updateWorldTime") return true;
  if (expiry === "combatStart" || expiry === "combatEnd") return true;

  const combat = context.combat ?? game.combat;
  if (["turnStart", "turnEnd", "roundStart", "roundEnd"].includes(expiry)) {
    return Boolean(combat?.started);
  }

  // Custom / system-specific expiry ids: event name match is enough.
  return true;
}

/**
 * @param {ActiveEffect} effect
 * @param {object} condition
 * @param {Combat} [combat]
 * @returns {boolean}
 */
function isTimeAfterConditionMet(effect, condition, combat) {
  const value = Number(condition.value);
  if (!Number.isFinite(value) || value <= 0) return false;
  const units = normalizeTimeUnit(condition.units);
  if (!units) return false;

  if (units === "rounds" || units === "turns") {
    const activeCombat = combat
      ?? resolveEffectStartCombat(effect)
      ?? game.combat;
    if (!activeCombat?.started) return false;

    // Foundry V13+ stores combat markers on effect.start (not duration).
    const startRound = effect.start?.round;
    const startTurn = effect.start?.turn;
    if (startRound == null) return false;

    const round = activeCombat.round ?? 0;
    const turn = activeCombat.turn ?? 0;
    const roundDelta = round - (Number(startRound) || 0);

    if (units === "rounds") return roundDelta >= value;

    const turnsPerRound = Math.max(
      1,
      activeCombat.turns?.length || activeCombat.combatants?.size || 1
    );
    const turnDelta = (roundDelta * turnsPerRound) + (turn - (Number(startTurn) || 0));
    return turnDelta >= value;
  }

  const secondsPer = {
    seconds: 1,
    minutes: 60,
    hours: 3600,
    days: 86400,
    months: 2628000,
    years: 31536000
  };
  const factor = secondsPer[units];
  if (!factor) return false;
  const start = effect.start?.time;
  if (start == null) return false;
  return (game.time.worldTime - start) >= (value * factor);
}
