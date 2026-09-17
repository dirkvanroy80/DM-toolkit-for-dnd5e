/**
 * Token auras: optional filled circle around a token.
 * Configured on the token Auras tab, or pushed from an Active Effect Changes tab
 * when the Token auras world setting is enabled.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const AURAS_SETTING = "tokenAuras";
const HIDE_HOSTILE_SETTING = "hideHostileAuras";
const AURA_FLAG = "aura";
const TAB_ID = "dm-toolkit-auras";
const AURA_CHILD = "dmToolkitAura";

const DEFAULT_AURA = Object.freeze({
  enabled: false,
  radius: 10,
  color: "#00ff00",
  alpha: 0.25
});

export function registerTokenAuras() {
  Hooks.once("ready", () => {
    Hooks.on("renderTokenConfig", onRenderTokenConfig);
    Hooks.on("renderPrototypeTokenConfig", onRenderTokenConfig);
    Hooks.on("renderActiveEffectConfig", onRenderActiveEffectConfig);
    Hooks.on("refreshToken", onRefreshToken);
    Hooks.on("drawToken", onRefreshToken);
    Hooks.on("createToken", onCreateToken);
    Hooks.on("updateToken", onUpdateToken);
    Hooks.on("updateActor", onUpdateActor);
    Hooks.on("preUpdateToken", onPreUpdateToken);
    Hooks.on("preUpdateActor", onPreUpdateActor);
    Hooks.on("preCreateActiveEffect", onPreCreateActiveEffect);
    Hooks.on("preUpdateActiveEffect", onPreUpdateActiveEffect);
    Hooks.on("createActiveEffect", onCreateActiveEffect);
    Hooks.on("updateActiveEffect", onUpdateActiveEffect);
    Hooks.on("deleteActiveEffect", onDeleteActiveEffect);
    Hooks.on("canvasReady", refreshAllAuras);
  });
}

export function registerTokenAurasSettings() {
  game.settings.register(MODULE_ID, AURAS_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.TokenAuras.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.TokenAuras.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => refreshAllAuras()
  });

  game.settings.register(MODULE_ID, HIDE_HOSTILE_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.HideHostileAuras.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.HideHostileAuras.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => refreshAllAuras()
  });
}

/**
 * @returns {boolean}
 */
function isAurasFeatureEnabled() {
  return Boolean(game.settings.get(MODULE_ID, AURAS_SETTING));
}

/**
 * @returns {boolean}
 */
function hideHostileFromPlayers() {
  return Boolean(game.settings.get(MODULE_ID, HIDE_HOSTILE_SETTING));
}

/**
 * @param {TokenDocument|object} doc
 * @returns {{enabled: boolean, radius: number, color: string, alpha: number}}
 */
function getAuraData(doc) {
  return normalizeAuraData(readAuraRaw(doc));
}

/**
 * Linked player tokens often store settings on the actor prototype token.
 * Linked TokenConfig can also mis-save onto Actor.flags; read that too.
 * @param {TokenDocument|object} doc
 * @returns {object}
 */
function readAuraRaw(doc) {
  if (!doc) return {};

  const fromDoc = doc.getFlag?.(MODULE_ID, AURA_FLAG)
    ?? foundry.utils.getProperty(doc, `flags.${MODULE_ID}.${AURA_FLAG}`);

  const actor = doc.actor
    ?? (doc.parent?.documentName === "Actor" ? doc.parent : null)
    ?? (doc.documentName === "Actor" ? doc : null);

  const fromPrototype = actor
    ? foundry.utils.getProperty(actor, `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`)
    : foundry.utils.getProperty(doc, `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`);

  const fromActorFlags = actor
    ? foundry.utils.getProperty(actor, `flags.${MODULE_ID}.${AURA_FLAG}`)
    : null;

  const isLinkedToken = doc.documentName === "Token" && Boolean(doc.actorLink) && Boolean(actor);

  // Linked tokens follow the prototype as source of truth so disabling the
  // prototype actually turns the canvas aura off (token flags can be stale).
  if (isLinkedToken) {
    if (fromPrototype && hasAuraConfig(fromPrototype)) return fromPrototype;
    if (fromActorFlags && hasAuraConfig(fromActorFlags)) return fromActorFlags;
    if (fromDoc && hasAuraConfig(fromDoc)) return fromDoc;
    return {};
  }

  if (fromDoc && hasAuraConfig(fromDoc)) return fromDoc;
  if (fromPrototype && hasAuraConfig(fromPrototype)) return fromPrototype;
  if (fromActorFlags && hasAuraConfig(fromActorFlags)) return fromActorFlags;
  return fromDoc ?? fromPrototype ?? fromActorFlags ?? {};
}

