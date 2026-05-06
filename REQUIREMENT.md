# Tourmaline Chrome

## Overview

Chrome extension port of Tourmaline for opening local Markdown files as an editor plus visual canvas preview.

## File URL Mode

- The primary Chrome workflow is opening a Markdown file directly as `file:///.../note.md`.
- The extension must use a content script on `file:///*.md` and `file:///*.markdown` to replace Chrome's plain file view with the Tourmaline UI.
- Users must enable Chrome's "Allow access to file URLs" option for the unpacked extension before file URL content scripts can run.
- `app.html` may remain as a secondary extension page, but it is not the primary local Markdown opening flow.
- Loading `app.html?file=file:///...` is not the desired model for normal file URL use.

## Chrome Extension Scope

- The build output for the Chrome extension is `/dist`.
- The extension is Manifest V3.
- The content script reads the Markdown text from the opened file page before replacing the document body.
- The content script injects the shared Tourmaline app shell and then runs the shared app logic.
- The source Markdown file remains the content source of truth.
- A file opened through `file://` does not grant write access by itself; direct overwrite still requires File System Access API file handles or another explicit write path.

## Non-Goals

- Do not require PWA installation for the normal Chrome extension workflow.
- Do not rely on OS double-click file association for the first Chrome extension target.
- Do not edit files under `/tourmaline`; use that subfolder as reference-only.
