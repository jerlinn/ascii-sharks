export interface Species {
  name: string;
  cruise: number;
  maxSpeed: number;
  minSpeed: number;
  /** Relative odds of a new school being this species. */
  weight: number;
  schoolSize: [number, number];
  /** Personal space in grid cells (x, y), so every fish gets its own glyph. */
  spacing: [number, number];
  // Behaviour weights. Different mixes produce different collective shapes
  // (Couzin et al. 2002): strong alignment gives polarised schools and
  // ribbons, low alignment gives swarms, and a tangential pull gives a mill.
  align: number;
  cohesion: number;
  jitter: number;
  /** Tangential pull around the local centre: >0 makes a rotating bait ball. */
  mill: number;
  /** Damps vertical speed; real fish mostly cruise level. */
  verticalDrag: number;
  /**
   * A food pellet rather than a fish: it only drifts on the current, never schools or flees,
   * and comes back only when someone drops more. Give it weight 0 so no school is made of it.
   */
  food?: boolean;
  /** How hard predators push this species away; krill barely manage to flee a whale. */
  fear?: number;
}

export const OCEAN_SPECIES: Species[] = [
  {
    name: "sardine",
    cruise: 36, maxSpeed: 64, minSpeed: 18, weight: 3,
    schoolSize: [18, 28], spacing: [1.8, 1.1],
    align: 1.6, cohesion: 1.6, jitter: 40, mill: 70, verticalDrag: 0.5,
  },
  {
    name: "anchovy",
    cruise: 46, maxSpeed: 78, minSpeed: 22, weight: 3,
    schoolSize: [20, 32], spacing: [1.5, 1],
    align: 3.2, cohesion: 0.45, jitter: 30, mill: 0, verticalDrag: 1.4,
  },
  {
    name: "silverside",
    cruise: 40, maxSpeed: 70, minSpeed: 20, weight: 3,
    schoolSize: [12, 20], spacing: [2, 1.1],
    align: 2.4, cohesion: 1.1, jitter: 35, mill: 0, verticalDrag: 1.6,
  },
  {
    name: "mackerel",
    cruise: 32, maxSpeed: 60, minSpeed: 16, weight: 2,
    schoolSize: [5, 9], spacing: [2.6, 1.3],
    align: 2, cohesion: 0.9, jitter: 25, mill: 0, verticalDrag: 2,
  },
  {
    name: "goby",
    cruise: 26, maxSpeed: 56, minSpeed: 10, weight: 1,
    schoolSize: [8, 12], spacing: [1.4, 1.1],
    align: 0.35, cohesion: 1.4, jitter: 110, mill: 0, verticalDrag: 0.3,
  },
];

// Koi pond: one small school of ricefish, plus the pellets a click scatters.
export const POND_SPECIES: Species[] = [
  {
    name: "medaka",
    cruise: 24, maxSpeed: 52, minSpeed: 10, weight: 1,
    schoolSize: [7, 11], spacing: [1.6, 1.1],
    align: 2, cohesion: 1.3, jitter: 45, mill: 0, verticalDrag: 0.8,
  },
  {
    name: "pellet",
    cruise: 0, maxSpeed: 0, minSpeed: 0, weight: 0,
    schoolSize: [0, 0], spacing: [1, 1],
    align: 0, cohesion: 0, jitter: 0, mill: 0, verticalDrag: 0,
    food: true,
  },
];

// Bubble-net scene: dense, slow krill swarms that only half-heartedly flee.
export const KRILL_SPECIES: Species[] = [
  {
    name: "krill",
    cruise: 12, maxSpeed: 40, minSpeed: 4, weight: 1,
    schoolSize: [60, 90], spacing: [1.1, 1],
    align: 0.5, cohesion: 2.4, jitter: 35, mill: 20, verticalDrag: 0.2,
    fear: 0.2,
  },
];

export function pickSpecies(species: Species[]) {
  let r = Math.random() * species.reduce((sum, s) => sum + s.weight, 0);
  for (let i = 0; i < species.length; i++) {
    r -= species[i].weight;
    if (r <= 0) return i;
  }
  return 0;
}
