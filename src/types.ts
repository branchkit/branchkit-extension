/**
 * BranchKit Browser — Message protocol and shared types.
 */

import type { CodewordMemoryEntry } from './labels/codeword-memory';
import type { PaletteDispatch } from './palette/model';

// --- Categories ---

export type Category = 'link' | 'button' | 'input' | 'tab' | 'edit' | 'view' | 'tables';

// --- Badge Display ---

export type BadgeDisplayMode = 'word' | 'letter' | 'both' | 'first-word';
export type HintVisibility = 'always' | 'manual';

// --- Scanned Elements ---

export interface ScannedElement {
  label: string;
  /**
   * Stable registry id. Minted in the content script when the wrapper
   * is registered. 0 means "not registered" — voice can't address it.
   * See docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md.
   */
  id: number;
  category: Category;
  type: string;         // more specific: 'record_action', 'nav', etc.
  adapter: string | null;
  /**
   * Voice handle assigned by the per-tab label pool — e.g. "arch" or
   * "zone arch". Empty when the pool didn't assign one (alphabet not
   * loaded, pool exhausted). Voice plugin skips elements without a
   * codeword. See notes/DESIGN_BROWSER_GRAMMAR_PROTOCOL.md section 3.
   */
  codeword: string;
  /**
   * Frame id this element lives in. Stamped by the SW on receipt of
   * SCAN_RESULT (content scripts don't know their own frame id). Flows
   * to the plugin so dispatched actions can carry frame_id and the SW
   * can route back to the right frame.
   */
  frame_id?: number;
  /**
   * True if the element's rect intersects the strict viewport at batch-
   * send time. Independent of `isInViewport` (the IO band flag, which
   * uses a wide margin — VIEWPORT_MARGIN_PX — for scroll-ahead). The plugin pushes only
   * strict-viewport entries into the `browser_hints_<prefix>_strict`
   * companion collection that drives the Discovery HUD and the activate
   * command's dependent capture — band-only entries get badges painted
   * (scroll-ahead) but stay outside the matchable set.
   */
  in_strict_viewport?: boolean;
}

// --- Per-batch grammar protocol (Option B) ---
//
// Mirror of the plugin-side shapes in plugins/browser/src/batch.go.
// Per notes/DESIGN_HINT_PIPELINE_RESYNC.md, the extension sends one
// GrammarBatchRequest per 10-20 elements; multiple batches with the
// same session_id make up one logical scan. tab_id and frame_id are
// stamped by the SW (sender.tab.id / sender.frameId), not the
// content script — same pattern as SCAN_RESULT today.

export interface GrammarBatchRequest {
  /** Set by background SW from sender.tab.id; absent from content's outbound shape. */
  tab_id?: number;
  /** Set by background SW from sender.frameId. */
  frame_id?: number;
  /** UUID per logical scan; groups all batches of one scan. */
  session_id: string;
  /** 0-based monotonic batch index within the session. */
  batch_index: number;
  /** True on the last batch of this scan (or for an empty terminal batch). */
  is_final: boolean;
  /** "scan" = full doScan replacement; "incremental" = MO-driven discovery. */
  kind: 'scan' | 'incremental';
  /**
   * Extension-minted connection nonce, stable for this background's lifetime.
   * Replaces the old self-reported bundle_id: the extension can't reliably name
   * its own macOS bundle (UA-sniffing breaks for forks like Brave/Nightly), so
   * it identifies its connection instead. The plugin binds this conn_id to the
   * OS-focused bundle via the focus handshake (POST /focus). Stamped by the
   * background SW, not the content script.
   */
  conn_id: string;
  hint_visibility: HintVisibility;
  app_id: string;
  table_id: string;
  elements: ScannedElement[];
  /**
   * Codewords whose elements disconnected from the DOM since the prior
   * batch — the extension's post-batch isConnected sweep piggybacks
   * them here so the plugin can Delete them from its per-prefix
   * collections (investigation item 5 RED mitigation). Optional;
   * absent on the first batch of a session and on any batch where
   * no sweep flagged anything.
   */
  delete_codewords?: string[];
}

export interface GrammarBatchFailure {
  codeword: string;
  reason: string;
}

