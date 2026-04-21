import { prisma } from '../db.js';

/**
 * Dashboard stats per §6.
 */
export async function getDashboard(userId: string) {
  const monthStart = new Date(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);

  const [totalLists, totalContacts, recentRuns, monthlyCost] = await Promise.all([
    // Non-deleted lists
    prisma.contactList.count({ where: { userId, deletedAt: null } }),

    // Sum imported_count from non-deleted lists
    prisma.contactList.aggregate({
      where: { userId, deletedAt: null },
      _sum: { importedCount: true },
    }),

    // Last 5 runs across all user's non-deleted lists
    prisma.enrichmentRun.findMany({
      where: {
        userId,
        list: { deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: { list: { select: { name: true } } },
    }),

    // Monthly cost — includes deleted-list spend per §17a visibility matrix
    prisma.enrichmentRun.aggregate({
      where: {
        userId,
        createdAt: { gte: monthStart },
      },
      _sum: { totalCostUsd: true },
    }),
  ]);

  return {
    totalLists,
    totalContacts: totalContacts._sum.importedCount ?? 0,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      listId: r.listId,
      listName: r.list.name,
      status: r.status,
      totalItems: r.totalItems,
      completedItems: r.completedItems,
      failedItems: r.failedItems,
      skippedItems: r.skippedItems,
      totalCostUsd: r.totalCostUsd.toString(),
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
    monthlyCostUsd: (monthlyCost._sum.totalCostUsd ?? 0).toString(),
  };
}
