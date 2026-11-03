export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * What a consumer decides when it writes an event while handling a message; the runner adds
 * `correlationId` and `causationId`. Defined here so a service handler can type its `emit`
 * without depending on the messaging package.
 */
export interface CausedEventInput {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly holdId?: string;
  readonly orderId?: string;
  readonly payload: JsonValue;
}
