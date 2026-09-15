// ============================================================
//  Settings Manager — barrel export
//  ----------------------------------------------------------
//  Public entry point: load settings from DB, fallback to defaults.
//
//  SPLIT-D (pure code motion): was src/lib/settings.ts (600 lines,
//  old file deleted). '@/lib/settings' resolves to this folder —
//  ALL existing import paths keep working unchanged. The barrel
//  re-exports EXACTLY the old public API (no `export *` → no
//  accidental additions):
//    ./definitions         — SettingDefinition + SETTING_DEFINITIONS
//    ./store               — cache + DB persistence + default bootstrap
//    ./runtime-thresholds  — RuntimeThresholds + getRuntimeThresholds
// ============================================================
export type { SettingDefinition } from './definitions';
export { SETTING_DEFINITIONS } from './definitions';

export {
  ensureDefaultSettings,
  getAllSettings,
  getSetting,
  getSettingNumber,
  getSettingBool,
  invalidateSettingsCache,
} from './store';

export type { RuntimeThresholds } from './runtime-thresholds';
export { getRuntimeThresholds } from './runtime-thresholds';
