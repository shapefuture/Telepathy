// Pure selection rules shared by the exporter and its tests. History arrives newest first, so a
// message older than `from` means the entire export can stop; messages at/after `until` are skipped.

export interface ExportSelection {
  from?: Date;
  until?: Date;
  limit?: number;
  lean?: boolean;
}

export function normalizeLimit(limit: number | undefined): number | undefined {
  return limit !== undefined && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

export function selectMessage(date: Date, service: boolean, options: ExportSelection): "include" | "skip" | "stop" {
  if (options.lean && service) return "skip";
  return selectDate(date, options);
}

export function selectDate(date: Date, options: ExportSelection): "include" | "skip" | "stop" {
  if (options.from && date < options.from) return "stop";
  if (options.until && date >= options.until) return "skip";
  return "include";
}
