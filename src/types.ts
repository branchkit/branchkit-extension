/**
 * BranchKit Browser — Message protocol and shared types.
 */

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
  bundle_id: string;
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
  result: 'ok' | 'error';
  succeeded: string[];
  failed: GrammarBatchFailure[];
}

// --- Messages ---

export type Message =
  | { type: 'SCAN_RESULT'; elements: ScannedElement[]; adapter: string | null }
  | {
      type: 'GRAMMAR_BATCH';
      /** Content omits tab_id/frame_id; SW stamps them from sender. */
      request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>;
    }
  | { type: 'SHOW_HINTS'; category?: Category }
  | { type: 'HIDE_HINTS' }
  | { type: 'BRANCHKIT_ACTION'; payload: { action: string; params: Record<string, string> } }
  | { type: 'SSE_EVENT'; data: unknown }
  | { type: 'HEALTH_STATUS'; branchkit: boolean }
  | { type: 'GRAMMAR_PUSH'; elements: ScannedElement[] }
  | { type: 'GET_HEALTH' }
  | { type: 'CONNECT_SSE'; port: number; token: string }
  // Content → background, after handling a BRANCHKIT_ACTION. Background
  // forwards to the browser plugin's POST /dispatch-result so the actuator
  // log carries end-to-end visibility (voice → match → dispatch → frame
  // resolution → outcome) without having to cross-reference SW DevTools.
  | { type: 'DISPATCH_RESULT'; payload: DispatchResult }
  // Frame label pool — content asks background for codewords so frames in
  // the same tab don't independently pick the same label. See
  // notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md section 2.
  | { type: 'CLAIM_LABELS'; count: number }
  | { type: 'RELEASE_LABELS'; labels: string[] }
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
  | { type: 'RESOLVE_HINT'; codeword: string };

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
// May be shorter than `count` if pool was partially exhausted; empty array
// if the pool isn't ready (alphabet not loaded yet).
export interface ClaimLabelsResponse {
  labels: string[];
}

// --- Frame label pool ---

/**
 * Per-tab pool of voice-recognizable codewords. Stored in
 * chrome.storage.session at key `labelStack:${tabId}`.
 *
 * `assigned` doubles as a routing table: when an action references a
 * codeword, the background looks up `assigned[codeword]` to find the
 * frame that owns it and routes the action there.
 */
export interface LabelStack {
  /** Unclaimed codewords. Singles first, pairs at the end. */
  free: string[];
  /** Claimed codewords mapped to their owning frameId. */
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
