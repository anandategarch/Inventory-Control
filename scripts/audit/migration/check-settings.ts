import type { MigrationAuditContext } from './context';
import { q } from './db';
import { hr } from './report';

// ============================================================
// CHECK 7: SETTING TABLE COMPARISON
// ============================================================
// NOTE (SPLIT-F): the dynamic import of src/lib/settings was
// '../../src/lib/settings' when this code lived in
// scripts/audit/audit-migration.ts; this module sits one directory
// deeper (scripts/audit/migration/) so the relative path gained one
// '../'. Same target file, same lazy import behavior.
export async function check7_settings(ctx: MigrationAuditContext) {
  hr('CHECK 7 — Setting Table Comparison (OLD vs NEW)');
  if (!ctx.state.oldReachable) {
    console.log('  ⚠ OLD DB unreachable — cannot compare OLD vs NEW settings.');
    console.log('  Falling back to NEW-only check: count settings in NEW and verify SETTING_DEFINITIONS defaults are present.');
    const newR = await q(ctx.newPool, `SELECT key, value, category, "dataType" FROM "Setting" ORDER BY key`);
    const newMap = new Map<string, { value: string; category: string; dataType: string }>();
    for (const r of newR.rows) newMap.set(r.key, { value: r.value, category: r.category, dataType: r.dataType });
    console.log(`  NEW DB: ${newMap.size} settings`);
    // Load SETTING_DEFINITIONS from source
    const { SETTING_DEFINITIONS } = await import('../../../src/lib/settings');
    const expectedKeys = new Set(SETTING_DEFINITIONS.map(d => d.key));
    const missingDefaults = [...expectedKeys].filter(k => !newMap.has(k));
    const extraKeys = [...newMap.keys()].filter(k => !expectedKeys.has(k));
    console.log(`  SETTING_DEFINITIONS count (expected defaults): ${expectedKeys.size}`);
    if (missingDefaults.length > 0) {
      console.log(`  ✗ ${missingDefaults.length} default settings missing from NEW DB:`);
      missingDefaults.forEach(k => console.log(`    - ${k}`));
      ctx.addIssue('MIGR-07-NEW', 'P2',
        'Default settings missing from NEW DB',
        `${missingDefaults.length} settings from SETTING_DEFINITIONS are absent in NEW DB.`,
        'Engine will fall back to hardcoded defaults in getRuntimeThresholds() — functionally OK but means /api/settings UI will not show these settings.',
        'Call ensureDefaultSettings() (src/lib/settings.ts:381) — it does createMany({ skipDuplicates: true }). Or trigger any API call (which calls getAllSettings → ensureDefaultSettings).'
      );
    } else {
      console.log(`  ✓ All ${expectedKeys.size} default settings present in NEW DB.`);
    }
    if (extraKeys.length > 0) {
      console.log(`  ℹ ${extraKeys.length} settings in NEW DB are NOT in SETTING_DEFINITIONS (likely user-customized or legacy):`);
      extraKeys.forEach(k => console.log(`    + ${k} = ${newMap.get(k)?.value}`));
    }
    // CRITICAL: note that user customizations from OLD DB are unrecoverable
    ctx.addIssue('MIGR-07-CUSTOM', 'P2',
      'User-customized settings from OLD DB cannot be verified',
      'OLD DB is unreachable. Any user-customized settings (e.g., changed STD_SUSUT_PCT from 0.10 to 0.15) are LOST — NEW DB only has SETTING_DEFINITIONS defaults.',
      'Engine will use default thresholds instead of user-customized values. Analysis results may differ from what the user expects.',
      'If OLD DB can be restored (Supabase dashboard → un-pause), re-run this audit and copy over any non-default values. Otherwise, ask user to manually re-apply customizations via /api/settings UI.'
    );
    return;
  }
  const oldR = await q(ctx.oldPool, `SELECT key, value, category FROM "Setting" ORDER BY key`);
  const newR = await q(ctx.newPool, `SELECT key, value, category FROM "Setting" ORDER BY key`);
  const oldMap = new Map<string, { value: string; category: string }>();
  const newMap = new Map<string, { value: string; category: string }>();
  for (const r of oldR.rows) oldMap.set(r.key, { value: r.value, category: r.category });
  for (const r of newR.rows) newMap.set(r.key, { value: r.value, category: r.category });
  console.log(`  OLD: ${oldMap.size} settings`);
  console.log(`  NEW: ${newMap.size} settings`);
  const missingInNew: string[] = [];
  const different: string[] = [];
  const extraInNew: string[] = [];
  for (const [key, ov] of oldMap) {
    const nv = newMap.get(key);
    if (!nv) missingInNew.push(key);
    else if (nv.value !== ov.value) different.push(`${key}: OLD=${ov.value}  NEW=${nv.value}`);
  }
  for (const key of newMap.keys()) if (!oldMap.has(key)) extraInNew.push(key);
  if (missingInNew.length > 0) {
    console.log(`\n  Missing in NEW (${missingInNew.length}):`);
    missingInNew.forEach(k => console.log(`    - ${k}`));
  }
  if (different.length > 0) {
    console.log(`\n  Value differs (${different.length}):`);
    different.forEach(d => console.log(`    - ${d}`));
  }
  if (extraInNew.length > 0) {
    console.log(`\n  Extra in NEW (${extraInNew.length}):`);
    extraInNew.forEach(k => console.log(`    + ${k}`));
  }
  if (missingInNew.length === 0 && different.length === 0) {
    console.log('\n  ✓ All OLD settings present in NEW with identical values.');
  } else {
    // Categorize severity
    const customized = different.filter(d => {
      // A "value differs" line: extract the key
      const k = d.split(':')[0].trim();
      const oldVal = oldMap.get(k)?.value;
      const newVal = newMap.get(k)?.value;
      return oldVal !== newVal;
    });
    if (missingInNew.length > 0) {
      ctx.addIssue('MIGR-07', 'P2',
        'Settings missing in NEW DB after migration',
        `${missingInNew.length} keys present in OLD are absent in NEW: ${missingInNew.slice(0, 5).join(', ')}${missingInNew.length > 5 ? '...' : ''}`,
        'Customized settings (user-edited thresholds, growth factors) are LOST. App will use hardcoded defaults instead — may produce different analysis results.',
        'Manually copy missing settings from OLD → NEW via SQL: INSERT INTO "Setting" (key, value, category, label, description, "dataType") SELECT ... FROM dblink(...). Or export OLD settings to JSON and re-import via /api/settings.'
      );
    }
    if (different.length > 0) {
      ctx.addIssue('MIGR-07b', 'P3',
        'Settings values differ between OLD and NEW (likely intentional — auto-seed)',
        `${different.length} keys have different values. NEW DB was auto-seeded from SETTING_DEFINITIONS (src/lib/settings.ts). Any user customizations in OLD DB are LOST.`,
        'Same as MIGR-07 — engine uses different threshold values. Analysis results may differ.',
        'Compare values from OLD with current defaults in SETTING_DEFINITIONS. If OLD had custom values, copy them over.'
      );
    }
  }
  // Special note: Setting was intentionally skipped (auto-seeded).
  // If NEW has the SAME set of default keys as SETTING_DEFINITIONS and OLD had user-customized values,
  // the diff is expected — but we flag it because user customizations are lost.
}
