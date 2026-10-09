export interface SpaceLayout { order: string[]; groups: string[][] }
export type SpaceDrop = 'before' | 'after' | 'group';

/** Stacks keep their Herdr spaces separate; only their strip presentation groups. */
export function spaceLayout(order: string[], groups: string[][], live = order): SpaceLayout {
  const ids = [...new Set([...order.filter(id => live.includes(id)), ...live])];
  const used = new Set<string>();
  const stacks: string[][] = [];
  for (const group of groups.filter(Array.isArray)) {
    const members = ids.filter(id => group.includes(id) && !used.has(id));
    if (members.length < 2) continue;
    members.forEach(id => used.add(id)); stacks.push(members);
  }
  const result: string[] = [], emitted = new Set<string>();
  for (const id of ids) {
    if (emitted.has(id)) continue;
    const members = stacks.find(group => group.includes(id)) || [id];
    result.push(...members); members.forEach(member => emitted.add(member));
  }
  return { order: result, groups: stacks };
}

export function dropSpace(layout: SpaceLayout, source: string, target: string, drop: SpaceDrop): SpaceLayout {
  if (source === target || !layout.order.includes(source) || !layout.order.includes(target)) return layout;
  const order = layout.order.filter(id => id !== source);
  const groups = layout.groups.map(group => group.filter(id => id !== source)).filter(group => group.length > 1);
  const group = groups.find(group => group.includes(target)), members = group || [target];
  const anchor = drop === 'before' ? members[0] : members.at(-1)!;
  order.splice(order.indexOf(anchor) + (drop === 'before' ? 0 : 1), 0, source);
  if (drop === 'group') {
    if (group) group.push(source); else groups.push([target, source]);
  }
  return spaceLayout(order, groups);
}
