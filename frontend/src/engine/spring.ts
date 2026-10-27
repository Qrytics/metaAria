/**
 * Closed-form underdamped harmonic oscillator spring evaluator.
 *
 * Arcade rule: NO CSS transitions and NO bezier curves for gameplay
 * feedback. Every micro-animation (receptor stomp, judgment pop, hold
 * glow) is driven by this exact analytical spring equation inside the
 * render loop, parameterized by elapsed audio/frame time `t` (seconds):
 *
 *   value(t) = Target + exp(-zeta * omegaN * t)
 *              * (A * cos(omegaD * t) + B * sin(omegaD * t))
 *
 * where omegaD = omegaN * sqrt(1 - zeta * zeta), A = from - Target, and
 * B carries the initial velocity (0 for a struck pose: the spring starts
 * displaced and at rest).
 *
 * Because the value is a pure function of elapsed time, sampling it at
 * `receptorY`-anchored audio positions keeps AV sync exact: pausing the
 * audio clock freezes the spring mid-pose instead of drifting it.
 */

/** Damping ratio window for the underdamped closed form (0, 1). */
export const UNDERDAMPED_MIN_ZETA = 0;
export const UNDERDAMPED_MAX_ZETA = 1;

/**
 * Evaluate the closed-form underdamped spring at elapsed time `t`.
 *
 * @param from    displaced start value (e.g. pressed scale 0.82)
 * @param target  rest value the spring settles to (e.g. 1.0)
 * @param omegaN  natural frequency in rad/s (stiffness)
 * @param zeta    damping ratio; MUST satisfy 0 < zeta < 1
 * @param t       elapsed time in seconds (>= 0)
 * @param initialVelocity value units per second at t = 0 (default 0)
 */
export function springValue(
  from: number,
  target: number,
  omegaN: number,
  zeta: number,
  t: number,
  initialVelocity = 0,
): number {
  if (!(zeta > UNDERDAMPED_MIN_ZETA && zeta < UNDERDAMPED_MAX_ZETA)) {
    throw new RangeError(
      `springValue requires 0 < zeta < 1 (underdamped), got zeta=${zeta}`,
    );
  }
  if (!(omegaN > 0)) {
    throw new RangeError(`springValue requires omegaN > 0, got ${omegaN}`);
  }
  const tt = Math.max(0, t);
  const omegaD = omegaN * Math.sqrt(1 - zeta * zeta);
  const a = from - target;
  const b = (initialVelocity + zeta * omegaN * a) / omegaD;
  const decay = Math.exp(-zeta * omegaN * tt);
  return (
    target + decay * (a * Math.cos(omegaD * tt) + b * Math.sin(omegaD * tt))
  );
}

/** Damped natural frequency in rad/s for the given stiffness/damping. */
export function dampedFrequency(omegaN: number, zeta: number): number {
  return omegaN * Math.sqrt(1 - zeta * zeta);
}

/** Receptor mechanical stomp: press snaps to 0.82, springs back to 1.0. */
export const RECEPTOR_STOMP = {
  from: 0.82,
  target: 1.0,
  omegaN: 45,
  zeta: 0.35,
} as const;

/** Judgment & combo popup scale-pop: 1.45 springs down to 1.0. */
export const POP_SPRING = {
  from: 1.45,
  target: 1.0,
  omegaN: 18,
  zeta: 0.4,
} as const;

/** Lane hit-flash / active-hold beam glow: 0 erupts to full intensity. */
export const GLOW_SPRING = {
  from: 0.0,
  target: 1.0,
  omegaN: 22,
  zeta: 0.45,
} as const;

/**
 * Receptor scale at `ageMs` milliseconds after the key press.
 * Before the press (ageMs <= 0) the receptor rests at 1.0.
 */
export function receptorScale(ageMs: number): number {
  if (ageMs <= 0) {
    return RECEPTOR_STOMP.target;
  }
  return springValue(
    RECEPTOR_STOMP.from,
    RECEPTOR_STOMP.target,
    RECEPTOR_STOMP.omegaN,
    RECEPTOR_STOMP.zeta,
    ageMs / 1000,
  );
}

/**
 * Judgment/combo popup scale at `ageMs` milliseconds after the hit.
 * Settles crisply to 1.0 with zero floaty CSS-style lag.
 */
export function popScale(ageMs: number): number {
  if (ageMs <= 0) {
    return POP_SPRING.from;
  }
  return springValue(
    POP_SPRING.from,
    POP_SPRING.target,
    POP_SPRING.omegaN,
    POP_SPRING.zeta,
    ageMs / 1000,
  );
}

/**
 * Hold-beam glow intensity at `ageMs` milliseconds after the hold head
 * was struck. Rises fast with a small mechanical overshoot, then holds
 * at full intensity while the key stays down.
 */
export function holdGlow(ageMs: number): number {
  if (ageMs <= 0) {
    return GLOW_SPRING.from;
  }
  return springValue(
    GLOW_SPRING.from,
    GLOW_SPRING.target,
    GLOW_SPRING.omegaN,
    GLOW_SPRING.zeta,
    ageMs / 1000,
  );
}
