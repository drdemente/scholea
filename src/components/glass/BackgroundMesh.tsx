import { motion, useReducedMotion } from "framer-motion";

/**
 * The animated gradient mesh + grain that sits behind every screen.
 * Parallax/animation applies ONLY to the mesh — never to functional UI.
 */
export function BackgroundMesh() {
  const prefersReduced = useReducedMotion() ?? false;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-canvas"
    >
      <motion.div
        className="absolute -inset-[20%] bg-mesh bg-mesh-fade"
        animate={prefersReduced ? undefined : { rotate: [0, 6, -4, 0], scale: [1, 1.04, 1.02, 1] }}
        transition={
          prefersReduced ? undefined : { duration: 28, ease: "easeInOut", repeat: Infinity }
        }
      />
      <div className="absolute inset-0 bg-grain" />
    </div>
  );
}
