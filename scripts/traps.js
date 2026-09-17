/**
 * Traps: DM scene-control tools to paint trap pads, GM-only borders,
 * and trigger effects when a token moves onto or over a trap square.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const ENABLED_SETTING = "trapsEnabled";
const TRAPS_SETTING = "traps";
const BORDER_COLOR_SETTING = "trapsBorderColor";
const BORDER_WIDTH_SETTING = "trapsBorderWidth";
const OVERLAY_NAME = "dmToolkitTrapsOverlay";
const PREVIEW_NAME = "dmToolkitTrapsPreview";
const DEFAULT_BORDER_COLOR = "#e63946";
const DEFAULT_BORDER_WIDTH = 4;
const PREVIEW_COLOR = 0xf4a261;
const TRAP_SOCKET = `module.${MODULE_ID}`;
const TRIGGER_COOLDOWN_MS = 1500;

/** @type {"idle"|"create"} */
let paintMode = "idle";
/** @type {Set<string>} */
let paintCells = new Set();
let paintPointerDown = false;
/** @type {WeakMap<TokenDocument, {trapId: string, until: number}>} */
const recentTriggers = new WeakMap();

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerTraps() {
  Hooks.once("ready", () => {
    registerTrapSocket();
    installTrapDblClickHook();
    if (game.user?.isGM) void syncTrapAppearanceToWorldData();
    // Ensure the control appears if the setting was already enabled.
    refreshSceneControls();
  });
  Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("canvasTearDown", onCanvasTearDown);
  // Foundry V13+ token ruler movement — do not rewrite x/y in preUpdateToken.
  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("moveToken", onMoveToken);
  // Legacy simple x/y updates (no movement operation).
  Hooks.on("preUpdateToken", onPreUpdateToken);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("renderSceneControls", () => {
    if (ui.controls?.control?.name !== "traps") stopPaintMode();
  });
  Hooks.on("updateSetting", setting => {
    const key = setting?.key;
    if (!key) return;
    if (key === `${MODULE_ID}.${ENABLED_SETTING}`) {
      refreshSceneControls();
      refreshTrapOverlay();
      if (!isTrapsEnabled()) stopPaintMode();
      return;
    }
    if (key === `${MODULE_ID}.${BORDER_COLOR_SETTING}`
      || key === `${MODULE_ID}.${BORDER_WIDTH_SETTING}`
      || key === `${MODULE_ID}.${TRAPS_SETTING}`) {
      refreshTrapOverlay();
    }
  });
}

export function registerTrapsSettings() {
  game.settings.register(MODULE_ID, ENABLED_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.Traps.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.Traps.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      refreshSceneControls();
      refreshTrapOverlay();
      if (!isTrapsEnabled()) stopPaintMode();
    }
  });

  game.settings.register(MODULE_ID, BORDER_COLOR_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.TrapsBorderColor.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.TrapsBorderColor.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.ColorField({
      required: true,
      nullable: false,
      initial: DEFAULT_BORDER_COLOR
    }),
    default: DEFAULT_BORDER_COLOR,
    onChange: () => {
      void syncTrapAppearanceToWorldData();
    }
  });

  game.settings.register(MODULE_ID, BORDER_WIDTH_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.TrapsBorderWidth.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.TrapsBorderWidth.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 1, max: 20, step: 1 },
    default: DEFAULT_BORDER_WIDTH,
    onChange: () => {
      void syncTrapAppearanceToWorldData();
    }
  });

  game.settings.register(MODULE_ID, TRAPS_SETTING, {
    name: "DM-TOOLKIT-DND5E.Traps.DataSetting",
    scope: "world",
    config: false,
    type: Object,
    default: {
      entries: [],
      borderColor: DEFAULT_BORDER_COLOR,
      borderWidth: DEFAULT_BORDER_WIDTH
    },
    onChange: () => refreshTrapOverlay()
  });
}

/**
 * @returns {boolean}
 */
function isPrimaryGM() {
  if (!game.user?.isGM) return false;
  const active = game.users.activeGM;
  if (active) return active.id === game.user.id;
  const gms = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id));
  return gms[0]?.id === game.user.id;
}

function registerTrapSocket() {
  game.socket.on(TRAP_SOCKET, async data => {
    if (data?.type !== "trapTriggered") return;
    if (!isPrimaryGM()) return;
    if (!isTrapsEnabled()) return;
    try {
      const tokenDoc = data.tokenUuid ? await fromUuid(data.tokenUuid) : null;
      await resolveTrapTrigger(data.trapId, tokenDoc);
    } catch (err) {
      console.error(`${MODULE_ID} | Trap trigger request failed`, err);
    }
  });
}

/**
 * @returns {{entries: object[], borderColor: string, borderWidth: number, hasAppearance: boolean}}
 */
function getTrapsSettingData() {
  try {
    const raw = game.settings.get(MODULE_ID, TRAPS_SETTING);
    if (Array.isArray(raw)) {
      return {
        entries: foundry.utils.duplicate(raw),
        borderColor: DEFAULT_BORDER_COLOR,
        borderWidth: DEFAULT_BORDER_WIDTH,
        hasAppearance: false
      };
    }
    const hasAppearance = raw != null
      && (raw.borderColor != null || raw.borderWidth != null);
    return {
      entries: Array.isArray(raw?.entries) ? foundry.utils.duplicate(raw.entries) : [],
      borderColor: normalizeColorCss(raw?.borderColor) || DEFAULT_BORDER_COLOR,
      borderWidth: clampBorderWidth(raw?.borderWidth),
      hasAppearance
    };
  } catch (_err) {
    return {
      entries: [],
      borderColor: DEFAULT_BORDER_COLOR,
      borderWidth: DEFAULT_BORDER_WIDTH,
      hasAppearance: false
    };
  }
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeColorCss(raw) {
  if (raw == null || raw === "") return "";
  try {
    if (typeof Color !== "undefined") {
      const css = Color.from(raw).css;
      if (css) return css;
    }
  } catch (_err) { /* fall through */ }
  const str = String(raw).trim();
  return /^#[0-9a-fA-F]{6}$/.test(str) ? str : "";
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function clampBorderWidth(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_BORDER_WIDTH;
  return Math.min(20, Math.max(1, Math.round(n)));
}

/**
 * @param {string} css
 * @returns {number}
 */
function colorCssToNumber(css) {
  try {
    if (typeof Color !== "undefined") return Color.from(css).valueOf();
  } catch (_err) { /* fall through */ }
  const hex = String(css ?? "").replace("#", "");
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : 0xe63946;
}

async function syncTrapAppearanceToWorldData() {
  refreshTrapOverlay();
  if (!game.user?.isGM) return;
  const data = getTrapsSettingData();
  let color;
  let width;
  try {
    color = normalizeColorCss(game.settings.get(MODULE_ID, BORDER_COLOR_SETTING)) || DEFAULT_BORDER_COLOR;
    width = clampBorderWidth(game.settings.get(MODULE_ID, BORDER_WIDTH_SETTING));
  } catch (_err) {
    return;
  }
  if (data.borderColor === color && data.borderWidth === width && data.hasAppearance) return;
  await game.settings.set(MODULE_ID, TRAPS_SETTING, {
    entries: data.entries,
    borderColor: color,
    borderWidth: width
  });
}

function getTrapBorderColor() {
  try {
    const data = getTrapsSettingData();
    if (data.hasAppearance) return colorCssToNumber(data.borderColor);
    return colorCssToNumber(
      normalizeColorCss(game.settings.get(MODULE_ID, BORDER_COLOR_SETTING)) || DEFAULT_BORDER_COLOR
    );
  } catch (_err) {
    return colorCssToNumber(DEFAULT_BORDER_COLOR);
  }
}

function getTrapBorderWidth() {
  try {
    const data = getTrapsSettingData();
    if (data.hasAppearance) return data.borderWidth;
    return clampBorderWidth(game.settings.get(MODULE_ID, BORDER_WIDTH_SETTING));
  } catch (_err) {
    return DEFAULT_BORDER_WIDTH;
  }
}

/**
 * Rebuild scene controls so the Traps control appears/disappears with the setting.
 */
function refreshSceneControls() {
  const controls = ui.controls;
  if (!controls?.render) return;
  controls.render({ reset: true });
}

/** @returns {boolean} */
export function isTrapsEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, ENABLED_SETTING));
  } catch (_err) {
    return false;
  }
}