/**
 * @param {object} raw
 * @returns {boolean}
 */
function hasAuraConfig(raw) {
  if (!raw || typeof raw !== "object") return false;
  return ("enabled" in raw) || ("radius" in raw) || ("color" in raw) || ("alpha" in raw);
}

/**
 * @param {object} raw
 * @returns {{enabled: boolean, radius: number, color: string, alpha: number}}
 */
function normalizeAuraData(raw = {}) {
  const alpha = Number(raw.alpha);
  return {
    enabled: coerceEnabled(raw.enabled),
    radius: Number.isFinite(Number(raw.radius)) ? Number(raw.radius) : DEFAULT_AURA.radius,
    color: typeof raw.color === "string" && raw.color ? raw.color : DEFAULT_AURA.color,
    alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : DEFAULT_AURA.alpha
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function coerceEnabled(value) {
  if (Array.isArray(value)) {
    return value.includes(true) || value.includes("true");
  }
  return value === true || value === "true" || value === 1 || value === "1";
}

/**
 * @param {TokenConfig|PrototypeTokenConfig} app
 * @param {HTMLElement} html
 */
function onRenderTokenConfig(app, html) {
  if (!isAurasFeatureEnabled()) return;

  const root = html instanceof HTMLElement ? html : null;
  if (!root) return;

  const nav = findTabNav(root);
  if (!nav) return;

  const group = nav.dataset.group || "sheet";
  let tabButton = nav.querySelector(`[data-tab="${TAB_ID}"]`);
  let section = root.querySelector(`.tab[data-tab="${TAB_ID}"]`);

  if (!tabButton || !section) {
    const doc = app.document ?? app.token ?? app.object;
    const aura = getAuraData(doc);
    const flagPath = `flags.${MODULE_ID}.${AURA_FLAG}`;

    if (!tabButton) {
      tabButton = document.createElement("a");
      tabButton.dataset.action = "tab";
      tabButton.dataset.group = group;
      tabButton.dataset.tab = TAB_ID;
      tabButton.innerHTML = `<i class="fas fa-circle-notch"></i> <span>${game.i18n.localize("DM-TOOLKIT-DND5E.Auras.Tab")}</span>`;
      nav.append(tabButton);
    }

    if (!section) {
      section = document.createElement("div");
      section.classList.add("tab", "scrollable", "dm-toolkit-auras");
      section.dataset.group = group;
      section.dataset.tab = TAB_ID;
      section.innerHTML = buildAuraTabHtml(flagPath, aura);
      insertAuraTabSection(findTabsParent(root, nav), section);
      bindAuraAlphaLabel(section);
    }
  } else {
    // Older inserts placed Auras after the footer; keep Update Token below the tabs.
    ensureAuraTabBeforeFooter(section);
  }

  // AppV2 keeps tabGroups pointing at Auras before our panel exists, so changeTab
  // no-ops unless forced — and we must also set classes ourselves.
  const activate = () => activateAuraTabIfNeeded(app, group, tabButton, section);
  activate();
  queueMicrotask(activate);
  requestAnimationFrame(activate);
}

/**
 * Foundry restores the last tab before our panel exists; re-activate if needed.
 * @param {TokenConfig|PrototypeTokenConfig} app
 * @param {string} group
 * @param {HTMLElement} tabButton
 * @param {HTMLElement} section
 */
function activateAuraTabIfNeeded(app, group, tabButton, section) {
  if (!section.isConnected) return;

  const groups = app.tabGroups ?? {};
  const matchedGroup = Object.entries(groups).find(([, tab]) => tab === TAB_ID)?.[0] ?? (
    groups[group] === TAB_ID ? group : null
  );
  if (!matchedGroup) return;

  const scope = (app.element instanceof HTMLElement ? app.element : null)
    ?? section.closest(".application, .app")
    ?? section.parentElement;
  if (!scope) return;

  // Already active in tabGroups — without force, changeTab is a no-op and leaves a blank body.
  try {
    app.changeTab?.(TAB_ID, matchedGroup, { force: true, navElement: tabButton });
  } catch (_err) {
    // Custom tabs are outside static TABS; fall through to manual activation.
  }
  if (app.tabGroups) app.tabGroups[matchedGroup] = TAB_ID;

  for (const el of scope.querySelectorAll(`[data-group="${matchedGroup}"][data-tab]`)) {
    el.classList.toggle("active", el.dataset.tab === TAB_ID);
  }
  tabButton.classList.add("active");
  section.classList.add("active");
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLElement|null}
 */
function findTabNav(root) {
  return root.querySelector(
    'nav.sheet-tabs[data-group], nav.tabs[data-group], [data-application-part="tabs"] nav, nav.sheet-tabs, nav.tabs'
  );
}

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} nav
 * @returns {HTMLElement}
 */
function findTabsParent(root, nav) {
  const existingTab = root.querySelector(".tab[data-group], .tab[data-tab]");
  if (existingTab?.parentElement) return existingTab.parentElement;

  return root.querySelector(".sheet-body, [data-application-part=\"body\"], .window-content form, form")
    ?? nav.parentElement
    ?? root;
}

/**
 * Keep the Auras panel with the other tabs, before the form footer / Update button.
 * @param {HTMLElement} parent
 * @param {HTMLElement} section
 */
function insertAuraTabSection(parent, section) {
  const tabs = [...parent.querySelectorAll(":scope > .tab[data-tab], :scope > .tab[data-group]")];
  const lastTab = tabs.filter(t => t !== section).at(-1);
  if (lastTab) {
    lastTab.after(section);
    return;
  }

  const footer = parent.querySelector(
    ':scope > footer, :scope > .form-footer, :scope > [data-application-part="footer"]'
  );
  if (footer) {
    footer.before(section);
    return;
  }

  parent.append(section);
}

/**
 * @param {HTMLElement} section
 */
function ensureAuraTabBeforeFooter(section) {
  const parent = section.parentElement;
  if (!parent) return;

  const footer = parent.querySelector(
    ':scope > footer, :scope > .form-footer, :scope > [data-application-part="footer"]'
  );
  if (footer && section.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_PRECEDING) {
    insertAuraTabSection(parent, section);
  }
}

/**
 * @param {string} flagPath
 * @param {{enabled: boolean, radius: number, color: string, alpha: number}} aura
 * @returns {string}
 */
function buildAuraTabHtml(flagPath, aura) {
  const enabled = aura.enabled ? "checked" : "";
  const units = canvas?.scene?.grid?.units
    || game.i18n.localize("DM-TOOLKIT-DND5E.Auras.UnitsFallback");

  return `
    <div class="form-group">
      <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Auras.Enabled")}</label>
      <div class="form-fields">
        <input type="hidden" name="${flagPath}.enabled" value="false">
        <input type="checkbox" name="${flagPath}.enabled" value="true" ${enabled}>
      </div>
    </div>
    <div class="form-group">
      <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Auras.Radius")} <span class="units">(${units})</span></label>
      <div class="form-fields">
        <input type="number" name="${flagPath}.radius" value="${aura.radius}" min="0" step="any">
      </div>
    </div>
    <div class="form-group">
      <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Auras.Color")}</label>
      <div class="form-fields">
        <input type="color" name="${flagPath}.color" value="${aura.color}">
      </div>
    </div>
    <div class="form-group">
      <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Auras.Alpha")}</label>
      <div class="form-fields">
        <input type="range" name="${flagPath}.alpha" value="${aura.alpha}" min="0" max="1" step="0.05">
        <span class="dm-toolkit-aura-alpha-value">${aura.alpha}</span>
      </div>
    </div>
  `;
}

/**
 * @param {HTMLElement} root
 */
function bindAuraAlphaLabel(root) {
  const range = root.querySelector(`input[type="range"][name="flags.${MODULE_ID}.${AURA_FLAG}.alpha"]`);
  const label = root.querySelector(".dm-toolkit-aura-alpha-value");
  if (!range || !label || range.dataset.dmToolkitBound) return;
  range.dataset.dmToolkitBound = "true";
  range.addEventListener("input", () => {
    label.textContent = range.value;
  });
}

/* -------------------------------------------- */
/*  Active Effect Changes tab                   */
/* -------------------------------------------- */

/**
 * @param {ActiveEffectConfig} app
 * @param {HTMLElement} html
 */
function onRenderActiveEffectConfig(app, html) {
  if (!isAurasFeatureEnabled()) return;

  const root = html instanceof HTMLElement ? html : null;
  if (!root || root.querySelector(".dm-toolkit-effect-aura")) return;

  const changesTab = findEffectChangesTab(root);
  if (!changesTab) return;

  const effect = app.document;
  const aura = normalizeAuraData(effect?.getFlag?.(MODULE_ID, AURA_FLAG) ?? {});
  const flagPath = `flags.${MODULE_ID}.${AURA_FLAG}`;

  const section = document.createElement("fieldset");
  section.classList.add("dm-toolkit-effect-aura");
  section.innerHTML = `
    <legend>${game.i18n.localize("DM-TOOLKIT-DND5E.Auras.EffectSection")}</legend>
    ${buildAuraTabHtml(flagPath, aura)}
  `;
  changesTab.prepend(section);
  bindAuraAlphaLabel(section);
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLElement|null}
 */
function findEffectChangesTab(root) {
  return root.querySelector('.tab[data-tab="changes"], [data-application-part="changes"]')
    ?? root.querySelector('.tab.changes, .changes')
    ?? null;
}

/**
 * @param {ActiveEffect} _effect
 * @param {object} data
 */
function onPreCreateActiveEffect(_effect, data) {
  normalizeAuraUpdate(foundry.utils.getProperty(data, `flags.${MODULE_ID}.${AURA_FLAG}`));
}

/**
 * @param {ActiveEffect} _effect
 * @param {object} change
 */
function onPreUpdateActiveEffect(_effect, change) {
  normalizeAuraUpdate(foundry.utils.getProperty(change, `flags.${MODULE_ID}.${AURA_FLAG}`));
}

/**
 * @param {ActiveEffect} effect
 */
function onCreateActiveEffect(effect) {
  syncEffectAuraToTokens(effect);
}

/**
 * @param {ActiveEffect} effect
 * @param {object} change
 */
function onUpdateActiveEffect(effect, change) {
  const auraChanged = foundry.utils.hasProperty(change, `flags.${MODULE_ID}.${AURA_FLAG}`);
  const disabledChanged = "disabled" in change;
  if (!auraChanged && !disabledChanged) return;
  syncEffectAuraToTokens(effect);
}

/**
 * @param {ActiveEffect} effect
 */
function onDeleteActiveEffect(effect) {
  if (!isAurasFeatureEnabled()) return;
  if (effect.parent?.documentName !== "Actor") return;

  const aura = normalizeAuraData(effect.getFlag?.(MODULE_ID, AURA_FLAG) ?? {});
  if (!aura.enabled) return;
  writeAuraToActor(effect.parent, { enabled: false });
}

/**
 * When the effect is active and its aura is enabled, push those values onto the
 * actor's token(s). When the effect is disabled but its aura is enabled, turn
 * the token aura off.
 * @param {ActiveEffect} effect
 */
function syncEffectAuraToTokens(effect) {
  if (!isAurasFeatureEnabled()) return;
  if (!effect || effect.parent?.documentName !== "Actor") return;

  const aura = normalizeAuraData(effect.getFlag?.(MODULE_ID, AURA_FLAG) ?? {});
  if (!aura.enabled) return;

  if (effect.disabled) {
    writeAuraToActor(effect.parent, { enabled: false });
  } else {
    writeAuraToActor(effect.parent, aura);
  }
}

/**
 * @param {Actor} actor
 * @param {{enabled?: boolean, radius?: number, color?: string, alpha?: number}} auraPatch
 */
async function writeAuraToActor(actor, auraPatch) {
  if (!actor || !auraPatch || typeof auraPatch !== "object") return;

  const tokenDocs = collectActorTokenDocuments(actor);
  for (const doc of tokenDocs) {
    if (!doc.canUserModify?.(game.user, "update")) continue;
    const next = normalizeAuraData({ ...getAuraData(doc), ...auraPatch });
    try {
      await doc.update({ [`flags.${MODULE_ID}.${AURA_FLAG}`]: next });
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to update token aura from effect`, err);
    }
  }

  if (!actor.canUserModify?.(game.user, "update")) return;
  const protoRaw = foundry.utils.getProperty(actor, `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`) ?? {};
  const nextProto = normalizeAuraData({ ...normalizeAuraData(protoRaw), ...auraPatch });
  try {
    await actor.update({
      [`prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`]: nextProto
    }, { render: false });
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to update prototype aura from effect`, err);
  }
}

/**
 * @param {Actor} actor
 * @returns {TokenDocument[]}
 */
function collectActorTokenDocuments(actor) {
  const byId = new Map();

  if (typeof actor.getActiveTokens === "function") {
    for (const token of actor.getActiveTokens(false)) {
      const doc = token.document ?? token;
      if (doc?.id) byId.set(doc.id, doc);
    }
  }

  for (const tokenDoc of actor.getDependentTokens?.() ?? []) {
    if (tokenDoc?.id) byId.set(tokenDoc.id, tokenDoc);
  }

  return [...byId.values()];
}

/**
 * @param {TokenDocument} _document
 * @param {object} change
 */
function onPreUpdateToken(_document, change) {
  normalizeAuraUpdate(foundry.utils.getProperty(change, `flags.${MODULE_ID}.${AURA_FLAG}`));
}

/**
 * @param {Actor} _actor
 * @param {object} change
 */
function onPreUpdateActor(_actor, change) {
  // Linked TokenConfig may write aura onto Actor.flags; move it onto the prototype token.
  const misplaced = foundry.utils.getProperty(change, `flags.${MODULE_ID}.${AURA_FLAG}`);
  if (misplaced && typeof misplaced === "object") {
    const targetPath = `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`;
    const existing = foundry.utils.getProperty(change, targetPath) ?? {};
    foundry.utils.setProperty(
      change,
      targetPath,
      foundry.utils.mergeObject(existing, misplaced, { inplace: false })
    );
    foundry.utils.setProperty(change, `flags.${MODULE_ID}.-=${AURA_FLAG}`, null);
  }

  normalizeAuraUpdate(
    foundry.utils.getProperty(change, `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`)
  );
}

/**
 * @param {object|undefined} aura
 */
function normalizeAuraUpdate(aura) {
  if (!aura || typeof aura !== "object") return;

  if ("enabled" in aura) aura.enabled = coerceEnabled(aura.enabled);
  if ("radius" in aura) aura.radius = Math.max(0, Number(aura.radius) || 0);
  if ("alpha" in aura) {
    const alpha = Number(aura.alpha);
    aura.alpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : DEFAULT_AURA.alpha;
  }
}

/**
 * @param {Token} token
 */
function onRefreshToken(token) {
  // Defer so Dynamic Token Ring / mesh rebuilds do not wipe the aura child.
  queueMicrotask(() => drawTokenAura(token));
}

/**
 * @param {TokenDocument} document
 */
function onCreateToken(document) {
  const token = document.object;
  if (token) queueMicrotask(() => drawTokenAura(token));
}

/**
 * @param {TokenDocument} document
 * @param {object} change
 * @param {object} [options]
 */
function onUpdateToken(document, change, options={}) {
  if (!foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)
    && !("width" in change)
    && !("height" in change)
    && !("disposition" in change)) {
    return;
  }
  const token = document.object;
  if (token) drawTokenAura(token);

  // Keep actor prototype in sync for linked player tokens (skip echo from prototype→token sync).
  if (options.dmToolkitAuraSync) return;
  if (document.actorLink && document.actor
    && foundry.utils.hasProperty(change, `flags.${MODULE_ID}.${AURA_FLAG}`)) {
    const aura = document.getFlag(MODULE_ID, AURA_FLAG);
    document.actor.update({
      [`prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`]: aura ?? null
    }, { render: false, dmToolkitAuraSync: true });
  }
}

