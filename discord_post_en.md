**Batch-delete world books without losing them**

If your World Info dropdown has turned into a graveyard of half-finished lorebooks (mine reached 71), deleting them one at a time is miserable. So I wrote an extension that does it properly.

**① Delete whole world books**
Searchable list of every book with its entry count, multi-select, one click deletes the files. A "delete everything" button requires typing a confirmation phrase — no accidental nukes.

**② Backup before anything is deleted**
Selected books are packed into a **single JSON** and downloaded first. One file, not one-per-book: browsers only allow the first of several consecutive downloads, so the rest silently vanish.

**③ Entry-level cleanup, when you only want to prune**
Empty entries, disabled entries, duplicate content — quick filters, book stays intact. Same backup behaviour.

**④ Native ST drawer UI**
Uses SillyTavern's own `inline-drawer`, so it folds like every other settings panel and remembers its state per browser. Works on narrow phone screens.

**Install**
Drop the folder into `public/scripts/extensions/third-party/`, enable it, Ctrl+F5. Panel is at the bottom of Extensions settings.

**How it talks to the server**
Prefers ST's own `deleteWorldInfo()` / `saveWorldInfo()`, falls back to `/api/worldinfo/*`, and always sends the CSRF header. If an extension ever reported "failed to load" for every book, that missing `X-CSRF-Token` is usually why.

**Honest notes**
• UI is currently **Chinese-only** — say the word and English strings move to the top of the list.
• Verified with a jsdom harness (28 assertions against a mocked ST), not every ST build. Try one unimportant book first.
• No telemetry, no external requests. MIT.

**github.com/l4046410-tech/st-batch-wi-delete**

Feedback welcome — especially which cleanup filters you'd actually use (long entries? unreferenced books?).