/** @returns {object[]} */
export function getTraps() {
  return getTrapsSettingData().entries;
}

/**
 * @param {object[]} traps
 */
async function setTraps(traps) {
  const data = getTrapsSettingData();
  let borderColor = data.borderColor;
  let borderWidth = data.borderWidth;
  try {
    borderColor = normalizeColorCss(game.settings.get(MODULE_ID, BORDER_COLOR_SETTING)) || borderColor;
    borderWidth = clampBorderWidth(game.settings.get(MODULE_ID, BORDER_WIDTH_SETTING));
  } catch (_err) { /* keep */ }
  await game.settings.set(MODULE_ID, TRAPS_SETTING, {
    entries: traps,
    borderColor,
    borderWidth
  });
}

/**
 * @param {string} id
 * @returns {object|null}
 */
function findTrap(id) {
  return getTraps().find(t => t.id === id) ?? null;
}

/**
 * @param {string} name
 * @param {string|null} [exceptId]
 * @returns {boolean}
 */
function isTrapNameUnique(name, exceptId = null) {
  const needle = name.trim().toLowerCase();
  return !getTraps().some(t => t.id !== exceptId && String(t.name ?? "").trim().toLowerCase() === needle);
}

/**
 * @param {{i:number,j:number}[]} cells
 * @returns {{i:number,j:number}[]}
 */
function normalizeCells(cells) {
  if (!cells.length) return [];
  return [...cells].sort((a, b) => (a.j - b.j) || (a.i - b.i));
}

/**
 * @param {number} i
 * @param {number} j
 * @returns {string}
 */
function cellKey(i, j) {
  return `${i},${j}`;
}

/**
 * @param {string} key
 * @returns {{i:number,j:number}}
 */
function parseCellKey(key) {
  const [i, j] = key.split(",").map(Number);
  return { i, j };
}

