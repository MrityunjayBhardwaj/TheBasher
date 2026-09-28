// When the example projects have finished seeding (#1290).
//
// Boot seeds the examples OFF the resume path: a returning director's project opens first, and
// the examples are written behind it — one of them is a captured scene several megabytes long,
// and waiting on it put about a second in front of every first boot, during which the app was
// interactive over a placeholder graph the resume then replaced. Edits made there were lost.
//
// Home lists projects, and an example written a moment after Home mounts would be missing from
// that list until the next visit. So Home asks here first. Boot marks seeding as begun BEFORE it
// routes anywhere, so there is no instant where Home can read "done" for a seeding that has not
// started; outside boot (a test mounting Home alone) nothing began, and the answer is immediate.

let seeding: Promise<void> = Promise.resolve();

/** Resolves once the examples boot is writing are in storage — at once when none are pending. */
export function whenExamplesSeeded(): Promise<void> {
  return seeding;
}

/** Mark seeding as begun; call the returned function when it has finished (or failed). */
export function beginExampleSeeding(): () => void {
  let done!: () => void;
  seeding = new Promise<void>((resolve) => {
    done = resolve;
  });
  return done;
}
