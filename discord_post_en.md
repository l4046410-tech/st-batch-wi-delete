**World book graveyard? Bulk-delete them without losing them**

My World Info list had 71 half-finished lorebooks. Deleting them one at a time is genuinely miserable, so I wrote a small extension.

**Delete whole books at once**
Searchable list, entry count on every book, multi-select, one click. There's a "delete everything" button, but it requires typing a confirmation phrase — no accidental nukes.

**Backup first, always**
Selected books are packed into a single JSON and downloaded *before* anything is deleted. One file, not one-per-book: browsers only let the first of several consecutive downloads through, so the rest vanish silently.

**Prune entries when you only want to trim**
Empty entries, disabled entries, duplicate content — quick filters, the book itself survives. Same backup behaviour.

**Chinese and English, one button**
An `EN / 中` toggle in the panel header flips every label instantly, including the delete-all confirmation word. It remembers your choice per browser.

**Looks native**
Uses SillyTavern's own `inline-drawer`, so it folds like every other settings panel and behaves on narrow phone screens.

**Install**
Drop the folder into `public/scripts/extensions/third-party/`, enable it, Ctrl+F5. Panel sits at the bottom of Extensions settings.

**Under the hood**
Prefers ST's own `deleteWorldInfo()` / `saveWorldInfo()`, falls back to `/api/worldinfo/*`, and always sends the CSRF header. If an extension ever reported "failed to load" for every single book, that missing `X-CSRF-Token` is usually why.

**Honest notes**
• Verified with a jsdom harness (40 assertions against a mocked ST), not against every ST build. Try one unimportant book first.
• No telemetry, no network calls. MIT.

**github.com/l4046410-tech/st-batch-wi-delete**

Feedback welcome — especially which cleanup filters you'd actually use next (overlong entries? books no character card references?).
