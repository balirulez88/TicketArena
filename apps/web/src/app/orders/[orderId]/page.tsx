import Link from "next/link";
import { OrderStatus } from "@/components/checkout/order-status";

export default async function OrderRoute({
  params,
}: {
  readonly params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-12">
      <Link href="/events" className="text-muted-foreground text-sm hover:underline">
        ← All events
      </Link>
      <OrderStatus orderId={orderId} />
    </main>
  );
}
