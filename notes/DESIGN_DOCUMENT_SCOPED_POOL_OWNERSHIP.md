# Document-scoped pool ownership — retiring the frame-identity gap

**Status:** designed + implemented 2026-07-24. Successor to the mitigations in
DESIGN_PRERENDER_POOL_POISONING.md — this re-key makes the whole bug class
(pool truth diverging from content-script truth across document transitions)
unrepresentable, and retires the patch-shaped parts of that fix.

## 1. The identity gap (recap)

The pool keyed ownership by (tabId, frameId). A frameId names a slot in the
tab's frame tree; label lifetimes follow DOCUMENTS, which rotate through that
slot. Two field failures on 2026-07-24 were the same gap:

- **Prerender:** a document born under a provisional frameId (4241) becomes
  frame 0 at activation — same document, new frame identity; its claims
  strand under an id nothing will ever reap.
- **bfcache:** the outgoing and restored documents BOTH answer to frame 0 —
  the outgoing document's port-disconnect release wipes the restored
  document's re-asserted claims (raced today, patched with reconfirm-twice).

## 2. The Firefox spike (resolved)

`MessageSender.documentId` — the browser-native document identity — is
Chrome 106+ and **Firefox 153+ (released July 2026)**; Mozilla's stated
motivation is exactly this class ("frameId identifies the frame rather than
its content" — see the Firefox 153 WebExtensions blog post and MDN's "Work
with documentId" page). Conclusion: usable as a cross-check, but too new to
be the primary key (store users on Firefox <153 would silently regress to
the old behavior). **Primary identity is therefore CS-minted**, which works
on every browser version and is fully in our control.

## 3. Design

**Identity.** `labels/document-identity.ts` mints one
`documentInstanceId` (UUID) per content-script context — which IS a
document: bfcache freezes and restores the same context (same id), prerender
activation continues the same context (same id), navigation creates a new
context (new id). Exactly the lifetime labels follow.

**Wire.** The reservoir stamps `doc_id` on CLAIM_LABELS / CONFIRM_LABELS /
RELEASE_LABELS (it is the single sender of all three). The liveness Port
carries the id in its NAME (`frame-liveness:<docId>`) so the SW has it
atomically at onConnect — no handshake race for the disconnect cleanup.

**Pool schema.** `reserved` and `assigned` map label → `{ d: docId,
f: frameId }`. The docId is OWNERSHIP (arbitration compares it); the
frameId is ROUTING (getFrameForLabel returns it; chrome.tabs.sendMessage
needs a frame target). The owner's frameId is refreshed on every confirm,
which is the prerender heal: the same document confirming post-activation
updates routing from the provisional id to the real one.

**Arbitration (confirmLabels), per label:**
- reserved by this doc → promote to assigned with the CURRENT frameId
- assigned to this doc → idempotent; refresh frameId if it changed
- in free → direct acquire (released-then-reclaimed, unchanged semantics)
- owned by another doc → REJECTED (unchanged — this check is load-bearing)

**Cleanup.** `releaseFrame` becomes `releaseDocument(tabId, docId)`, wired
to the port disconnect via the port-name id. A dying document can only ever
free its OWN labels — the bfcache race is structurally gone, so the restore
path's +1.5s second reconfirm shot is deleted (retirement, per the
clean-end-state rule).

**No storage migration.** Stacks live in chrome.storage.session and
clearAllStacks runs at SW init; the new build arrives via an extension
reload, which restarts the SW. Defensive: a stack loaded with the old
numeric owner shape is discarded wholesale (pre-launch, no back-compat).

## 4. What stays from the poisoning fix

- **L1 prerender deny — KEPT.** Correct under any keying: a document that
  may never activate shouldn't consume pool economy. (With doc-keying it is
  no longer load-bearing for correctness, only for economy.)
- **L2 reservation TTL steal — KEPT.** General backstop against any future
  leak source (e.g. a reservoir dying in an SW-asleep window). Owner
  comparison becomes doc-scoped.
- **L3 rejection cache-flush — KEPT.** A rejection still means suspect
  provenance; flushing remains the convergent recovery. Under doc-keying
  rejections should become rare and REAL (a genuine cross-document race).
- **Restore reconfirm — KEPT, single-shot.** A restored document's labels
  were legitimately freed when it entered bfcache; it still must re-acquire.
  Only the race-healing second shot retires.

## 5. Open items

- `sender.documentId` cross-check (Chrome 106+/Firefox 153+): assert
  CS-minted id ↔ browser documentId stability in a dev-only breadcrumb;
  promotes to primary key when Firefox 153 is a safe floor.
- The plugin-side frame sessions (`/grammar/batch` frame_id) still key by
  frame; they are display-grade post-demotion, so the same gap there is
  cosmetic. Revisit only if the HUD menus show stale-frame residue.