export interface GrammarBatchResponse {
  // 'ok' = stored and projected into the live collections (focused source).
  // 'stored' = stored in the plugin's per-source session but not projected
  // (the source isn't OS-focused); its codewords project when it gains focus.
  // 'calibration_active' = short-circuited during a calibration trial.
  result: 'ok' | 'error' | 'stored' | 'calibration_active';
  succeeded: string[];
  failed: GrammarBatchFailure[];
  /** The plugin's post-batch view of this frame's grammar membership
   * (count + order-insensitive codeword digest). Absent on refusals and on
   * plugin builds that predate the epoch handshake — absence disables the
   * check. See DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md. */
  epoch?: { count: number; hash: string };
}

// --- Messages ---

/**
 * The tab verbs handleTabAction (background.ts) implements. One vocabulary for
 * both entry points: keyboard (content dispatcher → TAB_ACTION message) and
 * voice (SSE action intercept in the background). See
 * notes/DESIGN_TAB_NAVIGATION.md, "Tab verbs".
 */
export type TabAction =
  | 'next' | 'previous' | 'first' | 'last' | 'goto' | 'last_active'
  | 'new' | 'close' | 'restore' | 'duplicate'
  | 'pin' | 'mute' | 'move_left' | 'move_right';

export type Message =
  | { type: 'SCAN_RESULT'; elements: ScannedElement[]; adapter: string | null }
  | {
      type: 'GRAMMAR_BATCH';
      /** Content omits tab_id/frame_id; SW stamps them from sender. */
      request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>;
    }
  | { type: 'SHOW_HINTS'; category?: Category }
  | { type: 'HIDE_HINTS' }
  | { type: 'BRANCHKIT_ACTION'; payload: { action: string; params: Record<string, string>; correlation_id?: string } }
  // Content → background: open an http(s) href in a new background tab (the
  // "stash" hint verb). Content scripts can't reach chrome.tabs.
  | { type: 'OPEN_TAB_BACKGROUND'; url: string }
  | { type: 'SSE_EVENT'; data: unknown }
  // Diagnostic breadcrumbs — content/background → background, forwarded to the
  // plugin's debug-log endpoints (see background.ts forwardDebugLog /
  // forwardPluginDebugLog). `tag` is a dotted pipeline step name (e.g.
  // "pipeline.cs_nav_step"); `data` is an arbitrary JSON payload for that step.
  | { type: 'DEBUG_LOG'; tag: string; data?: unknown }
  | { type: 'PLUGIN_DEBUG_LOG'; tag: string; data?: unknown; level?: string }
  | { type: 'HEALTH_STATUS'; branchkit: boolean }
  | { type: 'GRAMMAR_PUSH'; elements: ScannedElement[] }
  | { type: 'GET_HEALTH' }
  | { type: 'CONNECT_SSE'; port: number; token: string; connId: string }
  // Content → background, after handling a BRANCHKIT_ACTION. Background
  // forwards to the browser plugin's POST /dispatch-result so the actuator
  // log carries end-to-end visibility (voice → match → dispatch → frame
  // resolution → outcome) without having to cross-reference SW DevTools.
  | { type: 'DISPATCH_RESULT'; payload: DispatchResult }
  // Frame label pool — content asks background for codewords so frames in
  // the same tab don't independently pick the same label. See
  // notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md section 2.
  // `preferred[i]` is the codeword wrapper i held before it left the
  // viewport (or '' / absent for a brand-new element). The pool re-grants a
  // preferred codeword if it's still free, so an element that scrolls out and
  // back keeps its letter instead of being re-dealt a new one (kills flicker).
  | { type: 'CLAIM_LABELS'; count: number; preferred?: string[] }
  | { type: 'RELEASE_LABELS'; labels: string[] }
  | { type: 'CONFIRM_LABELS'; labels: string[] }
  | { type: 'REMEMBER_CODEWORDS'; entries: CodewordMemoryEntry[] }
  | { type: 'RECALL_CODEWORDS' }
  // Background → content ping. The focused frame answers true, others false.
  // Used to route keyboard-derived actions to whichever frame the user is
  // actually interacting with (vs. chrome's default top-frame routing).
  | { type: 'GET_FOCUS_STATUS' }
  | { type: 'SCROLL_BOUNDARY'; boundary: 'top' | 'bottom' | 'left' | 'right' }
  | { type: 'REFERENCE_NAMES_CHANGED' }
  | { type: 'REFERENCE_SAVED'; host: string; name: string; reference: Record<string, unknown> }
  // Options → background. User wants to convert a visible hint codeword
  // (in a specific tab) into a stable CSS selector for inclusion in a
  // domain rule. Background looks up which frame owns the codeword via
  // the label pool and forwards a RESOLVE_HINT to that frame.
  | { type: 'RESOLVE_HINT_FROM_TAB'; tabId: number; codeword: string }
  // Background → content (specific frame). Resolve the codeword to an
  // element in the local store and synthesize a stable selector. Response
  // shape is ResolveHintResponse.
  | { type: 'RESOLVE_HINT'; codeword: string }
  // Content → background. Keyboard tab verbs (notes/DESIGN_TAB_NAVIGATION.md,
  // "Tab verbs"). Content scripts can't touch chrome.tabs, so the keybind
  // handlers forward the verb to handleTabAction in the background. The voice
  // path never sends this — it's intercepted in the background's SSE handler
  // before content forwarding. `index` is goto's 1-based tab position.
  | { type: 'TAB_ACTION'; action: TabAction; index?: number }
  // Options → background. The keymap editor renders voice phrases from its own
  // catalog now; it only asks whether BranchKit is connected so it can show the
  // not-connected note. Response: { connected: boolean }.
  | { type: 'GET_VOICE_STATUS' }
  // --- Command palette (notes/DESIGN_TAB_NAVIGATION.md, Layer 2) ---
  // Content (subframe) → background. A palette keybind fired in a frame that
  // can't host the overlay; background relays it to the top frame as a
  // PALETTE_COMMAND so the palette always opens over the whole page. `command`
  // is which palette (full vs tabs-only); defaults to toggle_palette.
  | { type: 'PALETTE_OPEN'; command?: 'toggle_palette' | 'toggle_tab_palette' }
  // Palette page (extension iframe) → background. A selection or an explicit
  // close. Background closes the overlay in the sender's tab first, then
  // executes: switch_tab directly, command via PALETTE_COMMAND to the tab.
  | { type: 'PALETTE_ACTION'; action: PaletteDispatch | { kind: 'close' } }
  // Background → content (top frame). Remove the palette iframe and restore
  // focus to the page.
  | { type: 'PALETTE_CLOSE' }
  // Background → content (top frame). Run a catalog command through the
  // content dispatcher — the palette's command rows use the exact semantics
  // of pressing the command's keybind.
  | { type: 'PALETTE_COMMAND'; action: string; params?: Record<string, string> }
  // --- Tab markers (notes/DESIGN_TAB_MARKERS.md, Phase 1) ---
  // Content (top frame) → background on load: fetch this tab's marker letters.
  // Response: { letters: string | null }. Assignment is lazy on this call.
  | { type: 'GET_TAB_MARKER' }
  // Background → content (top frame). Set (or clear, with null) the tab's
  // marker letters; the decorator force-writes the title prefix.
  | { type: 'TAB_MARKER'; letters: string | null }
  // Background → content (top frame) on page retitle. Re-apply the current
  // marker through the echo + incremental-edit guards.
  | { type: 'TAB_MARKER_REAPPLY' }
  // Palette page → background. The palette's voice session: codeword badges
  // assigned to every row at open. Background keeps the row_id → dispatch
  // map and POSTs the (spoken, row_id) entries to the plugin's /palette,
  // which Puts the exclusive palette tag. Sent only when the voice alphabet
  // is loaded — keyboard-only palettes have no voice session at all.
  | { type: 'PALETTE_PUBLISH'; entries: PaletteVoiceEntry[]; rows: PaletteVoiceRow[] }
  // Content → background. The palette overlay was removed (any close path:
  // background-driven PALETTE_CLOSE, local Ctrl+K toggle, blur). Background
  // drains the plugin's palette entries — which clears the exclusive tag —
  // and drops the dispatch map. Idempotent.
  | { type: 'PALETTE_CLOSED' };

