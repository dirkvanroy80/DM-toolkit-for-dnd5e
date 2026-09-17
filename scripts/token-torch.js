/**
 * Token torch: HUD control to light/extinguish a moving torch on a token.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const ENABLED_SETTING = "tokenTorch";
const FLAG_KEY = "tokenTorch";
const DEFAULT_BRIGHT = 20;
const DEFAULT_DIM = 40;
// CONFIG key `flame` is localized as "Torch"; key `torch` is "Flickering Light".
const DEFAULT_ANIMATION = "flame";
const BUTTON_SELECTOR = ".dm-toolkit-token-torch";

export function registerTokenTorch() {
  Hooks.once("setup", patchTokenHudRender);
  Hooks.on("renderTokenHUD", injectFromHook);
  Hooks.on("renderTokenHUD5e", injectFromHook);
}

export function registerTokenTorchSettings() {
  game.settings.register(MODULE_ID, ENABLED_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.TokenTorch.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.TokenTorch.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      foundry.applications.instances.get("dm-toolkit-token-torch")?.close?.();
      const hud = canvas?.tokens?.hud;
      if (hud?.rendered) {
        if (isFeatureEnabled()) injectTorchButton(hud);
        else hud.element?.querySelector(BUTTON_SELECTOR)?.remove();
      }
    }
  });
}

/**
 * Patch the active Token HUD class so the button is injected after every render.
 */
function patchTokenHudRender() {
  const HudClass = CONFIG.Token?.hudClass;
  if (!HudClass?.prototype || HudClass.prototype._dmToolkitTorchPatched) return;

  const original = HudClass.prototype._onRender;
  HudClass.prototype._onRender = async function(...args) {
    const result = await original.apply(this, args);
    injectTorchButton(this);
    return result;
  };
  HudClass.prototype._dmToolkitTorchPatched = true;
}

/**
 * @param {Application} app
 * @param {HTMLElement} [_element]
 */
