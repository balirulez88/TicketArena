import type { PrismaClient } from "./index";

interface SectionPlan {
  readonly name: string;
  readonly priceMinor: number;
  readonly rows: readonly string[];
  readonly seatsPerRow: number;
}

interface VenuePlan {
  readonly name: string;
  readonly sections: readonly SectionPlan[];
}

interface EventPlan {
  readonly name: string;
  readonly venue: string;
  /** Days from the seeding instant until the on-sale opens. */
  readonly onSaleInDays: number;
  readonly demo: boolean;
}

const VENUES: readonly VenuePlan[] = [
  {
    name: "Arena Central",
    sections: [
      { name: "Floor", priceMinor: 12_500, rows: ["A", "B", "C"], seatsPerRow: 10 },
      { name: "Balcony", priceMinor: 6_500, rows: ["D", "E"], seatsPerRow: 10 },
    ],
  },
  {
    name: "Riverside Theatre",
    sections: [{ name: "Stalls", priceMinor: 8_000, rows: ["A", "B"], seatsPerRow: 8 }],
  },
];

const EVENTS: readonly EventPlan[] = [
  { name: "Demo Race", venue: "Arena Central", onSaleInDays: 1, demo: true },
  { name: "Midnight Symphony", venue: "Arena Central", onSaleInDays: 14, demo: false },
  { name: "Riverside Jazz Night", venue: "Riverside Theatre", onSaleInDays: 30, demo: false },
];

const DAY_MS = 86_400_000;
const QUEUE_LEAD_MS = 5 * 60_000;
const QUEUE_WINDOW_MS = 60 * 60_000;

/**
 * Creates the demo catalog. Every write is keyed on a natural unique key and never updates an
 * existing row, so re-running neither duplicates data nor resets seat state or shifted dates.
 */
export async function seedCatalog(prisma: PrismaClient, now: Date): Promise<void> {
  for (const plan of VENUES) {
    const venue =
      (await prisma.venue.findFirst({ where: { name: plan.name } })) ??
      (await prisma.venue.create({ data: { name: plan.name } }));
    for (const sectionPlan of plan.sections) {
      const section = await prisma.section.upsert({
        where: { venueId_name: { venueId: venue.id, name: sectionPlan.name } },
        create: {
          venueId: venue.id,
          name: sectionPlan.name,
          priceMinor: sectionPlan.priceMinor,
        },
        update: {},
      });
      for (const label of sectionPlan.rows) {
        await prisma.row.upsert({
          where: { sectionId_label: { sectionId: section.id, label } },
          create: { sectionId: section.id, label },
          update: {},
        });
      }
    }
  }

  for (const plan of EVENTS) {
    const venue = await prisma.venue.findFirstOrThrow({ where: { name: plan.venue } });
    const onSaleAt = new Date(now.getTime() + plan.onSaleInDays * DAY_MS);
    const event = await prisma.event.upsert({
      where: { name: plan.name },
      create: {
        venueId: venue.id,
        name: plan.name,
        onSaleAt,
        queueOpensAt: new Date(onSaleAt.getTime() - QUEUE_LEAD_MS),
        queueClosesAt: new Date(onSaleAt.getTime() + QUEUE_WINDOW_MS),
        demo: plan.demo,
      },
      update: {},
    });
    const rows = await prisma.row.findMany({
      where: { section: { venueId: venue.id } },
      include: { section: true },
    });
    // Scoped to this venue's sections: section names may repeat across venues.
    const seatsPerRow = new Map(
      (VENUES.find((v) => v.name === plan.venue)?.sections ?? []).map((section) => [
        section.name,
        section.seatsPerRow,
      ]),
    );
    // skipDuplicates keeps the (event, row, number) unique key the sole arbiter of existence.
    await prisma.seat.createMany({
      data: rows.flatMap((row) =>
        Array.from({ length: seatsPerRow.get(row.section.name) ?? 0 }, (_, index) => ({
          eventId: event.id,
          rowId: row.id,
          number: index + 1,
        })),
      ),
      skipDuplicates: true,
    });
  }
}
