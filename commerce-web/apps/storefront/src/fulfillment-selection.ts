type Window = { starts_at: string; ends_at: string };
export function hasAvailableSelections(groups: { source_id: string; slots: Window[] }[], chosen: Record<string, Window>) {
  return groups.length > 0 && groups.every(group => {
    const slot = chosen[group.source_id];
    return !!slot && group.slots.some(available => available.starts_at === slot.starts_at && available.ends_at === slot.ends_at);
  });
}
