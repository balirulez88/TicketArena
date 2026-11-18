import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";

/**
 * Whether tickets are purchasable yet, judged on the visitor's clock. Only a hint: admission and
 * holds are decided by the server's clock.
 */
export function OnSaleStatus({ onSaleAt }: { readonly onSaleAt: Date }) {
  const onSale = onSaleAt.getTime() <= Date.now();
  return (
    <span className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
      <Badge variant={onSale ? "default" : "secondary"}>
        {onSale ? "On sale now" : "Upcoming"}
      </Badge>
      <span>
        On sale <time dateTime={onSaleAt.toISOString()}>{formatDateTime(onSaleAt)}</time>
      </span>
    </span>
  );
}
