# Current Work

## Editable WYSIWYG Cards

- Replace the raw Markdown textarea as the primary editor.
- Make each canvas card directly editable in a WYSIWYG style, closer to Notion, Typora, or Bear.
- Treat Markdown as the import/export and persistence format, not as the main visible editing surface.
- Card edits should update the underlying document model and serialize back to Markdown for save.
- Keep card movement and resizing separate from text editing:
  - Card chrome, header, or border handles card selection, movement, and resizing.
  - Card body handles text editing.
  - Editing mode should not accidentally drag the card.

## Implementation Direction

- First milestone: remove the visible `textarea` editor panel and make card bodies editable.
- Prefer a real editor model such as Tiptap/ProseMirror for durable WYSIWYG behavior.
- Avoid long-term dependence on ad hoc `contenteditable` logic for lists, undo, paste, and Markdown round-tripping.
- Existing line-range Markdown operations can be used only as a temporary bridge; the target design should use document transactions or structured card content updates.
