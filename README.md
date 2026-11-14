# PBZ Mod Manager

A mod manager for Phantom Blade Zero with a built-in Nexus Mods store.

- **Library:** import `.zip`, `.7z`, `.rar`, `.pak`, `.dll` or a mod folder. You can drag them straight onto the window. Turn mods on and off, drag to set priority, uninstall, and see clashes between mods.
- **Knows the game's mod types:** PBZModLoader and Mods Menu script mods, PAK mods, UE4SS mods, and native files like ReShade. Each goes in the right folder automatically.
- **Safe:** mods are kept in the manager's own library and copied into the game only while switched on. Original game files a mod replaces are backed up and put back when you turn it off. **Remove all mods from game** in Settings cleans the folder in one click.
- **Nexus store:** browse, search and sort Phantom Blade Zero mods, read descriptions and pick files to install. Downloads install automatically.
- **Found in the game folder:** mods you installed by hand are listed, and you can take them over with one click.

## Start it

**Windows:** download the latest zip from [Releases](../../releases), unzip it anywhere, for example `Documents\PBZ Mod Manager`. Run `PBZ Mod Manager.exe`. Windows SmartScreen may warn about an unknown app (it isn't code-signed): click **More info › Run anyway**.

**macOS (Apple Silicon):** unzip, move `PBZ Mod Manager.app` to Applications, then run this once in Terminal (the app isn't signed by Apple):

```
xattr -cr "/Applications/PBZ Mod Manager.app"
codesign --force --deep -s - "/Applications/PBZ Mod Manager.app"
```

On a Mac the manager also looks for the game inside CrossOver and Whisky bottles.

**From source (any OS):** `npm install` then `npm start`.

## First run

1. **Game folder:** found automatically from your Steam libraries. If it isn't, go to Settings › Browse and pick the folder that holds `ProjectPBZ`.
2. **Script loader:** most gameplay mods need **PBZModLoader** (Nexus 113). The Library shows a button for it if it's missing.
3. **Nexus API key:** go to Settings › **Get my key**, copy your personal API key from Nexus, paste it, then click **Save key**.

## Installing from the store

- **Nexus Premium:** click **Install** on a file. It downloads and installs straight away.
- **Free account:** Nexus only allows API downloads through its website button. Click **Install via Nexus**, then click **Mod Manager Download** on the Nexus page. The manager catches the `nxm://` link and installs the file. The first time, your browser asks whether to open PBZ Mod Manager: allow it.
- Some files have no Mod Manager Download button. Download those manually. The manager notices new archives in your Downloads folder and offers to install them.

## Where things are

- Library, settings and backups: `%APPDATA%\pbz-mod-manager` on Windows, `~/Library/Application Support/pbz-mod-manager` on macOS.
- Loader logs: Settings › **Open loader logs**.

## Tested so far

- Install, enable/disable, priority, backup/restore, take over, purge, and zip/7z extraction: automated tests on a fake game folder (`npm test`).
- The app runs, and each screen was checked with sample data.
- **Not tested yet:** live Nexus Mods calls (the build machine couldn't reach Nexus) and a real Windows/Steam install. The store tries three query formats and falls back to the REST API, so small differences on Nexus's side are handled. If the store shows an error, the message says why.

Not affiliated with S-GAME or Nexus Mods.

## Building

```
npm install
npm start            # run from source
npm test             # library / deploy tests
npm run package:win  # Windows build in release/
```
