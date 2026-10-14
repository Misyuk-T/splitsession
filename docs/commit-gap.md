# Known residual hole: the "commit gap" in same-origin frames and popups

Research: 2026-10-10 (Playwright Chromium 156, headless, own test stand). Decision of 2026-10-10: **document it; do not build a paranoid mode.**

## The problem
When a same-origin frame (or popup) navigates to a new document, that document exists for at least one task before SplitSession's content scripts run in it. Chrome schedules `document_start` scripts only from `DidCreateDocumentElement`, and between the document's commit and that moment an extension has no hook (`extensions/renderer/script_injection_manager.cc`). This is how Chrome is built, not a bug.

A page that deliberately polls its own frame or popup in a loop while it navigates reads the **raw** values of its origin in that window: the real profile's cookies and localStorage, and the set of `__facet:<key>:` keys of all containers. A hostile site can therefore link accounts **on its own origin**. Other sites and HttpOnly sessions are not affected.

## Measurements (10 or 5 navigations each)
| Navigation | Leak |
|---|---|
| http same-origin, slow body, 302 to same-origin | 10/10 |
| cross-origin hop `b -> a` (`location.href` from a foreign document) | 5/5 |
| `blob:` same-origin HTML | 10/10 (localStorage; `document.cookie` is empty for `blob:`) |
| `about:blank`, `javascript:` | **0** (the shim already covers them) |
| cross-origin hop to a foreign `blob:` | 0 (Chrome blocks such a navigation itself) |
| `window.open` popup, same-origin, navigations | **5/5** (the same hole) |

## Checked and rejected
| Idea | Why not |
|---|---|
| Remove the real cookies/storage from the origin, "invert" the namespacing | The window shows the set of `__facet:...` keys of all containers in localStorage/IndexedDB/Cache, and the set itself links the containers; IndexedDB and Cache cannot be renamed; storage cannot be moved out of the origin synchronously (a DNR `data:` redirect holds at most 2 MB) |
| Guarded Proxy on `frames`/`contentWindow`, delaying `load` | `window[0]` is an indexed named property and cannot be intercepted; a Proxy breaks identity (`event.source`, `postMessage`); the WindowProxy is the same across all navigations |
| `Origin-Agent-Cluster: ?1` via DNR | No effect (10/10): OAC only separates same-site cross-origin documents |
| COEP / Document-Policy / Permissions-Policy | Irrelevant |
| CSP `sandbox allow-scripts allow-same-origin` | Leaks 10/10 (the origin is the same) |
| `scripting.executeScript` from `onCommitted` with `injectImmediately` | Won 0 of 10: the IPC task is queued behind the poller's tasks |
| CHIPS / storage partitioning / Storage Access API | Apply only to third-party contexts |

## What would close it (not implemented, by decision)
- **iframes:** DNR `append` of `content-security-policy: sandbox` **without** `allow-same-origin` on `sub_frame` requests of managed sites in container tabs: 0/5 leaks, including 302 and the cross-origin hop. Cost: every same-origin iframe application in a container tab stops working (localStorage and `document.cookie` throw SecurityError, `fetch` gets an opaque origin).
- **`blob:`:** have the shim refuse same-origin HTML/XML/SVG `blob:` navigations of frames.
- **popups:** DNR `Cross-Origin-Opener-Policy: same-origin` on the popup's `main_frame` severs the opener. It closes the hole but breaks OAuth popups that use `opener.postMessage`.

If it is ever needed, it would be an opt-in "paranoid mode", not the default behaviour.
