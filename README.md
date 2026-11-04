# Wardrobe for Inline Image Generation

An outfit manager for SillyTavern that plugs into **sillyimages** (Inline Image Generation).
Works on PC and mobile (full-screen panel and bottom sheets on phones).

## Install
SillyTavern → Extensions → Install extension → paste this repo's URL,
or copy the `sillywardrobe` folder to `SillyTavern/data/<user>/extensions/`.
Requires the sillyimages extension to be installed and enabled.

## Use
- Open the wardrobe from the **wand menu → Wardrobe** or **Extensions → Wardrobe → Open wardrobe**.
- **+ Outfit**: add a picture (camera or gallery), a name, a prompt, a folder and tags.
- Wear it: tap the robot button (character), the person button (you), or **Both** in the outfit sheet.
  Each character and each persona remembers its own outfit.
- Folders: **+ Folder**, then **Edit** to rename or delete. Tags: tap to filter; search covers names, prompts and tags.

## What gets sent (Extensions → Wardrobe)
- **Prompt**: the outfit text goes into the image prompt.
- **Picture**: the outfit image goes out as a reference image.
- **Both**: text and image.
- Optional fallback when an outfit lacks the chosen part, plus an editable prompt prefix and picture note.

## Opacity
The droplet button in the panel header (or **Extensions → Wardrobe → Panel opacity**) sets how see-through the panel is, 30–100%, so you can keep an eye on the chat behind it.

## How it connects
The worn outfit is written into sillyimages' *Character library* as managed items (ids start with `wardrobe-`),
so it is sent with every generation. No sillyimages files are modified.
Pictures are only used if the provider/model supports reference images.

## Chat-model macros
`{{outfit_char}}` and `{{outfit_user}}` insert the worn outfit prompt into a card or preset,
so the chat model writes matching image prompts.

## Backup
Export/Import (settings drawer) saves outfits, folders and tags, with pictures embedded, as JSON.
