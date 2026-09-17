/**
 * Portals: DM scene-control tools to create/connect portal pads, canvas overlays,
 * and token teleport (step-on or Activate button) across scenes.
 */

const MODULE_ID = "DM-toolkit-for-dnd5e";
const ENABLED_SETTING = "portalsEnabled";
const PORTALS_SETTING = "portals";
const BORDER_COLOR_SETTING = "portalsBorderColor";
const BORDER_WIDTH_SETTING = "portalsBorderWidth";
const TRANSIT_FLAG = "portalTransit";
const OVERLAY_NAME = "dmToolkitPortalsOverlay";
const PREVIEW_NAME = "dmToolkitPortalsPreview";
const DEFAULT_BORDER_COLOR = "#4cc9f0";
const DEFAULT_BORDER_WIDTH = 4;
const PREVIEW_COLOR = 0xf4a261;

/** @type {"idle"|"create"|"connect"} */
let paintMode = "idle";
/** @type {Set<string>} */
let paintCells = new Set();
/** @type {string|null} */
let connectSourceId = null;
/** @type {{di:number,dj:number}[]|null} */
let connectOffsets = null;
/** @type {{i:number,j:number}|null} */
let connectOrigin = null;
let paintPointerDown = false;
/** @type {WeakMap<TokenDocument, number>} */
const transitUntil = new WeakMap();

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

export function registerPortals() {
  Hooks.once("ready", () => {
    registerPortalSocket();
    installPortalDblClickHook();
    // Ensure Configure Settings appearance is mirrored into shared portal world data.
    if (game.user?.isGM) void syncPortalAppearanceToWorldData();
  });
  Hooks.on("getSceneControlButtons", onGetSceneControlButtons);
  Hooks.on("canvasReady", onCanvasReady);
  Hooks.on("canvasTearDown", onCanvasTearDown);
  Hooks.on("updateToken", onUpdateToken);
  Hooks.on("createToken", onCreateTokenPortalPull);
  Hooks.on("canvasPan", () => {
    if (isPortalsEnabled()) renderActivateButtons();
  });
  Hooks.on("renderSceneControls", () => {
    if (ui.controls?.control?.name !== "portals") stopPaintMode();
  });
  Hooks.on("updateSetting", setting => {
    const key = setting?.key;
    if (!key) return;
    if (key === `${MODULE_ID}.${BORDER_COLOR_SETTING}`
      || key === `${MODULE_ID}.${BORDER_WIDTH_SETTING}`
      || key === `${MODULE_ID}.${PORTALS_SETTING}`) {
      refreshPortalOverlay();
    }
  });
}

const PORTAL_SOCKET = `module.${MODULE_ID}`;

/** @type {Map<string, Promise<void>>} */
const pendingSceneViews = new Map();

/**
 * Wait until Foundry will allow a scene switch (no mid-load view()).
 * @returns {Promise<void>}
 */
async function waitForCanvasIdle() {
  const isBusy = () => Boolean(canvas?.loading) || (Boolean(canvas?.scene) && canvas.ready === false);
  if (!isBusy()) return;

  await Promise.race([
    new Promise(resolve => {
      const onReady = () => {
        Hooks.off("canvasReady", onReady);
        resolve();
      };
      Hooks.on("canvasReady", onReady);
      if (!isBusy()) {
        Hooks.off("canvasReady", onReady);
        resolve();
      }
    }),
    new Promise(resolve => setTimeout(resolve, 20000))
  ]);

  // Let Foundry clear its internal loading lock after canvasReady.
  if (isBusy()) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * View a scene only when the canvas is free. Coalesces concurrent pulls for the same scene
 * (createToken + socket both try to pull players after a cross-scene teleport).
 * @param {Scene|null|undefined} scene
 * @returns {Promise<void>}
 */
async function safeViewScene(scene) {
  if (!scene) return;
  if (canvas?.scene?.id === scene.id && canvas.ready && !canvas.loading) return;

  const existing = pendingSceneViews.get(scene.id);
  if (existing) return existing;

  const job = (async () => {
    try {
      await waitForCanvasIdle();
      if (canvas?.scene?.id === scene.id) return;
      await scene.view();
    } catch (err) {
      console.warn(`${MODULE_ID} | Scene view deferred; retrying`, err);
      await waitForCanvasIdle();
      if (canvas?.scene?.id === scene.id) return;
      try {
        await scene.view();
      } catch (err2) {
        console.warn(`${MODULE_ID} | Scene view failed`, err2);
      }
    } finally {
      pendingSceneViews.delete(scene.id);
    }
  })();

  pendingSceneViews.set(scene.id, job);
  return job;
}

/**
 * Whether this client should perform privileged portal document ops.
 * @returns {boolean}
 */
function isPrimaryGM() {
  if (!game.user?.isGM) return false;
  const active = game.users.activeGM;
  if (active) return active.id === game.user.id;
  const gms = game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id));
  return gms[0]?.id === game.user.id;
}

function registerPortalSocket() {
  game.socket.on(PORTAL_SOCKET, async data => {
    if (!data?.type) return;

    if (data.type === "viewScene") {
      if (data.userId !== game.user.id) return;
      // GMs keep their current view; only player owners are pulled.
      if (game.user.isGM) return;
      const scene = game.scenes.get(data.sceneId);
      void safeViewScene(scene);
      return;
    }

    // Activate-button / fallback: player asks primary GM to move the token.
    if (data.type === "requestTeleport") {
      if (!isPrimaryGM()) return;
      if (!isPortalsEnabled()) return;
      try {
        const tokenDoc = await fromUuid(data.tokenUuid);
        if (!tokenDoc) return;
        const portal = findPortal(data.portalId);
        if (!portal) return;
        await teleportTokenThroughPortal(tokenDoc, portal, data.sourceCell, { asGM: true });
      } catch (err) {
        console.error(`${MODULE_ID} | GM portal teleport request failed`, err);
      }
    }
  });
}

/**
 * Cross-scene portal moves require TOKEN_CREATE + TOKEN_DELETE.
 * @param {User} [user]
 * @returns {boolean}
 */
function canCrossSceneTeleport(user = game.user) {
  if (user?.isGM) return true;
  try {
    return Boolean(user?.can?.("TOKEN_CREATE") && user?.can?.("TOKEN_DELETE"));
  } catch (_err) {
    return false;
  }
}

/**
 * When a portal transit token appears on another scene, pull player owners there.
 * GMs are never auto-switched.
 * @param {TokenDocument} tokenDoc
 * @param {object} [options]
 */
function onCreateTokenPortalPull(tokenDoc, options) {
  if (!isPortalsEnabled()) return;
  if (game.user.isGM) return;
  if (!tokenDoc?.isOwner) return;
  const fromPortal = Boolean(options?.dmToolkitPortalSkip)
    || Boolean(tokenDoc.getFlag?.(MODULE_ID, TRANSIT_FLAG));
  if (!fromPortal) return;
  const scene = tokenDoc.parent;
  void safeViewScene(scene);
}

