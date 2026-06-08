/**
 * Ports are the typed connection points exposed by every device in the signal
 * graph. A {@link Route} connects an output port to an input port. Routing
 * legality is governed by two invariants enforced in validation:
 *
 *  1. **Direction:** only `output -> input` is permitted.
 *  2. **Transport:** a port may only connect to a port of the same transport
 *     (`dante <-> dante`, `analog <-> analog`).
 */

/** Physical/logical transport carrying a signal. A label only — no protocol is implemented. */
export type Transport = 'dante' | 'analog';

/** Whether a port sources a signal (`output`) or sinks one (`input`). */
export type PortKind = 'input' | 'output';

/** A typed connection point on a device. */
export interface Port {
  /** Stable unique id (unique across the whole graph). */
  id: string;
  /** Owning device id. */
  deviceId: string;
  /** Direction of signal flow relative to the owning device. */
  kind: PortKind;
  /** Transport type. Connections must match transport. */
  transport: Transport;
  /** Human-readable label, e.g. "Dante Out 1". */
  label: string;
}