/** @returns {boolean} */
function sceneHasSquareGrid() {
  if (!canvas?.grid) return false;
  const square = CONST.GRID_TYPES?.SQUARE ?? 1;
  return canvas.grid.type === square;
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

/* -------------------------------------------- */
/*  Scene controls                              */
/* -------------------------------------------- */

let suppressTrapToolStart = false;
let resettingTrapsToIdle = false;

/**
 * @param {Record<string, object>} controls
 */
function onGetSceneControlButtons(controls) {
  if (!isTrapsEnabled() || !game.user.isGM) return;

  const notesOrder = Number(controls.notes?.order) || 7;
  const portalsOrder = Number(controls.portals?.order);
  const order = Number.isFinite(portalsOrder) ? portalsOrder + 1 : notesOrder + 2;

  controls.traps = {
    name: "traps",
    title: "DM-TOOLKIT-DND5E.Traps.Control",
    icon: "fa-solid fa-triangle-exclamation",
    layer: "tokens",
    visible: true,
    order,
    activeTool: "trapIdle",
    onChange: (_event, active) => {
      if (!active) {
        stopPaintMode();
        return;
      }
      if (resettingTrapsToIdle) return;
      // Always enter Traps on Select — do not resume a prior Create tool.
      void resetTrapsControlToIdle();
    },
    onToolChange: (_event, tool) => {
      if (suppressTrapToolStart) return;
      const name = typeof tool === "string" ? tool : tool?.name;
      // Create is a button; only persistent tools need handling here.
      if (name && name !== "trapCreate") stopPaintMode();
    },
    tools: {
      trapIdle: {
        name: "trapIdle",
        title: "DM-TOOLKIT-DND5E.Traps.IdleTool",
        icon: "fa-solid fa-arrow-pointer",
        order: 0,
        visible: true,
        onChange: (_event, active) => {
          if (active) stopPaintMode();
        }
      },
      trapCreate: {
        name: "trapCreate",
        title: "DM-TOOLKIT-DND5E.Traps.CreateTool",
        icon: "fa-solid fa-plus",
        order: 1,
        button: true,
        visible: true,
        onChange: () => {
          if (suppressTrapToolStart) return;
          startCreateMode();
        }
      },
      trapManage: {
        name: "trapManage",
        title: "DM-TOOLKIT-DND5E.Traps.ManageTool",
        icon: "fa-solid fa-list",
        order: 2,
        button: true,
        visible: true,
        onChange: () => {
          stopPaintMode();
          TrapManageApp.open();
        }
      }
    }
  };
}

async function resetTrapsControlToIdle() {
  stopPaintMode();
  const currentTool = ui.controls?.tool?.name ?? ui.controls?.tool;
  if (currentTool === "trapIdle") return;

  resettingTrapsToIdle = true;
  suppressTrapToolStart = true;
  try {
    const controls = ui.controls;
    if (!controls) return;
    if (typeof controls.activate === "function") {
      await controls.activate({ control: "traps", tool: "trapIdle" });
    } else {
      await controls.render({ control: "traps", tool: "trapIdle" });
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to reset traps tool to idle`, err);
  } finally {
    setTimeout(() => {
      suppressTrapToolStart = false;
      resettingTrapsToIdle = false;
    }, 0);
  }
}

/* -------------------------------------------- */
/*  Paint modes                                 */
/* -------------------------------------------- */

function abortPaintMode() {
  paintMode = "idle";
  paintCells.clear();
  paintPointerDown = false;
  unbindPaintListeners();
  clearPreview();
}

function stopPaintMode() {
  abortPaintMode();
  closeTrapFormApps();
}

function startCreateMode() {
  if (!isTrapsEnabled() || !game.user.isGM) return;
  if (!sceneHasSquareGrid()) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.NeedSquareGrid"));
    return;
  }
  paintMode = "create";
  paintCells.clear();
  bindPaintListeners();
  redrawPreview();
  TrapCreateApp.open();
}

function bindPaintListeners() {
  unbindPaintListeners();
  if (!canvas?.stage) return;
  canvas.stage.on("pointerdown", onPaintPointerDown);
  canvas.stage.on("pointermove", onPaintPointerMove);
  canvas.stage.on("pointerup", onPaintPointerUp);
  canvas.stage.on("pointerupoutside", onPaintPointerUp);
  if (canvas.tokens) canvas.tokens.interactiveChildren = false;
}

function unbindPaintListeners() {
  if (!canvas?.stage) return;
  canvas.stage.off("pointerdown", onPaintPointerDown);
  canvas.stage.off("pointermove", onPaintPointerMove);
  canvas.stage.off("pointerup", onPaintPointerUp);
  canvas.stage.off("pointerupoutside", onPaintPointerUp);
  if (canvas.tokens) canvas.tokens.interactiveChildren = true;
}

/**
 * @param {PIXI.FederatedPointerEvent} event
 */
function onPaintPointerDown(event) {
  if (paintMode === "idle") return;
  if (event.button !== 0) return;
  if (!canvas?.ready) return;
  event.stopPropagation?.();
  paintPointerDown = true;
  applyPaintAtEvent(event, true);
}

/**
 * @param {PIXI.FederatedPointerEvent} event
 */
function onPaintPointerMove(event) {
  if (!paintPointerDown || paintMode !== "create") return;
  applyPaintAtEvent(event, false);
}

function onPaintPointerUp() {
  paintPointerDown = false;
}

/**
 * @param {string} [sceneId]
 * @returns {Set<string>}
 */
function getOccupiedTrapCellKeys(sceneId = canvas?.scene?.id) {
  const occupied = new Set();
  if (!sceneId) return occupied;
  for (const trap of getTraps()) {
    if (trap.sceneId !== sceneId) continue;
    for (const cell of trap.cells ?? []) {
      occupied.add(cellKey(cell.i, cell.j));
    }
  }
  return occupied;
}

/**
 * @param {number} i
 * @param {number} j
 * @param {string} [sceneId]
 * @returns {boolean}
 */
function isCellOccupiedByTrap(i, j, sceneId = canvas?.scene?.id) {
  return getOccupiedTrapCellKeys(sceneId).has(cellKey(i, j));
}

/**
 * @param {{i:number,j:number}[]} cells
 * @param {string} [sceneId]
 * @returns {boolean}
 */
function cellsOverlapExistingTrap(cells, sceneId = canvas?.scene?.id) {
  const occupied = getOccupiedTrapCellKeys(sceneId);
  return cells.some(c => occupied.has(cellKey(c.i, c.j)));
}

let occupiedCellWarnAt = 0;
function warnOccupiedTrapCell() {
  const now = Date.now();
  if (now - occupiedCellWarnAt < 800) return;
  occupiedCellWarnAt = now;
  ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrCellOccupied"));
}

/**
 * @param {PIXI.FederatedPointerEvent} event
 * @param {boolean} toggle
 */
function applyPaintAtEvent(event, toggle) {
  const pos = event.getLocalPosition?.(canvas.stage) ?? canvas.mousePosition;
  if (!pos) return;
  let offset;
  try {
    offset = canvas.grid.getOffset({ x: pos.x, y: pos.y });
  } catch (_err) {
    return;
  }
  if (offset?.i == null || offset?.j == null) return;

  const key = cellKey(offset.i, offset.j);

  // Never select (or keep) a square that already belongs to a trap.
  if (isCellOccupiedByTrap(offset.i, offset.j)) {
    if (paintCells.delete(key)) redrawPreview();
    warnOccupiedTrapCell();
    return;
  }

  if (toggle) {
    if (paintCells.has(key)) paintCells.delete(key);
    else paintCells.add(key);
  } else if (!paintCells.has(key)) {
    paintCells.add(key);
  }
  redrawPreview();
}

/**
 * @returns {{i:number,j:number}[]}
 */
function getPaintedCells() {
  const occupied = getOccupiedTrapCellKeys();
  return [...paintCells]
    .filter(key => !occupied.has(key))
    .map(parseCellKey);
}

/* -------------------------------------------- */
/*  Overlay / preview                           */
/* -------------------------------------------- */

function onCanvasReady() {
  stopPaintMode();
  refreshTrapOverlay();
  foundry.applications.instances.get("dm-toolkit-trap-manage")?.render?.({ force: true });
}

function onCanvasTearDown() {
  stopPaintMode();
}

/**
 * Foundry routes canvas double-clicks through layer `_onClickLeft2`,
 * not native DOM dblclick (which PIXI often never emits).
 */
function installTrapDblClickHook() {
  const layers = new Set([
    foundry.canvas?.layers?.InteractionLayer,
    foundry.canvas?.layers?.PlaceablesLayer,
    foundry.canvas?.layers?.TokenLayer
  ]);
  for (const cfg of Object.values(CONFIG.Canvas?.layers ?? {})) {
    if (cfg?.layerClass) layers.add(cfg.layerClass);
  }
  for (const LayerClass of layers) wrapTrapLayerClickLeft2(LayerClass);
}

/**
 * @param {typeof foundry.canvas.layers.InteractionLayer} LayerClass
 */
function wrapTrapLayerClickLeft2(LayerClass) {
  if (!LayerClass?.prototype) return;
  // Only wrap methods defined on this class to avoid double-wrapping inheritance.
  if (!Object.prototype.hasOwnProperty.call(LayerClass.prototype, "_onClickLeft2")) return;
  if (LayerClass.prototype._dmToolkitTrapClickLeft2) return;

  const original = LayerClass.prototype._onClickLeft2;
  if (typeof original !== "function") return;

  LayerClass.prototype._dmToolkitTrapClickLeft2 = true;
  LayerClass.prototype._onClickLeft2 = function(event) {
    if (tryOpenTrapFromCanvasDoubleClick(event)) return;
    return original.call(this, event);
  };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {string} [sceneId]
 * @returns {object|null}
 */
function findTrapAtCanvasPoint(x, y, sceneId = canvas?.scene?.id) {
  if (!sceneId || !canvas?.grid?.getOffset) return null;
  let offset;
  try {
    offset = canvas.grid.getOffset({ x, y });
  } catch (_err) {
    return null;
  }
  if (offset?.i == null || offset?.j == null) return null;
  const key = cellKey(offset.i, offset.j);
  for (const trap of getTraps()) {
    if (trap.sceneId !== sceneId) continue;
    if ((trap.cells ?? []).some(c => cellKey(c.i, c.j) === key)) return trap;
  }
  return null;
}

/**
 * @param {PIXI.FederatedEvent} [event]
 * @returns {boolean} True if the double-click was handled.
 */
function tryOpenTrapFromCanvasDoubleClick(event) {
  if (!isTrapsEnabled() || !game.user.isGM) return false;
  if (!canvas?.ready) return false;
  if (paintMode !== "idle") return false;

  let x;
  let y;
  const dest = event?.interactionData?.destination;
  if (dest && Number.isFinite(dest.x) && Number.isFinite(dest.y)) {
    x = dest.x;
    y = dest.y;
  } else if (canvas.mousePosition) {
    x = canvas.mousePosition.x;
    y = canvas.mousePosition.y;
  } else {
    return false;
  }

  const trap = findTrapAtCanvasPoint(x, y);
  if (!trap) return false;

  event?.stopPropagation?.();
  TrapManageApp.open(trap.id);
  return true;
}

/**
 * @returns {PIXI.Container|null}
 */
function getTrapDrawParent() {
  return canvas?.primary ?? null;
}

function destroyNonPrimaryTrapOverlays() {
  for (const parent of [canvas?.interface, canvas?.controls]) {
    if (!parent?.children) continue;
    for (const name of [OVERLAY_NAME, PREVIEW_NAME]) {
      const child = parent.children.find(c => c.name === name);
      if (child) child.destroy({ children: true });
    }
  }
}

function getOrCreateOverlay() {
  const parent = getTrapDrawParent();
  if (!parent) return null;
  destroyNonPrimaryTrapOverlays();
  let overlay = parent.children.find(c => c.name === OVERLAY_NAME);
  if (!overlay) {
    overlay = new PIXI.Container();
    overlay.name = OVERLAY_NAME;
    overlay.eventMode = "none";
    overlay.interactiveChildren = false;
    parent.addChild(overlay);
  } else if (overlay instanceof PIXI.Graphics) {
    const idx = parent.getChildIndex(overlay);
    overlay.destroy({ children: true });
    overlay = new PIXI.Container();
    overlay.name = OVERLAY_NAME;
    overlay.eventMode = "none";
    overlay.interactiveChildren = false;
    parent.addChildAt(overlay, idx);
  } else {
    overlay.eventMode = "none";
    overlay.interactiveChildren = false;
  }
  return overlay;
}

function getOrCreatePreview() {
  const parent = getTrapDrawParent();
  if (!parent) return null;
  let g = parent.children.find(c => c.name === PREVIEW_NAME);
  if (!g) {
    g = new PIXI.Graphics();
    g.name = PREVIEW_NAME;
    g.eventMode = "none";
    g.interactiveChildren = false;
    parent.addChild(g);
  }
  return g;
}

function clearPreview() {
  const g = getTrapDrawParent()?.children?.find(c => c.name === PREVIEW_NAME);
  g?.clear?.();
}

function redrawPreview() {
  const g = getOrCreatePreview();
  if (!g) return;
  g.clear();
  for (const cell of getPaintedCells()) {
    drawCellBorder(g, cell.i, cell.j, PREVIEW_COLOR, 0.85);
  }
}

/**
 * @param {PIXI.Graphics} g
 * @param {number} i
 * @param {number} j
 * @param {number} color
 * @param {number} alpha
 * @param {number} [width]
 */
function drawCellBorder(g, i, j, color, alpha = 1, width = getTrapBorderWidth()) {
  let tl;
  try {
    tl = canvas.grid.getTopLeftPoint({ i, j });
  } catch (_err) {
    return;
  }
  const size = canvas.grid.sizeX ?? canvas.grid.size ?? 100;
  const sizeY = canvas.grid.sizeY ?? size;
  const w = Math.max(1, width);
  g.lineStyle({ width: w, color, alpha });
  g.drawRect(tl.x + w / 2, tl.y + w / 2, size - w, sizeY - w);
}

/**
 * @param {PIXI.Container} parent
 * @param {number} i
 * @param {number} j
 * @param {string} name
 * @param {number} color
 * @param {number} alpha
 */
function drawCellLabel(parent, i, j, name, color, alpha = 1) {
  let tl;
  try {
    tl = canvas.grid.getTopLeftPoint({ i, j });
  } catch (_err) {
    return;
  }
  const size = canvas.grid.sizeX ?? canvas.grid.size ?? 100;
  const sizeY = canvas.grid.sizeY ?? size;
  const fontSize = Math.max(9, Math.min(13, Math.floor(Math.min(size, sizeY) * 0.16)));
  const style = {
    fontFamily: CONFIG?.defaultFontFamily || "Signika, sans-serif",
    fontSize,
    fill: color,
    align: "center",
    wordWrap: true,
    wordWrapWidth: Math.max(12, size - 10),
    stroke: 0x000000,
    strokeThickness: 3,
    lineJoin: "round"
  };
  const PreciseText = foundry.canvas?.containers?.PreciseText;
  const label = PreciseText
    ? new PreciseText(String(name ?? ""), style)
    : new PIXI.Text({ text: String(name ?? ""), style });
  label.anchor.set(0.5, 0.5);
  label.position.set(tl.x + size / 2, tl.y + sizeY / 2);
  label.alpha = alpha;
  label.eventMode = "none";
  parent.addChild(label);
}

export function refreshTrapOverlay() {
  const overlay = getOrCreateOverlay();
  if (!overlay) return;
  overlay.removeChildren().forEach(child => child.destroy({ children: true }));
  // Borders are GM-only and only when the feature is enabled.
  if (!isTrapsEnabled() || !game.user?.isGM || !canvas?.scene) return;

  const sceneId = canvas.scene.id;
  const borderColor = getTrapBorderColor();
  const borderWidth = getTrapBorderWidth();
  const g = new PIXI.Graphics();
  g.eventMode = "none";
  overlay.addChild(g);
  for (const trap of getTraps()) {
    if (trap.sceneId !== sceneId) continue;
    const alpha = trap.enabled === false ? 0.45 : 0.95;
    for (const cell of trap.cells ?? []) {
      drawCellBorder(g, cell.i, cell.j, borderColor, alpha, borderWidth);
      drawCellLabel(overlay, cell.i, cell.j, trap.name, borderColor, alpha);
    }
  }
}

/* -------------------------------------------- */
/*  CRUD                                        */
/* -------------------------------------------- */

/**
 * @param {object} data
 */
async function createTrap(data) {
  const traps = getTraps();
  traps.push(data);
  await setTraps(traps);
}

/**
 * @param {string} id
 * @param {object} patch
 */
async function updateTrap(id, patch) {
  const traps = getTraps();
  const idx = traps.findIndex(t => t.id === id);
  if (idx < 0) return;
  traps[idx] = { ...traps[idx], ...patch };
  await setTraps(traps);
}

/**
 * @param {string} id
 */
async function deleteTrap(id) {
  await setTraps(getTraps().filter(t => t.id !== id));
}

/**
 * @param {object} form
 * @returns {Promise<boolean>}
 */
async function submitCreateTrap(form) {
  const name = String(form.name ?? "").trim();
  const cells = getPaintedCells();
  if (!name) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrNameRequired"));
    return false;
  }
  if (!isTrapNameUnique(name)) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrNameUnique"));
    return false;
  }
  if (!cells.length) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrCellsRequired"));
    return false;
  }
  if (cellsOverlapExistingTrap(cells)) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrCellOccupied"));
    return false;
  }

  await createTrap({
    id: foundry.utils.randomID(),
    name,
    sceneId: canvas.scene.id,
    cells: normalizeCells(cells),
    pauseGame: Boolean(form.pauseGame),
    disableAfterTrigger: Boolean(form.disableAfterTrigger),
    enabled: true,
    tileUuid: form.tileUuid || null,
    macroUuid: form.macroUuid || null
  });

  ui.notifications.info(game.i18n.format("DM-TOOLKIT-DND5E.Traps.Created", { name }));
  stopPaintMode();
  refreshTrapOverlay();
  return true;
}

/* -------------------------------------------- */
/*  Apps                                        */
/* -------------------------------------------- */

function closeTrapFormApps() {
  foundry.applications.instances.get("dm-toolkit-trap-create")?.close?.();
}

/**
 * @param {string|null} [sceneId]
 * @returns {{value: string, label: string}[]}
 */
function getSceneTileOptions(sceneId = canvas?.scene?.id) {
  const scene = (sceneId ? game.scenes.get(sceneId) : null) ?? canvas?.scene;
  const tiles = scene?.tiles ?? [];
  return [...tiles]
    .map(tile => {
      const label = tile.name?.trim()
        || (tile.texture?.src ? String(tile.texture.src).split("/").pop() : null)
        || tile.id;
      return { value: tile.uuid, label: String(label) };
    })
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang || undefined));
}

/**
 * @returns {{value: string, label: string}[]}
 */
function getMacroOptions() {
  return [...(game.macros ?? [])]
    .filter(m => m?.canExecute !== false)
    .map(m => ({ value: m.uuid, label: m.name || m.id }))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang || undefined));
}

/**
 * @param {{value: string, label: string}[]} options
 * @param {string|null} [selected]
 * @returns {string}
 */
function optionsHTML(options, selected = null) {
  const none = `<option value="">${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.None")}</option>`;
  const rest = options.map(o => `
    <option value="${escapeHTML(o.value)}"${o.value === selected ? " selected" : ""}>
      ${escapeHTML(o.label)}
    </option>`).join("");
  return none + rest;
}

class TrapCreateApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-trap-create",
    classes: ["dm-toolkit-trap-form"],
    tag: "form",
    window: {
      title: "DM-TOOLKIT-DND5E.Traps.CreateTitle",
      contentClasses: ["standard-form"]
    },
    position: { width: 380 },
    form: {
      handler: TrapCreateApp.#onSubmit,
      closeOnSubmit: false,
      submitOnChange: false
    }
  };

  static open() {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      existing.render({ force: true });
      return existing;
    }
    const app = new this();
    app.render({ force: true });
    return app;
  }

  /** @inheritDoc */
  async _renderHTML() {
    const root = document.createElement("div");
    root.classList.add("dm-toolkit-trap-form-body");
    root.innerHTML = `
      <div class="form-group">
        <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Name")}</label>
        <input type="text" name="name" required />
      </div>
      <div class="form-group">
        <label class="checkbox">
          <input type="checkbox" name="pauseGame" />
          ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.PauseGame")}
        </label>
      </div>
      <div class="form-group">
        <label class="checkbox">
          <input type="checkbox" name="disableAfterTrigger" />
          ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.DisableAfterTrigger")}
        </label>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Tile")}</label>
        <select name="tileUuid">${optionsHTML(getSceneTileOptions())}</select>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Macro")}</label>
        <select name="macroUuid">${optionsHTML(getMacroOptions())}</select>
      </div>
      <p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.CreateHint")}</p>
      <footer class="form-footer">
        <button type="submit" class="dense">
          <i class="fa-solid fa-check"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Create")}
        </button>
      </footer>`;
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /**
   * @param {SubmitEvent} _event
   * @param {HTMLFormElement} form
   */
  static async #onSubmit(_event, form) {
    await submitCreateTrap({
      name: form.elements.name?.value ?? "",
      pauseGame: Boolean(form.elements.pauseGame?.checked),
      disableAfterTrigger: Boolean(form.elements.disableAfterTrigger?.checked),
      tileUuid: form.elements.tileUuid?.value || null,
      macroUuid: form.elements.macroUuid?.value || null
    });
  }

  /** @inheritDoc */
  async _onClose(options) {
    await super._onClose(options);
    abortPaintMode();
  }
}

class TrapManageApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-trap-manage",
    classes: ["dm-toolkit-trap-manage"],
    tag: "form",
    window: {
      title: "DM-TOOLKIT-DND5E.Traps.ManageTitle",
      contentClasses: ["standard-form"],
      resizable: true
    },
    position: { width: 520, height: 480 },
    form: {
      handler: TrapManageApp.#onSubmit,
      closeOnSubmit: false
    },
    actions: {
      selectTrap: TrapManageApp.#onSelect,
      deleteTrap: TrapManageApp.#onDelete
    }
  };

  /** @type {string|null} */
  #selectedId = null;

  /**
   * @param {string|null} trapId
   */
  setSelectedTrap(trapId) {
    this.#selectedId = trapId || null;
  }

  /**
   * @param {string|null} [trapId]
   */
  static open(trapId = null) {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      if (trapId) existing.setSelectedTrap(trapId);
      existing.render({ force: true });
      existing.bringToFront?.();
      return existing;
    }
    const app = new this();
    if (trapId) app.setSelectedTrap(trapId);
    app.render({ force: true });
    return app;
  }

  /** @inheritDoc */
  async _prepareContext() {
    const sceneId = canvas?.scene?.id ?? null;
    const traps = getTraps().filter(t => sceneId && t.sceneId === sceneId);
    const mapped = traps.map(t => ({
      ...t,
      sceneName: game.scenes.get(t.sceneId)?.name ?? "?",
      selected: false
    }));
    const collator = new Intl.Collator(game.i18n.lang || undefined, { sensitivity: "base", numeric: true });
    mapped.sort((a, b) => collator.compare(String(a.name ?? ""), String(b.name ?? "")));
    // Drop selection if it belongs to another scene.
    if (this.#selectedId && !mapped.some(t => t.id === this.#selectedId)) {
      this.#selectedId = null;
    }
    const selected = mapped.find(t => t.id === this.#selectedId) ?? mapped[0] ?? null;
    this.#selectedId = selected?.id ?? null;
    for (const t of mapped) t.selected = t.id === this.#selectedId;
    return {
      traps: mapped,
      selected: selected ? traps.find(t => t.id === selected.id) ?? selected : null
    };
  }

  /** @inheritDoc */
  async _renderHTML(context) {
    const root = document.createElement("div");
    root.classList.add("dm-toolkit-trap-manage-body");
    const list = context.traps.map(t => `
      <li class="${t.selected ? "selected" : ""}">
        <button type="button" data-action="selectTrap" data-trap-id="${t.id}" data-tooltip="${escapeHTML(t.name)}">
          <strong class="dm-toolkit-trap-list-name">${escapeHTML(t.name)}</strong>
          <span>${escapeHTML(t.sceneName)}${t.enabled === false ? ` — ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Disabled")}` : ""}</span>
        </button>
      </li>`).join("");

    const s = context.selected;
    const editor = s ? `
      <div class="dm-toolkit-trap-editor">
        <input type="hidden" name="trapId" value="${s.id}" />
        <div class="form-group">
          <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Name")}</label>
          <input type="text" name="name" value="${escapeHTML(s.name)}" required />
        </div>
        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="enabled" ${s.enabled !== false ? "checked" : ""} />
            ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Enabled")}
          </label>
        </div>
        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="pauseGame" ${s.pauseGame ? "checked" : ""} />
            ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.PauseGame")}
          </label>
        </div>
        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="disableAfterTrigger" ${s.disableAfterTrigger ? "checked" : ""} />
            ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.DisableAfterTrigger")}
          </label>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Tile")}</label>
          <select name="tileUuid">${optionsHTML(getSceneTileOptions(s.sceneId), s.tileUuid)}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Macro")}</label>
          <select name="macroUuid">${optionsHTML(getMacroOptions(), s.macroUuid)}</select>
        </div>
        <footer class="form-footer">
          <button type="submit" class="dense">
            <i class="fa-solid fa-floppy-disk"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Save")}
          </button>
          <button type="button" class="dense" data-action="deleteTrap" data-trap-id="${s.id}">
            <i class="fa-solid fa-trash"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Delete")}
          </button>
        </footer>
      </div>` : `<p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.NoTraps")}</p>`;

    root.innerHTML = `
      <div class="dm-toolkit-trap-manage-layout">
        <ul class="dm-toolkit-trap-list">${list || `<li class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Traps.NoTraps")}</li>`}</ul>
        ${editor}
      </div>`;
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  static async #onSelect(_event, target) {
    this.#selectedId = target.dataset.trapId;
    this.render({ force: true });
  }

  static async #onDelete(_event, target) {
    const id = target.dataset.trapId;
    const trap = findTrap(id);
    if (!trap) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DM-TOOLKIT-DND5E.Traps.DeleteTitle") },
      content: `<p>${game.i18n.format("DM-TOOLKIT-DND5E.Traps.DeleteConfirm", { name: trap.name })}</p>`
    });
    if (!confirmed) return;
    await deleteTrap(id);
    this.#selectedId = null;
    refreshTrapOverlay();
    this.render({ force: true });
  }

  static async #onSubmit(_event, form) {
    const app = foundry.applications.instances.get("dm-toolkit-trap-manage");
    const id = form.elements.trapId?.value;
    if (!id) return;
    const name = String(form.elements.name?.value ?? "").trim();
    if (!name) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrNameRequired"));
      return;
    }
    if (!isTrapNameUnique(name, id)) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.ErrNameUnique"));
      return;
    }
    await updateTrap(id, {
      name,
      enabled: Boolean(form.elements.enabled?.checked),
      pauseGame: Boolean(form.elements.pauseGame?.checked),
      disableAfterTrigger: Boolean(form.elements.disableAfterTrigger?.checked),
      tileUuid: form.elements.tileUuid?.value || null,
      macroUuid: form.elements.macroUuid?.value || null
    });
    refreshTrapOverlay();
    ui.notifications.info(game.i18n.localize("DM-TOOLKIT-DND5E.Traps.Saved"));
    app?.render({ force: true });
  }
}

/* -------------------------------------------- */
/*  Trigger / movement                          */
/* -------------------------------------------- */

/**
 * @param {Scene|null|undefined} scene
 * @returns {object|null}
 */
function getGridForScene(scene) {
  if (!scene) return null;
  if (canvas?.ready && canvas.scene?.id === scene.id && canvas.grid) return canvas.grid;
  const type = scene.grid?.type ?? CONST.GRID_TYPES?.SQUARE ?? 1;
  const Cls = foundry.grid?.gridClasses?.[type] ?? foundry.grid?.SquareGrid;
  if (!Cls) return null;
  try {
    return new Cls(foundry.utils.deepClone(scene.grid));
  } catch (_err) {
    return null;
  }
}

/**
 * @param {TokenDocument} tokenDoc
 * @param {number} x
 * @param {number} y
 * @returns {{i:number,j:number}[]}
 */
function getTokenOccupiedOffsets(tokenDoc, x, y) {
  const scene = tokenDoc.parent;
  const grid = getGridForScene(scene) ?? canvas?.grid;
  if (!grid?.getOffset) return [];

  const sizeX = grid.sizeX ?? grid.size ?? 100;
  const sizeY = grid.sizeY ?? grid.size ?? sizeX;
  const width = Math.max(1, Number(tokenDoc.width) || 1);
  const height = Math.max(1, Number(tokenDoc.height) || 1);
  const keys = new Set();
  const cells = [];

  // Sample centers of each grid square the token footprint covers.
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const cx = x + ((dx + 0.5) * sizeX);
      const cy = y + ((dy + 0.5) * sizeY);
      let offset;
      try {
        offset = grid.getOffset({ x: cx, y: cy });
      } catch (_err) {
        continue;
      }
      if (offset?.i == null || offset?.j == null) continue;
      const key = cellKey(offset.i, offset.j);
      if (keys.has(key)) continue;
      keys.add(key);
      cells.push({ i: offset.i, j: offset.j });
    }
  }
  return cells;
}

/**
 * Ordered grid cells crossed by a straight move (including start and end footprints).
 * @param {TokenDocument} tokenDoc
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {{i:number,j:number}[]}
 */
function getCellsAlongMovement(tokenDoc, fromX, fromY, toX, toY) {
  const scene = tokenDoc.parent;
  const grid = getGridForScene(scene) ?? canvas?.grid;
  if (!grid) return getTokenOccupiedOffsets(tokenDoc, toX, toY);

  const sizeX = grid.sizeX ?? grid.size ?? 100;
  const sizeY = grid.sizeY ?? grid.size ?? sizeX;
  const dist = Math.hypot(toX - fromX, toY - fromY);
  const step = Math.max(sizeX, sizeY) / 2;
  const samples = Math.max(1, Math.ceil(dist / step));
  const ordered = [];
  const seen = new Set();

  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    const x = fromX + ((toX - fromX) * t);
    const y = fromY + ((toY - fromY) * t);
    for (const cell of getTokenOccupiedOffsets(tokenDoc, x, y)) {
      const key = cellKey(cell.i, cell.j);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(cell);
    }
  }
  return ordered;
}

/**
 * @param {object} trap
 * @returns {boolean}
 */
function isTrapActive(trap) {
  return Boolean(trap) && trap.enabled !== false;
}

/**
 * @param {TokenDocument} tokenDoc
 * @param {number} x
 * @param {number} y
 * @returns {object|null}
 */
function findTrapAtTokenPosition(tokenDoc, x, y) {
  const sceneId = tokenDoc.parent?.id;
  if (!sceneId) return null;
  const occupied = getTokenOccupiedOffsets(tokenDoc, x, y);
  for (const trap of getTraps()) {
    if (trap.sceneId !== sceneId) continue;
    if (!isTrapActive(trap)) continue;
    const hit = (trap.cells ?? []).some(c => occupied.some(o => o.i === c.i && o.j === c.j));
    if (hit) return trap;
  }
  return null;
}

/**
 * First trap entered along a move that was not already occupied at the start.
 * @param {TokenDocument} tokenDoc
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {{trap: object, cell: {i:number,j:number}}|null}
 */
function findTrapAlongMovement(tokenDoc, fromX, fromY, toX, toY) {
  if (!isTrapsEnabled()) return null;
  const sceneId = tokenDoc.parent?.id;
  if (!sceneId) return null;

  const startKeys = new Set(
    getTokenOccupiedOffsets(tokenDoc, fromX, fromY).map(c => cellKey(c.i, c.j))
  );
  const path = getCellsAlongMovement(tokenDoc, fromX, fromY, toX, toY);

  for (const cell of path) {
    const key = cellKey(cell.i, cell.j);
    if (startKeys.has(key)) continue;
    for (const trap of getTraps()) {
      if (trap.sceneId !== sceneId) continue;
      if (!isTrapActive(trap)) continue;
      if ((trap.cells ?? []).some(c => c.i === cell.i && c.j === cell.j)) {
        return { trap, cell };
      }
    }
  }
  return null;
}

/**
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @param {number} [epsilon]
 * @returns {boolean}
 */
function positionsNear(x1, y1, x2, y2, epsilon = 1) {
  return Math.abs(x1 - x2) <= epsilon && Math.abs(y1 - y2) <= epsilon;
}

/**
 * @param {Scene} scene
 * @param {TokenDocument} tokenDoc
 * @param {{i:number,j:number}} cell
 * @returns {{x:number,y:number}}
 */
function getTokenPositionForCell(scene, tokenDoc, cell) {
  if (tokenDoc.parent?.id === scene.id && typeof tokenDoc._gridOffsetToPosition === "function") {
    try {
      const pos = tokenDoc._gridOffsetToPosition({ i: cell.i, j: cell.j });
      if (pos) return { x: pos.x, y: pos.y };
    } catch (_err) { /* fall through */ }
  }

  const grid = getGridForScene(scene);
  if (grid?.getTopLeftPoint) {
    try {
      return grid.getTopLeftPoint({ i: cell.i, j: cell.j });
    } catch (_err) { /* fall through */ }
  }

  const sizeX = scene.grid?.sizeX ?? scene.grid?.size ?? 100;
  const sizeY = scene.grid?.sizeY ?? scene.grid?.size ?? sizeX;
  const ox = scene.grid?.pos?.x ?? scene.dimensions?.sceneX ?? 0;
  const oy = scene.grid?.pos?.y ?? scene.dimensions?.sceneY ?? 0;
  return { x: ox + (cell.j * sizeX), y: oy + (cell.i * sizeY) };
}

/** @type {WeakMap<TokenDocument, string>} */
const pendingTrapTriggers = new WeakMap();
/** @type {WeakSet<TokenDocument>} */
const trapRedirectInFlight = new WeakSet();

/**
 * Foundry V13+ ruler movement: waypoints cannot be rewritten; reject path-past-trap
 * and re-issue a move that stops on the trap square.
 * @param {TokenDocument} document
 * @param {object} movement
 * @param {object} operation
 * @returns {boolean|void}
 */
function onPreMoveToken(document, movement, operation) {
  if (!isTrapsEnabled()) return;
  if (operation?.dmToolkitTrapSkip) return;
  if (trapRedirectInFlight.has(document)) return;

  const fromX = movement?.origin?.x ?? document.x;
  const fromY = movement?.origin?.y ?? document.y;
  const toX = movement?.destination?.x ?? document.x;
  const toY = movement?.destination?.y ?? document.y;
  if (positionsNear(fromX, fromY, toX, toY)) return;

  const hit = findTrapAlongMovement(document, fromX, fromY, toX, toY);
  if (!hit) return;

  const scene = document.parent;
  if (!scene) return;
  const stop = getTokenPositionForCell(scene, document, hit.cell);

  // Destination is already the trap (or on it) — allow and mark for trigger.
  const destTrap = findTrapAtTokenPosition(document, toX, toY);
  if (destTrap?.id === hit.trap.id || positionsNear(toX, toY, stop.x, stop.y)) {
    pendingTrapTriggers.set(document, hit.trap.id);
    if (operation && typeof operation === "object") {
      operation.dmToolkitTrapTrigger = hit.trap.id;
    }
    return;
  }

  // Path continues past the trap — cancel and move only onto the trap.
  const trapId = hit.trap.id;
  trapRedirectInFlight.add(document);
  Promise.resolve().then(async () => {
    try {
      pendingTrapTriggers.set(document, trapId);
      if (typeof document.move === "function") {
        await document.move([{ x: stop.x, y: stop.y }], {
          dmToolkitTrapTrigger: trapId
        });
      } else {
        await document.update({ x: stop.x, y: stop.y }, {
          dmToolkitTrapTrigger: trapId
        });
      }
    } catch (err) {
      pendingTrapTriggers.delete(document);
      console.error(`${MODULE_ID} | Trap movement redirect failed`, err);
    } finally {
      trapRedirectInFlight.delete(document);
    }
  });
  return false;
}

/**
 * @param {TokenDocument} document
 * @param {object} movement
 * @param {object} operation
 * @param {User} user
 */
async function onMoveToken(document, movement, operation, user) {
  if (!isTrapsEnabled()) return;
  if (operation?.dmToolkitTrapSkip) return;

  const trapId = operation?.dmToolkitTrapTrigger
    ?? pendingTrapTriggers.get(document)
    ?? null;
  if (!trapId) return;
  pendingTrapTriggers.delete(document);

  await handleTrapTriggerDispatch(trapId, document, user?.id ?? game.user.id);
}

/**
 * Legacy simple x/y updates without a movement operation.
 * @param {TokenDocument} document
 * @param {object} change
 * @param {object} options
 * @param {string} userId
 */
function onPreUpdateToken(document, change, options, userId) {
  if (!isTrapsEnabled()) return;
  if (options?.dmToolkitTrapSkip) return;
  // Movement API path is handled by preMoveToken — do not rewrite coordinates here.
  if (options?.movement || change?.movement) return;
  if (!("x" in change || "y" in change)) return;

  const fromX = document.x;
  const fromY = document.y;
  const toX = change.x ?? fromX;
  const toY = change.y ?? fromY;
  if (positionsNear(fromX, fromY, toX, toY)) return;

  const hit = findTrapAlongMovement(document, fromX, fromY, toX, toY);
  if (!hit) return;

  const scene = document.parent;
  if (!scene) return;
  const stop = getTokenPositionForCell(scene, document, hit.cell);
  change.x = stop.x;
  change.y = stop.y;
  options.dmToolkitTrapTrigger = hit.trap.id;
  pendingTrapTriggers.set(document, hit.trap.id);
}

/**
 * @param {TokenDocument} document
 * @param {object} change
 * @param {object} options
 * @param {string} userId
 */
async function onUpdateToken(document, change, options, userId) {
  if (!isTrapsEnabled()) return;
  if (options?.dmToolkitTrapSkip) return;
  if (options?.movement || change?.movement) return;

  const trapId = options?.dmToolkitTrapTrigger
    ?? pendingTrapTriggers.get(document)
    ?? null;
  if (!trapId) return;
  pendingTrapTriggers.delete(document);

  await handleTrapTriggerDispatch(trapId, document, userId);
}

/**
 * @param {string} trapId
 * @param {TokenDocument} document
 * @param {string} userId
 */
async function handleTrapTriggerDispatch(trapId, document, userId) {
  if (isPrimaryGM()) {
    await resolveTrapTrigger(trapId, document);
    return;
  }
  if (game.user.id === userId) {
    game.socket.emit(TRAP_SOCKET, {
      type: "trapTriggered",
      trapId,
      tokenUuid: document.uuid
    });
  }
}

/**
 * @param {string} trapId
 * @param {TokenDocument|null} tokenDoc
 */
async function resolveTrapTrigger(trapId, tokenDoc) {
  const trap = findTrap(trapId);
  if (!trap || !isTrapActive(trap)) return;

  if (tokenDoc) {
    const recent = recentTriggers.get(tokenDoc);
    if (recent && recent.trapId === trapId && Date.now() < recent.until) return;
    recentTriggers.set(tokenDoc, { trapId, until: Date.now() + TRIGGER_COOLDOWN_MS });
  }

  try {
    await ChatMessage.create({
      content: game.i18n.localize("DM-TOOLKIT-DND5E.Traps.TriggeredMessage"),
      speaker: tokenDoc
        ? ChatMessage.getSpeaker({ token: tokenDoc, actor: tokenDoc.actor })
        : ChatMessage.getSpeaker()
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Trap chat message failed`, err);
  }

  if (trap.pauseGame && game.user?.isGM) {
    try {
      if (!game.paused) game.togglePause(true, { broadcast: true });
    } catch (err) {
      console.error(`${MODULE_ID} | Trap pause failed`, err);
    }
  }

  if (trap.tileUuid) {
    await revealTrapTile(trap.tileUuid);
  }

  if (trap.macroUuid) {
    await executeTrapMacro(trap.macroUuid, tokenDoc);
  }

  if (trap.disableAfterTrigger) {
    try {
      await updateTrap(trapId, { enabled: false });
      refreshTrapOverlay();
      foundry.applications.instances.get("dm-toolkit-trap-manage")?.render?.({ force: true });
    } catch (err) {
      console.error(`${MODULE_ID} | Trap auto-disable failed`, err);
    }
  }
}

