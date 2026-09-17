/**
 * Enhanced status effects: GM-defined custom conditions with linked Active Effects,
 * toggled from the actor sheet Effects tab like core Conditions.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const ENABLED_SETTING = "enhancedStatusEffects";
const DATA_SETTING = "enhancedStatusEffectsData";
const MENU_KEY = "enhancedStatusEffectsMenu";
const EFFECTS_ITEM_FLAG = "customConditionsItem";
const CONDITION_FLAG = "customConditionId";
const AURA_FLAG = "aura";
const DEFAULT_CONDITION_IMG = "icons/svg/aura.svg";

/** @type {Set<string>} */
const pendingToggles = new Set();

export function registerEnhancedStatusEffects() {
  Hooks.on("renderCharacterActorSheet", onRenderActorSheet);
  Hooks.on("renderNPCActorSheet", onRenderActorSheet);
  Hooks.on("renderVehicleActorSheet", onRenderActorSheet);
  Hooks.on("renderSettingsConfig", onRenderSettingsConfig);
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
  Hooks.on("renderTokenHUD5e", onRenderTokenHUD);
  // dnd5e only creates Separate Status Conditions on effect create while active —
  // not when enabling a sheet effect later. Bridge that gap (independent of the setting).
  Hooks.on("createActiveEffect", onCreateActiveEffectRiders);
  Hooks.on("updateActiveEffect", onUpdateActiveEffectRiders);
}

export function registerEnhancedStatusEffectsSettings() {
  // Menu buttons are listed first in Configure Settings; register this toggle
  // before other module settings so it appears immediately under the menu.
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "DM-TOOLKIT-DND5E.Settings.EnhancedStatusEffectsMenu.Name",
    label: "DM-TOOLKIT-DND5E.Settings.EnhancedStatusEffectsMenu.Label",
    hint: "DM-TOOLKIT-DND5E.Settings.EnhancedStatusEffectsMenu.Hint",
    icon: "fas fa-hand-sparkles",
    type: CustomConditionsApp,
    restricted: true
  });

  game.settings.register(MODULE_ID, ENABLED_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.EnhancedStatusEffects.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.EnhancedStatusEffects.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      foundry.applications.instances.get("dm-toolkit-custom-conditions")?.close?.();
      foundry.applications.instances.get("dm-toolkit-token-conditions")?.close?.();
      for (const app of foundry.applications.instances.values()) {
        if (app?.document?.documentName === "Actor") app.render({ force: true });
      }
      ui.settings?.render?.(true);
    }
  });

  game.settings.register(MODULE_ID, DATA_SETTING, {
    name: "DM-TOOLKIT-DND5E.EnhancedStatusEffects.DataSetting",
    scope: "world",
    config: false,
    type: Object,
    default: { conditions: [] },
    onChange: () => {
      for (const app of foundry.applications.instances.values()) {
        if (app?.document?.documentName === "Actor") app.render({ force: true });
      }
      foundry.applications.instances.get("dm-toolkit-custom-conditions")?.render?.({ force: true });
      foundry.applications.instances.get("dm-toolkit-token-conditions")?.render?.({ force: true });
    }
  });
}

/**
 * @returns {boolean}
 */
function isFeatureEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, ENABLED_SETTING));
  } catch (_err) {
    return false;
  }
}

/**
 * Hide the configure menu when the feature is disabled.
 * @param {Application} _app
 * @param {HTMLElement} html
 */
function onRenderSettingsConfig(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const enabled = isFeatureEnabled();
  // Core SettingsConfig: menu buttons / form groups for registerMenu entries.
  const selectors = [
    `.form-group[data-setting-id="${MODULE_ID}.${MENU_KEY}"]`,
    `button[data-key="${MODULE_ID}.${MENU_KEY}"]`,
    `[name="${MODULE_ID}.${MENU_KEY}"]`
  ];
  for (const selector of selectors) {
    for (const el of root.querySelectorAll(selector)) {
      const row = el.closest(".form-group") ?? el;
      row.hidden = !enabled;
    }
  }
}

/**
 * @returns {{id: string, name: string, img: string, effectUuid: string|null, effectData?: object|null}[]}
 */
