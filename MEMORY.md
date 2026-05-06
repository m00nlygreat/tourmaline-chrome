# Memory

- Keep this file selective. Only record repeated pitfalls or major implementation/debugging takeaways that are likely to matter again.

## Chrome File URLs

- For this project, "open Markdown by file path" means opening the Markdown file itself in Chrome, such as `file:///E:/notes/a.md`, and letting a content script transform that page.
- `app.html?file=file:///...` is the wrong default mental model for the Chrome extension flow. It can read like a web app workaround instead of an extension integrating with the file page.
- Chrome file URL content scripts require the user to enable "Allow access to file URLs" on the extension details page.
- `file://` read access from a content script does not imply write access to the original Markdown file. Save behavior needs a real file handle or a separate explicit write mechanism.

## PWA Boundary

- PWA File Handling API is the route for OS-level open-with or double-click file association, but that is a different target from the Chrome extension file URL workflow.
- Do not introduce PWA scaffolding unless OS file-handler registration becomes an explicit requirement again.