/**
 * Reveal a tile if it still exists. Missing/invalid UUIDs are ignored.
 * @param {string} tileUuid
 */
async function revealTrapTile(tileUuid) {
  if (!tileUuid) return;
  let tile = null;
  try {
    tile = await fromUuid(tileUuid);
  } catch (_err) {
    return;
  }
  if (!tile) return;
  const isTile = tile.documentName === "Tile"
    || tile.constructor?.documentName === "Tile"
    || tile instanceof foundry.documents?.Tile;
  if (!isTile) return;
  if (!tile.hidden) return;
  try {
    await tile.update({ hidden: false });
  } catch (err) {
    console.warn(`${MODULE_ID} | Trap tile could not be revealed`, err);
  }
}

/**
 * Execute a macro if it still exists. Missing/invalid UUIDs are ignored.
 * @param {string} macroUuid
 * @param {TokenDocument|null} tokenDoc
 */
async function executeTrapMacro(macroUuid, tokenDoc) {
  if (!macroUuid) return;
  let macro = null;
  try {
    macro = await fromUuid(macroUuid);
  } catch (_err) {
    return;
  }
  if (!macro) return;
  const isMacro = macro.documentName === "Macro"
    || macro.constructor?.documentName === "Macro"
    || macro instanceof foundry.documents?.Macro
    || typeof macro.execute === "function";
  if (!isMacro || typeof macro.execute !== "function") return;
  try {
    await macro.execute({
      actor: tokenDoc?.actor ?? null,
      token: tokenDoc?.object ?? tokenDoc ?? null
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | Trap macro execution failed`, err);
  }
}