/**
 * Prototype token aura edits on actors must refresh (and sync) placed tokens.
 * @param {Actor} actor
 * @param {object} change
 * @param {object} [options]
 */
function onUpdateActor(actor, change, options={}) {
  if (!foundry.utils.hasProperty(change, `prototypeToken.flags.${MODULE_ID}`)
    && !foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) {
    return;
  }

  // When the prototype aura changes, push it onto linked placed tokens so stale
  // token flags cannot keep a disabled aura visible.
  if (!options.dmToolkitAuraSync
    && foundry.utils.hasProperty(change, `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`)) {
    const aura = foundry.utils.getProperty(actor, `prototypeToken.flags.${MODULE_ID}.${AURA_FLAG}`);
    const next = aura && typeof aura === "object"
      ? normalizeAuraData(aura)
      : { ...DEFAULT_AURA, enabled: false };
    void syncAuraToLinkedTokens(actor, next);
  }

  const tokens = typeof actor.getActiveTokens === "function"
    ? actor.getActiveTokens(false)
    : [];
  for (const token of tokens) queueMicrotask(() => drawTokenAura(token));
}

/**
 * @param {Actor} actor
 * @param {{enabled: boolean, radius: number, color: string, alpha: number}} aura
 */
async function syncAuraToLinkedTokens(actor, aura) {
  for (const tokenDoc of collectActorTokenDocuments(actor)) {
    if (!tokenDoc.actorLink) continue;
    if (!tokenDoc.canUserModify?.(game.user, "update")) continue;
    try {
      await tokenDoc.update({
        [`flags.${MODULE_ID}.${AURA_FLAG}`]: aura
      }, { render: false, dmToolkitAuraSync: true });
    } catch (err) {
      console.warn(`${MODULE_ID} | Failed to sync prototype aura to token`, err);
    }
  }
}

