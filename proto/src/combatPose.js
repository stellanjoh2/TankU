// One pose shape for anything that can be aimed at or heard: a tank or a patrol boat.
// Call sites read body / alive / position and call muzzle() or mgMuzzle().

/** @param {object} tank */
export function tankPose(tank) {
  return {
    body: tank.body,
    get alive() { return tank.alive; },
    get position() { return tank.model.position; },
    muzzle: () => tank.muzzle(),
    mgMuzzle: () => tank.mgMuzzle(),
  };
}

/** @param {{ body, root, alive, firing, mgMuzzle }} boat */
export function boatPose(boat) {
  return {
    body: boat.body,
    get alive() { return !!boat.alive; },
    get position() { return boat.root.position; },
    muzzle: () => null,
    mgMuzzle: () => (boat.firing ? boat.mgMuzzle() : null),
  };
}