export function registerPortalsSettings() {
  game.settings.register(MODULE_ID, ENABLED_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.Portals.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.Portals.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      refreshSceneControls();
      refreshPortalOverlay();
      if (!isPortalsEnabled()) stopPaintMode();
    }
  });

  game.settings.register(MODULE_ID, BORDER_COLOR_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.PortalsBorderColor.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.PortalsBorderColor.Hint",
    scope: "world",
    config: true,
    type: new foundry.data.fields.ColorField({
      required: true,
      nullable: false,
      initial: DEFAULT_BORDER_COLOR
    }),
    default: DEFAULT_BORDER_COLOR,
    onChange: () => {
      void syncPortalAppearanceToWorldData();
    }
  });

  game.settings.register(MODULE_ID, BORDER_WIDTH_SETTING, {
    name: "DM-TOOLKIT-DND5E.Settings.PortalsBorderWidth.Name",
    hint: "DM-TOOLKIT-DND5E.Settings.PortalsBorderWidth.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 1, max: 20, step: 1 },
    default: DEFAULT_BORDER_WIDTH,
    onChange: () => {
      void syncPortalAppearanceToWorldData();
    }
  });

  game.settings.register(MODULE_ID, PORTALS_SETTING, {
    name: "DM-TOOLKIT-DND5E.Portals.DataSetting",
    scope: "world",
    config: false,
    type: Object,
    default: {
      entries: [],
      borderColor: DEFAULT_BORDER_COLOR,
      borderWidth: DEFAULT_BORDER_WIDTH
    },
    onChange: () => refreshPortalOverlay()
  });
}

/**
 * @returns {{entries: object[], borderColor: string, borderWidth: number, hasAppearance: boolean}}
 */