function getConditions() {
  try {
    const raw = game.settings.get(MODULE_ID, DATA_SETTING);
    const list = Array.isArray(raw?.conditions) ? raw.conditions : [];
    return foundry.utils.duplicate(list).map(c => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      img: normalizeConditionImg(c.img),
      effectUuid: c.effectUuid || null,
      effectData: c.effectData ?? null
    })).filter(c => c.id);
  } catch (_err) {
    return [];
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeConditionImg(value) {
  const img = typeof value === "string" ? value.trim() : "";
  return img || DEFAULT_CONDITION_IMG;
}

/**
 * @param {{id: string, name: string, img?: string, effectUuid: string|null, effectData?: object|null}[]} conditions
 */
async function setConditions(conditions) {
  await game.settings.set(MODULE_ID, DATA_SETTING, {
    conditions: conditions.map(c => ({
      ...c,
      img: normalizeConditionImg(c.img)
    }))
  });
}

/**
 * World Item that stores Active Effect templates for custom conditions.
 * @returns {Promise<Item|null>}
 */
async function getOrCreateEffectsItem() {
  const existing = game.items.find(i => i.getFlag(MODULE_ID, EFFECTS_ITEM_FLAG));
  if (existing) return existing;
  if (!game.user?.isGM) return null;

  const [created] = await Item.createDocuments([{
    name: game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.EffectsItemName"),
    type: "feat",
    img: "icons/magic/symbols/rune-sigil-red-pink.webp",
    system: {
      description: {
        value: game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.EffectsItemHint")
      }
    },
    flags: {
      [MODULE_ID]: { [EFFECTS_ITEM_FLAG]: true }
    }
  }]);
  return created ?? null;
}

/**
 * @param {string} conditionId
 * @param {Actor} actor
 * @returns {ActiveEffect|undefined}
 */
function findAppliedEffect(actor, conditionId) {
  return actor.effects.find(e => e.getFlag(MODULE_ID, CONDITION_FLAG) === conditionId);
}

/**
 * Legacy ActiveEffect change modes → Foundry v14 change types.
 */
const LEGACY_MODE_TO_TYPE = {
  0: "add",
  1: "multiply",
  2: "override",
  3: "downgrade",
  4: "upgrade",
  5: "custom"
};

/**
 * Pull change rows from a template effect / cached snapshot into clean create-safe objects.
 * Full toObject() copies can carry invalid FiltersField / legacy fields that Foundry strips,
 * leaving system.changes empty on the actor.
 * @param {ActiveEffect|object|null} source
 * @returns {object[]}
 */
function extractChanges(source) {
  if (!source) return [];
  const raw = source.system?._source?.changes
    ?? source._source?.system?.changes
    ?? source.system?.changes
    ?? source.changes
    ?? [];
  if (!Array.isArray(raw)) return [];

  return raw.map(entry => {
    const c = typeof entry?.toObject === "function" ? entry.toObject() : foundry.utils.deepClone(entry);
    let type = c.type;
    if ((type == null || type === "") && c.mode != null) type = LEGACY_MODE_TO_TYPE[c.mode] ?? "add";
    type = String(type || "add");
    return {
      _id: foundry.utils.randomID(),
      key: String(c.key ?? ""),
      type,
      value: c.value ?? "",
      phase: c.phase || "initial",
      priority: Number.isFinite(c.priority) ? c.priority : undefined
    };
  }).filter(c => c.key);
}

/**
 * @param {Actor} actor
 * @param {string} conditionId
 * @returns {Promise<void>}
 */
async function enableCondition(actor, conditionId) {
  const condition = getConditions().find(c => c.id === conditionId);
  const existing = findAppliedEffect(actor, conditionId);
  if (existing) {
    if (!existing.active) {
      const update = {
        disabled: false,
        duration: { units: "seconds", expired: false }
      };
      // Older applied copies may lack aura flags; refresh from the template when re-enabling.
      if (condition) {
        const template = await buildEffectDataForCondition(condition, actor);
        const aura = template?.flags?.[MODULE_ID]?.[AURA_FLAG];
        if (aura) update[`flags.${MODULE_ID}.${AURA_FLAG}`] = foundry.utils.deepClone(aura);
      }
      await existing.update(update);
    }
    return;
  }
  if (!condition) return;

  try {
    const data = await buildEffectDataForCondition(condition, actor);
    if (!data) {
      ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNoEffect"));
      return;
    }
    const hasChanges = data.system.changes.length > 0;
    const hasStatuses = (data.statuses?.length ?? 0) > 0;
    const hasRiders = extractRiderStatuses(data).length > 0;
    const hasAura = data.flags?.[MODULE_ID]?.[AURA_FLAG]?.enabled === true;
    if (!hasChanges && !hasStatuses && !hasRiders && !hasAura) {
      ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNoChanges"));
      return;
    }

    const ActiveEffectCls = CONFIG.ActiveEffect.documentClass;
    const created = await ActiveEffectCls.create(data, { parent: actor, keepOrigin: false });
    if (!created) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrApplyFailed"));
      return;
    }
    // System hooks normally create Separate Status Conditions on create; fill any that were missed.
    await ensureRiderConditions(created);
    console.log(`${MODULE_ID} | Applied custom condition`, {
      conditionId,
      effectId: created.id,
      active: created.active,
      changeCount: created.system?.changes?.length ?? 0,
      riders: extractRiderStatuses(created),
      changes: created.system?.changes?.map(c => ({ key: c.key, type: c.type, value: c.value, phase: c.phase }))
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to apply custom condition`, err);
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrApplyFailed"));
  }
}

/**
 * Build a minimal ActiveEffect create payload from the linked template.
 * Custom conditions are toggled manually, so applied copies are permanent (no duration/expiry).
 * @param {{id: string, name: string, img?: string, effectUuid: string|null, effectData?: object|null}} condition
 * @param {Actor} [actor]
 * @returns {Promise<object|null>}
 */
async function buildEffectDataForCondition(condition, actor = null) {
  const ActiveEffectCls = CONFIG.ActiveEffect.documentClass;
  let source = null;
  if (condition.effectUuid) {
    try {
      source = await fromUuid(condition.effectUuid);
    } catch (_err) {
      source = null;
    }
  }
  if (!(source instanceof ActiveEffectCls) && condition.effectData) {
    source = condition.effectData;
  }
  if (!source) return null;

  let changes = extractChanges(source);
  if (typeof ActiveEffectCls.forApplication === "function" && changes.length) {
    const originDoc = source?.parent ?? null;
    changes = await ActiveEffectCls.forApplication(changes, originDoc, actor);
  }

  const name = condition.name
    || source.name
    || game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.NewEffect");
  const img = normalizeConditionImg(condition.img || source.img);
  const statuses = source.statuses instanceof Set
    ? Array.from(source.statuses)
    : Array.from(source.statuses ?? source._source?.statuses ?? []);
  const description = source.description
    ?? source._source?.description
    ?? "";
  const riderStatuses = extractRiderStatuses(source);

  const moduleFlags = {
    [CONDITION_FLAG]: condition.id
  };
  const aura = extractAuraFlag(source);
  if (aura) moduleFlags[AURA_FLAG] = aura;

  const flags = {
    [MODULE_ID]: moduleFlags
  };
  // Older dnd5e stores Separate Status Conditions here; migrateData may move them to system.rider.
  if (riderStatuses.length) {
    flags.dnd5e = { riders: { statuses: riderStatuses } };
  }

  // Minimal payload — avoid cloning template duration/expiry/filters that break application.
  // Aura + rider statuses are copied so applied effects match the linked template.
  return {
    type: "base",
    name,
    img,
    description,
    disabled: false,
    transfer: false,
    statuses,
    duration: { units: "seconds" },
    start: ActiveEffectCls.getEffectStart?.() ?? { time: game.time?.worldTime ?? 0 },
    system: {
      changes,
      magical: false,
      ...(riderStatuses.length ? { rider: { statuses: riderStatuses } } : {})
    },
    flags,
    _stats: source.uuid ? {
      duplicateSource: source.uuid,
      compendiumSource: null
    } : undefined
  };
}

/**
 * Separate Status Conditions (dnd5e riders) from a template / applied effect / cache.
 * Supports both legacy flags.dnd5e.riders.statuses and system.rider.statuses (dnd5e 6+).
 * @param {ActiveEffect|object|null} source
 * @returns {string[]}
 */
function extractRiderStatuses(source) {
  if (!source) return [];
  let raw = null;
  if (typeof source.getFlag === "function") {
    raw = source.getFlag("dnd5e", "riders.statuses");
  }
  if (raw == null) {
    raw = foundry.utils.getProperty(source, "system.rider.statuses")
      ?? foundry.utils.getProperty(source, "_source.system.rider.statuses")
      ?? foundry.utils.getProperty(source, "flags.dnd5e.riders.statuses")
      ?? foundry.utils.getProperty(source, "_source.flags.dnd5e.riders.statuses");
  }
  if (raw instanceof Set) return Array.from(raw).map(String).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return [];
}

/**
 * Create dnd5e Separate Status Conditions for an applied effect if any are still missing.
 * Prefer the system APIs (which skip existing status effects).
 * @param {ActiveEffect} effect
 * @returns {Promise<void>}
 */
async function ensureRiderConditions(effect) {
  if (!effect?.active || !(effect.parent instanceof Actor)) return;
  const riders = extractRiderStatuses(effect);
  if (!riders.length) return;

  const missing = riders.filter(id => !effect.parent.effects.get(dnd5eConditionEffectId(id)));
  if (!missing.length) return;

  // Legacy / deprecated wrapper — skips statuses that already exist on the actor.
  if (typeof effect.createRiderConditions === "function") {
    try {
      await effect.createRiderConditions();
      return;
    } catch (err) {
      console.warn(`${MODULE_ID} | createRiderConditions failed; falling back`, err);
    }
  }

  // dnd5e 6+: batch API when the deprecated wrapper is gone.
  if (typeof effect.system?.collectRiders === "function") {
    try {
      const batch = await effect.system.collectRiders();
      if (batch?.length && typeof foundry.documents.modifyBatch === "function") {
        await foundry.documents.modifyBatch(batch);
        return;
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | collectRiders failed; falling back`, err);
    }
  }

  const ActiveEffectCls = CONFIG.ActiveEffect.documentClass;
  if (typeof ActiveEffectCls.fromStatusEffect !== "function") return;
  const toCreate = [];
  for (const statusId of missing) {
    try {
      const statusEffect = await ActiveEffectCls.fromStatusEffect(statusId);
      if (statusEffect) toCreate.push(statusEffect.toObject());
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to build rider status`, statusId, err);
    }
  }
  if (toCreate.length) {
    await ActiveEffectCls.createDocuments(toCreate, { keepId: true, parent: effect.parent });
  }
}

/**
 * @param {ActiveEffect} effect
 * @param {object} _data
 * @param {object} _options
 * @param {string} userId
 */
function onCreateActiveEffectRiders(effect, _data, _options, userId) {
  if (game.userId !== userId) return;
  void ensureRiderConditions(effect);
}

/**
 * Apply Separate Status Conditions when an effect is enabled, or when riders are edited
 * onto an already-active effect. (dnd5e only does this on create-while-active.)
 * @param {ActiveEffect} effect
 * @param {object} change
 * @param {object} _options
 * @param {string} userId
 */
function onUpdateActiveEffectRiders(effect, change, _options, userId) {
  if (game.userId !== userId) return;
  if (!(effect.parent instanceof Actor)) return;
  if (!effect.active) return;

  const becomingEnabled = "disabled" in change && change.disabled === false;
  const ridersChanged = foundry.utils.hasProperty(change, "flags.dnd5e.riders")
    || foundry.utils.hasProperty(change, "system.rider");
  if (!becomingEnabled && !ridersChanged) return;

  void ensureRiderConditions(effect);
}

/**
 * Copy aura settings from a linked Active Effect template / cached snapshot.
 * @param {ActiveEffect|object} source
 * @returns {object|null}
 */
function extractAuraFlag(source) {
  if (!source) return null;
  let raw = null;
  if (typeof source.getFlag === "function") {
    raw = source.getFlag(MODULE_ID, AURA_FLAG);
  }
  if (raw == null) {
    raw = foundry.utils.getProperty(source, `flags.${MODULE_ID}.${AURA_FLAG}`)
      ?? foundry.utils.getProperty(source, `_source.flags.${MODULE_ID}.${AURA_FLAG}`);
  }
  if (!raw || typeof raw !== "object") return null;

  const alpha = Number(raw.alpha);
  return {
    enabled: raw.enabled === true || raw.enabled === "true" || raw.enabled === 1 || raw.enabled === "1"
      || (Array.isArray(raw.enabled) && (raw.enabled.includes(true) || raw.enabled.includes("true"))),
    radius: Number.isFinite(Number(raw.radius)) ? Number(raw.radius) : 10,
    color: typeof raw.color === "string" && raw.color ? raw.color : "#00ff00",
    alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0.25
  };
}

/**
 * Cache a serializable snapshot of the linked effect onto the condition entry.
 * @param {string} conditionId
 * @param {ActiveEffect} effect
 */
async function cacheConditionEffectData(conditionId, effect) {
  const data = effect.toObject();
  delete data._id;
  const conditions = getConditions().map(c => {
    if (c.id !== conditionId) return c;
    return {
      ...c,
      effectUuid: effect.uuid,
      effectData: data
    };
  });
  await setConditions(conditions);
}

/**
 * @param {Actor} actor
 * @param {string} conditionId
 * @returns {Promise<void>}
 */
async function disableCondition(actor, conditionId) {
  const existing = findAppliedEffect(actor, conditionId);
  if (existing) await existing.delete();
}

/**
 * @param {Actor} actor
 * @param {string} conditionId
 * @returns {Promise<void>}
 */
async function toggleCondition(actor, conditionId) {
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNoPermission"));
    return;
  }
  const key = `${actor.uuid}:${conditionId}`;
  if (pendingToggles.has(key)) return;
  pendingToggles.add(key);
  try {
    if (findAppliedEffect(actor, conditionId)) await disableCondition(actor, conditionId);
    else await enableCondition(actor, conditionId);
  } finally {
    setTimeout(() => pendingToggles.delete(key), 750);
  }
}

/**
 * @param {Application} app
 * @param {HTMLElement} element
 */
function onRenderActorSheet(app, element) {
  if (!isFeatureEnabled()) return;
  const actor = app?.actor ?? app?.document;
  if (!actor || actor.documentName !== "Actor") return;

  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;

  // Avoid duplicate injection on partial re-renders.
  root.querySelector(".dm-toolkit-core-conditions")?.remove();
  root.querySelector(".dm-toolkit-custom-conditions")?.remove();

  const host = root.querySelector("dnd5e-effects") ?? root.querySelector(".effects-element");
  if (!host) return;

  const refresh = () => app.render({ force: true });
  const coreSection = buildCoreConditionsSection(actor, { onChanged: refresh });
  const nativeConditions = host.querySelector(".conditions-list")?.closest("section.items-list");
  if (nativeConditions) nativeConditions.replaceWith(coreSection);
  else host.prepend(coreSection);

  coreSection.after(buildCustomConditionsSection(actor, { onChanged: refresh }));
}

/**
 * Replace Token HUD status-icon palette with Conditions + Custom conditions popup.
 * @param {Application} app
 * @param {HTMLElement} element
 */
function onRenderTokenHUD(app, element) {
  if (!isFeatureEnabled()) return;
  const root = element instanceof HTMLElement ? element : element?.[0] ?? app?.element;
  if (!root) return;

  const button = root.querySelector('[data-action="togglePalette"][data-palette="effects"]');
  if (!button || button.dataset.dmToolkitConditionsBound) return;
  button.dataset.dmToolkitConditionsBound = "1";

  // Remove core icon grid; our popup replaces it.
  root.querySelector('.palette[data-palette="effects"]')?.remove();
  button.removeAttribute("data-action");
  button.removeAttribute("data-palette");
  button.setAttribute(
    "data-tooltip",
    game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.TokenHudTooltip")
  );
  button.setAttribute(
    "aria-label",
    game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.TokenHudTooltip")
  );

  button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    const actor = app.actor ?? app.document?.actor;
    if (!actor) {
      ui.notifications.warn(game.i18n.localize("HUD.WarningEffectNoActor"));
      return;
    }
    await TokenConditionsPopup.open(actor, { hud: app });
  });
}

/**
 * Stable Active Effect id used by dnd5e for a condition status.
 * @param {string} conditionId
 * @returns {string}
 */
function dnd5eConditionEffectId(conditionId) {
  const id = `dnd5e${conditionId}`;
  return id.length >= 16 ? id.substring(0, 16) : id.padEnd(16, "0");
}

/**
 * @param {string} conditionId
 * @returns {boolean}
 */
function hasConditionLevels(conditionId) {
  return Number.isFinite(CONFIG.DND5E?.conditionTypes?.[conditionId]?.levels);
}

/**
 * Resolve a display name for a condition / status config entry.
 * @param {object} config
 * @param {string} id
 * @returns {string}
 */
function localizeConditionName(config, id) {
  const raw = config?.name ?? config?.label ?? id;
  if (typeof raw !== "string" || !raw) return id;
  return game.i18n.has(raw) ? game.i18n.localize(raw) : raw;
}

/**
 * All in-game conditions / HUD status effects (including pseudo conditions like Silenced).
 * @param {Actor} actor
 * @returns {{id: string, name: string, img: string, active: boolean, level: number|null, reference: string|null, order: number}[]}
 */
function getCoreConditionEntries(actor) {
  /** @type {Map<string, object>} */
  const byId = new Map();

  // Full token HUD set (conditions + extras like dead, concentrating, cover, …).
  for (const se of CONFIG.statusEffects ?? []) {
    if (!se?.id || se.hud === false) continue;
    byId.set(se.id, se);
  }
  // Ensure every conditionType is present, including pseudo entries (e.g. Silenced).
  for (const [id, config] of Object.entries(CONFIG.DND5E?.conditionTypes ?? {})) {
    if (config?.hud === false) continue;
    byId.set(id, foundry.utils.mergeObject(byId.get(id) ?? {}, config, { inplace: false }));
  }

  return Array.from(byId.entries()).map(([id, config]) => {
    const existing = actor.effects.get(dnd5eConditionEffectId(id));
    const active = Boolean(existing) && !existing.disabled;
    return {
      id,
      name: localizeConditionName(config, id),
      img: existing?.img || config.img || config.icon || "icons/svg/aura.svg",
      active,
      level: hasConditionLevels(id) ? (actor.system?.conditions?.[id] ?? 0) : null,
      reference: config.reference || null,
      order: Number.isFinite(config.order) ? config.order : Infinity
    };
  }).sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, game.i18n.lang));
}

/**
 * @param {Actor} actor
 * @param {string} conditionId
 * @param {PointerEvent} [event]
 * @returns {Promise<void>}
 */
async function toggleCoreCondition(actor, conditionId, event) {
  if (!actor?.isOwner) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNoPermission"));
    return;
  }
  if (hasConditionLevels(conditionId)) {
    await actor.toggleStatusEffect(conditionId, {
      levels: event?.type === "contextmenu" ? -1 : 1
    });
    return;
  }
  await actor.toggleStatusEffect(conditionId);
}

/**
 * Build a conditions-list `<ul>` populated with condition rows.
 * @param {object[]} entries
 * @param {object} options
 * @param {(entry: object, event: PointerEvent) => Promise<void>|void} options.onToggle
 * @param {boolean} [options.padToThree=false]
 * @param {boolean} [options.interactive=true]
 * @returns {HTMLUListElement}
 */
function buildConditionsList(entries, { onToggle, padToThree = false, interactive = true } = {}) {
  const list = document.createElement("ul");
  list.className = "conditions-list unlist";

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = `condition${entry.active ? " active" : ""}`;
    li.dataset.conditionId = entry.id;
    if (entry.reference) li.dataset.uuid = entry.reference;
    li.dataset.tooltip = entry.name;

    const levelHtml = entry.level != null && entry.level > 0
      ? `<span class="condition-level">${entry.level}</span>`
      : `<i class="fa-solid fa-toggle-${entry.active ? "on" : "off"}"></i>`;

    li.innerHTML = `
      <div class="icon"><dnd5e-icon src="${escapeHTML(entry.img || "icons/svg/aura.svg")}"></dnd5e-icon></div>
      <div class="name-stacked"><span class="title"></span></div>
      ${levelHtml}`;
    li.querySelector(".title").textContent = entry.name;

    if (interactive) {
      li.style.cursor = "pointer";
      li.addEventListener("click", async ev => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        await onToggle?.(entry, ev);
      }, { capture: true });
      if (entry.level != null) {
        li.addEventListener("contextmenu", async ev => {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          await onToggle?.(entry, ev);
        }, { capture: true });
      }
    } else {
      li.style.cursor = "default";
    }
    list.append(li);
  }

  if (padToThree && entries.length > 0 && entries.length < 3) {
    for (let i = entries.length; i < 3; i++) {
      const pad = document.createElement("li");
      pad.className = "condition dm-toolkit-condition-placeholder";
      pad.setAttribute("aria-hidden", "true");
      list.append(pad);
    }
  }

  return list;
}

/**
 * @param {Actor} actor
 * @param {object} [options]
 * @param {() => void|Promise<void>} [options.onChanged]
 * @returns {HTMLElement}
 */
function buildCoreConditionsSection(actor, { onChanged } = {}) {
  const section = document.createElement("section");
  section.className = "items-list dm-toolkit-core-conditions";
  section.innerHTML = `
    <div class="items-section card">
      <div class="items-header header">
        <h3 class="item-name">${game.i18n.localize("DND5E.Conditions")}</h3>
      </div>
    </div>`;
  const card = section.querySelector(".items-section");
  const list = buildConditionsList(getCoreConditionEntries(actor), {
    padToThree: false,
    interactive: actor.isOwner,
    onToggle: async (entry, event) => {
      await toggleCoreCondition(actor, entry.id, event);
      await onChanged?.();
    }
  });
  card.append(list);
  return section;
}

/**
 * @param {Actor} actor
 * @param {object} [options]
 * @param {() => void|Promise<void>} [options.onChanged]
 * @returns {HTMLElement}
 */
function buildCustomConditionsSection(actor, { onChanged } = {}) {
  const conditions = getConditions();
  const section = document.createElement("section");
  section.className = "items-list dm-toolkit-custom-conditions";
  section.innerHTML = `
    <div class="items-section card">
      <div class="items-header header">
        <h3 class="item-name">${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.CustomConditions")}</h3>
      </div>
    </div>`;
  const card = section.querySelector(".items-section");

  const entries = conditions.map(condition => {
    const applied = findAppliedEffect(actor, condition.id);
    return {
      id: condition.id,
      name: condition.name,
      img: applied?.img || condition.img || DEFAULT_CONDITION_IMG,
      active: Boolean(applied?.active),
      level: null,
      effectUuid: condition.effectUuid
    };
  });

  const list = buildConditionsList(entries, {
    padToThree: true,
    interactive: actor.isOwner,
    onToggle: async entry => {
      const key = `${actor.uuid}:${entry.id}`;
      if (pendingToggles.has(key)) return;
      pendingToggles.add(key);
      const wantActive = !findAppliedEffect(actor, entry.id)?.active;
      try {
        if (wantActive) await enableCondition(actor, entry.id);
        else await disableCondition(actor, entry.id);
      } finally {
        setTimeout(() => pendingToggles.delete(key), 750);
      }
      await onChanged?.();
    }
  });

  // Prefer configured condition icons; fall back to linked effect icons when still default.
  for (const li of list.querySelectorAll("li.condition[data-condition-id]")) {
    const entry = entries.find(e => e.id === li.dataset.conditionId);
    const iconEl = li.querySelector("dnd5e-icon");
    if (!entry || !iconEl) continue;
    if (entry.img && entry.img !== DEFAULT_CONDITION_IMG) continue;
    if (!entry.effectUuid) continue;
    fromUuid(entry.effectUuid).then(effect => {
      if (effect?.img && iconEl.isConnected) iconEl.setAttribute("src", effect.img);
    }).catch(() => null);
  }

  card.append(list);
  if (!conditions.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.style.padding = "0.35rem 0.5rem";
    empty.textContent = game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Empty");
    card.append(empty);
  }
  return section;
}

/* -------------------------------------------- */
/*  Token HUD Conditions Popup                  */
/* -------------------------------------------- */

class TokenConditionsPopup extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-token-conditions",
    classes: ["dm-toolkit-token-conditions-app", "dnd5e2"],
    window: {
      title: "DM-TOOLKIT-DND5E.EnhancedStatusEffects.TokenHudTitle",
      contentClasses: ["standard-form"],
      controls: [],
      minimizable: false,
      resizable: false
    },
    position: { width: 560, height: "auto" }
  };

  /** @type {(event: PointerEvent) => void} */
  #outsideClickBound = null;

  /** @type {number} */
  #ignoreOutsideUntil = 0;

  /**
   * @param {object} [options]
   * @param {Actor} options.actor
   */
  constructor(options = {}) {
    super(options);
    this.actor = options.actor ?? null;
  }

  /**
   * @param {Actor} actor
   * @param {object} [options]
   * @param {Application} [options.hud]
   * @returns {Promise<TokenConditionsPopup>}
   */
  static async open(actor, { hud } = {}) {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      existing.actor = actor;
      await existing.render({ force: true });
      existing.#positionNearHud(hud);
      existing.#armOutsideClose();
      return existing;
    }
    const app = new this({ actor });
    await app.render({ force: true });
    app.#positionNearHud(hud);
    app.#armOutsideClose();
    return app;
  }

  /** @inheritDoc */
  async _prepareContext() {
    return { actor: this.actor };
  }

  /** @inheritDoc */
  async _renderHTML(context) {
    const root = document.createElement("div");
    root.className = "dm-toolkit-token-conditions-body";
    const host = document.createElement("div");
    host.className = "effects-element dm-toolkit-token-conditions-effects";
    root.append(host);

    const actor = context.actor;
    if (!actor) {
      root.innerHTML = `<p class="hint">${game.i18n.localize("HUD.WarningEffectNoActor")}</p>`;
      return root;
    }

    const refresh = async () => {
      // Re-read actor from collection in case of replacement.
      this.actor = game.actors.get(actor.id) ?? actor;
      this.render({ force: true });
    };

    host.append(buildCoreConditionsSection(this.actor, { onChanged: refresh }));
    host.append(buildCustomConditionsSection(this.actor, { onChanged: refresh }));
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);
    // ApplicationV2 always inserts these; remove them for a compact popup chrome.
    this.element?.querySelectorAll(
      ".window-header [data-action='close'], .window-header [data-action='toggleControls']"
    ).forEach(el => el.remove());
  }

  /** @inheritDoc */
  _onClose(options) {
    this.#disarmOutsideClose();
    super._onClose?.(options);
  }

  #armOutsideClose() {
    this.#disarmOutsideClose();
    this.#ignoreOutsideUntil = Date.now() + 150;
    this.#outsideClickBound = event => {
      if (Date.now() < this.#ignoreOutsideUntil) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (this.element?.contains(target)) return;
      this.close();
    };
    document.addEventListener("pointerdown", this.#outsideClickBound, true);
  }

  #disarmOutsideClose() {
    if (!this.#outsideClickBound) return;
    document.removeEventListener("pointerdown", this.#outsideClickBound, true);
    this.#outsideClickBound = null;
  }

  /**
   * @param {Application} [hud]
   */
  #positionNearHud(hud) {
    const hudEl = hud?.element;
    if (!hudEl || !this.element) return;
    const rightCol = hudEl.querySelector(".col.right");
    const anchor = rightCol?.querySelector(".control-icon") ?? hudEl;
    const rect = anchor.getBoundingClientRect();
    const width = this.position?.width || 560;
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right + 8));
    const top = Math.min(window.innerHeight - 120, Math.max(12, rect.top));
    this.setPosition({ left, top, width });
  }
}

/* -------------------------------------------- */
/*  Manage Application                          */
/* -------------------------------------------- */

class CustomConditionsApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-custom-conditions",
    classes: ["dm-toolkit-custom-conditions-app"],
    tag: "form",
    window: {
      title: "DM-TOOLKIT-DND5E.EnhancedStatusEffects.ManageTitle",
      contentClasses: ["standard-form"],
      resizable: true
    },
    position: { width: 600, height: 560 },
    form: {
      handler: CustomConditionsApp.#onSubmit,
      closeOnSubmit: false
    },
    actions: {
      addCondition: CustomConditionsApp.#onAdd,
      deleteCondition: CustomConditionsApp.#onDelete,
      createEffect: CustomConditionsApp.#onCreateEffect,
      editEffect: CustomConditionsApp.#onEditEffect
    }
  };

  /** @inheritDoc */
  async _prepareContext() {
    const item = await getOrCreateEffectsItem();
    const effectOptions = (item?.effects?.contents ?? []).map(e => ({
      uuid: e.uuid,
      name: e.name
    }));
    return {
      enabled: isFeatureEnabled(),
      conditions: getConditions(),
      effectOptions,
      itemUuid: item?.uuid ?? null
    };
  }

  /** @inheritDoc */
  async _renderHTML(context) {
    const root = document.createElement("div");
    root.classList.add("dm-toolkit-custom-conditions-body");

    if (!context.enabled) {
      root.innerHTML = `<p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.DisabledHint")}</p>`;
      return root;
    }

    const rows = context.conditions.map((c, index) => {
      const options = context.effectOptions.map(opt =>
        `<option value="${escapeHTML(opt.uuid)}" ${opt.uuid === c.effectUuid ? "selected" : ""}>${escapeHTML(opt.name)}</option>`
      ).join("");
      return `
        <li class="dm-toolkit-custom-condition-row" data-index="${index}" data-condition-id="${escapeHTML(c.id)}">
          <div class="form-group">
            <label>${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Name")}</label>
            <input type="text" name="name-${c.id}" value="${escapeHTML(c.name)}" required />
          </div>
          <div class="form-group">
            <label>${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Icon")}</label>
            <div class="form-fields">
              <file-picker type="image" name="img-${c.id}" value="${escapeHTML(c.img || DEFAULT_CONDITION_IMG)}"></file-picker>
            </div>
          </div>
          <div class="form-group">
            <label>${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Effect")}</label>
            <div class="dm-toolkit-custom-condition-effect-row">
              <select name="effect-${c.id}">
                <option value="">${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.NoEffect")}</option>
                ${options}
              </select>
              <button type="button" class="icon" data-action="editEffect" data-condition-id="${escapeHTML(c.id)}"
                      data-tooltip="${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.EditEffect")}">
                <i class="fa-solid fa-pen-to-square"></i>
              </button>
              <button type="button" class="icon" data-action="createEffect" data-condition-id="${escapeHTML(c.id)}"
                      data-tooltip="${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.CreateEffect")}">
                <i class="fa-solid fa-plus"></i>
              </button>
              <button type="button" class="icon" data-action="deleteCondition" data-condition-id="${escapeHTML(c.id)}"
                      data-tooltip="${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Delete")}">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        </li>`;
    }).join("");

    root.innerHTML = `
      <p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ManageHint")}</p>
      <ul class="dm-toolkit-custom-conditions-list unlist">${rows || `<li class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Empty")}</li>`}</ul>
      <footer class="form-footer">
        <button type="button" class="dense" data-action="addCondition">
          <i class="fa-solid fa-plus"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Add")}
        </button>
        <button type="submit" class="dense">
          <i class="fa-solid fa-floppy-disk"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Save")}
        </button>
      </footer>`;
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /**
   * @param {HTMLFormElement} form
   * @returns {{id: string, name: string, img: string, effectUuid: string|null, effectData?: object|null}[]}
   */
  static readForm(form) {
    const current = getConditions();
    return current.map(c => {
      const picker = form.querySelector(`file-picker[name="img-${c.id}"]`);
      const imgValue = picker?.value
        ?? form.elements[`img-${c.id}`]?.value
        ?? c.img;
      return {
        id: c.id,
        name: String(form.elements[`name-${c.id}`]?.value ?? "").trim(),
        img: normalizeConditionImg(imgValue),
        effectUuid: form.elements[`effect-${c.id}`]?.value || null,
        effectData: c.effectData ?? null
      };
    });
  }

  static async #onSubmit(_event, form) {
    const conditions = CustomConditionsApp.readForm(form);
    if (conditions.some(c => !c.name)) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNameRequired"));
      return;
    }
    // Refresh cached effect data for linked effects.
    for (const condition of conditions) {
      if (!condition.effectUuid) {
        condition.effectData = null;
        continue;
      }
      try {
        const effect = await fromUuid(condition.effectUuid);
        if (effect) {
          const data = effect.toObject();
          delete data._id;
          condition.effectData = data;
        }
      } catch (_err) { /* keep prior cache */ }
    }
    await setConditions(conditions);
    ui.notifications.info(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.Saved"));
    this.render({ force: true });
  }

  static async #onAdd() {
    let conditions = getConditions();
    if (this.element) {
      try {
        conditions = CustomConditionsApp.readForm(this.element);
      } catch (_err) { /* keep stored */ }
    }
    conditions.push({
      id: foundry.utils.randomID(),
      name: game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.NewCondition"),
      img: DEFAULT_CONDITION_IMG,
      effectUuid: null,
      effectData: null
    });
    await setConditions(conditions);
    this.render({ force: true });
  }

  static async #onDelete(_event, target) {
    const id = target.dataset.conditionId;
    let conditions = getConditions();
    if (this.element) {
      try {
        conditions = CustomConditionsApp.readForm(this.element);
      } catch (_err) { /* keep stored */ }
    }
    conditions = conditions.filter(c => c.id !== id);
    await setConditions(conditions);
    this.render({ force: true });
  }

  static async #onCreateEffect(_event, target) {
    const conditionId = target.dataset.conditionId;
    let conditions = getConditions();
    if (this.element) {
      try {
        conditions = CustomConditionsApp.readForm(this.element);
      } catch (_err) { /* keep stored */ }
    }

    const item = await getOrCreateEffectsItem();
    if (!item) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNeedGM"));
      return;
    }

    const condition = conditions.find(c => c.id === conditionId);
    const name = condition?.name
      || game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.NewEffect");

    const [effect] = await item.createEmbeddedDocuments("ActiveEffect", [{
      name,
      img: normalizeConditionImg(condition?.img),
      type: "base",
      transfer: false,
      disabled: false,
      system: { changes: [] },
      flags: { [MODULE_ID]: { templateForCondition: conditionId } }
    }]);
    if (!effect) return;

    await cacheConditionEffectData(conditionId, effect);
    // Preserve name/icon from the form that were read into `conditions`.
    const withForm = getConditions().map(c => {
      const fromForm = conditions.find(x => x.id === c.id);
      if (!fromForm) return c;
      return {
        ...c,
        name: fromForm.name || c.name,
        img: normalizeConditionImg(fromForm.img || c.img)
      };
    });
    await setConditions(withForm);
    this.render({ force: true });
    effect.sheet?.render(true);
  }

  static async #onEditEffect(_event, target) {
    const conditionId = target.dataset.conditionId;
    let conditions = getConditions();
    if (this.element) {
      try {
        conditions = CustomConditionsApp.readForm(this.element);
      } catch (_err) { /* keep stored */ }
    }
    const condition = conditions.find(c => c.id === conditionId);
    if (!condition?.effectUuid) {
      ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrNoEffect"));
      return;
    }
    await setConditions(conditions);
    const effect = await fromUuid(condition.effectUuid);
    if (!effect) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.EnhancedStatusEffects.ErrEffectMissing"));
      return;
    }
    await cacheConditionEffectData(conditionId, effect);
    effect.sheet?.render(true);
  }
}

/**
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);
}