function injectFromHook(app, _element) {
  injectTorchButton(app);
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
 * @param {TokenDocument} tokenDoc
 * @returns {{active: boolean, priorLight: object|null}}
 */
function getTorchState(tokenDoc) {
  const raw = tokenDoc?.getFlag(MODULE_ID, FLAG_KEY);
  return {
    active: Boolean(raw?.active),
    priorLight: raw?.priorLight ?? null
  };
}

/**
 * @param {unknown} type
 * @returns {string|null}
 */
function normalizeAnimationType(type) {
  if (type === null || type === "" || type === "none") return null;
  if (typeof type !== "string") return DEFAULT_ANIMATION;
  if (!(type in (CONFIG.Canvas?.lightAnimations ?? {}))) return DEFAULT_ANIMATION;
  return type;
}

/**
 * @returns {{key: string, label: string}[]}
 */
function getAnimationChoices() {
  return Object.entries(CONFIG.Canvas?.lightAnimations ?? {})
    .map(([key, config]) => ({
      key,
      label: game.i18n.localize(config.label)
    }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/**
 * Build the dialog content element. Always uses fixed defaults (20 / 40 / Torch).
 * @returns {HTMLDivElement}
 */
function buildTorchDialogContent() {
  const root = document.createElement("div");
  const form = document.createElement("div");
  form.className = "standard-form dm-toolkit-token-torch-form";

  form.append(
    buildNumberField("bright", "DM-TOOLKIT-DND5E.TokenTorch.Bright", DEFAULT_BRIGHT),
    buildNumberField("dim", "DM-TOOLKIT-DND5E.TokenTorch.Dim", DEFAULT_DIM),
    buildAnimationField()
  );
  root.append(form);
  return root;
}

/**
 * @param {string} name
 * @param {string} labelKey
 * @param {number} value
 * @returns {HTMLDivElement}
 */
function buildNumberField(name, labelKey, value) {
  const group = document.createElement("div");
  group.className = "form-group";

  const label = document.createElement("label");
  label.textContent = game.i18n.localize(labelKey);

  const fields = document.createElement("div");
  fields.className = "form-fields";

  const input = document.createElement("input");
  input.type = "number";
  input.name = name;
  input.min = "0";
  input.step = "1";
  input.required = true;
  // setAttribute so the value survives DialogV2's innerHTML round-trip.
  input.setAttribute("value", String(value));
  input.value = String(value);

  fields.append(input);
  group.append(label, fields);
  return group;
}

/**
 * @returns {HTMLDivElement}
 */
function buildAnimationField() {
  const group = document.createElement("div");
  group.className = "form-group";

  const label = document.createElement("label");
  label.textContent = game.i18n.localize("DM-TOOLKIT-DND5E.TokenTorch.Animation");

  const fields = document.createElement("div");
  fields.className = "form-fields";

  const select = document.createElement("select");
  select.name = "animation";

  const choices = getAnimationChoices();
  const defaultChoice = choices.find(entry => entry.key === DEFAULT_ANIMATION);
  const otherChoices = choices.filter(entry => entry.key !== DEFAULT_ANIMATION);

  // Default type first so it remains visible even if selected-state is stripped.
  const ordered = [
    ...(defaultChoice ? [defaultChoice] : []),
    { key: "", label: game.i18n.localize("COMMON.None") },
    ...otherChoices
  ];

  for (const { key, label: optionLabel } of ordered) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = optionLabel;
    if (key === DEFAULT_ANIMATION) option.selected = true;
    select.append(option);
  }

  applyAnimationSelection(select, DEFAULT_ANIMATION);
  fields.append(select);
  group.append(label, fields);
  return group;
}

/**
 * @param {HTMLElement|HTMLSelectElement|null|undefined} root
 * @param {string} value
 */
function applyAnimationSelection(root, value) {
  const select = root instanceof HTMLSelectElement
    ? root
    : root?.querySelector?.('select[name="animation"]');
  if (!select) return;

  const preferred = value || DEFAULT_ANIMATION;
  select.value = preferred;
  for (const option of select.options) {
    option.selected = option.value === preferred;
  }
}

/**
 * Re-apply dialog defaults after DialogV2 inserts content into the DOM.
 * @param {HTMLElement|null|undefined} root
 */
function applyDialogDefaults(root) {
  if (!root) return;
  const bright = root.querySelector('input[name="bright"]');
  const dim = root.querySelector('input[name="dim"]');
  if (bright) {
    bright.value = String(DEFAULT_BRIGHT);
    bright.setAttribute("value", String(DEFAULT_BRIGHT));
  }
  if (dim) {
    dim.value = String(DEFAULT_DIM);
    dim.setAttribute("value", String(DEFAULT_DIM));
  }
  applyAnimationSelection(root, DEFAULT_ANIMATION);
}

/**
 * @param {Application} app
 */
function injectTorchButton(app) {
  const root = app?.element ?? document.getElementById("token-hud");
  if (!(root instanceof HTMLElement)) return;

  root.querySelector(BUTTON_SELECTOR)?.remove();
  if (!isFeatureEnabled()) return;

  const tokenDoc = app.document ?? app.object?.document;
  if (!tokenDoc) return;

  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if (!col) return;

  const lit = getTorchState(tokenDoc).active;
  const label = game.i18n.localize(
    lit
      ? "DM-TOOLKIT-DND5E.TokenTorch.ExtinguishTooltip"
      : "DM-TOOLKIT-DND5E.TokenTorch.LightTooltip"
  );

  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon dm-toolkit-token-torch${lit ? " active" : ""}`;
  button.dataset.tooltip = label;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = `<i class="fas fa-fire" inert></i>`;

  const after = col.querySelector('[data-action="visibility"]');
  if (after) after.after(button);
  else col.prepend(button);

  button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    await onTorchButtonClick(tokenDoc);
    if (app.render) await app.render({ force: true });
    else injectTorchButton(app);
  });
}

/**
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<void>}
 */
async function onTorchButtonClick(tokenDoc) {
  if (!tokenDoc?.isOwner) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.TokenTorch.ErrNoPermission"));
    return;
  }

  if (getTorchState(tokenDoc).active) {
    await extinguishTorch(tokenDoc);
    return;
  }
  await promptAndLightTorch(tokenDoc);
}

/**
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<void>}
 */
async function promptAndLightTorch(tokenDoc) {
  const content = buildTorchDialogContent();

  const onDialogRender = (app, element) => {
    if (app?.id !== "dm-toolkit-token-torch") return;
    applyDialogDefaults(element ?? app.element);
  };
  Hooks.on("renderDialogV2", onDialogRender);

  let result = null;
  try {
    result = await foundry.applications.api.DialogV2.prompt({
      id: "dm-toolkit-token-torch",
      window: { title: game.i18n.localize("DM-TOOLKIT-DND5E.TokenTorch.DialogTitle") },
      content,
      render: (_event, dialog) => {
        applyDialogDefaults(dialog.element);
        queueMicrotask(() => applyDialogDefaults(dialog.element));
        setTimeout(() => applyDialogDefaults(dialog.element), 0);
      },
      ok: {
        label: game.i18n.localize("DM-TOOLKIT-DND5E.TokenTorch.LightTorch"),
        icon: "fas fa-fire",
        callback: (_event, button) => {
          const form = button.form;
          const value = form.elements.animation?.value ?? DEFAULT_ANIMATION;
          return {
            bright: Math.max(0, Number(form.elements.bright?.value) || 0),
            dim: Math.max(0, Number(form.elements.dim?.value) || 0),
            animation: value === "" ? null : normalizeAnimationType(value)
          };
        }
      },
      rejectClose: false
    });
  } catch (_err) {
    return;
  } finally {
    Hooks.off("renderDialogV2", onDialogRender);
  }

  if (!result) return;
  if (result.dim < result.bright) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.TokenTorch.ErrDimLessThanBright"));
    return;
  }
  await lightTorch(tokenDoc, result.bright, result.dim, result.animation);
}

/**
 * @param {TokenDocument} tokenDoc
 * @param {number} bright
 * @param {number} dim
 * @param {string|null} animation
 * @returns {Promise<void>}
 */
async function lightTorch(tokenDoc, bright, dim, animation = DEFAULT_ANIMATION) {
  const priorLight = foundry.utils.duplicate(tokenDoc.toObject().light ?? {});
  const animationType = animation === undefined ? DEFAULT_ANIMATION : animation;
  await tokenDoc.update({
    light: {
      ...priorLight,
      bright,
      dim,
      color: priorLight.color || "#ff9329",
      alpha: priorLight.alpha ?? 0.5,
      animation: {
        type: animationType,
        speed: priorLight.animation?.speed ?? 5,
        intensity: priorLight.animation?.intensity ?? 5,
        reverse: priorLight.animation?.reverse ?? false
      }
    },
    [`flags.${MODULE_ID}.${FLAG_KEY}`]: {
      active: true,
      priorLight
    }
  });
}

/**
 * @param {TokenDocument} tokenDoc
 * @returns {Promise<void>}
 */
async function extinguishTorch(tokenDoc) {
  const state = getTorchState(tokenDoc);
  const prior = state.priorLight && typeof state.priorLight === "object"
    ? foundry.utils.duplicate(state.priorLight)
    : { bright: 0, dim: 0, animation: { type: null } };

  await tokenDoc.update({
    light: prior,
    [`flags.${MODULE_ID}.${FLAG_KEY}`]: {
      active: false,
      priorLight: null
    }
  });
}
