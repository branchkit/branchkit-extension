# Store Listing — BranchKit Browser

Use this content when submitting to Chrome Web Store and Firefox Add-ons.

---

## Name

BranchKit Browser

## Short Description (132 chars max for Chrome)

Voice-navigable hint badges for any website. Say a codeword to click, type, or navigate — hands-free browsing with BranchKit.

## Full Description

BranchKit Browser adds voice-navigable hint badges to interactive elements on any web page. Each badge shows a short codeword — say it out loud to click a button, focus an input field, or navigate a link. No mouse needed.

**How it works:**
- The extension scans the page for interactive elements (buttons, links, form fields, tabs)
- Each element gets a hint badge with a unique codeword (e.g., "ape", "beam", "cave")
- Say the codeword through BranchKit's push-to-talk to activate that element
- Works on any website — no site-specific configuration needed

**Voice command groups:**
- "go" — show clickable element hints (buttons, links, tabs)
- "set" — show form field hints (inputs, dropdowns, textareas)
- "tables" — show data table navigation hints

**Privacy first:**
- All data stays on your computer — element data is sent only to localhost
- No external servers, no analytics, no tracking
- No browsing history or personal data is collected or stored

**Requirements:**
- BranchKit desktop app (macOS) — provides push-to-talk voice recognition
- Works with Chrome, Edge, Arc, and Firefox

**Open source** — inspect the code yourself.

## Category

Chrome Web Store: Accessibility
Firefox Add-ons: Accessibility

## Tags / Keywords

voice control, accessibility, hands-free, dictation, voice navigation, hint badges, keyboard-free

---

## Review Justification for `<all_urls>`

(Submit this in the Chrome Web Store "Justify permissions" field)

This extension provides voice-navigable hint badges for interactive page elements (buttons, links, form fields) on any website. It must run on all pages because:

1. Voice navigation should work everywhere — users need consistent access across all sites
2. The extension scans the DOM to identify interactive elements and cannot predict which sites the user will visit
3. This is the same pattern used by accessibility tools like Vimium, which also require `<all_urls>`

All collected data (element labels and CSS selectors) is sent exclusively to localhost (127.0.0.1) — the companion desktop app running on the user's own machine. No data is transmitted to external servers. No browsing history, URLs, or personal information is collected.

## Review Justification for `tabs`

The `tabs` permission is required to broadcast voice command results to the correct browser tab. When a voice command matches (e.g., "click the Submit button"), the extension needs to route the action to the active tab's content script. Additionally, when the user changes badge display settings, the change must propagate to all open tabs.
