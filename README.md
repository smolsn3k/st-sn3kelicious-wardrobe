# Wardrobe

An outfit manager for SillyTavern that works with any image generator: outfits are saved per chat and can be picked automatically from the scene.
Works on PC and mobile (full-screen panel and bottom sheets on phones).

## Install
SillyTavern → Extensions → Install extension → paste this repo's URL,
or copy the `sillywardrobe` folder to `SillyTavern/data/<user>/extensions/`.
No other extension is required. If you use sillyimages, SillyTavern's Image Generation or any other generator, see *Works with any image generator* below.

## Use
- Open the wardrobe from the **wand menu → Wardrobe** or **Extensions → Wardrobe → Open wardrobe**.
- **+ Outfit**: add a picture (camera or gallery), a name, a prompt, a folder and tags.
- Wear it: tap the robot button (character), the person button (you), or **Both** in the outfit sheet.
  **Worn outfits are saved per chat**: every chat remembers what the character and your persona wear in it, so two chats with the same character can have different outfits. The outfit library itself (pictures, folders, tags) is shared by all chats.
- Folders: **+ Folder**, then **Edit** to rename or delete. Tags: tap to filter; search covers names, prompts and tags.

## sillyimages library: what gets sent (Extensions → Wardrobe)
- **Prompt**: the outfit text goes into the image prompt.
- **Picture**: the outfit image goes out as a reference image.
- **Both**: text and image.
- Optional fallback when an outfit lacks the chosen part, plus an editable prompt prefix and picture note.

## Opacity
The droplet button in the panel header (or **Extensions → Wardrobe → Panel opacity**) sets how see-through the panel is, 30–100%, so you can keep an eye on the chat behind it.

## Diagnostics
Extensions → Wardrobe → **Run diagnostics** briefly opens the panel, tests +Outfit, saving and editing, checks for duplicate installs, and shows a report you can copy.

## How it connects
Wardrobe is not tied to one extension; see *Works with any image generator* below for every route.
With sillyimages installed, the worn outfit is also written into its *Character library* as managed items (ids start with `wardrobe-`), so it is sent with every generation. No sillyimages files are modified. Pictures are only used if the provider/model supports reference images.

## Chat-model macros
`{{outfit_char}}`, `{{outfit_user}}` and `{{outfit_both}}` insert the worn outfit prompt into a card or preset,
so the chat model writes matching image prompts.

## Backup
Export/Import (settings drawer) saves outfits, folders and tags, with pictures embedded, as JSON.

## Chat-model injection (works with any provider)
Because the image prompt is written by your chat model, Wardrobe also tells it what each side is wearing in the current chat (Extensions → Wardrobe → *Tell the chat model what is worn*, on by default). That puts the outfit into the picture prompt even for text-only providers such as direct NovelAI, which ignore reference pictures. The outfit's **prompt text** is what gets used, so write it in the style your image model likes (tags for NovelAI).

### Direct NovelAI note
sillyimages sends library descriptions to NovelAI as extra `| ...` character prompts and never sends pictures, so on direct NovelAI Wardrobe relies on the chat-model injection above and skips the library text (turn on *Direct NovelAI: also send the outfit as an extra character prompt* to restore it). Also check sillyimages → NovelAI → *Send character descriptions* is not "Do not send" if you use the library route.

## Works with any image generator
Wardrobe is not tied to one extension. Every route is a checkbox under Extensions → Wardrobe → *Other image generators*:

| Route | Works with |
|---|---|
| Chat-model injection (on) | Anything where the chat model writes the image prompt |
| SillyTavern Image Generation hook (on) | The built-in `/sd` extension (via its `sd_prompt_processing` event) |
| sillyimages library (on) | sillyimages |
| Catch-all request hook (off, advanced) | Any extension that POSTs a JSON image request whose URL matches your patterns; adds the outfit to the `prompt` / `input` / `base_caption` fields |

For extension authors: `window.WardrobeAPI.getAll()` / `.getWorn('char'|'user')` / `.getPrompt('char'|'user'|'both')` / `.onChange(fn)`, the `wardrobe_changed` event on SillyTavern's `eventSource` (and a `wardrobe:changed` DOM event), macros `{{outfit_char}}`, `{{outfit_user}}`, `{{outfit_both}}`, and slash commands `/outfit-get`, `/outfit-wear char|user <name>`, `/outfit-off`.

## Auto outfits (lorebook-style)
Switch it on from the **Auto outfits** chip in the panel. Outfits are picked from a pool you choose, based on what the recent messages are about.
- **Tags are trigger words.** An outfit tagged `home` fires when the scene mentions home, house, bedroom, kitchen, apartment and so on. About 25 common tags have built-in synonym sets in English and Russian (`winter`, `beach`, `work`, `formal`, `rain`, `night` and more). Add your own words or a `/regex/` per tag. Tag aliases such as `pajamas`, `cozy` or `fall` map onto the right set.
- **Recent messages decide.** The last N messages are read (default 3), newer ones count more. If several pool outfits match, the one matching the most tags wins, and the one already worn is kept on ties.
- **Nothing matches?** Keep the current outfit (default), wear the outfit tagged `default`, or take it off.
- **Pools per subject:** the character, your persona and any number of **NPCs**. An NPC is found by its name (and nicknames) appearing in the recent messages, and its outfit is only sent while it is in the scene.
- **Per chat:** auto-chosen outfits live in the chat like manual ones. Wearing something by hand pins that subject until you press *Resume auto*. `/outfit-auto on|off|now|preview` works too.
- NPC outfits reach the chat model through the injection, the catch-all (*Everyone in the scene*) and `WardrobeAPI.getAll().npcs`.