/** One spoken palette codeword → row binding, published to the plugin. */
export interface PaletteVoiceEntry {
  spoken: string;
  row_id: string;
}

/** Background-side row dispatch record — never leaves the extension. */
export interface PaletteVoiceRow {
  row_id: string;
  dispatch: PaletteDispatch;
}

// Response to RESOLVE_HINT / RESOLVE_HINT_FROM_TAB.
export type ResolveHintResponse =
  | {
      ok: true;
      selector: string;
      tagName: string;
      accessibleName: string;
    }
  | { ok: false; reason: string };

// Response to CLAIM_LABELS. Returned via sendResponse callback.
// `labels` is index-aligned to the request: `labels[i]` is the codeword for
// the i-th requested slot, or '' when the pool was exhausted before reaching
// it. Empty array if the pool isn't ready (alphabet not loaded yet).
export interface ClaimLabelsResponse {
  labels: string[];
}

// Response to CONFIRM_LABELS (review bug #5 / epoch-handshake Phase 4).
// Confirm is an arbitrated exchange, not fire-and-forget: `rejected` lists
// the codewords this frame may NOT keep — they are reserved/assigned to a
// different frame (it won the release-vs-confirm race) or unknown to the
// pool (stale alphabet). The frame drops them locally and re-claims fresh.
// Empty when every label was promoted or directly acquired.
export interface ConfirmLabelsResponse {
  rejected: string[];
}

