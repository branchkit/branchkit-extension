/**
 * BranchKit Browser — Message protocol and shared types.
 */

// --- Categories ---

export type Category = 'link' | 'button' | 'input' | 'tab' | 'edit' | 'view' | 'tables';

export const CATEGORY_COLORS: Record<Category, { bg: string; fg: string; border: string }> = {
  input:   { bg: '#f5a623', fg: '#000',  border: '#c88400' },   // Gold
  edit:    { bg: '#ff9500', fg: '#000',  border: '#cc7700' },   // Orange
  view:    { bg: '#5ac8fa', fg: '#000',  border: '#3aa8d8' },   // Teal
  tab:     { bg: '#007AFF', fg: '#fff',  border: '#005ecb' },   // Blue
  link:    { bg: '#af52de', fg: '#fff',  border: '#8a3fb5' },   // Purple
  button:  { bg: '#007AFF', fg: '#fff',  border: '#005ecb' },   // Blue
  tables:  { bg: '#28a745', fg: '#fff',  border: '#1e7e34' },   // Green
};

// --- Badge Display ---

export type BadgeDisplayMode = 'word' | 'letter' | 'both';

// --- Scanned Elements ---

export interface ScannedElement {
  label: string;
  selector: string;
  category: Category;
  type: string;         // more specific: 'record_action', 'nav', etc.
  adapter: string | null;
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
  | { type: 'CONNECT_SSE'; port: number; token: string };

// --- Grammar format matching browser plugin Go types ---

export interface FieldInfo {
  fid: string;
  label: string;
  type: string;
  selector: string;
  id: string;
  position: number;
}

export interface ClickableInfo {
  label: string;
  selector: string;
  type: string;
}

export interface TableLink {
  label: string;
  selector: string;
  href: string;
  table_id: string;
}

export interface GrammarRequest {
  fields: FieldInfo[];
  clickables: ClickableInfo[];
  tables: TableLink[];
  app_id: string;
  table_id: string;
  bundle_id: string;
}
