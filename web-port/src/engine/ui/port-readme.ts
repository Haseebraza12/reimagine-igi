/**
 * The text of the main menu's "Read Me First!" box (AsciiBox "Text File"
 * LANGUAGE:readme.txt). igi.exe shows the installation's ReadMe.txt there; the
 * port shows this note about the port itself instead. Plain ASCII only: the
 * menu font has no other glyphs.
 */
export const PORT_README = `
Project IGI - Web Port
READ ME
A hobby project by Haseeb ur Rehman, CS Graduate
Contact: munibhaseeb2@gmail.com

Part I   - About this project
Part II  - What you can play
Part III - Controls
Part IV  - Legal notice

++++++++++++++++++++++++++++++++++++++++++++++++++++++
*** PART I - ABOUT THIS PROJECT ***
++++++++++++++++++++++++++++++++++++++++++++++++++++++

This is a personal, non-commercial hobby project. It rebuilds Project IGI: I'm Going In (2000) so that it runs in a modern web browser, with no installation and no plug-ins.

It is a showcase of reverse engineering and web technology. It is not a distribution of the game, and it is not for sale.

How it works
- The game's own files (missions, models, textures, sounds, scripts and menus) are read and decoded in the browser while it runs. Nothing is converted in advance.
- The rules of the game were recovered from the original program and written again in TypeScript: the 30 Hz game tick, the soldiers' AI scripts, weapons and damage, vehicles, cut-scenes, menus and the HUD.
- 3D graphics are drawn with WebGL (three.js) and sound is mixed with the Web Audio API. Settings are kept in your browser's storage.
- Every recovered rule is documented with its evidence in the project's documents.

++++++++++++++++++++++++++++++++++++++++++++++++++++++
*** PART II - WHAT YOU CAN PLAY ***
++++++++++++++++++++++++++++++++++++++++++++++++++++++

- All 14 missions, from Trainyard to Finding the bomb, with their cut-scenes, objectives, soldiers, vehicles and the map computer.
- Play Project IGI asks for Story Mode (the missions in order, as in the original) or Free Mode (any mission, in any order).
- Configuration > Cheats (also in the pause menu): Unlimited Ammo, Unlimited Health, One Shot Kills, Invisible To Enemies and All Weapons. Every cheat is off until you switch it on.
- Quit on the main menu closes the browser tab.

Not included: the intro movies and the credits text.

++++++++++++++++++++++++++++++++++++++++++++++++++++++
*** PART III - CONTROLS ***
++++++++++++++++++++++++++++++++++++++++++++++++++++++

Click the game to capture the mouse. Esc skips a cut-scene or opens the pause menu.

Move ............... arrow keys or W A S D
Look ............... mouse
Fire ............... left mouse button
Next weapon ........ right mouse button
Weapon groups ...... 1 to 9
Reload ............. Enter or R
Use ................ Right Shift (doors, ladders, switches, computers)
Crouch ............. Right Ctrl (hold)
Jump ............... Numpad 0
Peek ............... Numpad 1
Walk / run ......... Caps Lock
Map computer ....... C
Binoculars ......... Space
Zoom ............... Page Up / Page Down or the mouse wheel
Scope / zoom ....... Backspace or the middle mouse button

You can change every key in Configuration > Controls.

++++++++++++++++++++++++++++++++++++++++++++++++++++++
*** PART IV - LEGAL NOTICE ***
++++++++++++++++++++++++++++++++++++++++++++++++++++++

Project IGI: I'm Going In and all of its content, including its name, characters, story, levels, artwork, models, textures, sounds, music, video and program code, belong to their copyright and trademark owners (Innerloop Studios, Eidos Interactive and their successors). All rights are reserved by them.

This project is an unofficial fan project. It is not affiliated with, endorsed by or supported by the owners of Project IGI.

No original game files come with this project. To play, you need your own legally obtained copy of the game; the port reads that copy's files from your own computer.

Copying, uploading, sharing or selling the original game's files, or anything extracted or converted from them, without the owners' permission is copyright infringement and is illegal.

The code written for this web port is (c) 2026 Haseeb ur Rehman. It may not be copied, republished or sold without the author's written permission, and it may not be used for commercial purposes. Contact: munibhaseeb2@gmail.com

Thank you for playing.
`;