// --- Frame label pool ---

/**
 * Per-tab pool of voice-recognizable codewords. Stored in
 * chrome.storage.session at key `labelStack:${tabId}`.
 *
 * Three states track a codeword's relationship to a frame:
 *   - `free` — available to any frame's next refill
 *   - `reserved` — a frame's reservoir has the codeword but no wrapper
 *     has actually committed to using it. NOT routable: voice
 *     activations for reserved codewords fall through to the
 *     broadcast-to-all-frames fallback so the frame that DOES have a
 *     matching wrapper (typically a different one — iframes routinely
 *     pre-fetch codewords they never use) gets the chance to handle it.
 *   - `assigned` — a wrapper in a specific frame has claimed the
 *     codeword and confirmed via CONFIRM_LABELS. The frame is the
 *     routable owner.
 *
 * Pre-PR-6 the reserved/assigned distinction didn't exist; refill
 * marked codewords assigned-to-frame immediately, so iframe reservoirs
 * accumulated phantom ownership of codewords no wrapper would ever use
 * and voice routing landed there. See actuator.log 2026-06-05T17:18:37
 * for the QuickBase `fine jury` failure that motivated this split.
 */
export interface LabelStack {
  /** Unclaimed codewords. Singles first, pairs at the end. */
  free: string[];
  /**
   * Codewords held in a frame's reservoir but not yet claimed by a
   * wrapper. The map's value is the holding frameId so `releaseFrame`
   * can free them on frame disconnect, but the SW's `getFrameForLabel`
   * routing intentionally does NOT consult this map — that's the whole
   * point of the split. Confirmation via CONFIRM_LABELS promotes
   * reserved → assigned.
   */
  reserved: Record<string, number>;
  /** Wrapper-confirmed codewords mapped to their owning frameId. */
  assigned: Record<string, number>;
}

// --- Grammar format matching browser plugin Go types ---

export interface FieldInfo {
  label: string;
  type: string;
  id: number;
  frame_id: number;
  position: number;
  codeword: string;
}

export interface ClickableInfo {
  label: string;
  id: number;
  frame_id: number;
  type: string;
  codeword: string;
}

export interface TableLink {
  label: string;
  id: number;
  frame_id: number;
  href: string;
  table_id: string;
  codeword: string;
}

// Outcome of one content-script action attempt. Shapes the body content
// sends to background and (after forwarding) the body background POSTs to
// the plugin's /dispatch-result endpoint.
export interface DispatchResult {
  action: string;            // e.g. "activate", "scroll", "noop"
  codeword: string;          // e.g. "arch check" — empty for non-codeword actions
  resolution: 'registry' | 'fingerprint' | 'snapshot' | 'live_store' | 'none';
  elem_tag: string;          // actual tag of the resolved element, e.g. "input"
  taken: 'focus' | 'click' | 'skipped' | 'noop';
  ok: boolean;               // overall success
  frame: string;             // window.location.href, trimmed
  detail: string;            // optional error message or notes
  // Attempted fingerprint, for diagnostic grep in actuator.log when
  // resolution falls through to live_store/none. Format from
  // registry.fingerprintToString — flat key=value, not JSON.
  fp: string;
}

export interface GrammarRequest {
  fields: FieldInfo[];
  clickables: ClickableInfo[];
  tables: TableLink[];
  app_id: string;
  table_id: string;
  bundle_id: string;
  hint_visibility: HintVisibility;
  // Chrome tab ID this grammar came from. Plugin uses this only for
  // observability — log lines and emitted events include it so multi-tab
  // bugs are visible. No plugin-side enforcement; the extension is the
  // single source of truth for which tab's grammar is live.
  tab_id?: number;
}
