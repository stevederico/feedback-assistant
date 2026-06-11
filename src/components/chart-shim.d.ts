// Drift shim for the legacy `shadcn/ui/chart` subpath.
//
// The dashboard-01 scaffold (HomeView -> ChartAreaInteractive / DataTable*)
// imports `@stevederico/skateboard-ui/shadcn/ui/chart`, but skateboard-ui 3.12.0
// no longer ships that component (the canonical scaffold removed these files).
// This island is unrouted dead code — main.tsx never imports HomeView — so it
// never loads at runtime; this ambient declaration only lets `tsc` resolve the
// stale import. Remove this shim (and the scaffold files that need it) when the
// dashboard scaffold is dropped to match canonical.

declare module '@stevederico/skateboard-ui/shadcn/ui/chart' {
  import type { ComponentType, ReactNode } from 'react';

  /** Per-series chart configuration (label + color). */
  export type ChartConfig = Record<string, { label?: ReactNode; color?: string }>;

  export const ChartContainer: ComponentType<{
    config: ChartConfig;
    className?: string;
    children?: ReactNode;
  }>;
  export const ChartTooltip: ComponentType<Record<string, unknown>>;
  export const ChartTooltipContent: ComponentType<Record<string, unknown>>;
}
