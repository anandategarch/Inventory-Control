import type { Issue } from './context';

// ============================================================
//  report.ts — console/report output for audit-migration
//  ---------------------------------------------------------
//  SPLIT-F (pure code motion): `hr`, the SUMMARY block from main(),
//  and the /tmp JSON dump moved here unchanged. `issues` is now a
//  parameter instead of a module-level array.
// ============================================================

export function hr(label: string) {
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + label);
  console.log('═'.repeat(70));
}

export function printIssueSummary(issues: Issue[]) {
  hr('SUMMARY — Issues Found');
  if (issues.length === 0) {
    console.log('\n  ✓✓✓ NO ISSUES FOUND — migration is clean. ✓✓✓\n');
  } else {
    const p1 = issues.filter(i => i.severity === 'P1');
    const p2 = issues.filter(i => i.severity === 'P2');
    const p3 = issues.filter(i => i.severity === 'P3');
    console.log(`\n  Total: ${issues.length} issues  (P1=${p1.length}, P2=${p2.length}, P3=${p3.length})\n`);
    for (const i of issues) {
      console.log('┌' + '─'.repeat(78) + '┐');
      console.log(`│ ${i.id} [${i.severity}]: ${i.title}`.padEnd(80) + '│');
      console.log(`│ Finding: ${i.finding}`.padEnd(80) + '│');
      console.log(`│ Impact:  ${i.impact}`.padEnd(80) + '│');
      console.log(`│ Fix:     ${i.fix}`.padEnd(80) + '│');
      console.log('└' + '─'.repeat(78) + '┘');
    }
  }
}

// Save issues to JSON for the worklog writer
export async function writeIssuesJson(issues: Issue[], counts: Record<string, { old: number; new: number }>) {
  const fs = await import('fs');
  fs.writeFileSync('/tmp/audit-migration-issues.json', JSON.stringify({ issues, counts }, null, 2));
}
