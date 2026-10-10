import type { StylePreset } from '@/lib/chartStudio'

// Look shared by the Chart Studio screens.

export const PRESETS: { id: StylePreset; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Matches the app' },
  { id: 'graphpad', label: 'GraphPad style', hint: 'White, no grid, heavy axes: for papers and slides' },
]

export const selectClass =
  'mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500/50'

export const segClass = (active: boolean) =>
  `px-4 py-2 rounded-lg text-sm border transition-all ${
    active
      ? 'bg-green-500/10 text-green-400 border-green-500/20'
      : 'text-gray-400 border-gray-700 hover:bg-gray-800 hover:text-white'
  }`