import { computeLayout, outputScale, scaledSize, type FrameLayout, type FrameSource, type Size } from "./geometry";
import { frameSequence, layoutOptionsFrom, type AnimationOptions } from "./options";

export interface AnimationPlan {
  layout: FrameLayout;
  /** Source-pixel → output-pixel scale. */
  scale: number;
  /** Final pixel size of the animation. */
  output: Size;
  /** Source image index for each displayed frame. */
  sequence: number[];
  /** Total length of one loop, in milliseconds. */
  durationMs: number;
}

export function planAnimation(sources: readonly FrameSource[], options: AnimationOptions): AnimationPlan {
  const layout = computeLayout(sources, layoutOptionsFrom(options));
  const scale = outputScale(layout, options.maxEdge);
  const sequence = frameSequence(sources.length, options.playback);
  return {
    layout,
    scale,
    output: scaledSize(layout, scale),
    sequence,
    durationMs: sequence.length * options.frameDelay,
  };
}
