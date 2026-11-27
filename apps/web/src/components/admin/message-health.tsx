import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDuration } from "@/lib/format";
import type { AdminSnapshot } from "@/server/routers/admin";

const SERVICES = ["booking", "payment", "notification"] as const;

function Figure({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function DeliveryFigures({
  delivery,
}: {
  readonly delivery: NonNullable<AdminSnapshot["messageHealth"]["delivery"]>;
}) {
  return (
    <>
      <Table>
        <TableCaption>Consumer delivery</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Consumer</TableHead>
            <TableHead scope="col">Lag</TableHead>
            <TableHead scope="col">Pending acks</TableHead>
            <TableHead scope="col">Redeliveries</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(delivery.consumers).map(([consumer, figures]) => (
            <TableRow key={consumer}>
              <TableCell>{consumer}</TableCell>
              {figures === null ? (
                <TableCell colSpan={3} className="text-muted-foreground">
                  not found on the broker
                </TableCell>
              ) : (
                <>
                  <TableCell className="tabular-nums">{figures.lag}</TableCell>
                  <TableCell className="tabular-nums">{figures.pendingAcks}</TableCell>
                  <TableCell className="tabular-nums">{figures.redeliveries}</TableCell>
                </>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <dl>
        <Figure label="DLQ size" value={String(delivery.dlq.size)} />
        <Figure
          label="Oldest DLQ message"
          value={
            delivery.dlq.oldestAgeMs === null ? "none" : formatDuration(delivery.dlq.oldestAgeMs)
          }
        />
      </dl>
    </>
  );
}

/**
 * Delivery health at a glance: outbox lag (events held back before the broker) next to the
 * broker's consumer and DLQ figures (events stuck after it), and the oldest refund still owed.
 */
export function MessageHealth({ snapshot }: { readonly snapshot: AdminSnapshot }) {
  const { outboxLagMs, delivery } = snapshot.messageHealth;
  return (
    <section aria-label="Message health">
      <Card>
        <CardHeader>
          <CardTitle>Message health</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableCaption>Outbox lag per service</TableCaption>
            <TableBody>
              {SERVICES.map((service) => (
                <TableRow key={service}>
                  <TableCell>{service}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatDuration(outboxLagMs[service])}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {delivery === null ? (
            <p className="text-muted-foreground text-sm">
              Consumer and DLQ figures are unavailable: the worker's health endpoint could not be
              read.
            </p>
          ) : (
            <DeliveryFigures delivery={delivery} />
          )}
          <dl>
            <Figure
              label="Oldest open refund"
              value={formatDuration(snapshot.refundPendingAgeMaxMs)}
            />
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}
