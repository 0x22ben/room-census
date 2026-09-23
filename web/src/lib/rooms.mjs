// Choosing a room to publish in. A message can only go to a room Room Census has already measured:
// the page never invents a name, and Technocore creates a room on first write, so an unknown name
// would quietly create one. Every search runs on the list the page carries; nothing is fetched.

/** Rooms whose name contains `query`, busiest first, at most `limit`. An empty query lists the busiest. */
export function searchRooms(rooms, query, limit = 6) {
  const q = String(query ?? "").trim().toLowerCase();
  return rooms
    .filter((r) => !q || r.room.includes(q))
    .slice(0, limit);
}

/** Whether this exact room is one of the rooms the page carries. */
export const known = (rooms, name) => rooms.some((r) => r.room === name);

/** The room entry, or null. */
export const find = (rooms, name) => rooms.find((r) => r.room === name) ?? null;