function getPortalsSettingData() {
  try {
    const raw = game.settings.get(MODULE_ID, PORTALS_SETTING);
    if (Array.isArray(raw)) {
      return {
        entries: foundry.utils.deepClone(raw),
        borderColor: DEFAULT_BORDER_COLOR,
        borderWidth: DEFAULT_BORDER_WIDTH,
        hasAppearance: false
      };
    }
    const hasAppearance = raw != null
      && (raw.borderColor != null || raw.borderWidth != null);
    return {
      entries: Array.isArray(raw?.entries) ? foundry.utils.deepClone(raw.entries) : [],
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
  if (/^#[0-9a-fA-F]{6}$/.test(str)) return str.toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(str)) return `#${str.toLowerCase()}`;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return `#${Math.max(0, Math.min(0xffffff, Math.round(raw))).toString(16).padStart(6, "0")}`;
  }
  return "";
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
 * Push Configure Settings color/width into the shared portals world object so every
 * client draws the same appearance (same sync path as portal entries).
 * @returns {Promise<void>}
 */
async function syncPortalAppearanceToWorldData() {
  refreshPortalOverlay();
  if (!game.user?.isGM) return;
  const color = normalizeColorCss(game.settings.get(MODULE_ID, BORDER_COLOR_SETTING)) || DEFAULT_BORDER_COLOR;
  const width = clampBorderWidth(game.settings.get(MODULE_ID, BORDER_WIDTH_SETTING));
  const data = getPortalsSettingData();
  if (data.borderColor === color && data.borderWidth === width) return;
  await game.settings.set(MODULE_ID, PORTALS_SETTING, {
    entries: data.entries,
    borderColor: color,
    borderWidth: width
  });
}

/**
 * @returns {number} PIXI-compatible hex color
 */
function getPortalBorderColor() {
  try {
    const data = getPortalsSettingData();
    let raw = data.hasAppearance ? data.borderColor : "";
    if (!raw) {
      raw = normalizeColorCss(game.settings.get(MODULE_ID, BORDER_COLOR_SETTING))
        || data.borderColor
        || DEFAULT_BORDER_COLOR;
    }
    if (typeof Color !== "undefined") {
      const n = Number(Color.from(raw));
      if (Number.isFinite(n)) return n;
    }
    const hex = String(raw).replace("#", "");
    const parsed = Number.parseInt(hex, 16);
    return Number.isFinite(parsed) ? parsed : 0x4cc9f0;
  } catch (_err) {
    return 0x4cc9f0;
  }
}

/**
 * @returns {number}
 */
function getPortalBorderWidth() {
  try {
    const data = getPortalsSettingData();
    if (data.hasAppearance) return clampBorderWidth(data.borderWidth);
    return clampBorderWidth(game.settings.get(MODULE_ID, BORDER_WIDTH_SETTING));
  } catch (_err) {
    return DEFAULT_BORDER_WIDTH;
  }
}

/**
 * Rebuild scene controls so the Portals control appears/disappears with the setting.
 */
function refreshSceneControls() {
  const controls = ui.controls;
  if (!controls?.render) return;
  controls.render({ reset: true });
}

/**
 * @returns {boolean}
 */
export function isPortalsEnabled() {
  try {
    return Boolean(game.settings.get(MODULE_ID, ENABLED_SETTING));
  } catch (_err) {
    return false;
  }
}

/* -------------------------------------------- */
/*  Data helpers                                */
/* -------------------------------------------- */

/**
 * @returns {object[]}
 */
export function getPortals() {
  return getPortalsSettingData().entries;
}

/**
 * @param {object[]} portals
 */
async function setPortals(portals) {
  const data = getPortalsSettingData();
  await game.settings.set(MODULE_ID, PORTALS_SETTING, {
    entries: portals,
    borderColor: data.borderColor || DEFAULT_BORDER_COLOR,
    borderWidth: clampBorderWidth(data.borderWidth)
  });
}

/**
 * @param {string} id
 * @returns {object|null}
 */
function findPortal(id) {
  return getPortals().find(p => p.id === id) ?? null;
}

/**
 * @param {string} name
 * @param {string} [exceptId]
 * @returns {boolean}
 */
function isPortalNameUnique(name, exceptId = null) {
  const needle = name.trim().toLowerCase();
  return !getPortals().some(p => p.id !== exceptId && String(p.name ?? "").trim().toLowerCase() === needle);
}

/**
 * @param {{i:number,j:number}[]} cells
 * @returns {{cells: {i:number,j:number}[], offsets: {di:number,dj:number}[], origin: {i:number,j:number}}}
 */
function normalizeCells(cells) {
  if (!cells.length) return { cells: [], offsets: [], origin: { i: 0, j: 0 } };
  const origin = {
    i: Math.min(...cells.map(c => c.i)),
    j: Math.min(...cells.map(c => c.j))
  };
  const sorted = [...cells].sort((a, b) => (a.j - b.j) || (a.i - b.i));
  const offsets = sorted.map(c => ({ di: c.i - origin.i, dj: c.j - origin.j }));
  return { cells: sorted, offsets, origin };
}

/**
 * @param {{i:number,j:number}} origin
 * @param {{di:number,dj:number}[]} offsets
 * @returns {{i:number,j:number}[]}
 */
function cellsFromOffsets(origin, offsets) {
  return offsets.map(o => ({ i: origin.i + o.di, j: origin.j + o.dj }));
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

/**
 * Prefer CONST when available.
 * @returns {boolean}
 */
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

/** When true, ignore tool onChange/onToolChange that would start paint modes. */
let suppressPortalToolStart = false;
/** Prevent recursive reset when forcing the idle tool. */
let resettingPortalsToIdle = false;

/**
 * @param {Record<string, object>} controls
 */
function onGetSceneControlButtons(controls) {
  if (!isPortalsEnabled() || !game.user.isGM) return;

  const notesOrder = Number(controls.notes?.order) || 7;
  controls.portals = {
    name: "portals",
    title: "DM-TOOLKIT-DND5E.Portals.Control",
    icon: "fa-solid fa-right-left",
    layer: "tokens",
    visible: true,
    order: notesOrder + 1,
    activeTool: "portalIdle",
    onChange: (_event, active) => {
      if (!active) {
        stopPaintMode();
        return;
      }
      if (resettingPortalsToIdle) return;
      // Always enter Portals on Select — do not resume a prior Create/Connect tool.
      void resetPortalsControlToIdle();
    },
    onToolChange: (_event, tool) => {
      if (suppressPortalToolStart) return;
      const name = typeof tool === "string" ? tool : tool?.name;
      // Create/Connect are buttons; only persistent tools need handling here.
      if (name && name !== "portalCreate" && name !== "portalConnect") stopPaintMode();
    },
    tools: {
      portalIdle: {
        name: "portalIdle",
        title: "DM-TOOLKIT-DND5E.Portals.IdleTool",
        icon: "fa-solid fa-arrow-pointer",
        order: 0,
        onChange: (_event, active) => {
          if (active) stopPaintMode();
        }
      },
      portalCreate: {
        name: "portalCreate",
        title: "DM-TOOLKIT-DND5E.Portals.CreateTool",
        icon: "fa-solid fa-plus",
        order: 1,
        button: true,
        onChange: () => {
          if (suppressPortalToolStart) return;
          startCreateMode();
        }
      },
      portalConnect: {
        name: "portalConnect",
        title: "DM-TOOLKIT-DND5E.Portals.ConnectTool",
        icon: "fa-solid fa-link",
        order: 2,
        button: true,
        onChange: () => {
          if (suppressPortalToolStart) return;
          startConnectMode();
        }
      },
      portalManage: {
        name: "portalManage",
        title: "DM-TOOLKIT-DND5E.Portals.ManageTool",
        icon: "fa-solid fa-list",
        order: 3,
        button: true,
        onChange: () => {
          stopPaintMode();
          PortalManageApp.open();
        }
      }
    }
  };
}

/**
 * Activate the idle tool without starting create/connect from a remembered tool.
 */
async function resetPortalsControlToIdle() {
  stopPaintMode();
  const currentTool = ui.controls?.tool?.name ?? ui.controls?.tool;
  if (currentTool === "portalIdle") return;

  resettingPortalsToIdle = true;
  suppressPortalToolStart = true;
  try {
    const controls = ui.controls;
    if (!controls) return;
    if (typeof controls.activate === "function") {
      await controls.activate({ control: "portals", tool: "portalIdle" });
    } else {
      await controls.render({ control: "portals", tool: "portalIdle" });
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | Failed to reset portals tool to idle`, err);
  } finally {
    setTimeout(() => {
      suppressPortalToolStart = false;
      resettingPortalsToIdle = false;
    }, 0);
  }
}

/* -------------------------------------------- */
/*  Paint modes                                 */
/* -------------------------------------------- */

function abortPaintMode() {
  paintMode = "idle";
  paintCells.clear();
  connectSourceId = null;
  connectOffsets = null;
  connectOrigin = null;
  paintPointerDown = false;
  unbindPaintListeners();
  clearPreview();
}

function stopPaintMode() {
  abortPaintMode();
  closePortalFormApps();
}

function startCreateMode() {
  if (!isPortalsEnabled() || !game.user.isGM) return;
  if (!sceneHasSquareGrid()) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.NeedSquareGrid"));
    return;
  }
  paintMode = "create";
  paintCells.clear();
  connectSourceId = null;
  connectOffsets = null;
  connectOrigin = null;
  bindPaintListeners();
  redrawPreview();
  PortalCreateApp.open();
}

async function startConnectMode() {
  if (!isPortalsEnabled() || !game.user.isGM) return;
  if (!sceneHasSquareGrid()) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.NeedSquareGrid"));
    return;
  }

  const unconnected = getPortals().filter(p => !p.linkedPortalId);
  if (!unconnected.length) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.NoUnconnected"));
    return;
  }

  const options = unconnected.map(p => {
    const sceneName = game.scenes.get(p.sceneId)?.name ?? p.sceneId;
    return `<option value="${p.id}">${escapeHTML(p.name)} (${escapeHTML(sceneName)})</option>`;
  }).join("");

  const content = `
    <div class="form-group">
      <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.SelectPortal")}</label>
      <select name="portalId">${options}</select>
    </div>`;

  let portalId = null;
  try {
    const DialogV2 = foundry.applications.api.DialogV2;
    const result = await DialogV2.prompt({
      window: { title: game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ConnectSelectTitle") },
      content,
      ok: {
        label: game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Select"),
        callback: (_event, button) => button.form.elements.portalId?.value
      },
      rejectClose: false
    });
    portalId = result;
  } catch (_err) {
    return;
  }

  if (!portalId) return;
  const source = findPortal(portalId);
  if (!source) return;

  paintMode = "connect";
  paintCells.clear();
  connectSourceId = source.id;
  connectOffsets = Array.isArray(source.offsets) ? source.offsets : normalizeCells(source.cells ?? []).offsets;
  connectOrigin = null;
  bindPaintListeners();
  redrawPreview();
  PortalConnectApp.open();
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
function getOccupiedPortalCellKeys(sceneId = canvas?.scene?.id) {
  const occupied = new Set();
  if (!sceneId) return occupied;
  for (const portal of getPortals()) {
    if (portal.sceneId !== sceneId) continue;
    for (const cell of portal.cells ?? []) {
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
function isCellOccupiedByPortal(i, j, sceneId = canvas?.scene?.id) {
  return getOccupiedPortalCellKeys(sceneId).has(cellKey(i, j));
}

/**
 * @param {{i:number,j:number}[]} cells
 * @param {string} [sceneId]
 * @returns {boolean}
 */
function cellsOverlapExistingPortal(cells, sceneId = canvas?.scene?.id) {
  const occupied = getOccupiedPortalCellKeys(sceneId);
  return cells.some(c => occupied.has(cellKey(c.i, c.j)));
}

let occupiedCellWarnAt = 0;
function warnOccupiedPortalCell() {
  const now = Date.now();
  if (now - occupiedCellWarnAt < 800) return;
  occupiedCellWarnAt = now;
  ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrCellOccupied"));
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

  if (paintMode === "create") {
    const key = cellKey(offset.i, offset.j);
    if (toggle) {
      if (paintCells.has(key)) paintCells.delete(key);
      else if (isCellOccupiedByPortal(offset.i, offset.j)) warnOccupiedPortalCell();
      else paintCells.add(key);
    } else if (!paintCells.has(key)) {
      if (isCellOccupiedByPortal(offset.i, offset.j)) warnOccupiedPortalCell();
      else paintCells.add(key);
    }
    redrawPreview();
    return;
  }

  if (paintMode === "connect" && connectOffsets?.length) {
    const origin = { i: offset.i, j: offset.j };
    const cells = cellsFromOffsets(origin, connectOffsets);
    if (cellsOverlapExistingPortal(cells)) {
      warnOccupiedPortalCell();
      return;
    }
    connectOrigin = origin;
    paintCells = new Set(cells.map(c => cellKey(c.i, c.j)));
    redrawPreview();
  }
}

/**
 * @returns {{i:number,j:number}[]}
 */
function getPaintedCells() {
  return [...paintCells].map(parseCellKey);
}

/* -------------------------------------------- */
/*  Overlay / preview                           */
/* -------------------------------------------- */

function onCanvasReady() {
  // Never resume create/connect paint across scene loads.
  stopPaintMode();
  refreshPortalOverlay();
}

function onCanvasTearDown() {
  stopPaintMode();
  const layer = document.getElementById("dm-toolkit-portal-activate-layer");
  if (layer) {
    layer.replaceChildren();
    layer.hidden = true;
  }
}

/**
 * Foundry routes canvas double-clicks through layer `_onClickLeft2`,
 * not native DOM dblclick (which PIXI often never emits).
 */
function installPortalDblClickHook() {
  const layers = new Set([
    foundry.canvas?.layers?.InteractionLayer,
    foundry.canvas?.layers?.PlaceablesLayer,
    foundry.canvas?.layers?.TokenLayer
  ]);
  for (const cfg of Object.values(CONFIG.Canvas?.layers ?? {})) {
    if (cfg?.layerClass) layers.add(cfg.layerClass);
  }
  for (const LayerClass of layers) wrapLayerClickLeft2(LayerClass);
}

/**
 * @param {typeof foundry.canvas.layers.InteractionLayer} LayerClass
 */
function wrapLayerClickLeft2(LayerClass) {
  if (!LayerClass?.prototype) return;
  // Only wrap methods defined on this class to avoid double-wrapping inheritance.
  if (!Object.prototype.hasOwnProperty.call(LayerClass.prototype, "_onClickLeft2")) return;
  if (LayerClass.prototype._dmToolkitPortalClickLeft2) return;

  const original = LayerClass.prototype._onClickLeft2;
  if (typeof original !== "function") return;

  LayerClass.prototype._dmToolkitPortalClickLeft2 = true;
  LayerClass.prototype._onClickLeft2 = function(event) {
    if (tryOpenPortalFromCanvasDoubleClick(event)) return;
    return original.call(this, event);
  };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {string} [sceneId]
 * @returns {object|null}
 */
function findPortalAtCanvasPoint(x, y, sceneId = canvas?.scene?.id) {
  if (!sceneId || !canvas?.grid?.getOffset) return null;
  let offset;
  try {
    offset = canvas.grid.getOffset({ x, y });
  } catch (_err) {
    return null;
  }
  if (offset?.i == null || offset?.j == null) return null;
  const key = cellKey(offset.i, offset.j);
  for (const portal of getPortals()) {
    if (portal.sceneId !== sceneId) continue;
    if (!portal.visibleToPlayers && !game.user.isGM) continue;
    if ((portal.cells ?? []).some(c => cellKey(c.i, c.j) === key)) return portal;
  }
  return null;
}

/**
 * @param {PIXI.FederatedEvent} [event]
 * @returns {boolean} True if the double-click was handled.
 */
function tryOpenPortalFromCanvasDoubleClick(event) {
  if (!isPortalsEnabled() || !game.user.isGM) return false;
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

  const portal = findPortalAtCanvasPoint(x, y);
  if (!portal) return false;

  event?.stopPropagation?.();
  PortalManageApp.open(portal.id);
  return true;
}

/**
 * @returns {PIXI.Container|null}
 */
function getPortalDrawParent() {
  return canvas?.primary ?? null;
}

/**
 * Remove overlays left on interface/controls from earlier experiments.
 */
function destroyNonPrimaryPortalOverlays() {
  for (const parent of [canvas?.interface, canvas?.controls]) {
    if (!parent?.children) continue;
    for (const name of [OVERLAY_NAME, PREVIEW_NAME]) {
      const child = parent.children.find(c => c.name === name);
      if (child) child.destroy({ children: true });
    }
  }
}

function getOrCreateOverlay() {
  const parent = getPortalDrawParent();
  if (!parent) return null;
  destroyNonPrimaryPortalOverlays();
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
  const parent = getPortalDrawParent();
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
  const g = getPortalDrawParent()?.children?.find(c => c.name === PREVIEW_NAME);
  g?.clear?.();
}

function redrawPreview() {
  const g = getOrCreatePreview();
  if (!g) return;
  g.clear();
  const cells = getPaintedCells();
  for (const cell of cells) drawCellBorder(g, cell.i, cell.j, PREVIEW_COLOR, 0.85);
}

/**
 * @param {PIXI.Graphics} g
 * @param {number} i
 * @param {number} j
 * @param {number} color
 * @param {number} alpha
 * @param {number} [width]
 */
function drawCellBorder(g, i, j, color, alpha = 1, width = getPortalBorderWidth()) {
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

export function refreshPortalOverlay() {
  const overlay = getOrCreateOverlay();
  if (overlay) {
    overlay.removeChildren().forEach(child => child.destroy({ children: true }));
    if (isPortalsEnabled() && canvas?.scene) {
      const sceneId = canvas.scene.id;
      const borderColor = getPortalBorderColor();
      const borderWidth = getPortalBorderWidth();
      const g = new PIXI.Graphics();
      g.eventMode = "none";
      overlay.addChild(g);
      for (const portal of getPortals()) {
        if (portal.sceneId !== sceneId) continue;
        if (!portal.visibleToPlayers && !game.user.isGM) continue;
        const alpha = portal.visibleToPlayers ? 1 : 0.9;
        for (const cell of portal.cells ?? []) {
          drawCellBorder(g, cell.i, cell.j, borderColor, alpha, borderWidth);
          drawCellLabel(overlay, cell.i, cell.j, portal.name, borderColor, alpha);
        }
      }
    }
  }
  renderActivateButtons();
}

/**
 * @returns {HTMLElement}
 */
function getActivateButtonLayer() {
  let layer = document.getElementById("dm-toolkit-portal-activate-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "dm-toolkit-portal-activate-layer";
    layer.className = "dm-toolkit-portal-activate-layer";
    document.body.append(layer);
  }
  return layer;
}

/**
 * @param {number} worldX
 * @param {number} worldY
 * @returns {{x: number, y: number}|null}
 */
function worldToClient(worldX, worldY) {
  if (!canvas?.ready) return null;
  if (typeof canvas.clientCoordinatesFromCanvas === "function") {
    return canvas.clientCoordinatesFromCanvas({ x: worldX, y: worldY });
  }
  const t = canvas.stage?.worldTransform;
  if (!t) return null;
  return { x: (worldX * t.a) + t.tx, y: (worldY * t.d) + t.ty };
}

function renderActivateButtons() {
  const layer = getActivateButtonLayer();
  layer.replaceChildren();
  if (!isPortalsEnabled() || !canvas?.scene || !canvas.ready) {
    layer.hidden = true;
    return;
  }
  layer.hidden = false;

  const sceneId = canvas.scene.id;
  for (const portal of getPortals()) {
    if (portal.sceneId !== sceneId) continue;
    if (!canUserSeeActivateButton(portal)) continue;

    const cells = portal.cells ?? [];
    if (!cells.length) continue;
    const right = cells.reduce((a, b) => (b.i > a.i || (b.i === a.i && b.j < a.j) ? b : a), cells[0]);
    let tl;
    try {
      tl = canvas.grid.getTopLeftPoint({ i: right.i, j: right.j });
    } catch (_err) {
      continue;
    }
    const size = canvas.grid.sizeX ?? canvas.grid.size ?? 100;
    const sizeY = canvas.grid.sizeY ?? size;
    const screen = worldToClient(tl.x + size + 10, tl.y + (sizeY / 2));
    if (!screen) continue;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dm-toolkit-portal-activate";
    btn.dataset.portalId = portal.id;
    btn.innerHTML = `<i class="fa-solid fa-right-left" aria-hidden="true"></i>`;
    const activateLabel = game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Activate");
    btn.setAttribute("aria-label", activateLabel);
    btn.dataset.tooltip = activateLabel;
    btn.style.left = `${screen.x}px`;
    btn.style.top = `${screen.y}px`;
    if (!portal.canEnter || !portal.linkedPortalId) {
      btn.classList.add("inactive");
      btn.dataset.tooltip = !portal.linkedPortalId
        ? game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNoPartner")
        : game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrCannotEnter");
    }
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      activatePortalForSelectedToken(portal.id);
    });
    layer.append(btn);
  }
}

/**
 * @param {object} portal
 * @returns {boolean}
 */
function canUserSeeActivateButton(portal) {
  if (!portal?.activationButton) return false;
  if (game.user.isGM) return true;
  return Boolean(portal.visibleToPlayers) && Boolean(portal.activationButtonVisibleToPlayers);
}

/* -------------------------------------------- */
/*  CRUD                                        */
/* -------------------------------------------- */

/**
 * @param {object} data
 */
async function createPortal(data) {
  const portals = getPortals();
  portals.push(data);
  await setPortals(portals);
}

/**
 * @param {string} id
 * @param {object} patch
 */
async function updatePortal(id, patch) {
  const portals = getPortals();
  const idx = portals.findIndex(p => p.id === id);
  if (idx < 0) return;
  portals[idx] = { ...portals[idx], ...patch };
  await setPortals(portals);
}

/**
 * @param {string} id
 */
async function deletePortal(id) {
  let portals = getPortals();
  const target = portals.find(p => p.id === id);
  if (!target) return;
  portals = portals.filter(p => p.id !== id);
  if (target.linkedPortalId) {
    const partnerIdx = portals.findIndex(p => p.id === target.linkedPortalId);
    if (partnerIdx >= 0) portals[partnerIdx].linkedPortalId = null;
  }
  await setPortals(portals);
}

/**
 * @param {object} form
 * @returns {Promise<boolean>}
 */
async function submitCreatePortal(form) {
  const name = String(form.name ?? "").trim();
  const cells = getPaintedCells();
  if (!name) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNameRequired"));
    return false;
  }
  if (!isPortalNameUnique(name)) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNameUnique"));
    return false;
  }
  if (!cells.length) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrCellsRequired"));
    return false;
  }
  if (cellsOverlapExistingPortal(cells)) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrCellOccupied"));
    return false;
  }

  const { cells: normalized, offsets } = normalizeCells(cells);
  await createPortal({
    id: foundry.utils.randomID(),
    name,
    sceneId: canvas.scene.id,
    cells: normalized,
    offsets,
    canEnter: Boolean(form.canEnter),
    activationButton: Boolean(form.activationButton),
    visibleToPlayers: Boolean(form.visibleToPlayers),
    activationButtonVisibleToPlayers: Boolean(form.activationButtonVisibleToPlayers),
    linkedPortalId: null
  });

  ui.notifications.info(game.i18n.format("DM-TOOLKIT-DND5E.Portals.Created", { name }));
  stopPaintMode();
  refreshPortalOverlay();
  return true;
}

/**
 * @param {object} form
 * @returns {Promise<boolean>}
 */
async function submitConnectPortal(form) {
  if (!connectSourceId || !connectOffsets?.length || !connectOrigin) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrConnectPlace"));
    return false;
  }
  const source = findPortal(connectSourceId);
  if (!source || source.linkedPortalId) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrConnectInvalid"));
    return false;
  }

  const name = String(form.name ?? "").trim();
  if (!name) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNameRequired"));
    return false;
  }
  if (!isPortalNameUnique(name)) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNameUnique"));
    return false;
  }

  const cells = cellsFromOffsets(connectOrigin, connectOffsets);
  if (cellsOverlapExistingPortal(cells)) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrCellOccupied"));
    return false;
  }
  const { cells: normalized, offsets } = normalizeCells(cells);
  const newId = foundry.utils.randomID();

  const portals = getPortals();
  const srcIdx = portals.findIndex(p => p.id === source.id);
  if (srcIdx < 0) return false;
  portals[srcIdx].linkedPortalId = newId;
  portals.push({
    id: newId,
    name,
    sceneId: canvas.scene.id,
    cells: normalized,
    offsets,
    canEnter: Boolean(form.canEnter),
    activationButton: Boolean(form.activationButton),
    visibleToPlayers: Boolean(form.visibleToPlayers),
    activationButtonVisibleToPlayers: Boolean(form.activationButtonVisibleToPlayers),
    linkedPortalId: source.id
  });
  await setPortals(portals);

  ui.notifications.info(game.i18n.format("DM-TOOLKIT-DND5E.Portals.Connected", { name }));
  stopPaintMode();
  refreshPortalOverlay();
  return true;
}

/**
 * Suggested name for the B-side of a linked portal pair.
 * @param {string} sourceName
 * @returns {string}
 */
function suggestConnectedPortalName(sourceName) {
  const baseName = String(sourceName ?? "Portal").trim() || "Portal";
  let name = `${baseName} (B)`;
  let n = 2;
  while (!isPortalNameUnique(name)) {
    name = `${baseName} (${n++})`;
  }
  return name;
}

/* -------------------------------------------- */
/*  Apps                                        */
/* -------------------------------------------- */

function closePortalFormApps() {
  foundry.applications.instances.get("dm-toolkit-portal-create")?.close?.();
  foundry.applications.instances.get("dm-toolkit-portal-connect")?.close?.();
}

function readCheckboxForm(formElement) {
  const activationButton = Boolean(formElement.elements.activationButton?.checked);
  const visibleToPlayers = Boolean(formElement.elements.visibleToPlayers?.checked);
  return {
    name: formElement.elements.name?.value ?? "",
    canEnter: Boolean(formElement.elements.canEnter?.checked),
    activationButton,
    visibleToPlayers,
    activationButtonVisibleToPlayers: activationButton && visibleToPlayers
      && Boolean(formElement.elements.activationButtonVisibleToPlayers?.checked)
  };
}

/**
 * Shared checkbox fields for create / connect / manage portal forms.
 * @param {{activationButton?: boolean, visibleToPlayers?: boolean, activationButtonVisibleToPlayers?: boolean, canEnter?: boolean}} [opts]
 * @returns {string}
 */
function portalOptionFieldsHTML(opts = {}) {
  const canEnter = opts.canEnter !== false;
  const activationButton = Boolean(opts.activationButton);
  const visibleToPlayers = Boolean(opts.visibleToPlayers);
  const activationButtonVisibleToPlayers = Boolean(opts.activationButtonVisibleToPlayers);
  const showPlayerActivate = activationButton && visibleToPlayers;
  return `
      <div class="form-group">
        <label class="checkbox">
          <input type="checkbox" name="canEnter" ${canEnter ? "checked" : ""} />
          ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.CanEnter")}
        </label>
      </div>
      <div class="form-group">
        <label class="checkbox">
          <input type="checkbox" name="activationButton" ${activationButton ? "checked" : ""} />
          ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ActivationButton")}
        </label>
      </div>
      <div class="form-group">
        <label class="checkbox">
          <input type="checkbox" name="visibleToPlayers" ${visibleToPlayers ? "checked" : ""} />
          ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.VisibleToPlayers")}
        </label>
      </div>
      <div class="form-group dm-toolkit-portal-player-activate"${showPlayerActivate ? "" : " hidden"}>
        <label class="checkbox">
          <input type="checkbox" name="activationButtonVisibleToPlayers" ${activationButtonVisibleToPlayers ? "checked" : ""} />
          ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ActivationButtonVisibleToPlayers")}
        </label>
      </div>`;
}

/**
 * Show/hide "Activate button visible for players" when both parent options are checked.
 * @param {HTMLElement} root
 */
function bindPortalOptionVisibility(root) {
  const activation = root.querySelector('input[name="activationButton"]');
  const visible = root.querySelector('input[name="visibleToPlayers"]');
  const playerGroup = root.querySelector(".dm-toolkit-portal-player-activate");
  if (!activation || !visible || !playerGroup) return;
  const sync = () => {
    playerGroup.hidden = !(activation.checked && visible.checked);
  };
  if (!activation.dataset.dmToolkitBound) {
    activation.dataset.dmToolkitBound = "true";
    activation.addEventListener("change", sync);
  }
  if (!visible.dataset.dmToolkitBound) {
    visible.dataset.dmToolkitBound = "true";
    visible.addEventListener("change", sync);
  }
  sync();
}

class PortalCreateApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-portal-create",
    classes: ["dm-toolkit-portal-form"],
    tag: "form",
    window: {
      title: "DM-TOOLKIT-DND5E.Portals.CreateTitle",
      contentClasses: ["standard-form"]
    },
    position: { width: 360 },
    form: {
      handler: PortalCreateApp.#onSubmit,
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
    root.classList.add("dm-toolkit-portal-form-body");
    root.innerHTML = `
      <div class="form-group">
        <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Name")}</label>
        <input type="text" name="name" required />
      </div>
      ${portalOptionFieldsHTML({ canEnter: true })}
      <p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.CreateHint")}</p>
      <footer class="form-footer">
        <button type="submit" class="dense">
          <i class="fa-solid fa-check"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Create")}
        </button>
      </footer>`;
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    bindPortalOptionVisibility(this.element);
  }

  /**
   * @param {SubmitEvent} _event
   * @param {HTMLFormElement} form
   * @param {FormDataExtended} _formData
   */
  static async #onSubmit(_event, form, _formData) {
    await submitCreatePortal(readCheckboxForm(form));
  }

  /** @inheritDoc */
  async _onClose(options) {
    await super._onClose(options);
    abortPaintMode();
  }
}

class PortalConnectApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-portal-connect",
    classes: ["dm-toolkit-portal-form"],
    tag: "form",
    window: {
      title: "DM-TOOLKIT-DND5E.Portals.ConnectTitle",
      contentClasses: ["standard-form"]
    },
    position: { width: 360 },
    form: {
      handler: PortalConnectApp.#onSubmit,
      closeOnSubmit: false
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
    const source = connectSourceId ? findPortal(connectSourceId) : null;
    const suggestedName = suggestConnectedPortalName(source?.name ?? "Portal");
    const root = document.createElement("div");
    root.classList.add("dm-toolkit-portal-form-body");
    root.innerHTML = `
      <p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ConnectHint")}</p>
      <div class="form-group">
        <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Name")}</label>
        <input type="text" name="name" value="${escapeHTML(suggestedName)}" required />
      </div>
      ${portalOptionFieldsHTML({
        canEnter: source?.canEnter !== false,
        activationButton: Boolean(source?.activationButton),
        visibleToPlayers: Boolean(source?.visibleToPlayers),
        activationButtonVisibleToPlayers: Boolean(source?.activationButtonVisibleToPlayers)
      })}
      <footer class="form-footer">
        <button type="submit" class="dense">
          <i class="fa-solid fa-link"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Connect")}
        </button>
      </footer>`;
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    bindPortalOptionVisibility(this.element);
  }

  static async #onSubmit(_event, form, _formData) {
    await submitConnectPortal(readCheckboxForm(form));
  }

  /** @inheritDoc */
  async _onClose(options) {
    await super._onClose(options);
    abortPaintMode();
  }
}

class PortalManageApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "dm-toolkit-portal-manage",
    classes: ["dm-toolkit-portal-manage"],
    tag: "form",
    window: {
      title: "DM-TOOLKIT-DND5E.Portals.ManageTitle",
      contentClasses: ["standard-form"],
      resizable: true
    },
    position: { width: 520, height: 480 },
    form: {
      handler: PortalManageApp.#onSubmit,
      closeOnSubmit: false
    },
    actions: {
      selectPortal: PortalManageApp.#onSelect,
      deletePortal: PortalManageApp.#onDelete
    }
  };

  /** @type {string|null} */
  #selectedId = null;

  /**
   * @param {string|null} portalId
   */
  setSelectedPortal(portalId) {
    this.#selectedId = portalId || null;
  }

  /**
   * @param {string|null} [portalId]
   */
  static open(portalId = null) {
    const existing = foundry.applications.instances.get(this.DEFAULT_OPTIONS.id);
    if (existing) {
      if (portalId) existing.setSelectedPortal(portalId);
      existing.render({ force: true });
      existing.bringToFront?.();
      return existing;
    }
    const app = new this();
    if (portalId) app.setSelectedPortal(portalId);
    app.render({ force: true });
    return app;
  }

  /** @inheritDoc */
  async _prepareContext() {
    const portals = getPortals();
    const mapped = portals.map(p => ({
      ...p,
      sceneName: game.scenes.get(p.sceneId)?.name ?? "?",
      partnerName: p.linkedPortalId
        ? (portals.find(x => x.id === p.linkedPortalId)?.name ?? "?")
        : game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Unconnected"),
      selected: false
    }));
    const collator = new Intl.Collator(game.i18n.lang || undefined, { sensitivity: "base", numeric: true });
    const openSceneId = canvas?.scene?.id ?? null;
    mapped.sort((a, b) => {
      const aOpen = openSceneId && a.sceneId === openSceneId ? 0 : 1;
      const bOpen = openSceneId && b.sceneId === openSceneId ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      const byScene = collator.compare(a.sceneName, b.sceneName);
      if (byScene) return byScene;
      return collator.compare(String(a.name ?? ""), String(b.name ?? ""));
    });
    const selected = mapped.find(p => p.id === this.#selectedId) ?? mapped[0] ?? null;
    this.#selectedId = selected?.id ?? null;
    for (const p of mapped) p.selected = p.id === this.#selectedId;
    return { portals: mapped, selected: selected ? portals.find(p => p.id === selected.id) ?? selected : null };
  }

  /** @inheritDoc */
  async _renderHTML(context) {
    const root = document.createElement("div");
    root.classList.add("dm-toolkit-portal-manage-body");
    const list = context.portals.map(p => `
      <li class="${p.selected ? "selected" : ""}">
        <button type="button" data-action="selectPortal" data-portal-id="${p.id}" data-tooltip="${escapeHTML(p.name)}">
          <strong class="dm-toolkit-portal-list-name">${escapeHTML(p.name)}</strong>
          <span>${escapeHTML(p.sceneName)} — ${escapeHTML(p.partnerName)}</span>
        </button>
      </li>`).join("");

    const s = context.selected;
    const editor = s ? `
      <div class="dm-toolkit-portal-editor">
        <input type="hidden" name="portalId" value="${s.id}" />
        <div class="form-group">
          <label>${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Name")}</label>
          <input type="text" name="name" value="${escapeHTML(s.name)}" required />
        </div>
        ${portalOptionFieldsHTML({
          canEnter: Boolean(s.canEnter),
          activationButton: Boolean(s.activationButton),
          visibleToPlayers: Boolean(s.visibleToPlayers),
          activationButtonVisibleToPlayers: Boolean(s.activationButtonVisibleToPlayers)
        })}
        <footer class="form-footer">
          <button type="submit" class="dense">
            <i class="fa-solid fa-floppy-disk"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Save")}
          </button>
          <button type="button" class="dense" data-action="deletePortal" data-portal-id="${s.id}">
            <i class="fa-solid fa-trash"></i> ${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Delete")}
          </button>
        </footer>
      </div>` : `<p class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.NoPortals")}</p>`;

    root.innerHTML = `
      <div class="dm-toolkit-portal-manage-layout">
        <ul class="dm-toolkit-portal-list">${list || `<li class="hint">${game.i18n.localize("DM-TOOLKIT-DND5E.Portals.NoPortals")}</li>`}</ul>
        ${editor}
      </div>`;
    return root;
  }

  /** @inheritDoc */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  /** @inheritDoc */
  _onRender(context, options) {
    super._onRender(context, options);
    bindPortalOptionVisibility(this.element);
  }

  static async #onSelect(event, target) {
    const app = this;
    app.#selectedId = target.dataset.portalId;
    app.render({ force: true });
  }

  static async #onDelete(_event, target) {
    const id = target.dataset.portalId;
    const portal = findPortal(id);
    if (!portal) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DM-TOOLKIT-DND5E.Portals.DeleteTitle") },
      content: `<p>${game.i18n.format("DM-TOOLKIT-DND5E.Portals.DeleteConfirm", { name: portal.name })}</p>`
    });
    if (!confirmed) return;
    await deletePortal(id);
    this.#selectedId = null;
    refreshPortalOverlay();
    this.render({ force: true });
  }

  static async #onSubmit(_event, form) {
    const app = foundry.applications.instances.get("dm-toolkit-portal-manage");
    const data = readCheckboxForm(form);
    const id = form.elements.portalId?.value;
    if (!id) return;
    const name = String(data.name ?? "").trim();
    if (!name) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNameRequired"));
      return;
    }
    if (!isPortalNameUnique(name, id)) {
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNameUnique"));
      return;
    }
    await updatePortal(id, {
      name,
      canEnter: data.canEnter,
      activationButton: data.activationButton,
      visibleToPlayers: data.visibleToPlayers,
      activationButtonVisibleToPlayers: data.activationButtonVisibleToPlayers
    });
    refreshPortalOverlay();
    ui.notifications.info(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.Saved"));
    app?.render({ force: true });
  }
}

/* -------------------------------------------- */
/*  Teleport                                    */
/* -------------------------------------------- */

/**
 * @param {TokenDocument} tokenDoc
 * @param {number} x
 * @param {number} y
 * @returns {{portal: object, cell: {i:number,j:number}, cellIndex: number}|null}
 */
function findPortalAtTokenPosition(tokenDoc, x, y) {
  if (!isPortalsEnabled()) return null;
  const sceneId = tokenDoc.parent?.id ?? canvas?.scene?.id;
  if (!sceneId) return null;

  const scene = game.scenes.get(sceneId);
  const grid = getGridForScene(scene) ?? canvas?.grid;
  if (!grid?.getOffset) return null;

  const sizeX = grid.sizeX ?? grid.size ?? 100;
  const sizeY = grid.sizeY ?? grid.size ?? sizeX;
  const cx = x + ((tokenDoc.width ?? 1) * sizeX) / 2;
  const cy = y + ((tokenDoc.height ?? 1) * sizeY) / 2;

  let offset;
  try {
    offset = grid.getOffset({ x: cx, y: cy });
  } catch (_err) {
    return null;
  }
  if (offset?.i == null || offset?.j == null) return null;

  for (const portal of getPortals()) {
    if (portal.sceneId !== sceneId) continue;
    if (!portal.canEnter || !portal.linkedPortalId) continue;
    const idx = (portal.cells ?? []).findIndex(c => c.i === offset.i && c.j === offset.j);
    if (idx >= 0) return { portal, cell: portal.cells[idx], cellIndex: idx };
  }
  return null;
}

/**
 * Map the entered source cell to the matching cell on the partner portal (same relative offset).
 * @param {object} sourcePortal
 * @param {object} partner
 * @param {{i:number,j:number}} sourceCell
 * @returns {{i:number,j:number}|null}
 */
function resolveDestinationCell(sourcePortal, partner, sourceCell) {
  const srcCells = sourcePortal.cells ?? [];
  const dstCells = partner.cells ?? [];
  if (!sourceCell || !dstCells.length) return dstCells[0] ?? null;

  const srcOrigin = {
    i: Math.min(...srcCells.map(c => c.i)),
    j: Math.min(...srcCells.map(c => c.j))
  };
  const dstOrigin = {
    i: Math.min(...dstCells.map(c => c.i)),
    j: Math.min(...dstCells.map(c => c.j))
  };
  const target = {
    i: dstOrigin.i + (sourceCell.i - srcOrigin.i),
    j: dstOrigin.j + (sourceCell.j - srcOrigin.j)
  };
  return dstCells.find(c => c.i === target.i && c.j === target.j) ?? target;
}

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
 * Token document top-left for a destination grid cell on a scene.
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

/**
 * Player users who should follow this token across scenes (never GMs).
 * Uses assigned character + explicit OWNER entries on token/actor.
 * @param {TokenDocument} tokenDoc
 * @returns {string[]}
 */
function getTokenOwnerUserIds(tokenDoc) {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  const ids = new Set();
  const actor = tokenDoc.actor;

  if (actor) {
    for (const u of game.users) {
      if (!u.active || u.isGM) continue;
      if (u.character?.id === actor.id) ids.add(u.id);
    }
  }

  const addFrom = doc => {
    if (!doc?.ownership) return;
    for (const [userId, level] of Object.entries(doc.ownership)) {
      if (userId === "default") continue;
      const u = game.users.get(userId);
      if (!u?.active || u.isGM) continue;
      if (Number(level) >= OWNER) ids.add(userId);
    }
  };
  addFrom(tokenDoc);
  addFrom(actor);

  return [...ids];
}

/**
 * Pull only player owners to the destination scene. GMs keep their current view.
 * @param {Scene} destScene
 * @param {TokenDocument} tokenDoc
 */
async function viewSceneForTokenOwners(destScene, tokenDoc) {
  const owners = getTokenOwnerUserIds(tokenDoc);
  for (const userId of owners) {
    const user = game.users.get(userId);
    if (!user?.active || user.isGM) continue;

    if (userId === game.user.id) {
      await safeViewScene(destScene);
    } else {
      game.socket.emit(PORTAL_SOCKET, { type: "viewScene", sceneId: destScene.id, userId });
    }
  }
}

/**
 * @param {TokenDocument} token
 * @param {object} [change]
 * @param {object} [options]
 * @param {string} [userId]
 */
async function onUpdateToken(token, change, options, userId) {
  if (!isPortalsEnabled()) return;
  if (options?.dmToolkitPortalSkip) return;
  if (!("x" in change || "y" in change)) return;

  const until = transitUntil.get(token) ?? 0;
  if (Date.now() < until) return;

  const x = change.x ?? token.x;
  const y = change.y ?? token.y;
  const hit = findPortalAtTokenPosition(token, x, y);
  if (!hit) return;
  // Manual activation portals never auto-teleport on step-on.
  if (hit.portal.activationButton) return;

  const partner = findPortal(hit.portal.linkedPortalId);
  if (!partner) return;
  if (!game.scenes.get(partner.sceneId)) return;

  // Create/delete teleport: primary GM always executes (TOKEN_CREATE/DELETE).
  if (!isPrimaryGM()) return;
  await teleportTokenThroughPortal(token, hit.portal, hit.cell, { asGM: true });
}

/**
 * @param {object} portal
 * @returns {{token: TokenDocument, cell: {i:number,j:number}}|null}
 */
function findOwnedTokenOnPortal(portal) {
  const placeables = canvas.tokens?.placeables ?? [];
  const candidates = [
    ...placeables.filter(t => t.controlled && t.document?.isOwner),
    ...placeables.filter(t => !t.controlled && t.document?.isOwner)
  ];
  const seen = new Set();
  for (const placeable of candidates) {
    const doc = placeable.document;
    if (!doc || seen.has(doc.id)) continue;
    seen.add(doc.id);
    const hit = findPortalAtTokenPosition(doc, doc.x, doc.y);
    if (hit?.portal.id === portal.id) return { token: doc, cell: hit.cell };
  }
  return null;
}

/**
 * @param {string} portalId
 */
async function activatePortalForSelectedToken(portalId) {
  if (!isPortalsEnabled()) return;
  const portal = findPortal(portalId);
  if (!portal?.activationButton) return;
  if (!portal.canEnter) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrCannotEnter"));
    return;
  }
  if (!portal.linkedPortalId) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNoPartner"));
    return;
  }

  const onPad = findOwnedTokenOnPortal(portal);
  if (!onPad) {
    ui.notifications.warn(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrTokenNotOnPortal"));
    return;
  }

  await teleportTokenThroughPortal(onPad.token, portal, onPad.cell);
}

/**
 * @param {TokenDocument} tokenDoc
 * @param {object} portal
 * @param {{i:number,j:number}} sourceCell
 * @param {{asGM?: boolean}} [options]
 */
async function teleportTokenThroughPortal(tokenDoc, portal, sourceCell, options = {}) {
  const partner = findPortal(portal.linkedPortalId);
  if (!partner) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNoPartner"));
    return;
  }

  const destCell = resolveDestinationCell(portal, partner, sourceCell);
  if (!destCell) return;

  const destScene = game.scenes.get(partner.sceneId);
  if (!destScene) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrSceneMissing"));
    return;
  }

  const sameScene = tokenDoc.parent?.id === destScene.id;
  const { x: destX, y: destY } = getTokenPositionForCell(destScene, tokenDoc, destCell);

  // Same-scene: move in place (keeps token id). Owners can do this themselves.
  if (sameScene) {
    const canUpdate = options.asGM || tokenDoc.canUserModify?.(game.user, "update");
    if (!canUpdate) {
      await requestGmTeleport(tokenDoc, portal, sourceCell);
      return;
    }
    transitUntil.set(tokenDoc, Date.now() + 1500);
    try {
      await tokenDoc.update({ x: destX, y: destY }, { dmToolkitPortalSkip: true });
    } catch (err) {
      console.error(`${MODULE_ID} | Portal teleport failed`, err);
      ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrTeleportFailed"));
    }
    return;
  }

  // Cross-scene needs TOKEN_CREATE + TOKEN_DELETE — players usually ask the primary GM.
  if (!options.asGM && !canCrossSceneTeleport()) {
    await requestGmTeleport(tokenDoc, portal, sourceCell);
    return;
  }

  transitUntil.set(tokenDoc, Date.now() + 1500);

  try {
    if (tokenDoc.canUserModify?.(game.user, "update")) {
      await tokenDoc.setFlag(MODULE_ID, TRANSIT_FLAG, true);
    }
  } catch (_err) { /* ignore */ }

  try {
    const data = tokenDoc.toObject();
    delete data._id;
    data.x = destX;
    data.y = destY;
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.${TRANSIT_FLAG}`, true);
    const [created] = await destScene.createEmbeddedDocuments("Token", [data], { dmToolkitPortalSkip: true });
    await tokenDoc.delete({ dmToolkitPortalSkip: true });
    if (created) transitUntil.set(created, Date.now() + 1500);

    // Pull player owners (local view + one socket each). createToken also pulls; safeViewScene coalesces.
    await viewSceneForTokenOwners(destScene, created ?? tokenDoc);
  } catch (err) {
    console.error(`${MODULE_ID} | Portal teleport failed`, err);
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrTeleportFailed"));
  } finally {
    setTimeout(async () => {
      try {
        const scene = game.scenes.get(partner.sceneId);
        for (const t of scene?.tokens ?? []) {
          if (t.getFlag?.(MODULE_ID, TRANSIT_FLAG)) await t.unsetFlag(MODULE_ID, TRANSIT_FLAG);
        }
      } catch (_err) { /* ignore */ }
    }, 1600);
  }
}

/**
 * Ask the primary GM to perform a privileged portal teleport.
 * @param {TokenDocument} tokenDoc
 * @param {object} portal
 * @param {{i:number,j:number}} sourceCell
 */
async function requestGmTeleport(tokenDoc, portal, sourceCell) {
  const gmOnline = game.users.some(u => u.isGM && u.active);
  if (!gmOnline) {
    ui.notifications.error(game.i18n.localize("DM-TOOLKIT-DND5E.Portals.ErrNeedGM"));
    return;
  }
  transitUntil.set(tokenDoc, Date.now() + 2000);
  game.socket.emit(PORTAL_SOCKET, {
    type: "requestTeleport",
    tokenUuid: tokenDoc.uuid,
    portalId: portal.id,
    sourceCell
  });
}
