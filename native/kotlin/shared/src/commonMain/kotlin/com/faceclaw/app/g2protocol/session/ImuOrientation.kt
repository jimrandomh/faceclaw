package com.faceclaw.app

/**
 * Faceclaw's accelerometer frame. Every model's samples are rotated into it before they reach a
 * FaceclawImuListener ([GlassesSessionCore.emitImuData]), so Faceclaw apps and EvenHub pages see
 * the same frame whichever glasses are worn. It is the G2's own frame, in g, glasses worn:
 *
 *   +x forward (the way the wearer faces), +y to the wearer's left, +z up through the top of the head.
 *
 * At rest a reading is the "up" direction (the reaction to gravity): head level reads (0, 0, 1),
 * looking 45° up (0.71, 0, 0.71), and the head tilted 45° to the right (right ear down)
 * (0, 0.71, 0.71). Pitch above level is atan2(x, hypot(y, z)).
 */
object ImuOrientation {
    /**
     * A sample as [type]'s hardware reports it, in the canonical frame. Axes measured on hardware
     * with the Developer app's accelerometer page:
     * - G2: already canonical.
     * - G1 (g1v0): +x right, +y up, +z back. Level reads (0, 1, 0), 45° up (0, 0.71, -0.71),
     *   45° to the right (-0.71, 0.71, 0).
     * - RayNeo iO: no accelerometer stream yet, so nothing to rotate; measure its axes when one
     *   is added.
     */
    fun toCanonical(type: GlassesType, x: Double, y: Double, z: Double): DoubleArray = when (type) {
        GlassesType.G2 -> doubleArrayOf(x, y, z)
        GlassesType.G1 -> doubleArrayOf(-z, -x, y)
        GlassesType.RAYNEO_IO -> doubleArrayOf(x, y, z)
    }
}
