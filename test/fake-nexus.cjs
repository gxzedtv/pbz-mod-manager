'use strict';
// Sample store data for screenshots when Nexus is unreachable (dev only).
const names = [
  ['PBZModLoader', 'LLKKFF', 'JS/TS mod loader for Phantom Blade Zero, with Alt+F5 hot reload.', 113],
  ['PBZ Boss Phase Reset', '12thmonths', 'Every death in a boss fight restarts the fight at phase 1.', 71],
  ['Mods Menu - In-Game Mod Settings', 'SLEEP', 'A Mods Menu tab in the game settings for all your mods.', 149],
  ['Phantom Tweaks - FOV, Camera Distance, Ultrawide', 'Lyall', 'Field of view, camera distance, ultrawide fixes and a cleaner image.', 30],
  ['Nemesis System', 'FKAQ8', 'When something kills you it becomes your nemesis and comes back stronger.', 412],
  ['Boss Map - Boss Portraits and Tracker', '12thmonths', 'Shows every undefeated boss on the map with its bestiary portrait.', 459],
  ['Weapon transmog', 'Soulsmith', 'Use the look of another weapon while keeping your stats and moveset.', 316],
  ['Dark Souls Style Controller Layout - DualSense', 'kaitou', 'Familiar Souls button layout for DualSense controllers.', 88],
];
exports.browse = async () => ({
  items: names.map(([name, author, summary, id], i) => ({
    modId: id, name, author, summary, version: '1.' + i, thumb: '', picture: '',
    endorsements: 2400 - i * 230, downloads: 48000 - i * 5100, updatedAt: '2026-11-1' + (i % 9) + 'T10:00:00Z',
    url: 'https://www.nexusmods.com/phantombladezero/mods/' + id,
  })),
  total: 214, source: 'fake',
});