function refreshAllAuras() {
  if (!canvas?.ready || !canvas.tokens) return;
  for (const token of canvas.tokens.placeables) drawTokenAura(token);
}

/**
 * @param {Token} token
 */
function drawTokenAura(token) {
  if (!token) return;

  const existing = token[AURA_CHILD];
  if (!isAurasFeatureEnabled() || !shouldDisplayAura(token)) {
    destroyAura(token, existing);
    return;
  }

  const aura = getAuraData(token.document);
  const graphics = ensureAuraGraphics(token, existing);
  const radiusPx = getAuraRadiusPixels(token, aura.radius);
  const color = Color.from(aura.color);

  graphics.clear();
  if (!(radiusPx > 0) || !(aura.alpha > 0)) return;

  graphics.beginFill(Number(color), aura.alpha);
  graphics.drawCircle(token.w / 2, token.h / 2, radiusPx);
  graphics.endFill();
  graphics.visible = true;
}

/**
 * @param {Token} token
 * @returns {boolean}
 */
function shouldDisplayAura(token) {
  const aura = getAuraData(token.document);
  if (!aura.enabled) return false;

  if (!game.user.isGM && hideHostileFromPlayers()) {
    if (token.document.disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE) return false;
  }

  return true;
}

/**
 * Radius is measured from the token border (emanation-style).
 * @param {Token} token
 * @param {number} radius
 * @returns {number}
 */
