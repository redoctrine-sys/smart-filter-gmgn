import { Snapshotter } from "./snapshotter.js";

/**
 * Singleton snapshotter shared across pipelines and the entrypoint.
 * Pipelines call `snapshotter.register(ca, pipeline)` when they first see a
 * token; the snapshotter then handles the periodic capture schedule on its
 * own timer.
 */
export const snapshotter = new Snapshotter();
