// ============================================================
//  Analysis Engine — Shared Types
// ============================================================
import type { InventoryRecord, Outlet, Item, Week } from '@prisma/client';

export type RecWithRels = InventoryRecord & { outlet: Outlet; item: Item; week: Week };
