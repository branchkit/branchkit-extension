/**
 * BranchKit Browser — Message protocol and shared types.
 */

// --- Categories ---

export type Category = 'link' | 'button' | 'input' | 'tab' | 'edit' | 'view' | 'tables';

// --- Badge Display ---

export type BadgeDisplayMode = 'word' | 'letter' | 'both';
export type HintVisibility = 'always' | 'manual';

// --- Scanned Elements ---

export interface ScannedElement {
  label: string;
  selector: string;
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
}

// --- Messages ---

export type Message =
  | { type: 'SCAN_RESULT'; elements: ScannedElement[]; adapter: string | null }
  | { type: 'SHOW_HINTS'; category?: Category }
  | { type: 'HIDE_HINTS' }
  | { type: 'BRANCHKIT_ACTION'; payload: { action: string; params: Record<string, string> } }
  | { type: 'SSE_EVENT'; data: unknown }
  | { type: 'HEALTH_STATUS'; branchkit: boolean }
  | { type: 'GRAMMAR_PUSH'; elements: ScannedElement[] }
  | { type: 'GET_HEALTH' }
  | { type: 'CONNECT_SSE'; port: number; token: string }
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
  | { type: 'REFERENCE_SAVED'; host: string; name: string; reference: Record<string, unknown> };

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
  fid: string;
  label: string;
  type: string;
  selector: string;
  id: string;
  position: number;
  codeword: string;
}

export interface ClickableInfo {
  label: string;
  selector: string;
  type: string;
  codeword: string;
}

export interface TableLink {
  label: string;
  selector: string;
  href: string;
  table_id: string;
  codeword: string;
}

export interface GrammarRequest {
  fields: FieldInfo[];
  clickables: ClickableInfo[];
  tables: TableLink[];
  app_id: string;
  table_id: string;
  bundle_id: string;
}
