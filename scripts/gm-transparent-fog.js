/**
 * Make fog-of-war / out-of-vision blackness semi-transparent for the GM only,
 * and keep all tokens visible/selectable for the GM even with a token selected.
 * Players are unaffected.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const SETTING_KEY = "gmTransparentFog";
/** Fog overlay opacity for the GM when the feature is on (0 = clear, 1 = solid black). */
const GM_FOG_ALPHA = 0.7;
const FILTER_FLAG = "__dmToolkitFogAlpha";

export function registerGmTransparentFog() {
  Hooks.once("setup", wrapTokenIsVisible);
  Hooks.on("drawCanvasVisibility", applyGmFogTransparency);
  Hooks.on("canvasReady", () => {
    applyGmFogTransparency();
    refreshTokenVisibility();
  });
}

export function registerGmTransparentFogSettings() {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "DM-TOOLKIT-DND5E.Settings.GmTransparentFog.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.GmTransparentFog.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      applyGmFogTransparency();
      refreshTokenVisibility();
    }
  });
}

/**
 * @returns {boolean}
 */
function isFeatureEnabled() {
  return Boolean(game.settings.get(MODULE_ID, SETTING_KEY));
}

/**
 * @returns {boolean}
 */
function shouldRevealMapToGm() {
  return Boolean(game.user?.isGM && isFeatureEnabled());
}

/**
 * Add or remove the GM-only alpha filter on the visibility (fog) layer.
 */
function applyGmFogTransparency() {
  const layer = canvas?.visibility;
  if (!layer) return;

  layer.filters = (layer.filters ?? []).filter(filter => !filter[FILTER_FLAG]);

  if (!shouldRevealMapToGm()) return;

  const filter = new PIXI.AlphaFilter(GM_FOG_ALPHA);
  filter[FILTER_FLAG] = true;
  layer.filters.push(filter);
}

/**
 * Let the GM see and select every token even when viewing through a selected actor.
 */
function wrapTokenIsVisible() {
  const proto = CONFIG.Token?.objectClass?.prototype;
  if (!proto) return;

  const descriptor = Object.getOwnPropertyDescriptor(proto, "isVisible")
    ?? findIsVisibleDescriptor(proto);
  if (!descriptor?.get || descriptor.get.__dmToolkitFog) return;

  const originalGet = descriptor.get;
  function getIsVisible() {
    if (originalGet.call(this)) return true;
    return shouldRevealMapToGm();
  }
  getIsVisible.__dmToolkitFog = true;

  Object.defineProperty(proto, "isVisible", {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get: getIsVisible
  });
}

/**
 * @param {object} proto
 * @returns {PropertyDescriptor|undefined}
 */
function findIsVisibleDescriptor(proto) {
  let current = proto;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "isVisible");
    if (descriptor?.get) return descriptor;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function refreshTokenVisibility() {
  if (!canvas?.ready) return;
  canvas.perception?.update?.({ refreshVision: true, refreshOcclusion: true });
}
