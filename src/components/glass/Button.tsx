import { motion, type HTMLMotionProps } from "framer-motion";
import { forwardRef, type ReactNode } from "react";

type Variant = "filled" | "soft" | "ghost";
type Size = "sm" | "md" | "lg";

type GlassButtonProps = Omit<HTMLMotionProps<"button">, "ref"> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  children?: ReactNode;
};

const variantClasses: Record<Variant, string> = {
  filled: "bg-primary text-ink-onBrand hover:bg-primary-hover active:bg-primary-press shadow-1",
  soft: "bg-primary-soft text-primary hover:brightness-105",
  ghost: "bg-transparent text-ink hover:bg-primary-soft",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-9 px-3 text-sm rounded-input",
  md: "h-11 px-4 text-base rounded-input",
  lg: "h-12 px-5 text-md rounded-input",
};

/** Glass button — filled / soft / ghost, with hover-lift + press-spring. */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ variant = "filled", size = "md", loading, disabled, className = "", children, ...rest }, ref) => {
    const isDisabled = disabled || loading;
    return (
      <motion.button
        ref={ref}
        type="button"
        disabled={isDisabled}
        aria-busy={loading || undefined}
        whileHover={isDisabled ? undefined : { y: -1 }}
        whileTap={isDisabled ? undefined : { scale: 0.97 }}
        transition={{ type: "spring", stiffness: 520, damping: 24 }}
        className={`
          inline-flex items-center justify-center gap-2 font-medium
          transition-colors duration-micro ease-standard
          focus-visible:focus-ring
          disabled:opacity-50 disabled:cursor-not-allowed
          ${variantClasses[variant]} ${sizeClasses[size]} ${className}
        `}
        {...rest}
      >
        {loading && (
          <span
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-pill border-2 border-current border-t-transparent"
          />
        )}
        {children}
      </motion.button>
    );
  },
);
GlassButton.displayName = "GlassButton";