function getAuraRadiusPixels(token, radius) {
  const gridDistance = canvas.grid?.distance
    ?? canvas.scene?.grid?.distance
    ?? 5;
  const gridSize = canvas.grid?.size
    ?? canvas.dimensions?.size
    ?? 100;
  if (!(gridDistance > 0)) return 0;

  const borderOffset = Math.max(token.w, token.h) / 2;
  return (Math.max(0, radius) / gridDistance) * gridSize + borderOffset;
}

/**
 * @param {Token} token
 * @param {PIXI.Graphics|undefined} existing
 * @returns {PIXI.Graphics}
 */
function ensureAuraGraphics(token, existing) {
  if (existing && !existing.destroyed && existing.parent === token) return existing;
  if (existing && !existing.destroyed) existing.destroy({ children: true });

  const graphics = new PIXI.Graphics();
  graphics.name = AURA_CHILD;
  graphics.eventMode = "none";
  graphics.interactive = false;
  token[AURA_CHILD] = graphics;

  // Keep the fill under the sprite / dynamic token ring mesh.
  const meshIndex = token.mesh && token.children.includes(token.mesh)
    ? token.getChildIndex(token.mesh)
    : 0;
  token.addChildAt(graphics, Math.max(0, meshIndex));
  return graphics;
}

/**
 * @param {Token} token
 * @param {PIXI.DisplayObject|undefined} existing
 */
function destroyAura(token, existing) {
  const graphic = existing ?? token[AURA_CHILD];
  if (graphic && !graphic.destroyed) graphic.destroy({ children: true });
  token[AURA_CHILD] = null;
}
